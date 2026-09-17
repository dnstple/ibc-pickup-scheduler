import { test } from "node:test";
import assert from "node:assert/strict";

import { courierIntent, courierPlan, DEFAULT_BOOKING } from "../app/lib/courier-booking.js";

/* An order, as the webhook sees one. Only the parts these tests care about. */
function orderWith(attributes, extra = {}) {
  return {
    id: "gid://shopify/Order/1",
    name: "#1100",
    customAttributes: Object.entries(attributes).map(([key, value]) => ({ key, value })),
    ...extra,
  };
}

const NOW = new Date("2026-09-17T11:00:00+01:00");

/* A tier order, as the basket writes one: ready in fifteen minutes, promised
 * by two o'clock, £11.95 paid. */
const TIER_ATTRS = {
  delivery_method: "delivery",
  delivery_option: "sameday",
  delivery_date: "2026-09-17",
  delivery_label: "By 2:00pm",
  delivery_window_start: "2026-09-17T11:15:00+01:00",
  delivery_window_end: "2026-09-17T14:00:00+01:00",
  delivery_tier: "priority",
  delivery_deadline: "2026-09-17T14:00:00+01:00",
  delivery_ready_at: "2026-09-17T11:15:00+01:00",
  delivery_price_pence: "1195",
};

/* An order from before tiers existed. It must go on booking unchanged. */
const WINDOW_ATTRS = {
  delivery_method: "delivery",
  delivery_option: "sameday",
  delivery_date: "2026-09-17",
  delivery_label: "2:00–4:00pm",
  delivery_window_start: "2026-09-17T14:00:00+01:00",
  delivery_window_end: "2026-09-17T16:00:00+01:00",
};

test("a tier order reports its tier, deadline, ready time and price", () => {
  const intent = courierIntent(orderWith(TIER_ATTRS));
  assert.equal(intent.wanted, true);
  assert.equal(intent.tier, "priority");
  assert.equal(intent.deadline, "2026-09-17T14:00:00+01:00");
  assert.equal(intent.readyAt, "2026-09-17T11:15:00+01:00");
  assert.equal(intent.pricePence, 1195);
});

test("an order from before tiers carries none of them, and says so honestly", () => {
  const intent = courierIntent(orderWith(WINDOW_ATTRS));
  assert.equal(intent.wanted, true);
  assert.equal(intent.tier, null);
  assert.equal(intent.deadline, null);
  assert.equal(intent.readyAt, null);
  /* NOT zero. A missing price is not a free delivery, and the guard has to
   * be able to tell the difference. */
  assert.equal(intent.pricePence, null);
});

test("the rider is asked for when the basket is ready, not half an hour earlier", () => {
  const plan = courierPlan({
    order: orderWith(TIER_ATTRS),
    booking: { ...DEFAULT_BOOKING, pickup_offset_minutes: 30 },
    now: NOW,
  });
  assert.equal(plan.act, "quote");
  /* ready_at exactly. The thirty-minute offset is NOT applied on top: the
   * preparation is already inside ready_at, and applying it twice would put
   * a rider at the counter while the cake was still being boxed. */
  assert.equal(plan.pickupIso, "2026-09-17T10:15:00+00:00");
});

test("an older order still gets the offset it was placed under", () => {
  const plan = courierPlan({
    order: orderWith(WINDOW_ATTRS),
    booking: { ...DEFAULT_BOOKING, pickup_offset_minutes: 30 },
    now: NOW,
  });
  assert.equal(plan.act, "quote");
  /* 2pm window, thirty minutes before it opens. */
  assert.equal(plan.pickupIso, "2026-09-17T12:30:00+00:00");
});

test("the deadline booked is the deadline sold", () => {
  const plan = courierPlan({ order: orderWith(TIER_ATTRS), booking: DEFAULT_BOOKING, now: NOW });
  assert.equal(plan.deadlineIso, "2026-09-17T13:00:00+00:00");
  assert.equal(plan.deadlineReason, null);
});

test("an older order still deadlines on its window end", () => {
  const plan = courierPlan({ order: orderWith(WINDOW_ATTRS), booking: DEFAULT_BOOKING, now: NOW });
  assert.equal(plan.deadlineIso, "2026-09-17T15:00:00+00:00");
});

test("the guard measures against what the customer paid, not against a zone", () => {
  /* Paid £11.95. Ceiling multiple 1.0 and £5 headroom allow up to £16.95. */
  const booking = { ...DEFAULT_BOOKING, auto_book: true, ceiling_multiple: 1.0, headroom_pence: 500, ceiling_pence: 4000 };
  const ok = courierPlan({
    order: orderWith(TIER_ATTRS),
    booking,
    /* bandPrice deliberately WRONG — an old zone price of £19.95. The order's
     * own figure must win, or the guard polices a number nobody was charged. */
    quote: { grossAmount: 16.5, bandPrice: 19.95 },
    now: NOW,
  });
  assert.equal(ok.act, "book", "£16.50 is inside £11.95 + £5");

  const tooDear = courierPlan({
    order: orderWith(TIER_ATTRS),
    booking,
    quote: { grossAmount: 17.5, bandPrice: 19.95 },
    now: NOW,
  });
  assert.equal(tooDear.act, "flag", "£17.50 is outside £11.95 + £5");
});

test("a tier order with no price falls back to the zone band rather than refusing", () => {
  const attrs = { ...TIER_ATTRS };
  delete attrs.delivery_price_pence;
  const plan = courierPlan({
    order: orderWith(attrs),
    booking: { ...DEFAULT_BOOKING, auto_book: true, ceiling_multiple: 1.0, headroom_pence: 500, ceiling_pence: 4000 },
    quote: { grossAmount: 16.5, bandPrice: 19.95 },
    now: NOW,
  });
  assert.equal(plan.act, "book");
});

test("a deadline on another day is refused, wherever it came from", () => {
  const plan = courierPlan({
    order: orderWith({ ...TIER_ATTRS, delivery_deadline: "2026-09-18T14:00:00+01:00" }),
    booking: DEFAULT_BOOKING,
    now: NOW,
  });
  assert.equal(plan.deadlineIso, null);
  assert.equal(plan.deadlineReason, "different_day");
});

test("a deadline before the pickup is refused", () => {
  const plan = courierPlan({
    order: orderWith({ ...TIER_ATTRS, delivery_deadline: "2026-09-17T10:00:00+01:00" }),
    booking: DEFAULT_BOOKING,
    now: NOW,
  });
  assert.equal(plan.deadlineIso, null);
  assert.equal(plan.deadlineReason, "ends_before_pickup");
});

test("a collection order carrying a stale same-day tier is still ignored", () => {
  const plan = courierPlan({
    order: orderWith({ ...TIER_ATTRS, delivery_method: "pickup" }),
    booking: DEFAULT_BOOKING,
    now: NOW,
  });
  assert.equal(plan.act, "ignore");
  assert.equal(plan.reason, "not_delivery");
});
