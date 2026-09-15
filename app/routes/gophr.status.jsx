// Gophr status webhook — the rider's progress, written onto the Shopify order.
//
// NOT A SHOPIFY WEBHOOK. Gophr posts here, so none of Shopify's webhook
// machinery applies: no HMAC, no `authenticate.webhook`, no session. The URL
// is pasted into Gophr's own booking portal.
//
// AUTHENTICATION
// --------------
// Gophr sends the account's API key back in an `Api-Key` header, and its
// documentation says to check that it matches. That is the whole of the
// authentication available, so it is done carefully:
//
//   · compared in constant time, because a plain `===` on a secret leaks its
//     prefix to anyone willing to time the responses
//   · a missing or wrong key gets 401 and nothing else happens
//   · the key itself is never logged, not even a fragment
//
// WHY THIS MATTERS EVEN WITH auto_book OFF
// ----------------------------------------
// While automatic booking is switched off, the shop confirms each draft by
// hand in Gophr's portal. The orders/paid webhook never sees that, so stage
// one never fires — but Gophr still reports the job's progress here. So for
// the fortnight of manual confirming, THIS is the route that tells the
// customer anything at all.

import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { gophrKey } from "../lib/gophr.server.js";
import { mergeAttributes } from "../lib/order-booking.js";
import { fulfilWithTracking, updateTracking } from "../lib/fulfilment.server.js";

const log = (...parts) => console.log("[ibc-courier:status]", ...parts);

/**
 * The shop this app serves.
 *
 * Gophr has no idea which Shopify store its callback belongs to, so the app
 * has to know. An environment variable was the first answer and it is the
 * wrong one: it is a value the app ALREADY HOLDS, and a second copy in Vercel
 * is one more thing to set correctly, forget, and then debug at a distance.
 *
 * The session store has it. Distribution is SingleMerchant — see
 * shopify.server.js — so there is exactly one shop, and the row is written by
 * OAuth the moment the app is installed. The env var stays as an override for
 * the case where somebody needs to point a local build at a dev store.
 */
async function shopDomain() {
  const configured = (process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOP_DOMAIN || "").trim();
  if (configured) return configured;

  const session = await db.session.findFirst({ select: { shop: true } });
  return session?.shop || "";
}

/**
 * Constant-time string comparison.
 *
 * `a === b` on a secret returns as soon as two characters differ, so the time
 * it takes reveals how much of a guess was right. Over enough requests that
 * is a key. This always walks the whole string.
 */
function safeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/* Statuses that mean the parcel is moving, and so the customer should have
 * been told. Gophr's vocabulary is not fully documented, so this matches
 * loosely and errs towards telling somebody: a customer emailed slightly
 * early is a smaller harm than one never emailed at all. */
function isUnderway(status) {
  const s = String(status || "").toUpperCase();
  return /PICK|COLLECT|TRANSIT|WAY|PROGRESS|ASSIGN|ACCEPT|DELIVER/.test(s);
}

function isDelivered(status) {
  return /DELIVERED|COMPLETE/.test(String(status || "").toUpperCase());
}

/* Find the order Gophr is talking about.
 *
 * `external_id` is the order name with its `#` stripped, which is why the
 * booking sends it that way. Shopify's order search matches `name:1093`. */
const FIND_ORDER = `
  query CourierFindOrder($q: String!) {
    orders(first: 2, query: $q) {
      nodes {
        id
        name
        cancelledAt
        customAttributes { key value }
      }
    }
  }
`;

const ORDER_UPDATE = `
  mutation CourierStatusUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response("POST only", { status: 405 });
  }

  const sent = request.headers.get("Api-Key") || request.headers.get("api-key") || "";
  const expected = gophrKey();

  if (!expected) {
    log("GOPHR_API_KEY is not set, so nothing can be verified; refusing");
    return new Response("not configured", { status: 503 });
  }
  if (!safeEqual(sent, expected)) {
    /* No detail. An attacker learns nothing from this, and the log line says
     * enough for the shop to tell a misconfiguration from an intrusion. */
    log("rejected a status callback with a bad or missing Api-Key");
    return new Response("unauthorized", { status: 401 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const body = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const externalId = String(body?.external_id || "").trim();
  const status = String(body?.status || "").trim();
  const trackerUrl = String(body?.public_tracker_url || body?.tracking_url || "").trim();
  const courierName = String(body?.courier_name || "").trim();
  const deliveryEta = String(body?.delivery_eta || "").trim();

  log("status", status || "(none)", "for external_id", externalId || "(none)");

  if (!externalId) {
    /* Answer 200 anyway. Gophr will retry a non-2xx, and retrying a payload
     * with nothing to match on will not start matching. */
    log("no external_id on the callback; nothing to match");
    return new Response("ok");
  }

  try {
    const shop = await shopDomain();
    if (!shop) {
      log("no shop in the session store — is the app installed?");
      return new Response("not installed", { status: 503 });
    }
    const { admin } = await unauthenticated.admin(shop);

    const found = await admin.graphql(FIND_ORDER, {
      variables: { q: `name:${externalId}` },
    });
    const { data } = await found.json();
    const orders = data?.orders?.nodes || [];

    if (orders.length !== 1) {
      /* Zero is a job booked from somewhere else, or a test. More than one is
       * genuinely ambiguous, and guessing which order a rider is carrying is
       * not a guess worth making. */
      log(externalId, "matched", orders.length, "orders; leaving it alone");
      return new Response("ok");
    }

    const order = orders[0];

    /* A cancelled order still gets its attributes updated — the shop wants
     * the record — but nobody is emailed about a delivery they cancelled. */
    const notifiable = !order.cancelledAt;

    const updates = {
      ibc_courier_last_status: status || null,
      ibc_courier_courier_name: courierName || null,
      ibc_courier_eta: deliveryEta || null,
      ibc_courier_updated_at: new Date().toISOString(),
    };
    if (trackerUrl) updates.ibc_courier_tracking_url = trackerUrl;

    const response = await admin.graphql(ORDER_UPDATE, {
      variables: {
        input: {
          id: order.id,
          customAttributes: mergeAttributes(order.customAttributes, updates),
        },
      },
    });
    const { data: updated } = await response.json();
    const errors = updated?.orderUpdate?.userErrors || [];
    if (errors.length) {
      log(order.name, "orderUpdate refused:", errors.map((e) => e.message).join("; "));
    }

    /* STAGE TWO. The fulfillment may or may not exist yet:
     *
     *   · automatic booking ON  — stage one already created it, so this only
     *     refreshes the tracker, quietly.
     *   · automatic booking OFF — the shop confirmed the draft by hand, so
     *     nothing has told Shopify anything. This creates the fulfillment and
     *     sends the one email the customer gets.
     *
     * fulfilWithTracking returns `nothing_open` rather than throwing when the
     * order is already fulfilled, which is what makes it safe to call on
     * every status update. */
    if (notifiable && (isUnderway(status) || isDelivered(status))) {
      const created = await fulfilWithTracking(admin, {
        orderGid: order.id,
        trackingUrl: trackerUrl || null,
        notify: true,
      });

      if (!created.ok && created.reason === "nothing_open") {
        /* Already fulfilled. Refresh the link WITHOUT notifying — Gophr sends
         * a status update per leg, and a customer emailed on each one will
         * unsubscribe from the shop entirely. */
        await updateTracking(admin, {
          orderGid: order.id,
          trackingUrl: trackerUrl || null,
          notify: false,
        });
      } else if (!created.ok) {
        log(order.name, "could not fulfil:", created.reason, created.message || "");
      }
    }

    return new Response("ok");
  } catch (error) {
    log(externalId, "failed:", error?.message || error);
    /* 500 so Gophr retries. Unlike the Shopify side there is no window to
     * miss here — a status arriving late is still worth having. */
    return new Response("error", { status: 500 });
  }
};

/* A GET is how a person checks the URL is live before pasting it into Gophr.
 * It says nothing about the key. */
export const loader = async () =>
  new Response("Gophr status endpoint. POST only.", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
