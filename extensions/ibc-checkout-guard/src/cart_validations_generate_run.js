// @ts-check
//
// The last thing between a same-day basket and a paid order.
//
// WHY A SECOND LAYER
// ------------------
// The delivery gate already hides local delivery when the address is not the
// one the price was quoted for, so a mismatched order should be impossible to
// place. "Should be" is doing a lot of work in that sentence: express
// checkouts — Shop Pay, PayPal, Apple Pay, Google Pay — take a different
// route through checkout, and a hidden option is not the same as a refused
// order.
//
// It is also the difference between a customer who is stuck and a customer
// who knows why. Hiding an option answers nothing; this says, in words, that
// the postcode changed and what to do about it.
//
// WHAT IT REFUSES
// ---------------
//   · a same-day basket whose delivery address is not the postcode quoted
//   · a same-day basket with no window, no deadline or no price
//   · a same-day basket with no courier charge in it, or the wrong one
//
// The last one matters most. The charge is an ordinary line item, and an
// ordinary line item can be deleted from the basket — which would otherwise
// buy a £16 courier for nothing.

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/* The ladder product. A handle rather than an id: ids are shop-specific and
 * would have to be hard-coded, and a handle survives the product being
 * rebuilt. */
const LADDER_HANDLE = "ibc-same-day-delivery";

/* Outward code, the part that decides the zone.
 *
 * A FULL POSTCODE OR AN OUTWARD CODE, BOTH ACCEPTED. The inward half is
 * always exactly three characters, so anything five or longer has one to
 * strip; anything shorter is already an outward code, which is what a
 * customer types when they enter "W1T" rather than "W1T 1JG". Treating a
 * short one as empty would read as "no postcode recorded" and switch the
 * whole mismatch check off — the basket that most needed catching would be
 * the one that got through. */
function outward(raw) {
  const clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean) return "";
  if (clean.length < 5) return clean;
  return clean.slice(0, clean.length - 3);
}

function value(node) {
  return String(node?.value || "").trim();
}

/** One error, wrapped the way the run target wants it. */
function refuse(message, target) {
  return {
    operations: [
      { validationAdd: { errors: [{ message, target: target || "$.cart" }] } },
    ],
  };
}

const PASS = { operations: [{ validationAdd: { errors: [] } }] };

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const cart = input?.cart;

  /* ONLY AT CHECKOUT. NOT WHILE THE BASKET IS BEING FILLED IN.
   *
   * A validation function runs on every cart write, not only at checkout,
   * and its errors block the write. Choosing "same-day delivery" is the
   * FIRST of several writes — the method and option land before a time has
   * been picked, because the customer has not been shown the times yet — so
   * enforcing here refused the very write that starts the process. The
   * basket answered "Sorry, that could not be saved", and no tier could ever
   * be chosen, which made the option impossible to select at all.
   *
   * CART_INTERACTION is the step where the customer is still deciding.
   * Everything below is a question about a finished basket, so it waits
   * until checkout — which is also the only moment the delivery address
   * exists to be compared against. */
  if (String(input?.buyerJourney?.step || "") === "CART_INTERACTION") return PASS;

  const sameday =
    value(cart?.option) === "sameday" && value(cart?.method) === "delivery";

  /* Not a same-day order. Nothing here applies, and a validation function
   * with an opinion about ordinary orders is a validation function that
   * breaks ordinary orders. */
  if (!sameday) return PASS;

  const label = value(cart?.label);
  const deadline = value(cart?.deadline);
  const pricePence = Number(value(cart?.pricePence));

  if (!label || !deadline || !Number.isFinite(pricePence) || pricePence <= 0) {
    /* Returned immediately. Every check below reads one of the values just
     * found missing, and three errors describing one cause is three times
     * the confusion. */
    return refuse(
      "Your same-day delivery time is missing. Go back to your basket and choose when you would like it."
    );
  }

  /* ---- the courier charge is actually in the basket ------------------- */
  let paidPence = 0;
  for (const line of cart?.lines || []) {
    const merchandise = line?.merchandise;
    if (merchandise?.__typename !== "ProductVariant") continue;
    if (merchandise?.product?.handle !== LADDER_HANDLE) continue;
    const amount = Number(line?.cost?.totalAmount?.amount);
    if (Number.isFinite(amount)) paidPence += Math.round(amount * 100);
  }

  if (paidPence <= 0) {
    return refuse(
      "The same-day delivery charge is missing from your basket. Go back and choose your delivery time again."
    );
  }

  /* A PENNY EITHER WAY IS FINE, A POUND IS NOT. Rounding between Shopify's
   * decimal amounts and our pence should never drift, but refusing an order
   * over a rounding error would be its own kind of failure. */
  if (Math.abs(paidPence - pricePence) > 1) {
    return refuse(
      "The same-day delivery charge in your basket does not match the time you chose. Go back and choose your delivery time again."
    );
  }

  /* ---- the address is still the one we priced ------------------------- */
  const quoted = outward(cart?.quotedPostcode?.value);

  for (const group of cart?.deliveryGroups || []) {
    const delivering = outward(group?.deliveryAddress?.zip);
    /* No address yet — the customer has not got that far. Not an error. */
    if (!delivering) continue;
    /* No quoted postcode means a basket from before this existed. The booking
     * guard re-quotes the real journey and flags what it cannot afford, so
     * the money is protected; blocking these would strand baskets that were
     * open when this shipped. */
    if (!quoted) continue;

    if (quoted !== delivering) {
      return refuse(
        `Your same-day price was quoted for ${quoted}, but this address is ${delivering}. ` +
          "Go back to your basket and check the new postcode.",
        "$.cart.deliveryGroups"
      );
    }
  }

  return PASS;
}
