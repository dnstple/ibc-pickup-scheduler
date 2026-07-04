import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAvailability,
  buildOrderCounts,
  validateSettings,
  normalizeSettings,
  maxPrepDelayMinutes,
  rangeLabel,
  summarizeSettings,
} from "../app/lib/availability.js";
import { toZonedISO, wallTimeToInstant, offsetMinutes } from "../app/lib/timezone.js";

// Tuesday–Saturday 10:00–18:00 (Sat until 17:00), matching the store defaults.
function settings(overrides = {}) {
  return normalizeSettings({
    timezone: "Europe/London",
    booking_horizon_days: 14,
    slot_interval_minutes: 30,
    same_day_pickup_enabled: true,
    same_day_pickup_cutoff_time: "15:00",
    minimum_pickup_order_value_enabled: false,
    minimum_pickup_order_value: null,
    maximum_pickup_orders_per_day: null,
    maximum_pickup_orders_per_slot: null,
    collection_location_name: "Italian Bear Chocolate",
    collection_instructions: "Collect from the counter.",
    weekly_hours: {
      monday: { enabled: false, start_time: null, end_time: null },
      tuesday: { enabled: true, start_time: "10:00", end_time: "18:00" },
      wednesday: { enabled: true, start_time: "10:00", end_time: "18:00" },
      thursday: { enabled: true, start_time: "10:00", end_time: "18:00" },
      friday: { enabled: true, start_time: "10:00", end_time: "18:00" },
      saturday: { enabled: true, start_time: "10:00", end_time: "17:00" },
      sunday: { enabled: false, start_time: null, end_time: null },
    },
    blackout_dates: [],
    capacity_overrides: [],
    ...overrides,
  });
}

// Wednesday 8 July 2026, 12:15 BST.
const WED_1215 = new Date("2026-07-08T12:15:00+01:00");
const cart = (items = [{}], totalPence = 2500) => ({ totalPence, items });

test("default 60-minute preparation: 12:15 now -> first slot 1:30-2:00pm", () => {
  const a = computeAvailability({ settings: settings(), now: WED_1215, cart: cart() });
  assert.equal(a.eligible, true);
  const today = a.dates[0];
  assert.equal(today.date, "2026-07-08");
  assert.equal(today.slots[0].time_label, "1:30–2:00pm");
  assert.equal(today.slots[0].start_iso, "2026-07-08T13:30:00+01:00");
});

test("longer product delay wins: 180 minutes -> first slot 3:30pm", () => {
  const a = computeAvailability({
    settings: settings(),
    now: WED_1215,
    cart: cart([{ delayMinutes: 180 }]),
  });
  assert.equal(a.max_delay_minutes, 180);
  assert.equal(a.dates[0].slots[0].start_iso, "2026-07-08T15:30:00+01:00");
});

test("multiple products: highest delay applies, never the sum", () => {
  assert.equal(maxPrepDelayMinutes([{ delayMinutes: 180 }, { delayMinutes: 120 }, {}]), 180);
  assert.equal(maxPrepDelayMinutes([{ delayMinutes: 30 }]), 60); // floor is 60
});

test("same-day cut-off removes today entirely", () => {
  const now = new Date("2026-07-08T15:05:00+01:00");
  const a = computeAvailability({ settings: settings(), now, cart: cart() });
  assert.notEqual(a.dates[0].date, "2026-07-08");
  assert.equal(a.dates[0].date, "2026-07-09");
});

test("same-day pickup disabled removes today even before cut-off", () => {
  const a = computeAvailability({
    settings: settings({ same_day_pickup_enabled: false }),
    now: WED_1215,
    cart: cart(),
  });
  assert.notEqual(a.dates[0].date, "2026-07-08");
});

test("disabled weekdays (Sunday, Monday) never appear", () => {
  const a = computeAvailability({ settings: settings(), now: WED_1215, cart: cart() });
  for (const d of a.dates) {
    assert.ok(!["Sunday", "Monday"].includes(d.weekday), `${d.date} is ${d.weekday}`);
  }
});

test("full blackout date is excluded", () => {
  const a = computeAvailability({
    settings: settings({
      blackout_dates: [{ date: "2026-07-11", all_day: true, note: "Private event" }],
    }),
    now: WED_1215,
    cart: cart(),
  });
  assert.ok(!a.dates.some((d) => d.date === "2026-07-11"));
});

test("partial closure hides only overlapping slots", () => {
  const a = computeAvailability({
    settings: settings({
      blackout_dates: [
        { date: "2026-07-11", all_day: false, start_time: "14:00", end_time: "23:59", note: "Event" },
      ],
    }),
    now: WED_1215,
    cart: cart(),
  });
  const sat = a.dates.find((d) => d.date === "2026-07-11");
  assert.ok(sat, "Saturday should still be bookable in the morning");
  assert.ok(sat.slots.length > 0);
  for (const s of sat.slots) {
    assert.ok(s.start_time < "14:00", `slot ${s.start_time} should be before 14:00`);
  }
});

test("minimum order value blocks slot selection with reason", () => {
  const a = computeAvailability({
    settings: settings({
      minimum_pickup_order_value_enabled: true,
      minimum_pickup_order_value: 15,
    }),
    now: WED_1215,
    cart: cart([{}], 1200), // £12.00
  });
  assert.equal(a.eligible, false);
  assert.equal(a.reason, "below_minimum");
  assert.equal(a.minimum_value_pence, 1500);
  assert.equal(a.dates.length, 0);
});

test("maximum orders per day removes the whole day", () => {
  const a = computeAvailability({
    settings: settings({ maximum_pickup_orders_per_day: 2 }),
    now: WED_1215,
    cart: cart(),
    orderCounts: { byDate: { "2026-07-09": 2 }, bySlot: {} },
  });
  assert.ok(!a.dates.some((d) => d.date === "2026-07-09"));
  assert.ok(a.dates.some((d) => d.date === "2026-07-10"));
});

test("maximum orders per slot removes only that slot", () => {
  const a = computeAvailability({
    settings: settings({ maximum_pickup_orders_per_slot: 1 }),
    now: WED_1215,
    cart: cart(),
    orderCounts: { byDate: {}, bySlot: { "2026-07-09 10:00": 1 } },
  });
  const thu = a.dates.find((d) => d.date === "2026-07-09");
  assert.ok(!thu.slots.some((s) => s.start_time === "10:00"));
  assert.ok(thu.slots.some((s) => s.start_time === "10:30"));
});

test("capacity override: specific date and specific slot", () => {
  const a = computeAvailability({
    settings: settings({
      maximum_pickup_orders_per_day: 30,
      capacity_overrides: [
        { date: "2026-07-11", slot_start: null, max_orders: 2, note: "Short-staffed" },
        { date: "2026-07-10", slot_start: "14:00", max_orders: 1, note: "" },
      ],
    }),
    now: WED_1215,
    cart: cart(),
    orderCounts: {
      byDate: { "2026-07-11": 2, "2026-07-10": 2 },
      bySlot: { "2026-07-10 14:00": 1 },
    },
  });
  assert.ok(!a.dates.some((d) => d.date === "2026-07-11"), "day override full");
  const fri = a.dates.find((d) => d.date === "2026-07-10");
  assert.ok(fri, "general day limit 30 not hit");
  assert.ok(!fri.slots.some((s) => s.start_time === "14:00"), "slot override full");
});

test("product unavailable for pickup blocks the scheduler", () => {
  const a = computeAvailability({
    settings: settings(),
    now: WED_1215,
    cart: cart([{ pickupAvailable: true }, { pickupAvailable: false }]),
  });
  assert.equal(a.eligible, false);
  assert.equal(a.reason, "products_unavailable");
});

test("booking horizon caps the last date", () => {
  const a = computeAvailability({
    settings: settings({ booking_horizon_days: 3 }),
    now: WED_1215,
    cart: cart(),
  });
  const last = a.dates[a.dates.length - 1];
  assert.ok(last.date <= "2026-07-10");
});

test("slot end never exceeds closing time", () => {
  const a = computeAvailability({ settings: settings(), now: WED_1215, cart: cart() });
  const sat = a.dates.find((d) => d.weekday === "Saturday");
  const lastSlot = sat.slots[sat.slots.length - 1];
  assert.equal(lastSlot.start_time, "16:30"); // 16:30-17:00 is the final Saturday slot
});

test("BST: July slots carry +01:00, winter slots +00:00", () => {
  const july = wallTimeToInstant("2026-07-11", "14:00", "Europe/London");
  assert.equal(toZonedISO(july, "Europe/London"), "2026-07-11T14:00:00+01:00");
  const winter = wallTimeToInstant("2026-12-12", "14:00", "Europe/London");
  assert.equal(toZonedISO(winter, "Europe/London"), "2026-12-12T14:00:00+00:00");
});

test("BST transition days: 29 March 2026 (clocks forward) and 25 October 2026 (back)", () => {
  // Offsets flip at 01:00 UTC on both dates.
  assert.equal(offsetMinutes(new Date("2026-03-29T00:30:00Z"), "Europe/London"), 0);
  assert.equal(offsetMinutes(new Date("2026-03-29T01:30:00Z"), "Europe/London"), 60);
  assert.equal(offsetMinutes(new Date("2026-10-25T00:30:00Z"), "Europe/London"), 60);
  assert.equal(offsetMinutes(new Date("2026-10-25T01:30:00Z"), "Europe/London"), 0);
  // A 10:00 wall-clock slot resolves to the correct instant either side.
  assert.equal(
    toZonedISO(wallTimeToInstant("2026-03-29", "10:00", "Europe/London"), "Europe/London"),
    "2026-03-29T10:00:00+01:00"
  );
  assert.equal(
    toZonedISO(wallTimeToInstant("2026-10-25", "10:00", "Europe/London"), "Europe/London"),
    "2026-10-25T10:00:00+00:00"
  );
});

test("order counting ignores Delivery and cancelled orders", () => {
  const counts = buildOrderCounts([
    { cancelled: false, isPickup: true, attributes: { ibc_pickup_requested: "true", ibc_pickup_date: "2026-07-11", ibc_pickup_slot_start: "2026-07-11T14:00:00+01:00" } },
    { cancelled: false, isPickup: false, attributes: { ibc_pickup_requested: "true", ibc_pickup_date: "2026-07-11", ibc_pickup_slot_start: "2026-07-11T14:00:00+01:00" } },
    { cancelled: true, isPickup: true, attributes: { ibc_pickup_requested: "true", ibc_pickup_date: "2026-07-11", ibc_pickup_slot_start: "2026-07-11T14:00:00+01:00" } },
    { cancelled: false, isPickup: true, attributes: {} },
  ]);
  assert.equal(counts.byDate["2026-07-11"], 1);
  assert.equal(counts.bySlot["2026-07-11 14:00"], 1);
});

test("validation: end time before start time is rejected", () => {
  const errors = validateSettings(settings({
    weekly_hours: {
      ...settings().weekly_hours,
      tuesday: { enabled: true, start_time: "18:00", end_time: "10:00" },
    },
  }));
  assert.ok(errors["weekly_hours.tuesday.end_time"]);
});

test("validation: horizon, interval, cutoff, min value, limits", () => {
  const errors = validateSettings(settings({
    booking_horizon_days: 0,
    slot_interval_minutes: 45,
    same_day_pickup_cutoff_time: "25:99",
    minimum_pickup_order_value_enabled: true,
    minimum_pickup_order_value: -5,
    maximum_pickup_orders_per_day: 0.5,
  }));
  assert.ok(errors.booking_horizon_days);
  assert.ok(errors.slot_interval_minutes);
  assert.ok(errors.same_day_pickup_cutoff_time);
  assert.ok(errors.minimum_pickup_order_value);
  assert.ok(errors.maximum_pickup_orders_per_day);
});

test("validation: clean settings pass", () => {
  assert.deepEqual(validateSettings(settings()), {});
});

test("labels: meridiem stripped only when shared", () => {
  assert.equal(rangeLabel(14 * 60, 15 * 60), "2:00–3:00pm");
  assert.equal(rangeLabel(11 * 60 + 30, 12 * 60), "11:30am–12:00pm");
});

test("summary reads naturally", () => {
  const text = summarizeSettings(settings());
  assert.match(text, /Tuesday–Saturday/);
  assert.match(text, /Same-day collection closes at 3:00pm/);
});
