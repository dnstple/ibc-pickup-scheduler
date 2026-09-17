// Pricing the tiles a customer sees — four live Gophr quotes, one per tier.
//
// WHY FOUR QUOTES AND NOT ONE
// ---------------------------
// Gophr prices the deadline. A tier IS a deadline. So "Express" and
// "Standard" are not one price with a surcharge bolted on, they are two
// different questions with two different answers, and the only honest way to
// show them is to ask both. Asking once and adding a made-up premium would
// mean the shop's arithmetic and Gophr's invoice disagreeing, which is
// exactly the failure the price guard exists to catch — better not to create
// it in the first place.
//
// WHY IT IS CACHED
// ----------------
// Four calls per postcode typed is four calls per keystroke-and-a-half if
// somebody backspaces. The cache is keyed on the things that actually change
// the price — where, how heavy, how urgent — and nothing else, so two
// customers in the same postcode with the same basket share one answer.
//
// It lives in memory, deliberately. The database in this app holds sessions
// and nothing else; bookings, orders and customers are Shopify's, and a quote
// is a guess with a short shelf life rather than a record of anything. A cold
// Vercel instance simply asks Gophr again.
//
// WHAT HAPPENS WHEN GOPHR IS DOWN
// -------------------------------
// The tier is returned with `price: null` and a reason. The basket then shows
// same-day as unavailable rather than showing a price nobody can honour. A
// courier integration that guesses a price when its supplier is unreachable
// is a courier integration that loses money quietly.

import { quote, parcelFor, GophrError } from "./gophr.server";
import { ladderPrice } from "./ladder";
import { deadlineInstant } from "./tiers";
import { gophrInstant, packedGrams } from "./courier-booking";

/** How long a quote is worth reusing. Short, because Gophr surges. */
export const QUOTE_TTL_MS = 5 * 60 * 1000;

/** Above this many grams a basket travels as a cake-sized parcel. Same
 *  threshold the booking path uses, so the quote and the job agree. */
export const BULKY_GRAMS = 1500;

const cache = new Map();

function cacheKey({ postcode, grams, perishable, deadlineIso, pickupIso }) {
  return [postcode, grams, perishable ? "b" : "s", deadlineIso || "-", pickupIso || "-"].join("|");
}

/** Drop everything stale. Called on every read, which is enough for a map
 *  that only ever holds a few hundred postcodes. */
function sweep(now) {
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }
}

export function clearQuoteCache() {
  cache.clear();
}

/**
 * Price one tier.
 *
 * Returns the tier with `quotePence`, `pricePence`, `priceLabel` and
 * `lossPence` added, or with `unavailable` set and a reason. Never throws:
 * one tier failing must not take the other three down with it.
 */
async function priceTier({ tier, destination, grams, perishable, dayStart, pickupIso, now }) {
  /* THE DEADLINE AS A REAL INSTANT, IN LONDON.
   *
   * Supplied by the caller wherever possible, because only the caller knows
   * the shop's date, and "6pm" is a question about London rather than about
   * the server. Vercel runs in UTC: computing it here from the machine's own
   * midnight put every deadline an hour out through British Summer Time,
   * which is a wrong price at best and a refused quote at worst. */
  const deadlineIso = tier.deadlineIso
    ? tier.deadlineIso
    : (() => {
        const fallback = deadlineInstant(dayStart, tier.deadlineMinutes);
        return fallback ? gophrInstant(fallback) : null;
      })();

  const key = cacheKey({ postcode: destination.postcode, grams, perishable, deadlineIso, pickupIso });
  sweep(now);
  const hit = cache.get(key);
  if (hit) return { ...tier, ...hit.value, cached: true };

  let quotePence = null;
  let failure = null;
  try {
    const result = await quote({
      destination,
      parcel: parcelFor({ grams, perishable, id: `ibc-quote-${tier.id}` }),
      earliestPickup: pickupIso,
      dropoffDeadline: deadlineIso,
    });
    /* GROSS, not net. Gross is what Gophr bills, and a price shown to a
     * customer that quietly excluded VAT would be under by a fifth. */
    const amount = result.price?.gross?.amount ?? result.price?.amount ?? null;
    quotePence = Number.isFinite(Number(amount)) ? Math.round(Number(amount) * 100) : null;
  } catch (error) {
    failure = error instanceof GophrError ? error.message : String(error?.message || error);
  }

  if (quotePence === null) {
    /* NOT CACHED. A failure is usually transient — a timeout, a cold start,
     * a moment of Gophr being Gophr — and caching it would keep same-day
     * switched off for five minutes after it came back. */
    return { ...tier, unavailable: true, reason: failure || "no_price", deadlineIso };
  }

  const ladder = ladderPrice(quotePence);
  const value = {
    quotePence,
    pricePence: ladder.pence,
    priceLabel: ladder.pence === null ? null : `£${(ladder.pence / 100).toFixed(2)}`,
    lossPence: ladder.lossPence,
    rung: ladder.rung,
    capped: ladder.capped,
    floored: ladder.floored,
    deadlineIso,
  };

  cache.set(key, { value, expires: now + QUOTE_TTL_MS });
  return { ...tier, ...value, cached: false };
}

/**
 * Price every tier for one basket and one postcode.
 *
 * SEQUENTIAL, not parallel. Four requests is nothing, and firing them at once
 * at an integration whose rate limits nobody has documented is how the whole
 * basket breaks on the first busy Saturday rather than on a quiet Tuesday
 * where somebody would notice.
 */
export async function priceTiers({
  tiers,
  postcode,
  address1 = "",
  contentsGrams,
  settings,
  dayStart = new Date(),
  pickupIso = null,
  now = Date.now(),
}) {
  /* GOPHR WANTS A STREET LINE, and at basket time nobody has typed one — the
   * customer has given a postcode and nothing else. Sending an empty string
   * is sending a field Gophr has to reject or guess at, so the postcode goes
   * in both places: it is the truest thing we know about where this is
   * going, and it is what Gophr geocodes from anyway. */
  const clean = String(postcode || "").trim();
  const destination = { postcode: clean, address1: address1 || clean, city: "London" };
  /* PACKED weight, not the contents' weight. The box, the ribbon and the ice
   * pack are what the rider actually carries, and the booking path already
   * adds them — a quote that left them out would be cheaper than the job. */
  const grams = packedGrams(contentsGrams, settings?.booking);
  const perishable = grams >= BULKY_GRAMS;

  const priced = [];
  for (const tier of tiers) {
    /* eslint-disable no-await-in-loop -- sequential on purpose, see above */
    priced.push(
      await priceTier({ tier, destination, grams, perishable, dayStart, pickupIso, now })
    );
  }

  return {
    tiers: priced,
    grams,
    perishable,
    /* Every tier failing is a different thing from one tier failing: the
     * first means Gophr is unreachable and same-day should disappear, the
     * second means one deadline could not be priced and the others stand. */
    allFailed: priced.length > 0 && priced.every((t) => t.unavailable),
  };
}
