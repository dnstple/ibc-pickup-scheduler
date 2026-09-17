// The price ladder — turning a live Gophr quote into a price a customer pays.
//
// WHY A LADDER AND NOT THE QUOTE ITSELF
// -------------------------------------
// Shopify Basic cannot ask an app for a shipping price at checkout; that is
// the Carrier Service API and it starts at Advanced. So the delivery charge
// has to arrive in the basket as an ordinary line item, and a line item's
// price comes from a variant, and a variant's price is fixed when it is
// created. One variant per price point is therefore the only way to charge a
// live figure on this plan — hence a ladder of them.
//
// WHY THE RUNG BELOW, NOT THE NEAREST
// -----------------------------------
// The shop does not want to make money on delivery, and is willing to lose up
// to £5 an order. So the rule is the largest rung STRICTLY BELOW the quote:
// the customer always pays less than the courier costs, never more, and never
// exactly. A quote of £9.42 charges £8.95 and the shop absorbs 47p.
//
// "Strictly" matters. Rounding to the nearest rung would sometimes charge a
// penny over cost, and a delivery that occasionally turns a profit is a
// delivery that has to be explained. Rounding down to the rung at or below
// would charge exactly cost when a quote landed on £9.95 — true to the number
// and false to the instruction, which was "the rate below the one we receive".
//
// WHAT IT COSTS: the loss is between 1p and £1.00 per order, averaging about
// 50p. Against a stated tolerance of £5 that leaves the tolerance free to do
// its real job — absorbing the surge on a wet Friday — rather than being
// spent on rounding.

/** The step between rungs, in pence. */
export const RUNG_STEP_PENCE = 100;

/** Every rung ends in 95, because a price ending in 95 reads as a price. */
export const RUNG_ENDING_PENCE = 95;

/** The cheapest rung. Below this we are giving delivery away, which is a
 *  decision for a person, not for a rounding rule. */
export const LADDER_FLOOR_PENCE = 495;

/** The dearest rung. A quote above this is not a price to put in front of a
 *  customer without a human looking at it first — see ladderPrice()'s `capped`.
 *
 *  RAISED FROM £34.95 after a live basket to Chiswick came back with TWO
 *  tiers both reading £34.95. Two different deadlines cannot cost the same to
 *  the penny: it was the ceiling showing through, on quotes of £36 and more,
 *  and the shop would have absorbed the difference without ever seeing it.
 *  W4 is seven miles out where the measured zone was three. */
export const LADDER_CEILING_PENCE = 4995;

/**
 * Every rung, cheapest first, in pence.
 *
 * Generated rather than typed. A hand-written list of thirty-one prices is a
 * list with a typo in it, and the typo is invisible until a customer is
 * charged £18.59.
 */
export function ladderRungs({
  floorPence = LADDER_FLOOR_PENCE,
  ceilingPence = LADDER_CEILING_PENCE,
  stepPence = RUNG_STEP_PENCE,
} = {}) {
  const rungs = [];
  for (let p = floorPence; p <= ceilingPence; p += stepPence) rungs.push(p);
  return rungs;
}

/**
 * The price to charge for a quote.
 *
 * Returns { pence, quotePence, lossPence, floored, capped, rung } where
 * `rung` is the ladder index — which is what the basket needs to pick the
 * right variant — and `lossPence` is what the shop absorbs on this order.
 *
 * A quote that is missing or nonsense returns pence: null rather than a
 * guess. A basket that cannot be priced must say so; it must never quietly
 * charge the floor.
 */
export function ladderPrice(quotePence, options = {}) {
  const rungs = ladderRungs(options);
  const quote = Number(quotePence);

  if (!Number.isFinite(quote) || quote <= 0) {
    return { pence: null, quotePence: null, lossPence: null, floored: false, capped: false, rung: -1, reason: "no_quote" };
  }

  /* STRICTLY BELOW. The whole point: the customer pays less than the courier
   * costs, always, including when the quote lands exactly on a rung. */
  let index = -1;
  for (let i = 0; i < rungs.length; i += 1) {
    if (rungs[i] < quote) index = i;
    else break;
  }

  if (index === -1) {
    /* Cheaper than the cheapest rung. Charge the floor, which is ABOVE the
     * quote — the one case where the customer pays more than cost, and it
     * exists because a 90p delivery charge looks like a mistake. */
    return {
      pence: rungs[0],
      quotePence: quote,
      lossPence: quote - rungs[0],
      floored: true,
      capped: false,
      rung: 0,
      reason: null,
    };
  }

  const capped = index === rungs.length - 1 && quote > rungs[rungs.length - 1] + RUNG_STEP_PENCE;

  return {
    pence: rungs[index],
    quotePence: quote,
    lossPence: quote - rungs[index],
    floored: false,
    /* CAPPED means the quote ran off the top of the ladder and the loss is
     * bigger than a rung. The basket may still show it; the booking guard is
     * what decides whether to dispatch. Two different jobs, deliberately
     * kept apart — a price the customer can see is not the same as a price
     * the shop will pay. */
    capped,
    rung: index,
    reason: null,
  };
}

/** Pence to the string a variant is priced at: 895 -> "8.95". */
export function rungPrice(pence) {
  const n = Number(pence);
  if (!Number.isFinite(n)) return null;
  return (n / 100).toFixed(2);
}

/** "£8.95", for anything a customer reads. */
export function rungLabel(pence) {
  const price = rungPrice(pence);
  return price === null ? "" : `£${price}`;
}

/**
 * The variant SKU for a rung.
 *
 * Deterministic, so the basket can find the variant it needs without holding
 * a map of thirty-one Shopify ids, and so the ladder can be rebuilt in the
 * admin without anything in the theme changing. IBC-DEL-0895 is £8.95.
 */
export function rungSku(pence) {
  const n = Number(pence);
  if (!Number.isFinite(n)) return null;
  return `IBC-DEL-${String(Math.round(n)).padStart(4, "0")}`;
}

/**
 * The whole ladder as the admin needs to create it.
 *
 * This is what builds the CSV that makes the product, so the prices in the
 * shop and the prices in this file cannot disagree — there is only one list.
 */
export function ladderVariants(options = {}) {
  return ladderRungs(options).map((pence) => ({
    pence,
    price: rungPrice(pence),
    sku: rungSku(pence),
    title: rungLabel(pence),
  }));
}

/**
 * What the shop is giving away, across a set of orders.
 *
 * Exists so the subsidy is a number somebody can look at rather than a
 * feeling. Takes the ladder results, returns pence.
 */
export function subsidyTotal(results) {
  return (Array.isArray(results) ? results : [])
    .map((r) => Number(r?.lossPence))
    .filter((n) => Number.isFinite(n))
    .reduce((total, n) => total + n, 0);
}
