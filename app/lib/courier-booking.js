// Deciding whether an order needs a courier, whether the quote is acceptable,
// and what to write back onto the order. NO I/O — the same pattern as
// availability.js and order-booking.js, so every rule here is unit-testable
// without a Gophr key or a Shopify session.
//
// The I/O lives in two places and only two:
//   app/lib/gophr.server.js          talks to Gophr
//   app/routes/webhooks.orders.paid  talks to Shopify
//
// WHY A SEPARATE FILE FROM order-booking.js. That one is about collection
// slots chosen after payment. This is about couriers booked after payment.
// They share nothing but the word "booking", and merging them would put the
// kitchen's rules and a courier's rules in one place where a change to either
// can break the other.

import { attributesToObject } from "./order-booking.js";
import { zonedParts } from "./timezone.js";

/* ------------------------------------------------------------------ keys */

/* The attributes the PICKER writes, which this module only ever reads. */
export const SAMEDAY_READ_KEYS = [
  "delivery_method",
  "delivery_option",
  "delivery_date",
  "delivery_label",
  "delivery_window_start",
  "delivery_window_end",
  /* THE TIER, ADDED RATHER THAN SUBSTITUTED.
   *
   * The two window keys go on meaning exactly what they always meant, so
   * every order already placed still reads correctly and nothing downstream
   * had to be taught a new word. These four are the tier's own facts: which
   * one was bought, the deadline it promises, when the basket is ready to
   * leave, and what the customer actually paid for it. */
  "delivery_tier",
  "delivery_deadline",
  "delivery_ready_at",
  "delivery_price_pence",
];

/* The attributes THIS module writes. Prefixed `ibc_courier_` to sit beside
 * `ibc_pickup_` rather than inside it: an order is one or the other, never
 * both, and a shared prefix would invite code that assumes otherwise. */
export const COURIER_WRITE_KEYS = [
  "ibc_courier_status",
  "ibc_courier_job_id",
  "ibc_courier_delivery_id",
  "ibc_courier_tracking_url",
  "ibc_courier_job_url",
  "ibc_courier_quote_pence",
  "ibc_courier_booked_at",
  "ibc_courier_note",
];

/* Statuses. A small closed set, because the admin reads these and a typo
 * would show as a blank column rather than an error. */
export const STATUS = {
  BOOKED: "booked",
  REVIEW: "needs_review",
  FAILED: "failed",
};

/* ------------------------------------------------------------------ settings */

export const DEFAULT_BOOKING = {
  /* OFF BY DEFAULT, AND THAT IS THE POINT.
   *
   * With this false the webhook still runs, still quotes, and still writes the
   * quote onto the order — it simply does not book. Every same-day order lands
   * as `needs_review` with the real Gophr price attached, so the shop can book
   * by hand for a week and compare what it WOULD have paid against what the
   * customer was charged, before letting anything book itself.
   *
   * Turning this on is a deliberate act, taken with a fortnight of real prices
   * to look at. It is not a default anybody should inherit. */
  auto_book: false,

  /* THE CIRCUIT BREAKER. Above this, the job is flagged rather than booked.
   *
   * Three numbers rather than one because one is wrong at both ends. A plain
   * multiple is too tight on a cheap band (a 60p rounding difference trips
   * 1.6× on a £1 job that does not exist) and too loose on an expensive one
   * (1.6× of £19.95 is £31.92, which is not a price anyone wants to discover
   * afterwards). So: a multiple, a flat headroom that always allows a little
   * slack, and a hard ceiling that nothing passes. */
  ceiling_multiple: 1.6,
  headroom_pence: 500,
  /* £25, AND THE NUMBER IS LOAD-BEARING.
   *
   * The first draft of this said £40, which is a safety net with a hole the
   * size of the thing it was catching: 1.6 × the dearest band (£19.95) is
   * £31.92, so a £40 ceiling could never bite on any zone the shop actually
   * sells. It looked like protection and was decoration. A test asserting it
   * beat the multiple failed, which is how it was found.
   *
   * £25 bites where it should. Against Zone A (£12.95) the multiple is
   * tighter and binds first; against Zone C (£19.95) the multiple would allow
   * £31.92 and this stops it at £25 — a £5 loss the shop can absorb, where
   * £32 is one it would rather be asked about. */
  ceiling_pence: 2500,

  /* HOW LONG BEFORE THE WINDOW OPENS THE RIDER IS ASKED FOR.
   *
   * The window the customer chose is when the chocolate should ARRIVE. The
   * rider has to collect before that. This is the gap, and it is a setting
   * rather than a constant because the right number is a fact about the shop's
   * kitchen and the traffic outside it, neither of which this file knows. */
  pickup_offset_minutes: 30,

  /* A same-day order whose window has already passed by the time the webhook
   * runs is not bookable, however good the price. Payment delays, a retried
   * webhook and a customer who left the tab open all produce one. */
  grace_minutes: 15,

  /* PACKAGING, WHICH SHOPIFY DOES NOT KNOW ABOUT.
   *
   * `order.totalWeight` is the sum of the product weights and nothing else.
   * The box, the padding, the ribbon and the ice pack in July all weigh
   * something, and the courier carries them too. Under-declaring means Gophr
   * chooses a vehicle for a lighter parcel than the one the rider is handed.
   *
   * TWO NUMBERS, BECAUSE ONE IS WRONG AT BOTH ENDS. A percentage alone
   * under-counts a single slice — a 220g slice in a box is nearer 370g, which
   * is 68%, not 10% — while a flat weight alone over-counts a big order that
   * is mostly its own contents. So: a fixed weight for the packaging itself,
   * plus a percentage for padding that scales with what is being padded. */
  packaging_grams: 150,
  packaging_percent: 10,

  /* WHERE THE COURIER COLLECTS.
   *
   * These were a hard-coded constant in gophr.server.js, under a comment
   * promising to move them into settings "in the next increment". They did
   * not move, and a shop address living in code is a shop address that is
   * wrong the day anybody moves, opens a second counter, or sends a courier
   * to a kitchen rather than a shop front.
   *
   * Note this is the SAME PLACE as the collection point customers walk to,
   * spelled separately. If the shop moves, both need changing — which is a
   * worse arrangement than one copy, and a better one than a copy in code. */
  pickup_name: "Italian Bear Chocolate",
  pickup_address1: "29 Rathbone Place",
  pickup_city: "London",
  pickup_postcode: "W1T 1JG",
};

export function normalizeBooking(raw) {
  const b = { ...DEFAULT_BOOKING, ...(raw && typeof raw === "object" ? raw : {}) };

  b.auto_book = b.auto_book === true;

  const rawMultiple = b.ceiling_multiple;
  const multiple = rawMultiple === null || rawMultiple === undefined || rawMultiple === ""
    ? NaN
    : Number(rawMultiple);
  b.ceiling_multiple = Number.isFinite(multiple) && multiple > 0
    ? multiple
    : DEFAULT_BOOKING.ceiling_multiple;

  /* `Number(null)` IS 0, AND 0 IS FINITE. So a null ceiling read as a ceiling
   * of zero pence — every job over free flagged — rather than falling back to
   * the default. Same for `undefined` via `Number(undefined)`? No: that is
   * NaN and would have fallen back. It is null, "" and [] that lie, and they
   * are exactly what a half-saved settings blob contains. Absence is tested
   * for first, before the number is read. */
  for (const key of [
    "headroom_pence", "ceiling_pence", "pickup_offset_minutes", "grace_minutes",
    "packaging_grams", "packaging_percent",
  ]) {
    const raw = b[key];
    const absent = raw === null || raw === undefined || raw === "";
    const n = absent ? NaN : Number(raw);
    b[key] = Number.isFinite(n) ? Math.floor(n) : DEFAULT_BOOKING[key];
  }

  for (const key of ["pickup_name", "pickup_address1", "pickup_city", "pickup_postcode"]) {
    const value = String(b[key] ?? "").trim();
    b[key] = value || DEFAULT_BOOKING[key];
  }

  return b;
}

export function validateBooking(b) {
  const errors = {};

  if (!(Number(b.ceiling_multiple) >= 1)) {
    errors["booking.ceiling_multiple"] =
      "Enter 1 or more. Below 1 would flag every job, including the cheap ones.";
  }
  if (!Number.isInteger(b.ceiling_pence) || b.ceiling_pence < 100) {
    errors["booking.ceiling_pence"] = "Enter a hard ceiling of at least £1.";
  }
  if (!Number.isInteger(b.headroom_pence) || b.headroom_pence < 0) {
    errors["booking.headroom_pence"] = "Enter 0 or more.";
  }
  if (!Number.isInteger(b.pickup_offset_minutes) ||
      b.pickup_offset_minutes < 0 || b.pickup_offset_minutes > 240) {
    errors["booking.pickup_offset_minutes"] =
      "Enter between 0 and 240 minutes before the delivery window opens.";
  }
  if (!Number.isInteger(b.grace_minutes) || b.grace_minutes < 0 || b.grace_minutes > 240) {
    errors["booking.grace_minutes"] = "Enter between 0 and 240 minutes.";
  }
  if (!Number.isInteger(b.packaging_grams) || b.packaging_grams < 0 || b.packaging_grams > 5000) {
    errors["booking.packaging_grams"] = "Enter between 0 and 5000 grams.";
  }
  if (!Number.isInteger(b.packaging_percent) ||
      b.packaging_percent < 0 || b.packaging_percent > 100) {
    errors["booking.packaging_percent"] = "Enter between 0 and 100 per cent.";
  }
  /* A postcode is the one field a courier genuinely cannot work without. */
  if (!String(b.pickup_postcode || "").trim()) {
    errors["booking.pickup_postcode"] =
      "The courier needs a postcode to collect from.";
  }
  if (!String(b.pickup_address1 || "").trim()) {
    errors["booking.pickup_address1"] = "Enter the street address the courier collects from.";
  }

  /* NOT AN ERROR, BUT WORTH SAYING. A ceiling below the most expensive zone
   * means that zone can never book itself, which looks like a broken
   * integration rather than a setting. */
  return errors;
}

/* ------------------------------------------------------------------ intent */

/**
 * Does this order want a courier, and what did it promise?
 *
 * Deliberately strict. Every reason for saying no is named, because the one
 * question worth being able to answer at 4pm on a Saturday is "why did that
 * order not book" — and "it did not match" is not an answer.
 */
export function courierIntent(order) {
  const attributes = attributesToObject(order?.customAttributes);

  const method = String(attributes.delivery_method || "").trim();
  const option = String(attributes.delivery_option || "").trim();

  if (option !== "sameday") {
    return { wanted: false, reason: "not_sameday", attributes };
  }
  /* A same-day OPTION on a collection order is a stale attribute, not an
   * instruction. The picker clears it, but an order placed mid-change could
   * carry both, and booking a rider to deliver an order somebody is coming to
   * collect is the worst of the available mistakes. */
  if (method !== "delivery") {
    return { wanted: false, reason: "not_delivery", attributes };
  }
  if (order?.cancelledAt) {
    return { wanted: false, reason: "cancelled", attributes };
  }

  const date = String(attributes.delivery_date || "").trim();
  const label = String(attributes.delivery_label || "").trim();
  if (!date || !label) {
    /* The checkout validation function refuses this combination, so reaching
     * here means something wrote the attributes directly. Flagged rather than
     * ignored: a paid same-day order with no window is a customer expecting
     * chocolate today. */
    return { wanted: true, incomplete: true, reason: "no_window", attributes, date, label };
  }

  return {
    wanted: true,
    incomplete: false,
    reason: null,
    attributes,
    date,
    label,
    windowStart: String(attributes.delivery_window_start || "").trim() || null,
    windowEnd: String(attributes.delivery_window_end || "").trim() || null,
    /* THE TIER, WHERE THE ORDER CARRIES ONE.
     *
     * An order placed before tiers existed carries none of these, and must
     * go on booking exactly as it did — hence null rather than a default.
     * The caller decides what to do with the absence; inventing a deadline
     * for an order that never bought one would be inventing a promise. */
    tier: String(attributes.delivery_tier || "").trim() || null,
    deadline: String(attributes.delivery_deadline || "").trim() || null,
    readyAt: String(attributes.delivery_ready_at || "").trim() || null,
    /* ALREADY PENCE. toPence() turns pounds into pence and would have read
     * £11.95 out of "1195" as £1,195.00 — caught by a test that expected the
     * guard to refuse a £17.50 quote and watched it book instead. The name
     * of the attribute is the unit; parse it, do not convert it. */
    pricePence: (() => {
      const raw = String(attributes.delivery_price_pence || "").trim();
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    })(),
  };
}

/**
 * What has already happened to this order.
 *
 * IDEMPOTENCY LIVES ON THE ORDER, not in a table. The app writes no records of
 * its own by design — see prisma/schema.prisma — and an order that already
 * carries a job id has already been booked, whatever this delivery of the
 * webhook believes. Shopify retries `orders/paid`, and a retry that books a
 * second rider costs real money.
 */
export function existingBooking(order) {
  const attributes = attributesToObject(order?.customAttributes);
  const status = String(attributes.ibc_courier_status || "").trim();
  const jobId = String(attributes.ibc_courier_job_id || "").trim();

  return {
    status: status || null,
    jobId: jobId || null,
    /* A job id is proof. A status of `booked` without one is not — it would
     * mean the write half-succeeded, and re-booking is worse than re-checking. */
    alreadyBooked: Boolean(jobId),
    /* `needs_review` and `failed` are both terminal for the WEBHOOK: a human
     * deals with them. Re-running on every retry would re-quote forever. */
    settled: Boolean(jobId) || status === STATUS.REVIEW || status === STATUS.FAILED,
  };
}

/* ------------------------------------------------------------------ weight */

/**
 * What the rider actually picks up, in grams.
 *
 * Shopify's `totalWeight` is the products and nothing else. This adds the
 * packaging: a percentage of the contents for padding, plus a flat weight for
 * the box itself.
 *
 * The floor is deliberate. An order of products with no weights set reads as
 * 0g, and a parcel declared at zero is a parcel Gophr will happily give to a
 * pushbike. Falling back to a sensible default is safer than believing a
 * number that means "nobody filled this in".
 */
export function packedGrams(contentsGrams, settings) {
  const b = normalizeBooking(settings);
  const contents = Number(contentsGrams);
  const real = Number.isFinite(contents) && contents > 0 ? contents : 500;
  return Math.round(real * (1 + b.packaging_percent / 100)) + b.packaging_grams;
}

/* ------------------------------------------------------------------ phones */

/**
 * A UK mobile in the form a courier API can text.
 *
 * `07873989675` and `+447873989675` are the same number, and Gophr accepted
 * both without complaint — which is exactly the problem. A validator that
 * shrugs is not a validator, and the failure this guards against is silent:
 * the job books, the rider goes out, and the customer simply never gets the
 * text. Nothing errors. Nobody finds out until somebody complains that the
 * chocolate arrived unannounced.
 *
 * So the national form is converted rather than trusted. E.164 is what the
 * shop's own number is already set to, so this also stops the two ends of the
 * same job being spelled two different ways.
 *
 * Anything that is not recognisably a UK number is passed through untouched:
 * a wrong guess at an international number would be worse than leaving it
 * alone, and Gophr can refuse it on its own terms.
 */
export function normalizeMobile(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";

  /* Spaces, brackets and dashes are how people type phone numbers and mean
   * nothing to a dialler. A leading + is kept; it is the only punctuation
   * that carries meaning. */
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (!digits) return trimmed;

  if (plus) return `+${digits}`;
  /* 00 is the other way of writing +. */
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  /* 447873989675 — already international, just missing its plus. */
  if (digits.startsWith("44") && digits.length >= 12) return `+${digits}`;
  /* 07873989675 -> +447873989675. Eleven digits starting 07 is the only
   * pattern this converts, because it is the only one it can be sure of. */
  if (digits.startsWith("0") && digits.length === 11) return `+44${digits.slice(1)}`;

  return trimmed;
}

/* ------------------------------------------------------------------ money */

/** "12.95" | 12.95 | "£12.95" -> 1295, or null. */
export function toPence(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Is this quote acceptable?
 *
 * `bandPence` is what the customer was charged — the zone's price. `quotePence`
 * is what Gophr says the job costs, GROSS, because that is what leaves the
 * bank account. Comparing gross to gross was got wrong once already, in the
 * margin figures in the upgrade report, and the mistake is invisible: both
 * numbers look like prices.
 */
export function priceVerdict({ quotePence, bandPence, settings }) {
  const s = normalizeBooking(settings);

  if (!Number.isFinite(quotePence) || quotePence <= 0) {
    return { ok: false, reason: "no_quote", note: "Gophr returned no usable price." };
  }

  if (!Number.isFinite(bandPence) || bandPence <= 0) {
    /* No band to compare against — an order from a zone that has since been
     * renamed or removed. The hard ceiling still applies, because it is the
     * one limit that does not depend on knowing what was charged. */
    if (quotePence > s.ceiling_pence) {
      return {
        ok: false,
        reason: "over_ceiling",
        note: `£${(quotePence / 100).toFixed(2)} is over the £${(s.ceiling_pence / 100).toFixed(2)} ceiling, and the order's zone is no longer configured.`,
      };
    }
    return { ok: true, reason: "no_band", note: "No zone price to compare against." };
  }

  /* TWO LIMITS, AND THE LOWER ONE IS THE REAL ONE.
   *
   * Testing the ceiling first meant a £26 job on a £12.95 band was reported
   * as "over the £25 ceiling" when the informative answer is "more than the
   * £20.72 allowed against a £12.95 charge" — the band comparison is the one
   * that tells the shop about its margin. Testing the band first would get
   * the dear-band case wrong the other way. So both are computed and the
   * binding one is named, which is what a person would say if asked. */
  const byBand = Math.max(
    Math.round(bandPence * s.ceiling_multiple),
    bandPence + s.headroom_pence
  );
  const allowed = Math.min(byBand, s.ceiling_pence);

  if (quotePence > allowed) {
    const ceilingBinds = s.ceiling_pence < byBand;
    return {
      ok: false,
      reason: ceilingBinds ? "over_ceiling" : "over_band",
      note: ceilingBinds
        ? `£${(quotePence / 100).toFixed(2)} is over the hard ceiling of £${(s.ceiling_pence / 100).toFixed(2)}.`
        : `£${(quotePence / 100).toFixed(2)} is more than the £${(allowed / 100).toFixed(2)} allowed against a £${(bandPence / 100).toFixed(2)} charge.`,
    };
  }

  return {
    ok: true,
    reason: null,
    note: `£${(quotePence / 100).toFixed(2)} against £${(bandPence / 100).toFixed(2)} charged.`,
    marginPence: bandPence - quotePence,
  };
}

/* ------------------------------------------------------------------ timing */

/**
 * When to ask for the rider.
 *
 * Returns an ISO string, or null when the window has already gone.
 *
 * `windowStart` is an ISO time the PICKER wrote. It is not parsed out of the
 * human label, and that is deliberate: "3:00–5:00pm" is display text, one of
 * the windows has no time in it at all ("Any time before 9pm"), and a parser
 * that reads prices and dates out of sentences meant for people is a parser
 * that fails in a new locale on a quiet Sunday.
 */
/**
 * An instant in the shape Gophr will accept.
 *
 * `toISOString()` gives `2026-09-15T14:30:00.000Z`, and Gophr refuses it:
 *
 *   object:  pickups.0.earliest_pickup_time
 *   message: The input does not appear to be a valid ISO8601 datetime
 *            e.g. 2022-03-01T13:00:00+00:00
 *
 * Its own example is the specification. Two differences from what JavaScript
 * produces, and the error does not say which one it minds, so both are fixed:
 * the milliseconds go, and `Z` becomes the explicit `+00:00` offset. Both
 * spell the same instant; only one gets through.
 *
 * WHY THE BENCH MISSED THIS. Every successful draft was created with the
 * pickup set to "Right now", which omits `earliest_pickup_time` altogether.
 * The field that broke was the one never sent — a reminder that a green test
 * proves what it exercised and nothing else.
 */
export function gophrInstant(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function pickupTime({ windowStart, settings, now = new Date() }) {
  const s = normalizeBooking(settings);

  if (!windowStart) return { iso: null, reason: "no_window_start" };

  const start = new Date(windowStart);
  if (Number.isNaN(start.getTime())) return { iso: null, reason: "bad_window_start" };

  const nowMs = now.getTime();

  /* The window is over. Grace covers a payment that took a minute and a
   * webhook that took another. */
  if (start.getTime() + s.grace_minutes * 60000 < nowMs) {
    return { iso: null, reason: "window_passed" };
  }

  const wanted = start.getTime() - s.pickup_offset_minutes * 60000;

  /* Never ask for a rider in the past. Gophr would either refuse it or send
   * one immediately, and "immediately" is the one answer the kitchen cannot
   * give. */
  const at = new Date(Math.max(wanted, nowMs));
  return { iso: gophrInstant(at), reason: null };
}

/* ------------------------------------------------------------------ deadline */

/* The shop's clock. "Same day" is a question about London, not about UTC, and
 * at 00:30 BST the two disagree. */
const TZ = "Europe/London";

/**
 * The deadline to give Gophr: the end of the window the customer chose.
 *
 * WHY THIS EXISTS AT ALL. Until now nothing sent a deadline, so Gophr
 * defaulted to the end of the day — a live job booked for a 15:38–16:38
 * window was given until 23:55, and the rider quite properly took other work
 * while the ETA slid. The window was promised in the basket and never passed
 * on to the only party who could keep it.
 *
 * WHY IT IS FREE. Measured, not assumed:
 *
 *     no deadline   £9.42          180 min   £9.42   ← free
 *     60 min       £17.15          240 min   £9.42
 *     90 min       £16.58          300 min   £9.42
 *     120 min      £13.85
 *
 * Gophr prices URGENCY, and past three hours there is none to price. A
 * two-hour window opening ninety minutes after the order ends 210 minutes
 * out, so the ordinary case is always in the free band. Tighter windows cost
 * more and the circuit breaker already judges that on its merits.
 *
 * THE ONE RULE GOPHR ENFORCES, quoted from its own 422:
 *   "Earliest pickup time and delivery deadline must be on the same day."
 *
 * A deadline that breaks it is DROPPED rather than sent. Failing open costs
 * the promise; failing closed costs the whole booking, and a rider with a
 * loose deadline beats no rider at all.
 */
export function deadlineFor({ windowEnd, pickupIso, timeZone = TZ }) {
  if (!windowEnd) return { iso: null, reason: "no_window_end" };

  const end = new Date(windowEnd);
  if (Number.isNaN(end.getTime())) return { iso: null, reason: "bad_window_end" };

  const pickup = pickupIso ? new Date(pickupIso) : null;
  if (!pickup || Number.isNaN(pickup.getTime())) {
    return { iso: null, reason: "no_pickup" };
  }

  /* A deadline before the collection is not a deadline, it is a mistake. */
  if (end.getTime() <= pickup.getTime()) {
    return { iso: null, reason: "ends_before_pickup" };
  }

  if (zonedParts(end, timeZone).dateStr !== zonedParts(pickup, timeZone).dateStr) {
    return { iso: null, reason: "different_day" };
  }

  return { iso: gophrInstant(end), reason: null };
}

/* ------------------------------------------------------------------ writes */

/** What goes onto the order when a job is booked. */
export function bookedAttributes({ job, quotePence, now = new Date() }) {
  return {
    ibc_courier_status: STATUS.BOOKED,
    ibc_courier_job_id: String(job?.jobId ?? ""),
    ibc_courier_delivery_id: job?.deliveryId ? String(job.deliveryId) : null,
    ibc_courier_tracking_url: job?.trackingUrl ? String(job.trackingUrl) : null,
    /* The SHOP'S link into Gophr, as distinct from the customer's tracker.
     * `private_job_url` in Gophr's response. Worth carrying because the
     * question an order raises at 4pm on a Saturday is "where is it", and the
     * answer should be one click from the order rather than a hunt through a
     * portal for an id. */
    ibc_courier_job_url: job?.jobUrl ? String(job.jobUrl) : null,
    ibc_courier_quote_pence: Number.isFinite(quotePence) ? String(quotePence) : null,
    ibc_courier_booked_at: now.toISOString(),
    /* Cleared, not left standing. An order that failed, was fixed and then
     * booked must not keep the sentence explaining why it failed. */
    ibc_courier_note: null,
  };
}

/** What goes onto the order when a human needs to look at it. */
export function reviewAttributes({ note, quotePence, now = new Date() }) {
  return {
    ibc_courier_status: STATUS.REVIEW,
    ibc_courier_quote_pence: Number.isFinite(quotePence) ? String(quotePence) : null,
    ibc_courier_booked_at: now.toISOString(),
    ibc_courier_note: String(note || "Needs a look."),
  };
}

/** What goes onto the order when the attempt itself broke. */
export function failedAttributes({ note, now = new Date() }) {
  return {
    ibc_courier_status: STATUS.FAILED,
    ibc_courier_booked_at: now.toISOString(),
    ibc_courier_note: String(note || "The booking attempt failed."),
  };
}

/* ------------------------------------------------------------------ retries */

/**
 * Gophr did not answer. Ask Shopify to try again, or give up and flag it?
 *
 * Shopify retries `orders/paid` on a non-2xx, up to nineteen times across
 * forty-eight hours. For most webhooks that is a gift. For this one it is a
 * trap: a same-day window has passed long before the later retries, so a job
 * booked on the eighth attempt at two in the morning is worse than no job —
 * it is a rider sent for chocolate nobody is waiting for any more.
 *
 * So the retries are allowed for a few minutes, where they genuinely help
 * with a blip, and then stopped by returning 200 with the order flagged. The
 * shop sees it and rings the customer, which is what should happen anyway.
 */
export function retryVerdict({ paidAt, now = new Date(), maxRetryMinutes = 20 }) {
  const paid = paidAt ? new Date(paidAt) : null;
  if (!paid || Number.isNaN(paid.getTime())) {
    /* No timestamp to reason from. One attempt, then flagged — better than a
     * retry loop nothing can stop. */
    return { retry: false, reason: "no_paid_at" };
  }
  const minutes = (now.getTime() - paid.getTime()) / 60000;
  if (minutes <= maxRetryMinutes) {
    return { retry: true, reason: "within_window", minutes };
  }
  return { retry: false, reason: "too_late_to_retry", minutes };
}

/* ------------------------------------------------------------------ the plan */

/**
 * THE WHOLE DECISION, in one pure function.
 *
 * Everything above is a part of this; this is the part the webhook calls. It
 * takes the order, the settings and the quote, and returns what to do. It
 * performs no I/O, so the webhook's own tests are about plumbing and this
 * function's tests are about policy — which is the split that lets the policy
 * be argued about without a Gophr key.
 *
 * `quote` is null on the first pass: the caller asks `plan()` whether to
 * bother quoting at all, quotes if told to, then asks again with the answer.
 * Two calls rather than a callback, so this file makes no network decisions.
 */
export function courierPlan({ order, booking, quote = null, now = new Date() }) {
  const b = normalizeBooking(booking);
  const intent = courierIntent(order);

  if (!intent.wanted) {
    return { act: "ignore", reason: intent.reason };
  }

  const already = existingBooking(order);
  if (already.settled) {
    return {
      act: "ignore",
      reason: already.alreadyBooked ? "already_booked" : "already_settled",
      jobId: already.jobId,
    };
  }

  if (intent.incomplete) {
    return {
      act: "flag",
      reason: "no_window",
      attributes: reviewAttributes({
        note: "This order is marked same-day but carries no delivery window. Book the courier by hand and contact the customer.",
        now,
      }),
    };
  }

  /* `b`, NOT the caller's whole settings blob. An earlier draft passed the
   * entire scheduler settings object here, which worked only by accident: it
   * has no pickup_offset_minutes or grace_minutes, so every lookup missed and
   * fell back to the defaults. It would have started silently obeying the
   * wrong numbers the day anybody added a top-level key with one of those
   * names. */
  /* WHEN TO ASK FOR THE RIDER.
   *
   * A tier order already knows: delivery_ready_at is the moment the basket
   * can be handed over, and the basket's own preparation — an hour more for
   * a whole cake — is already inside it. So the usual offset is set to zero
   * rather than applied twice; subtracting another thirty minutes would put
   * a rider at the counter while the cake was still being boxed.
   *
   * An older order has only a window, and falls through to the behaviour it
   * was placed under. */
  const readyAt = intent.readyAt || null;
  const when = readyAt
    ? pickupTime({ windowStart: readyAt, settings: { ...b, pickup_offset_minutes: 0 }, now })
    : pickupTime({ windowStart: intent.windowStart, settings: b, now });
  if (!when.iso) {
    const why = when.reason === "window_passed"
      ? `The ${intent.label} window had already passed when this order was paid.`
      : "This order's delivery window could not be read as a time.";
    return {
      act: "flag",
      reason: when.reason,
      attributes: reviewAttributes({ note: `${why} Book by hand and contact the customer.`, now }),
    };
  }

  /* THE DEADLINE THE CUSTOMER BOUGHT.
   *
   * A tier IS a deadline, and it was priced as one — the customer paid for
   * "by 2pm" and Gophr quoted for "by 2pm". Recomputing it from the window
   * would risk booking a different promise from the one that was sold.
   *
   * It still goes through deadlineFor(), because the rules it enforces hold
   * whatever the source: a deadline before the pickup, or on another day, is
   * one Gophr refuses outright. */
  const deadline = deadlineFor({
    windowEnd: intent.deadline || intent.windowEnd,
    pickupIso: when.iso,
  });

  /* Nothing to judge yet — the caller has not quoted. */
  if (quote === null) {
    return {
      act: "quote",
      pickupIso: when.iso,
      deadlineIso: deadline.iso,
      deadlineReason: deadline.reason,
      intent,
    };
  }

  const quotePence = toPence(quote?.grossAmount ?? quote?.gross ?? null);
  /* WHAT THE CUSTOMER ACTUALLY PAID, where the order says so.
   *
   * The guard's whole job is to compare the courier's price against the
   * customer's, and under live pricing the customer's price is on the order
   * rather than in a zone table. A tier order checked against a zone band
   * would be policing a number nobody was charged — the same mistake as
   * quoting one deadline and booking another. */
  const bandPence = intent.pricePence != null
    ? intent.pricePence
    : toPence(quote?.bandPrice ?? null);
  const verdict = priceVerdict({ quotePence, bandPence, settings: b });

  if (!verdict.ok) {
    return {
      act: "flag",
      reason: verdict.reason,
      quotePence,
      attributes: reviewAttributes({
        note: `${verdict.note} Not booked automatically — book by hand if you are happy with it.`,
        quotePence,
        now,
      }),
    };
  }

  if (!b.auto_book) {
    return {
      act: "flag",
      reason: "auto_book_off",
      quotePence,
      attributes: reviewAttributes({
        note: `Quoted ${verdict.note} Automatic booking is switched off, so no rider has been booked.`,
        quotePence,
        now,
      }),
    };
  }

  return {
    act: "book",
    pickupIso: when.iso,
    deadlineIso: deadline.iso,
    deadlineReason: deadline.reason,
    quotePence,
    marginPence: verdict.marginPence,
    intent,
  };
}
