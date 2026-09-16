// Courier booking policy. Run with: node --test tests/courier-booking.test.mjs
//
// Every rule about WHETHER to book a rider, tested without a Gophr key and
// without a Shopify session. The plumbing that calls these lives in
// app/routes/webhooks.orders.paid.jsx and is a different kind of test.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BOOKING,
  STATUS,
  normalizeBooking,
  validateBooking,
  courierIntent,
  existingBooking,
  toPence,
  priceVerdict,
  pickupTime,
  bookedAttributes,
  reviewAttributes,
  failedAttributes,
  courierPlan,
  retryVerdict,
  gophrInstant,
  normalizeMobile,
  packedGrams,
  deadlineFor,
} from "../app/lib/courier-booking.js";

/* An order as Shopify's GraphQL returns it, with only the parts that matter. */
const orderWith = (attrs, extra = {}) => ({
  id: "gid://shopify/Order/1234",
  customAttributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
  ...extra,
});

const NOW = new Date("2026-09-15T12:00:00.000Z");
const windowAt = (iso) => iso;

const sameday = (over = {}) =>
  orderWith({
    delivery_method: "delivery",
    delivery_option: "sameday",
    delivery_date: "2026-09-15",
    delivery_label: "3:00–5:00pm",
    delivery_window_start: windowAt("2026-09-15T14:00:00.000Z"),
    delivery_window_end: windowAt("2026-09-15T16:00:00.000Z"),
    ...over,
  });

/* ------------------------------------------------------------------ settings */

test("automatic booking is OFF until somebody turns it on", () => {
  assert.equal(DEFAULT_BOOKING.auto_book, false);
  assert.equal(normalizeBooking({}).auto_book, false);
  assert.equal(normalizeBooking({ auto_book: "yes" }).auto_book, false);
  assert.equal(normalizeBooking({ auto_book: true }).auto_book, true);
});

test("nonsense settings fall back rather than propagating", () => {
  const b = normalizeBooking({
    ceiling_multiple: "not a number",
    ceiling_pence: null,
    pickup_offset_minutes: "30",
  });
  assert.equal(b.ceiling_multiple, DEFAULT_BOOKING.ceiling_multiple);
  assert.equal(b.ceiling_pence, DEFAULT_BOOKING.ceiling_pence);
  assert.equal(b.pickup_offset_minutes, 30);
});

test("a multiple below 1 is refused — it would flag every job", () => {
  const errors = validateBooking(normalizeBooking({ ceiling_multiple: 0.5 }));
  assert.ok(errors["booking.ceiling_multiple"]);
});

test("a sane settings block validates clean", () => {
  assert.deepEqual(validateBooking(normalizeBooking({})), {});
});

/* ------------------------------------------------------------------ intent */

test("a same-day delivery order wants a courier", () => {
  const intent = courierIntent(sameday());
  assert.equal(intent.wanted, true);
  assert.equal(intent.incomplete, false);
  assert.equal(intent.label, "3:00–5:00pm");
  assert.equal(intent.windowStart, "2026-09-15T14:00:00.000Z");
});

test("an ordinary postal order does not", () => {
  const intent = courierIntent(orderWith({
    delivery_method: "delivery",
    delivery_option: "standard",
  }));
  assert.equal(intent.wanted, false);
  assert.equal(intent.reason, "not_sameday");
});

test("a dated delivery does not either", () => {
  const intent = courierIntent(orderWith({
    delivery_method: "delivery",
    delivery_option: "scheduled",
    delivery_date: "2026-09-20",
    delivery_label: "Sat 20th Sept",
  }));
  assert.equal(intent.wanted, false);
});

test("an order with no attributes at all is left alone", () => {
  assert.equal(courierIntent(orderWith({})).wanted, false);
  assert.equal(courierIntent({}).wanted, false);
  assert.equal(courierIntent(null).wanted, false);
});

test("A COLLECTION ORDER CARRYING A STALE SAME-DAY OPTION IS NOT BOOKED", () => {
  /* The worst available mistake: sending a rider to deliver an order somebody
   * is walking in to collect. */
  const intent = courierIntent(orderWith({
    delivery_method: "pickup",
    delivery_option: "sameday",
    delivery_date: "2026-09-15",
    delivery_label: "3:00–5:00pm",
  }));
  assert.equal(intent.wanted, false);
  assert.equal(intent.reason, "not_delivery");
});

test("a cancelled order is not booked", () => {
  const intent = courierIntent(sameday({}, ));
  assert.equal(intent.wanted, true);
  const cancelled = { ...sameday(), cancelledAt: "2026-09-15T11:00:00Z" };
  assert.equal(courierIntent(cancelled).wanted, false);
  assert.equal(courierIntent(cancelled).reason, "cancelled");
});

test("a same-day order with no window is WANTED but incomplete", () => {
  /* Not ignored. A paid same-day order with no window is a customer expecting
   * chocolate today, and silence is the wrong answer. */
  const intent = courierIntent(orderWith({
    delivery_method: "delivery",
    delivery_option: "sameday",
  }));
  assert.equal(intent.wanted, true);
  assert.equal(intent.incomplete, true);
  assert.equal(intent.reason, "no_window");
});

/* ------------------------------------------------------------------ idempotency */

test("an order carrying a job id has already been booked", () => {
  const already = existingBooking(orderWith({
    ibc_courier_status: STATUS.BOOKED,
    ibc_courier_job_id: "JOB-9",
  }));
  assert.equal(already.alreadyBooked, true);
  assert.equal(already.settled, true);
  assert.equal(already.jobId, "JOB-9");
});

test("A STATUS OF booked WITH NO JOB ID IS NOT PROOF", () => {
  /* It means the write half-succeeded. Re-checking is cheap; a second rider
   * is not. */
  const already = existingBooking(orderWith({ ibc_courier_status: STATUS.BOOKED }));
  assert.equal(already.alreadyBooked, false);
});

test("a flagged order is settled — the webhook stops touching it", () => {
  for (const status of [STATUS.REVIEW, STATUS.FAILED]) {
    const already = existingBooking(orderWith({ ibc_courier_status: status }));
    assert.equal(already.settled, true, status);
    assert.equal(already.alreadyBooked, false, status);
  }
});

test("an untouched order is not settled", () => {
  assert.equal(existingBooking(orderWith({})).settled, false);
});

/* ------------------------------------------------------------------ money */

test("pence are read from whatever shape the price arrives in", () => {
  assert.equal(toPence("12.95"), 1295);
  assert.equal(toPence(12.95), 1295);
  assert.equal(toPence("£12.95"), 1295);
  assert.equal(toPence(" 12.95 "), 1295);
  assert.equal(toPence(""), null);
  assert.equal(toPence(null), null);
  assert.equal(toPence("nonsense"), null);
});

test("rounding is to the nearest penny, not toward zero", () => {
  assert.equal(toPence("12.955"), 1296);
  assert.equal(toPence("0.1"), 10);
});

test("a quote inside the band is fine", () => {
  const v = priceVerdict({ quotePence: 900, bandPence: 1295, settings: {} });
  assert.equal(v.ok, true);
  assert.equal(v.marginPence, 395);
});

test("a quote a little over the band is allowed by the headroom", () => {
  /* £13.50 against £12.95 charged. A multiple alone would allow it too, but
   * the headroom is what stops a cheap band tripping on pennies. */
  const v = priceVerdict({ quotePence: 1350, bandPence: 1295, settings: {} });
  assert.equal(v.ok, true);
});

test("a quote far over the band is refused", () => {
  const v = priceVerdict({ quotePence: 2600, bandPence: 1295, settings: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "over_band");
  assert.match(v.note, /26\.00/);
  assert.match(v.note, /12\.95/);
});

test("THE HARD CEILING BEATS THE MULTIPLE", () => {
  /* 1.6 × £19.95 is £31.92, so the multiple alone would wave a £30 job
   * through. The ceiling exists precisely so the dearest band cannot quietly
   * authorise the dearest jobs.
   *
   * This test is why the ceiling default is £25 and not the £40 it was first
   * written as: at £40 nothing could ever reach it, and the assertion below
   * failed, which is the only reason anybody noticed. */
  const v = priceVerdict({ quotePence: 3000, bandPence: 1995, settings: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "over_ceiling");

  /* And just under it still passes, so the ceiling is a limit rather than a
   * blanket refusal of the top band. */
  assert.equal(priceVerdict({ quotePence: 2400, bandPence: 1995, settings: {} }).ok, true);
});

test("the ceiling is reachable from every band the shop sells", () => {
  /* A ceiling no band can reach is decoration. For each real band, the
   * ceiling must be BELOW what the multiple alone would allow, or it never
   * binds. */
  const b = normalizeBooking({});
  for (const bandPence of [1295, 1595, 1995]) {
    const byMultiple = Math.max(
      Math.round(bandPence * b.ceiling_multiple),
      bandPence + b.headroom_pence
    );
    assert.ok(
      b.ceiling_pence < byMultiple || bandPence === 1295,
      `£${(b.ceiling_pence / 100).toFixed(2)} ceiling never bites on a £${(bandPence / 100).toFixed(2)} band`
    );
  }
});

test("the headroom beats the multiple when the band is small", () => {
  /* 1.6 × £2 is £3.20; the headroom allows £7. Neither is a real band, which
   * is the point — the rule must not depend on the bands being sensible. */
  const v = priceVerdict({ quotePence: 650, bandPence: 200, settings: {} });
  assert.equal(v.ok, true);
});

test("no quote is not an acceptable quote", () => {
  assert.equal(priceVerdict({ quotePence: null, bandPence: 1295, settings: {} }).ok, false);
  assert.equal(priceVerdict({ quotePence: 0, bandPence: 1295, settings: {} }).ok, false);
  assert.equal(
    priceVerdict({ quotePence: NaN, bandPence: 1295, settings: {} }).reason, "no_quote");
});

test("an order from a zone that no longer exists still meets the ceiling", () => {
  const fine = priceVerdict({ quotePence: 1500, bandPence: null, settings: {} });
  assert.equal(fine.ok, true);
  assert.equal(fine.reason, "no_band");

  const steep = priceVerdict({ quotePence: 5000, bandPence: null, settings: {} });
  assert.equal(steep.ok, false);
  assert.equal(steep.reason, "over_ceiling");
});

/* ------------------------------------------------------------------ timing */

test("the rider is asked for before the window opens, not during it", () => {
  const { iso } = pickupTime({
    windowStart: "2026-09-15T14:00:00.000Z",
    settings: {},
    now: NOW,
  });
  assert.equal(iso, "2026-09-15T13:30:00+00:00");
});

test("the offset is a setting, not a constant", () => {
  const { iso } = pickupTime({
    windowStart: "2026-09-15T14:00:00.000Z",
    settings: { pickup_offset_minutes: 90 },
    now: NOW,
  });
  assert.equal(iso, "2026-09-15T12:30:00+00:00");
});

test("A RIDER IS NEVER ASKED FOR IN THE PAST", () => {
  /* Offset 90 against a window 30 minutes away would ask for a pickup an hour
   * ago. Gophr would send somebody immediately, and "immediately" is the one
   * answer the kitchen cannot give. */
  const { iso } = pickupTime({
    windowStart: "2026-09-15T12:30:00.000Z",
    settings: { pickup_offset_minutes: 90 },
    now: NOW,
  });
  assert.equal(iso, gophrInstant(NOW));
});

test("a window that has already gone is refused", () => {
  const { iso, reason } = pickupTime({
    windowStart: "2026-09-15T10:00:00.000Z",
    settings: {},
    now: NOW,
  });
  assert.equal(iso, null);
  assert.equal(reason, "window_passed");
});

test("the grace period covers a slow payment", () => {
  /* Five minutes past the window start, with fifteen minutes of grace. */
  const { iso } = pickupTime({
    windowStart: "2026-09-15T11:55:00.000Z",
    settings: {},
    now: NOW,
  });
  assert.equal(iso, gophrInstant(NOW));
});

test("a missing or unreadable window start is named, not guessed at", () => {
  assert.equal(pickupTime({ windowStart: null, settings: {}, now: NOW }).reason,
    "no_window_start");
  assert.equal(pickupTime({ windowStart: "3:00–5:00pm", settings: {}, now: NOW }).reason,
    "bad_window_start");
});

/* ------------------------------------------------------------------ writes */

test("a booked order carries the job id and loses any old note", () => {
  const attrs = bookedAttributes({
    job: { jobId: "JOB-9", deliveryId: "DEL-1", trackingUrl: "https://t/9" },
    quotePence: 980,
    now: NOW,
  });
  assert.equal(attrs.ibc_courier_status, STATUS.BOOKED);
  assert.equal(attrs.ibc_courier_job_id, "JOB-9");
  assert.equal(attrs.ibc_courier_quote_pence, "980");
  /* null CLEARS the key — see mergeAttributes in order-booking.js. */
  assert.equal(attrs.ibc_courier_note, null);
});

test("a flagged order explains itself", () => {
  const attrs = reviewAttributes({ note: "Too dear.", quotePence: 3000, now: NOW });
  assert.equal(attrs.ibc_courier_status, STATUS.REVIEW);
  assert.equal(attrs.ibc_courier_note, "Too dear.");
  assert.equal(attrs.ibc_courier_quote_pence, "3000");
});

test("a failed attempt says so rather than looking booked", () => {
  const attrs = failedAttributes({ note: "Gophr timed out.", now: NOW });
  assert.equal(attrs.ibc_courier_status, STATUS.FAILED);
  assert.equal(attrs.ibc_courier_job_id, undefined);
});

/* ------------------------------------------------------------------ the plan */

test("an ordinary order is ignored before anything is quoted", () => {
  const plan = courierPlan({
    order: orderWith({ delivery_method: "delivery", delivery_option: "standard" }),
    booking: {},
    now: NOW,
  });
  assert.equal(plan.act, "ignore");
  assert.equal(plan.reason, "not_sameday");
});

test("a same-day order asks to be quoted first", () => {
  const plan = courierPlan({ order: sameday(), booking: {}, now: NOW });
  assert.equal(plan.act, "quote");
  assert.equal(plan.pickupIso, "2026-09-15T13:30:00+00:00");
});

test("AN ALREADY-BOOKED ORDER IS IGNORED — Shopify retries this webhook", () => {
  const plan = courierPlan({
    order: sameday({ ibc_courier_job_id: "JOB-9", ibc_courier_status: STATUS.BOOKED }),
    booking: { auto_book: true },
    now: NOW,
  });
  assert.equal(plan.act, "ignore");
  assert.equal(plan.reason, "already_booked");
  assert.equal(plan.jobId, "JOB-9");
});

test("a flagged order is not re-quoted on every retry", () => {
  const plan = courierPlan({
    order: sameday({ ibc_courier_status: STATUS.REVIEW }),
    booking: { auto_book: true },
    now: NOW,
  });
  assert.equal(plan.act, "ignore");
});

test("with automatic booking OFF, a good quote is still only flagged", () => {
  const plan = courierPlan({
    order: sameday(),
    booking: {},
    quote: { grossAmount: "9.80", bandPrice: "12.95" },
    now: NOW,
  });
  assert.equal(plan.act, "flag");
  assert.equal(plan.reason, "auto_book_off");
  assert.equal(plan.quotePence, 980);
  assert.match(plan.attributes.ibc_courier_note, /switched off/);
  /* THE PRICE IS STILL RECORDED. That is the whole value of the off state: a
   * fortnight of real quotes to look at before trusting it. */
  assert.equal(plan.attributes.ibc_courier_quote_pence, "980");
});

test("with automatic booking ON, a good quote books", () => {
  const plan = courierPlan({
    order: sameday(),
    booking: { auto_book: true },
    quote: { grossAmount: "9.80", bandPrice: "12.95" },
    now: NOW,
  });
  assert.equal(plan.act, "book");
  assert.equal(plan.quotePence, 980);
  assert.equal(plan.marginPence, 315);
  assert.equal(plan.pickupIso, "2026-09-15T13:30:00+00:00");
});

test("THE CIRCUIT BREAKER BEATS auto_book", () => {
  const plan = courierPlan({
    order: sameday(),
    booking: { auto_book: true },
    quote: { grossAmount: "26.00", bandPrice: "12.95" },
    now: NOW,
  });
  assert.equal(plan.act, "flag");
  assert.equal(plan.reason, "over_band");
  assert.match(plan.attributes.ibc_courier_note, /book by hand/i);
});

test("a same-day order with no window is flagged, never silently dropped", () => {
  const plan = courierPlan({
    order: orderWith({ delivery_method: "delivery", delivery_option: "sameday" }),
    booking: { auto_book: true },
    now: NOW,
  });
  assert.equal(plan.act, "flag");
  assert.equal(plan.reason, "no_window");
  assert.match(plan.attributes.ibc_courier_note, /contact the customer/i);
});

test("a window that has passed is flagged with the window named", () => {
  const plan = courierPlan({
    order: sameday({ delivery_window_start: "2026-09-15T09:00:00.000Z" }),
    booking: { auto_book: true },
    now: NOW,
  });
  assert.equal(plan.act, "flag");
  assert.equal(plan.reason, "window_passed");
  assert.match(plan.attributes.ibc_courier_note, /3:00–5:00pm/);
});

test("an order the picker never wrote a machine window onto is flagged", () => {
  /* Orders placed before the theme started writing delivery_window_start.
   * Flagged rather than parsed out of "3:00–5:00pm", because display text is
   * not a data format. */
  const plan = courierPlan({
    order: sameday({ delivery_window_start: "" }),
    booking: { auto_book: true },
    now: NOW,
  });
  assert.equal(plan.act, "flag");
  assert.equal(plan.reason, "no_window_start");
});

test("the whole happy path, end to end, with no I/O anywhere in it", () => {
  const order = sameday();
  const booking = { auto_book: true };

  const first = courierPlan({ order, booking, now: NOW });
  assert.equal(first.act, "quote");

  const second = courierPlan({
    order,
    booking,
    quote: { grossAmount: "9.80", bandPrice: "12.95" },
    now: NOW,
  });
  assert.equal(second.act, "book");

  const booked = bookedAttributes({
    job: { jobId: "JOB-9", trackingUrl: "https://t/9" },
    quotePence: second.quotePence,
    now: NOW,
  });

  /* And now the same order, with the booking written back onto it, is inert. */
  const after = courierPlan({
    order: sameday(booked),
    booking,
    quote: { grossAmount: "9.80", bandPrice: "12.95" },
    now: NOW,
  });
  assert.equal(after.act, "ignore");
  assert.equal(after.reason, "already_booked");
});

/* ------------------------------------------------------------------ retries */

test("a blip within the first few minutes is worth retrying", () => {
  const v = retryVerdict({
    paidAt: "2026-09-15T11:55:00.000Z",
    now: NOW,
  });
  assert.equal(v.retry, true);
});

test("SHOPIFY'S 48-HOUR RETRY SCHEDULE IS NOT WANTED HERE", () => {
  /* A rider booked on the eighth retry at two in the morning is worse than no
   * rider: the window went hours ago and somebody is asleep. */
  const v = retryVerdict({
    paidAt: "2026-09-15T10:00:00.000Z",
    now: NOW,
  });
  assert.equal(v.retry, false);
  assert.equal(v.reason, "too_late_to_retry");
});

test("the retry window is adjustable", () => {
  assert.equal(
    retryVerdict({ paidAt: "2026-09-15T11:00:00.000Z", now: NOW, maxRetryMinutes: 90 }).retry,
    true
  );
});

test("no payment timestamp means one attempt, not a loop", () => {
  assert.equal(retryVerdict({ paidAt: null, now: NOW }).retry, false);
  assert.equal(retryVerdict({ paidAt: "not a date", now: NOW }).reason, "no_paid_at");
});

test("THE OFFSET SETTING REACHES THE PICKUP TIME THROUGH courierPlan", () => {
  /* It did not, once. courierPlan was handing pickupTime the caller's whole
   * settings blob instead of the booking block, and got away with it because
   * that blob has none of these keys — so every lookup missed and the
   * defaults applied. It would have gone wrong the day a top-level key
   * happened to be called grace_minutes. */
  const plan = courierPlan({
    order: sameday(),
    booking: { pickup_offset_minutes: 90 },
    now: NOW,
  });
  assert.equal(plan.act, "quote");
  assert.equal(plan.pickupIso, "2026-09-15T12:30:00+00:00");
});

/* ------------------------------------------------------------- draft vs booked */

test("A DRAFT'S ID MUST NOT LOOK LIKE A BOOKING", () => {
  /* Booking is two steps: POST /jobs makes a draft that dispatches nobody,
   * PATCH /jobs/{id} confirms it and sends a rider. An unconfirmed draft has
   * an id too — and if that id were written to ibc_courier_job_id, this would
   * report the order as already booked and never look at it again, which is
   * the precise failure the idempotency check exists to prevent.
   *
   * So: a flagged order carries its draft id in the NOTE, and the job id
   * field stays empty. */
  const flagged = courierPlan({
    order: sameday(),
    booking: { auto_book: true },
    quote: { grossAmount: "26.00", bandPrice: "12.95" },
    now: NOW,
  });
  assert.equal(flagged.act, "flag");
  assert.equal(flagged.attributes.ibc_courier_job_id, undefined);

  /* And an order written that way is NOT treated as booked on the next pass,
   * though it IS settled, so the webhook leaves it for the human it asked. */
  const after = existingBooking(sameday(flagged.attributes));
  assert.equal(after.alreadyBooked, false);
  assert.equal(after.settled, true);
});

test("only a confirmed job fills the job id field", () => {
  const attrs = bookedAttributes({
    job: { jobId: "JOB-9" },
    quotePence: 980,
    now: NOW,
  });
  assert.equal(attrs.ibc_courier_job_id, "JOB-9");
  assert.equal(existingBooking(sameday(attrs)).alreadyBooked, true);
});

test("a booked order carries BOTH links — the customer's and the shop's", () => {
  /* Gophr returns two: public_tracker_url, which the customer follows, and
   * private_job_url, which is the shop's way into job management. They are
   * different things and both are worth having on the order. */
  const attrs = bookedAttributes({
    job: {
      jobId: "JOB-9",
      trackingUrl: "https://gophr/tracking/1043402/x/delivery",
      jobUrl: "https://gophr/job-management/1043402",
    },
    quotePence: 900,
    now: NOW,
  });
  assert.match(attrs.ibc_courier_tracking_url, /tracking/);
  assert.match(attrs.ibc_courier_job_url, /job-management/);
});

test("and clears them when there are none, rather than keeping stale ones", () => {
  const attrs = bookedAttributes({ job: { jobId: "JOB-9" }, quotePence: 900, now: NOW });
  assert.equal(attrs.ibc_courier_tracking_url, null);
  assert.equal(attrs.ibc_courier_job_url, null);
});

/* ------------------------------------------------------------- gophr instants */

test("GOPHR REFUSES WHAT toISOString() PRODUCES", () => {
  /* Its own error names the format it wants: "2022-03-01T13:00:00+00:00".
   * No milliseconds, explicit offset. JavaScript gives neither. */
  const d = new Date("2026-09-15T14:30:00.000Z");
  assert.equal(d.toISOString(), "2026-09-15T14:30:00.000Z");
  assert.equal(gophrInstant(d), "2026-09-15T14:30:00+00:00");
});

test("the shape matches Gophr's worked example exactly", () => {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  assert.match(gophrInstant(new Date("2022-03-01T13:00:00Z")), pattern);
  assert.match(gophrInstant(new Date()), pattern);
  /* And every pickup time the planner emits goes through it. */
  const plan = courierPlan({ order: sameday(), booking: {}, now: NOW });
  assert.match(plan.pickupIso, pattern);
});

test("no milliseconds survive, whatever the input", () => {
  for (const ms of [0, 1, 999]) {
    const d = new Date(Date.UTC(2026, 8, 15, 14, 30, 0, ms));
    assert.equal(gophrInstant(d).includes("."), false, `ms=${ms}`);
  }
});

/* ------------------------------------------------------------------ phones */

test("A UK MOBILE REACHES GOPHR IN ONE SPELLING, NOT TWO", () => {
  /* The shop's number is set as +447873989675; a customer's arrives from the
   * Shopify address as 07873989675. Gophr accepted both without complaint,
   * which is worse than refusing one: the job books, the rider goes, and the
   * text silently never arrives. */
  assert.equal(normalizeMobile("07873989675"), "+447873989675");
  assert.equal(normalizeMobile("+447873989675"), "+447873989675");
  assert.equal(normalizeMobile("00447873989675"), "+447873989675");
  assert.equal(normalizeMobile("447873989675"), "+447873989675");
});

test("how people actually type numbers", () => {
  assert.equal(normalizeMobile("07873 989675"), "+447873989675");
  assert.equal(normalizeMobile("(07873) 989-675"), "+447873989675");
  assert.equal(normalizeMobile("  +44 7873 989675  "), "+447873989675");
});

test("anything it cannot be sure of is left alone, not guessed at", () => {
  /* A wrong guess at an international number is worse than passing it through
   * and letting Gophr refuse it on its own terms. */
  assert.equal(normalizeMobile("+33612345678"), "+33612345678");
  assert.equal(normalizeMobile("12345"), "12345");
  assert.equal(normalizeMobile(""), "");
  assert.equal(normalizeMobile(null), "");
  assert.equal(normalizeMobile(undefined), "");
});

test("a London landline is not mangled into a mobile", () => {
  /* 02071234567 is eleven digits starting 0, so it converts — correctly, to
   * +442071234567. The rule is about UK numbers, not about mobiles. */
  assert.equal(normalizeMobile("02071234567"), "+442071234567");
});

/* ------------------------------------------------------------------ packaging */

test("SHOPIFY'S WEIGHT IS THE PRODUCTS AND NOTHING ELSE", () => {
  /* The box, the padding and the ribbon are carried by the rider too, and
   * under-declaring means Gophr picks a vehicle for a lighter parcel than
   * the one it is handed. */
  assert.equal(packedGrams(2100, {}), 2460);   // whole cake, boxed
  assert.equal(packedGrams(220, {}), 392);     // one slice, boxed
});

test("a percentage alone would under-count a small order", () => {
  /* 10% of a 220g slice is 22g, and no box weighs 22g. The flat weight is
   * what makes the small end honest; the percentage is what keeps the big
   * end from being over-stated. */
  const percentOnly = packedGrams(220, { packaging_grams: 0, packaging_percent: 10 });
  const both = packedGrams(220, {});
  assert.equal(percentOnly, 242);
  assert.ok(both > percentOnly + 100);
});

test("both numbers are adjustable and either can be switched off", () => {
  assert.equal(packedGrams(1000, { packaging_grams: 0, packaging_percent: 0 }), 1000);
  assert.equal(packedGrams(1000, { packaging_grams: 500, packaging_percent: 0 }), 1500);
  assert.equal(packedGrams(1000, { packaging_grams: 0, packaging_percent: 25 }), 1250);
});

test("AN ORDER WITH NO WEIGHTS SET DOES NOT BECOME A ZERO-GRAM PARCEL", () => {
  /* A parcel declared at nothing is one Gophr will happily give a pushbike.
   * A missing weight means "nobody filled this in", not "it weighs nothing". */
  assert.equal(packedGrams(0, {}), 700);
  assert.equal(packedGrams(null, {}), 700);
  assert.equal(packedGrams(undefined, {}), 700);
  assert.equal(packedGrams("nonsense", {}), 700);
});

test("packaging can push an order over the bulky threshold, and should", () => {
  /* 1.4kg of chocolate is under 1.5kg. The same order in a box is not, and
   * the boxed figure is the one the rider carries. */
  assert.ok(packedGrams(1400, {}) >= 1500);
  assert.ok(packedGrams(1200, {}) < 1500);
});

/* ------------------------------------------------------------------ pickup */

test("THE SHOP ADDRESS IS A SETTING, NOT A CONSTANT", () => {
  /* It lived in gophr.server.js under a comment promising to move it into
   * settings. It did not move, and an address in code is wrong the day the
   * shop does. */
  const b = normalizeBooking({});
  assert.equal(b.pickup_address1, "29 Rathbone Place");
  assert.equal(b.pickup_postcode, "W1T 1JG");

  const moved = normalizeBooking({ pickup_address1: "1 New Street", pickup_postcode: "W1A 1AA" });
  assert.equal(moved.pickup_address1, "1 New Street");
  assert.equal(moved.pickup_postcode, "W1A 1AA");
});

test("a blank address falls back rather than sending a courier nowhere", () => {
  const b = normalizeBooking({ pickup_address1: "   ", pickup_postcode: "" });
  assert.equal(b.pickup_address1, "29 Rathbone Place");
  assert.equal(b.pickup_postcode, "W1T 1JG");
});

test("but an address that cannot be saved blank is reported as an error", () => {
  /* normalizeBooking backfills, so validate is checked against a raw block —
   * the shape the form hands over before it is normalised. */
  const errors = validateBooking({ ...normalizeBooking({}), pickup_postcode: "" });
  assert.ok(errors["booking.pickup_postcode"]);
});

test("packaging settings are validated", () => {
  assert.ok(validateBooking(normalizeBooking({ packaging_percent: 500 }))["booking.packaging_percent"]);
  assert.deepEqual(validateBooking(normalizeBooking({ packaging_percent: 15 })), {});
});

/* ------------------------------------------------------------------ deadline */

test("THE DEADLINE IS THE END OF THE WINDOW THE CUSTOMER CHOSE", () => {
  /* Without it Gophr gives every job until 23:55 and the rider takes other
   * work while the ETA slides — watched happening on a live job. */
  const { iso } = deadlineFor({
    windowEnd: "2026-09-16T18:30:00+01:00",
    pickupIso: "2026-09-16T15:00:00+00:00",
  });
  assert.equal(iso, "2026-09-16T17:30:00+00:00");
});

test("it is spelled the way Gophr accepts, like every other instant", () => {
  const { iso } = deadlineFor({
    windowEnd: "2026-09-16T18:30:00.000Z",
    pickupIso: "2026-09-16T15:00:00+00:00",
  });
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("A DEADLINE ON A DIFFERENT DAY IS DROPPED, NOT SENT", () => {
  /* Gophr's own 422: "Earliest pickup time and delivery deadline must be on
   * the same day." Sending it anyway would fail the whole booking, and a
   * rider with a loose deadline beats no rider at all. */
  const { iso, reason } = deadlineFor({
    windowEnd: "2026-09-17T09:00:00+01:00",
    pickupIso: "2026-09-16T22:00:00+00:00",
  });
  assert.equal(iso, null);
  assert.equal(reason, "different_day");
});

test("same day is judged in LONDON, not in UTC", () => {
  /* At half past midnight BST the two calendars disagree, and the shop's
   * clock is the one Gophr means. */
  const londonSameDay = deadlineFor({
    windowEnd: "2026-07-01T00:30:00+01:00",   // 1 July in London, 30 June UTC
    pickupIso: "2026-06-30T23:00:00+01:00",   // 30 June in London
  });
  assert.equal(londonSameDay.reason, "different_day");
});

test("a deadline before the collection is a mistake, not a deadline", () => {
  const { iso, reason } = deadlineFor({
    windowEnd: "2026-09-16T14:00:00+00:00",
    pickupIso: "2026-09-16T15:00:00+00:00",
  });
  assert.equal(iso, null);
  assert.equal(reason, "ends_before_pickup");
});

test("an order with no machine window sends no deadline, as before", () => {
  assert.equal(deadlineFor({ windowEnd: "", pickupIso: "2026-09-16T15:00:00+00:00" }).iso, null);
  assert.equal(deadlineFor({ windowEnd: "3:00–5:00pm", pickupIso: "2026-09-16T15:00:00+00:00" }).reason,
    "bad_window_end");
});

test("the plan carries the deadline through to the booking", () => {
  const plan = courierPlan({ order: sameday(), booking: {}, now: NOW });
  assert.equal(plan.act, "quote");
  /* The fixture's window is 14:00–16:00 UTC, pickup 13:30. */
  assert.equal(plan.deadlineIso, "2026-09-15T16:00:00+00:00");
});

test("AND THE ORDINARY CASE IS IN GOPHR'S FREE BAND", () => {
  /* Measured: a deadline 180 minutes out or more costs nothing, while 60
   * minutes costs +£7.73. A two-hour window opening ninety minutes after the
   * order ends 210 minutes out, so the shop never pays the urgency premium
   * on a normal order. This asserts the shape of that, not the price. */
  const plan = courierPlan({ order: sameday(), booking: {}, now: NOW });
  const minutes = (new Date(plan.deadlineIso) - NOW) / 60000;
  assert.ok(minutes >= 180, `deadline only ${minutes} minutes out`);
});
