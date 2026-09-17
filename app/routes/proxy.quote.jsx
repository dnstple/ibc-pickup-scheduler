// Live same-day prices for the basket.
//
//   POST /apps/ibc-pickup/quote      (storefront, signed by Shopify)
//
// Answers one question: given this postcode and this basket, what are the
// delivery choices and what does each one cost? Four live Gophr quotes, one
// per tier, each rounded DOWN to the ladder rung below so the customer always
// pays a little less than the courier does.
//
// NOTHING IS TRUSTED FROM THE BASKET.
// -----------------------------------
// The theme sends product and variant ids. Weights and cake-ness are read
// back from Shopify, because both change the price we pay: a basket that
// under-declared its weight would quote as a small parcel and arrive as a
// cake on a pushbike, which has already happened once on this integration and
// is not happening twice. The client's own numbers are ignored entirely.
//
// The postcode is the exception — it is the customer's to state, and it is
// checked against the zone list rather than believed.

import { authenticate } from "../shopify.server";
import { loadSettings } from "../lib/settings.server";
import { zoneForPostcode, outwardCode } from "../lib/sameday";
import { tiersFor, cakeNotice, DEFAULT_TIER_SETTINGS } from "../lib/tiers";
import { priceTiers } from "../lib/quote-tiers.server";
import { pickupTime } from "../lib/courier-booking";
import { zonedParts, timeToMinutes } from "../lib/timezone";

const TZ = "Europe/London";

/* The collection that decides what needs an extra hour. A handle rather than
 * an id: ids are shop-specific and would have to be hard-coded, and the
 * standing rule on this build is that nothing store-specific gets baked into
 * code when a handle will resolve it. */
const CAKE_COLLECTION_HANDLE = "cakes";

const BASKET_QUERY = `
  query BasketWeightAndCakes($ids: [ID!]!, $cakes: ID!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        weight: inventoryItem { measurement { weight { value unit } } }
        product {
          id
          inCakes: inCollection(id: $cakes)
        }
      }
    }
  }
`;

const CAKE_COLLECTION_QUERY = `
  query CakeCollection($handle: String!) {
    collectionByIdentifier(identifier: { handle: $handle }) { id }
  }
`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** Grams, whatever unit Shopify holds the weight in. */
function toGrams(measurement) {
  const value = Number(measurement?.value);
  if (!Number.isFinite(value)) return 0;
  switch (String(measurement?.unit || "").toUpperCase()) {
    case "KILOGRAMS": return value * 1000;
    case "GRAMS": return value;
    case "POUNDS": return value * 453.59237;
    case "OUNCES": return value * 28.349523125;
    default: return 0;
  }
}

export const loader = async ({ request }) => {
  await authenticate.public.appProxy(request);
  return json({ ok: true, endpoint: "quote" });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) return json({ error: "app_not_installed" }, 503);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }

  const postcode = String(payload?.postcode || "").trim();
  if (!outwardCode(postcode)) {
    return json({ ok: false, reason: "bad_postcode" });
  }

  const { settings } = await loadSettings(admin);
  const sameday = settings?.sameday || {};

  if (sameday.enabled !== true) {
    /* Off is off. The theme should not have asked, but a stale page can, and
     * answering with prices would put same-day in front of a customer the
     * shop has switched it away from. */
    return json({ ok: false, reason: "sameday_off" });
  }

  const zone = zoneForPostcode(postcode, sameday.zones);
  if (!zone) {
    return json({ ok: false, reason: "out_of_area", message: sameday.out_of_area || "" });
  }

  /* ---------------------------------------------------------------- basket */
  const rawItems = Array.isArray(payload?.items) ? payload.items.slice(0, 100) : [];
  const variantIds = [
    ...new Set(
      rawItems
        .map((i) => String(i?.variant_id || "").replace(/\D/g, ""))
        .filter(Boolean)
        .map((id) => `gid://shopify/ProductVariant/${id}`)
    ),
  ];

  let contentsGrams = 0;
  let hasWholeCake = false;

  if (variantIds.length) {
    let cakeCollectionId = null;
    try {
      const response = await admin.graphql(CAKE_COLLECTION_QUERY, {
        variables: { handle: CAKE_COLLECTION_HANDLE },
      });
      const { data } = await response.json();
      cakeCollectionId = data?.collectionByIdentifier?.id || null;
    } catch {
      cakeCollectionId = null;
    }

    if (cakeCollectionId) {
      const response = await admin.graphql(BASKET_QUERY, {
        variables: { ids: variantIds, cakes: cakeCollectionId },
      });
      const { data } = await response.json();
      const byId = new Map(
        (data?.nodes || []).filter(Boolean).map((node) => [node.id, node])
      );

      for (const item of rawItems) {
        const gid = `gid://shopify/ProductVariant/${String(item?.variant_id || "").replace(/\D/g, "")}`;
        const node = byId.get(gid);
        if (!node) continue;
        const quantity = Math.max(1, Math.min(Number(item?.quantity) || 1, 100));
        contentsGrams += toGrams(node.weight?.measurement?.weight) * quantity;
        if (node.product?.inCakes) hasWholeCake = true;
      }
    }
  }

  /* ----------------------------------------------------------------- clock */
  const now = new Date();
  const parts = zonedParts(now, TZ);
  const nowMinutes = parts.hour * 60 + parts.minute;

  /* timeToMinutes answers null OR NaN depending on what it was handed, and a
   * NaN cut-off would compare false against everything and quietly keep
   * same-day open all night. Checked rather than trusted. */
  const minutesOr = (value, fallback) => {
    const n = Number(timeToMinutes(value));
    return Number.isFinite(n) ? n : fallback;
  };

  const tierSettings = {
    ...DEFAULT_TIER_SETTINGS,
    /* The shop's own two boundaries, not a second copy of them. A cut-off
     * edited in the app must move the tiles the same afternoon. */
    cutoff_minutes: minutesOr(sameday.cutoff_time, DEFAULT_TIER_SETTINGS.cutoff_minutes),
    day_end_minutes: minutesOr(sameday.day_end, DEFAULT_TIER_SETTINGS.day_end_minutes),
    ...(settings?.tiers || {}),
  };

  const { tiers, prepMinutes, reason } = tiersFor({
    nowMinutes,
    hasWholeCake,
    settings: tierSettings,
  });

  if (!tiers.length) {
    return json({
      ok: false,
      reason: reason || "no_windows",
      zone: { id: zone.id, name: zone.name },
      has_whole_cake: hasWholeCake,
    });
  }

  /* WHEN THE RIDER IS ASKED FOR. Preparation decides it, not the deadline —
   * a cake that needs seventy-five minutes must not have a rider arriving in
   * twenty to stand in the shop. */
  const pickup = pickupTime({
    windowStart: new Date(now.getTime() + prepMinutes * 60 * 1000).toISOString(),
    settings: { ...(settings?.booking || {}), pickup_offset_minutes: 0 },
    now,
  });

  const priced = await priceTiers({
    tiers,
    postcode,
    contentsGrams,
    settings,
    dayStart: now,
    pickupIso: pickup?.iso || null,
    now: Date.now(),
  });

  if (priced.allFailed) {
    /* Gophr is unreachable. Same-day disappears rather than showing a made-up
     * number: a price we cannot honour is worse than no option at all. */
    return json({ ok: false, reason: "no_courier_prices" });
  }

  return json({
    ok: true,
    zone: { id: zone.id, name: zone.name },
    postcode,
    has_whole_cake: hasWholeCake,
    cake_notice: hasWholeCake ? cakeNotice(tiers, tierSettings) : "",
    prep_minutes: prepMinutes,
    grams: Math.round(priced.grams),
    tiers: priced.tiers
      .filter((t) => !t.unavailable)
      .map((t) => ({
        id: t.id,
        name: t.name,
        label: t.label,
        blurb: t.blurb,
        deadline_minutes: t.deadlineMinutes,
        deadline_iso: t.deadlineIso || null,
        price_pence: t.pricePence,
        price_label: t.priceLabel,
        open_ended: Boolean(t.openEnded),
      })),
    generated_at: new Date().toISOString(),
  });
};
