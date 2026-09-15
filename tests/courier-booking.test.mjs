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
  assert.equal(iso, "2026-09-15T13:30:00.000Z");
});

test("the offset is a setting, not a constant", () => {
  const { iso } = pickupTime({
    windowStart: "2026-09-15T14:00:00.000Z",
    settings: { pickup_offset_minutes: 90 },
    now: NOW,
  });
  assert.equal(iso, "2026-09-15T12:30:00.000Z");
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
  assert.equal(iso, NOW.toISOString());
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
  assert.equal(iso, NOW.toISOString());
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
  assert.equal(plan.pickupIso, "2026-09-15T13:30:00.000Z");
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
  assert.equal(plan.pickupIso, "2026-09-15T13:30:00.000Z");
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
  assert.equal(plan.pickupIso, "2026-09-15T12:30:00.000Z");
});
