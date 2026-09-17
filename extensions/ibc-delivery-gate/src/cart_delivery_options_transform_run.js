// @ts-check
//
// Which delivery option a customer is allowed to see.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Shopify Basic cannot ask an app for a shipping price at checkout, so the
// same-day courier charge rides in the basket as a line item and local
// delivery itself is set to £0. That arrangement has two holes, and this
// function plugs both:
//
//   1. A customer who did NOT choose same-day, but whose address happens to
//      sit in one of the delivery postcodes, would be offered "Local
//      delivery — Free" and would quite reasonably take it. Free courier
//      delivery on an order that paid for postage. So: no same-day in the
//      basket, no local delivery at checkout.
//
//   2. A customer who DID choose same-day and then changed their address at
//      checkout would pay the price quoted for the old postcode. Quote W1T
//      at £8.95, deliver to SW11 at £15.58. So: the address must still be the
//      one the price was quoted for, or local delivery disappears and they
//      are sent back to the basket.
//
// WHAT THIS FUNCTION CANNOT DO
// ----------------------------
// It cannot change a price. Hide, rename and reorder are the whole of its
// power — which is why the money lives in a line item at all.
//
// Nor can it rename freely: Shopify requires the carrier's own name to
// survive, so the tier is APPENDED to the existing title rather than
// replacing it.

/**
 * @typedef {import("../generated/api").CartDeliveryOptionsTransformRunInput} CartDeliveryOptionsTransformRunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsTransformRunResult} CartDeliveryOptionsTransformRunResult
 */

const NO_CHANGES = { operations: [] };

/* Outward code, the part that decides the zone.
 *
 * A FULL POSTCODE OR AN OUTWARD CODE, BOTH ACCEPTED. The inward half is
 * always exactly three characters, so anything five or longer has one to
 * strip; anything shorter is already an outward code, which is what a
 * customer types when they enter "W1T" rather than "W1T 1JG".
 *
 * Deliberately not a postcode validator. Shopify has already accepted the
 * address by the time this runs, and a function that second-guesses that
 * would be refusing deliveries over a space. */
function outward(raw) {
  const clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean) return "";
  if (clean.length < 5) return clean;
  return clean.slice(0, clean.length - 3);
}

/* Shopify's own name for the local delivery rate. Matched on the title
 * rather than the handle because the handle is generated per rate and would
 * change the day the shop edits a zone — and a gate that silently stops
 * matching is worse than no gate at all. */
function isLocalDelivery(option) {
  return String(option?.title || "").trim().toLowerCase().startsWith("local delivery");
}

/**
 * @param {CartDeliveryOptionsTransformRunInput} input
 * @returns {CartDeliveryOptionsTransformRunResult}
 */
export function cartDeliveryOptionsTransformRun(input) {
  const cart = input?.cart;
  if (!cart) return NO_CHANGES;

  const operations = [];

  const wantsSameday =
    String(cart?.option?.value || "").trim() === "sameday" &&
    String(cart?.method?.value || "").trim() === "delivery";

  const quoted = outward(cart?.quotedPostcode?.value);
  const label = String(cart?.tierLabel?.value || "").trim();

  for (const group of cart?.deliveryGroups || []) {
    const delivering = outward(group?.deliveryAddress?.zip);

    for (const option of group?.deliveryOptions || []) {
      const local = isLocalDelivery(option);

      if (!wantsSameday) {
        /* Local delivery is a £0 rate that exists only to carry a paid
         * courier order. Postage behaves exactly as it always has. */
        if (local) {
          operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
        }
        continue;
      }

      if (!local) {
        /* Postage alongside a courier the customer has already paid for
         * would be charging twice for one parcel. */
        operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
        continue;
      }

      /* THE ADDRESS MUST STILL BE THE ONE WE PRICED.
       *
       * An empty quoted postcode means a basket from before this attribute
       * existed. Those are let through rather than blocked: the booking guard
       * re-quotes the real journey and flags anything it cannot afford, so
       * the money is still protected, and refusing them would break baskets
       * that were already open when this shipped. */
      if (quoted && delivering && quoted !== delivering) {
        operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
        continue;
      }

      /* It stays, and it says what was bought. "Local delivery — Free" is
       * true of the rate and false of the transaction.
       *
       * APPENDED, not replaced: Shopify prohibits renaming a delivery option
       * in a way that drops the carrier's own name, so the original title
       * stays at the front. */
      if (label) {
        operations.push({
          deliveryOptionRename: {
            deliveryOptionHandle: option.handle,
            title: `${String(option.title || "Local delivery").trim()} — ${label}`,
          },
        });
      }
    }
  }

  return operations.length ? { operations } : NO_CHANGES;
}
