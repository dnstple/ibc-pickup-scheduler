// orders/paid — book a rider for a same-day order.
//
// PLUMBING ONLY. Every rule about whether to book, what price is acceptable
// and what to write back lives in app/lib/courier-booking.js, which is pure
// and has its own tests. This file reads Shopify, calls Gophr, writes Shopify,
// and chooses an HTTP status. Nothing else.
//
// WHAT THIS RETURNS, AND WHY IT MATTERS
// -------------------------------------
// Shopify retries a webhook that does not answer 2xx — nineteen times across
// forty-eight hours. That is the wrong shape for same-day: the window has long
// gone by the later attempts. So:
//
//   200  the order was dealt with, or deliberately left alone. Includes every
//        flagged order: a human has been asked to look, and asking again
//        nineteen times does not help.
//   500  something transient went wrong AND the order is new enough that a
//        retry might still land inside the window.
//
// The choice between those two is made by retryVerdict(), which is pure and
// tested.

import { authenticate } from "../shopify.server";
import { loadSettings } from "../lib/settings.server";
import { normalizeSameday, zoneForPostcode } from "../lib/sameday.js";
import { normalizeDelivery } from "../lib/delivery.js";
import { mergeAttributes } from "../lib/order-booking.js";
import {
  courierPlan,
  retryVerdict,
  bookedAttributes,
  failedAttributes,
  normalizeBooking,
} from "../lib/courier-booking.js";
import { bookJob, parcelFor, GophrError } from "../lib/gophr.server.js";

/* Everything the decision needs, and nothing else. `customAttributes` is read
 * FRESH rather than taken from the webhook payload: the payload is a snapshot
 * from the moment of payment, and the whole idempotency scheme rests on seeing
 * what is on the order right now. */
const ORDER_QUERY = `
  query CourierOrder($id: ID!) {
    order(id: $id) {
      id
      name
      cancelledAt
      processedAt
      email
      phone
      customAttributes { key value }
      totalWeight
      shippingAddress {
        name
        phone
        address1
        address2
        city
        zip
        countryCodeV2
      }
      lineItems(first: 50) {
        nodes {
          quantity
          product {
            perishable: metafield(namespace: "custom", key: "pickup_delay_minutes") { value }
          }
        }
      }
    }
  }
`;

const ORDER_UPDATE = `
  mutation CourierOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const TAGS_ADD = `
  mutation CourierTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const log = (...parts) => console.log("[ibc-courier]", ...parts);

/** Write attributes back, merging rather than replacing. */
async function writeBack(admin, order, updates, tags) {
  /* orderUpdate REPLACES customAttributes wholesale. Every existing key has to
   * be carried through or the collection attributes, the delivery window and
   * anything an app wrote would be deleted by a courier booking. This mistake
   * is already documented in order-booking.js; it is repeated here because it
   * is the kind that looks fine in testing and loses data in production. */
  const customAttributes = mergeAttributes(order.customAttributes, updates);

  const response = await admin.graphql(ORDER_UPDATE, {
    variables: { input: { id: order.id, customAttributes } },
  });
  const { data } = await response.json();
  const errors = data?.orderUpdate?.userErrors || [];
  if (errors.length) {
    log("orderUpdate refused:", JSON.stringify(errors));
    throw new Error(`orderUpdate: ${errors.map((e) => e.message).join("; ")}`);
  }

  /* Tags are a separate mutation on purpose: the `tags` field on OrderInput
   * replaces the whole list, and quietly removing a merchant's own tags to add
   * one of ours is not a trade worth making. */
  if (tags && tags.length) {
    try {
      await admin.graphql(TAGS_ADD, { variables: { id: order.id, tags } });
    } catch (error) {
      /* A tag is a convenience. Losing it must not lose the booking. */
      log("tagsAdd failed, continuing:", error?.message || error);
    }
  }
}

/* `#1092` -> `1092`.
 *
 * Shopify order names carry a leading `#`, and it travels into Gophr as the
 * job's external_id and into the parcel id. Gophr has not complained about it
 * yet, but an identifier with a punctuation prefix is the kind of thing that
 * passes validation and then breaks a lookup or a URL later. The name is
 * still recognisable without it, which is the only reason it is worth
 * normalising rather than sending as-is. */
function orderRef(order) {
  const name = String(order?.name || "").replace(/^#/, "").trim();
  if (name) return name;
  const id = String(order?.id || "");
  return id.split("/").pop() || "order";
}

/** The dropoff, as Gophr wants it, from the order's shipping address. */
function destinationFrom(order) {
  const a = order?.shippingAddress || {};
  return {
    name: a.name || "",
    /* The checkout collects a mobile for local delivery — it is a required
     * field on that rate — so this is normally present. The order's own phone
     * is the fallback for an order placed by other means. */
    mobile: a.phone || order?.phone || "",
    email: order?.email || "",
    address1: a.address1 || "",
    address2: a.address2 || "",
    city: a.city || "London",
    postcode: a.zip || "",
    country_code: a.countryCodeV2 || "GB",
  };
}

/** Grams for the whole basket, and whether anything in it is a cake. */
function parcelFrom(order) {
  const grams = Number(order?.totalWeight);
  const perishable = (order?.lineItems?.nodes || []).some(
    (line) => Number(line?.product?.perishable?.value) > 60
  );
  return parcelFor({
    grams: Number.isFinite(grams) && grams > 0 ? grams : 500,
    perishable,
    id: `ibc-${orderRef(order)}`,
  });
}

/* Topics arrive spelled differently depending on the library version — some
 * hand back `orders/paid`, some `ORDERS_PAID`. A strict `!==` against one
 * spelling turns the other into a silent 200 that writes nothing, logs
 * nothing and looks exactly like a webhook that never fired. Both spellings
 * normalise to the same thing here. */
const sameTopic = (topic, wanted) =>
  String(topic || "").toUpperCase().replace(/[^A-Z]+/g, "_") === wanted;

export const action = async ({ request }) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  /* EVERY EXIT FROM THIS FUNCTION SAYS SO, including the boring ones.
   *
   * The first version returned a bare 200 from three different places without
   * a word. When an order came through and nothing happened, there was no way
   * to tell a webhook that never arrived from one that arrived and fell out
   * of the first `if` — and those need completely different fixes. One line
   * per exit is cheap; an afternoon spent guessing is not. */
  log("received", topic, "for", payload?.name || payload?.id || "(unknown order)");

  if (!sameTopic(topic, "ORDERS_PAID")) {
    log("not an orders/paid topic; ignoring:", topic);
    return new Response();
  }

  /* An uninstalled shop has no admin client. Nothing to do and nothing to
   * retry — answering 200 stops Shopify asking again. */
  if (!admin) {
    log("no admin client for", shop, "— is the app still installed?");
    return new Response();
  }

  const gid = payload?.admin_graphql_api_id;
  if (!gid) {
    log("no order gid on the payload; ignoring");
    return new Response();
  }

  try {
    const response = await admin.graphql(ORDER_QUERY, { variables: { id: gid } });
    const { data } = await response.json();
    const order = data?.order;
    if (!order) {
      log(gid, "could not be read; ignoring");
      return new Response();
    }

    const { settings } = await loadSettings(admin);
    const delivery = normalizeDelivery(settings?.delivery);
    const sameday = normalizeSameday(delivery?.sameday);
    const booking = normalizeBooking(delivery?.booking);

    /* Pass one: is this even a same-day order, and is it still bookable? */
    const first = courierPlan({ order, booking });

    if (first.act === "ignore") {
      log(order.name, "ignored:", first.reason);
      return new Response();
    }

    if (first.act === "flag") {
      await writeBack(admin, order, first.attributes, ["same-day", "courier-review"]);
      log(order.name, "flagged:", first.reason);
      return new Response();
    }

    /* Pass two: create the DRAFT and let it name its own price.
     *
     * There is no separate /quotes call here any more, and its absence is the
     * point. Gophr's documentation says a job confirmed at a later point may
     * be re-quoted and "prices may change" — so a circuit breaker fed from
     * /quotes would be policing a number nobody is charged. The draft carries
     * the price that confirming will charge, and the two happen one after the
     * other, so there is no later point for it to drift in.
     *
     * A draft dispatches nobody. If the price is refused below, it is simply
     * left as a draft: it costs nothing, sends nobody, and expires on Gophr's
     * side. Cancelling it would be tidier and is not worth making a second
     * half-understood call on the unhappy path. */
    const destination = destinationFrom(order);
    const zone = zoneForPostcode(destination.postcode, sameday.zones);

    let verdictForLog = null;

    const result = await bookJob(
      {
        destination,
        parcel: parcelFrom(order),
        earliestPickup: first.pickupIso,
        externalId: orderRef(order),
        reference: order.name || undefined,
        dropoffNotes: first.intent?.label
          ? `Delivery window: ${first.intent.label}`
          : undefined,
      },
      {
        approve: async (draft) => {
          const decided = courierPlan({
            order,
            booking,
            quote: {
              grossAmount:
                draft.job?.price?.gross?.amount ?? draft.job?.price?.amount ?? null,
              bandPrice: zone?.price ?? null,
            },
          });
          verdictForLog = decided;
          return { ok: decided.act === "book", plan: decided };
        },
      }
    );

    /* The draft was made and then not confirmed — too dear, or automatic
     * booking is off. Either way a human decides now. */
    if (result.refused) {
      const decided = verdictForLog;
      const attributes = decided?.attributes || {};
      await writeBack(
        admin,
        order,
        {
          ...attributes,
          /* THE JOB ID FIELD STAYS EMPTY, and the draft's id goes in the NOTE
           * instead. That split is deliberate, not tidiness.
           *
           * `ibc_courier_job_id` means "a rider is coming". It is what
           * existingBooking() reads to decide an order is already handled, so
           * putting a draft's id there would make the webhook treat an
           * unconfirmed job as a booked one and never look at it again — the
           * exact failure the idempotency check exists to prevent.
           *
           * The note is prose for a human, who can open that draft in Gophr,
           * look at the real price and confirm it in one click rather than
           * building the job again by hand. */
          ibc_courier_job_id: null,
          /* THE DRAFT'S LINK, not its id. `private_job_url` comes back on
           * every draft, so the shop gets one click through to the job
           * instead of an id to paste into a portal. The id is kept beside
           * it for when the link is the thing that has gone stale. */
          ibc_courier_job_url: result.draft?.job?.jobUrl || null,
          ibc_courier_note:
            `${attributes.ibc_courier_note || "Not booked."} ` +
            `An unconfirmed draft is waiting in Gophr` +
            `${result.draft?.job?.jobId ? ` (${result.draft.job.jobId})` : ""} — ` +
            `open it and confirm there if you are happy with the price.`,
        },
        ["same-day", "courier-review"]
      );
      log(order.name, "drafted but not confirmed:", decided?.reason, decided?.quotePence);
      return new Response();
    }

    await writeBack(
      admin,
      order,
      bookedAttributes({
        job: result.job,
        quotePence: verdictForLog?.quotePence,
      }),
      ["same-day", "courier-booked"]
    );
    log(order.name, "booked", result.job?.jobId, "at", verdictForLog?.quotePence, "pence");
    return new Response();
  } catch (error) {
    const isGophr = error instanceof GophrError;
    log(gid, "failed:", error?.message || error, isGophr ? JSON.stringify(error.body) : "");

    /* A transient failure is worth one more go, for a few minutes. After that
     * the window is gone and a retry is a rider nobody wants. */
    const verdict = retryVerdict({ paidAt: payload?.processed_at || payload?.created_at });

    if (verdict.retry) {
      log(gid, "asking Shopify to retry;", Math.round(verdict.minutes), "minutes old");

      /* SAY WHAT WENT WRONG ON THE ORDER, NOT ONLY IN THE LOGS.
       *
       * A retrying webhook writes nothing and answers 500, so for the first
       * twenty minutes the only record of the failure is a Vercel log line —
       * which nobody is watching at four on a Saturday, and which is a poor
       * place to keep the one sentence explaining why a customer's chocolate
       * is not moving.
       *
       * This writes the NOTE ONLY. No status, so existingBooking() does not
       * treat the order as settled and the retries carry on as intended; if
       * one of them succeeds the note is cleared by bookedAttributes(). It is
       * a running commentary, not a verdict. */
      try {
        const response = await admin.graphql(ORDER_QUERY, { variables: { id: gid } });
        const { data } = await response.json();
        if (data?.order) {
          await writeBack(admin, data.order, {
            ibc_courier_note:
              `Trying to book the courier: ${error?.message || "unknown error"}` +
              `${isGophr && error.body ? ` — ${JSON.stringify(error.body).slice(0, 400)}` : ""}`,
          });
        }
      } catch (noteError) {
        log(gid, "could not leave a note:", noteError?.message || noteError);
      }

      return new Response("retry", { status: 500 });
    }

    /* Give up loudly rather than quietly. Best effort — if this write fails
     * too, the 200 still stops the retry storm and the log carries the detail. */
    try {
      const response = await admin.graphql(ORDER_QUERY, { variables: { id: gid } });
      const { data } = await response.json();
      if (data?.order) {
        await writeBack(
          admin,
          data.order,
          failedAttributes({
            note: `The courier booking failed: ${error?.message || "unknown error"}. Book by hand and contact the customer.`,
          }),
          ["same-day", "courier-review"]
        );
      }
    } catch (writeError) {
      log(gid, "could not even flag it:", writeError?.message || writeError);
    }

    return new Response();
  }
};
