// Delivery rules. Run with: node --test tests/delivery.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DELIVERY,
  normalizeDelivery,
  validateDelivery,
  earliestDeliveryDate,
  weekdayIndex,
  summarizeDelivery,
} from "../app/lib/delivery.js";
import {
  normalizeSettings,
  validateSettings,
  DEFAULT_SETTINGS,
} from "../app/lib/availability.js";

const openWeek = Object.fromEntries(
  ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [
    d,
    { enabled: true, start_time: "10:00", end_time: "21:00" },
  ])
);

function liveish(patch = {}) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    weekly_hours: openWeek,
    ...patch,
  });
}

test("weekdayIndex uses Sunday = 0 and is DST-proof", () => {
  assert.equal(weekdayIndex("2026-09-13"), 0); // Sunday
  assert.equal(weekdayIndex("2026-09-14"), 1); // Monday
  assert.equal(weekdayIndex("2026-09-19"), 6); // Saturday
  // The clocks go back on 2026-10-25 in the UK. A naive local Date would slip.
  assert.equal(weekdayIndex("2026-10-25"), 0);
  assert.equal(weekdayIndex("2026-03-29"), 0);
});

test("normalizeDelivery fills defaults and never returns a hostile shape", () => {
  const d = normalizeDelivery(null);
  assert.equal(d.lead_days, 2);
  assert.deepEqual(d.closed_weekdays, [0]);
  assert.deepEqual(d.blackout_dates, []);
  assert.equal(d.enabled, true);

  const junk = normalizeDelivery({ closed_weekdays: "hello", blackout_dates: "no" });
  assert.deepEqual(junk.closed_weekdays, []);
  assert.deepEqual(junk.blackout_dates, []);
});

test("closed_weekdays accepts the old comma string the theme used", () => {
  assert.deepEqual(normalizeDelivery({ closed_weekdays: "0,6" }).closed_weekdays, [0, 6]);
  assert.deepEqual(normalizeDelivery({ closed_weekdays: " 6 , 0 " }).closed_weekdays, [0, 6]);
});

test("closed_weekdays de-duplicates, sorts and drops out-of-range values", () => {
  const d = normalizeDelivery({ closed_weekdays: [6, 0, 6, 9, -1, "3"] });
  assert.deepEqual(d.closed_weekdays, [0, 3, 6]);
});

test("valid defaults produce no delivery errors", () => {
  assert.deepEqual(validateDelivery(normalizeDelivery(null)), {});
});

test("delivery switched off skips every other delivery rule", () => {
  const d = normalizeDelivery({ enabled: false, lead_days: -5, horizon_days: 0, caution: "" });
  assert.deepEqual(validateDelivery(d), {});
});

test("both shipping choices off is rejected", () => {
  const d = normalizeDelivery({ standard_enabled: false, dated_enabled: false });
  assert.ok(validateDelivery(d)["delivery.enabled"]);
});

test("lead and horizon are bounded", () => {
  assert.ok(validateDelivery(normalizeDelivery({ lead_days: -1 }))["delivery.lead_days"]);
  assert.ok(validateDelivery(normalizeDelivery({ lead_days: 2.5 }))["delivery.lead_days"]);
  assert.ok(validateDelivery(normalizeDelivery({ lead_days: 31 }))["delivery.lead_days"]);
  assert.ok(validateDelivery(normalizeDelivery({ horizon_days: 0 }))["delivery.horizon_days"]);
  assert.ok(validateDelivery(normalizeDelivery({ horizon_days: 366 }))["delivery.horizon_days"]);
  assert.equal(validateDelivery(normalizeDelivery({ lead_days: 0 }))["delivery.lead_days"], undefined);
});

test("closing all seven weekdays is rejected", () => {
  const d = normalizeDelivery({ closed_weekdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.ok(validateDelivery(d)["delivery.closed_weekdays"]);
});

test("basket wording cannot be saved blank", () => {
  const e = validateDelivery(normalizeDelivery({ standard_label: "  ", caution: "" }));
  assert.ok(e["delivery.standard_label"]);
  assert.ok(e["delivery.caution"]);
});

test("a cut-off time is only checked when the cut-off is on", () => {
  assert.equal(validateDelivery(normalizeDelivery({ cutoff_time: "nonsense" }))["delivery.cutoff_time"], undefined);
  assert.ok(
    validateDelivery(normalizeDelivery({ cutoff_enabled: true, cutoff_time: "nonsense" }))["delivery.cutoff_time"]
  );
});

test("blackout dates must be real dates", () => {
  const d = normalizeDelivery({ blackout_dates: [{ date: "25/12/2026" }, { date: "2026-12-25" }] });
  const e = validateDelivery(d);
  assert.ok(e["delivery.blackout_dates.0.date"]);
  assert.equal(e["delivery.blackout_dates.1.date"], undefined);
});

/* THE CASE THIS RULE WAS REWRITTEN FOR, kept first and named after the real
   conversation it came out of.

   Saturday the 12th. Couriers do not deliver Sunday or Monday. Two days to
   make and dispatch. The shop can bake on Sunday and Monday, hand it over on
   the Monday, and the customer gets it on the Tuesday — so Tuesday the 15th
   is the honest earliest date.

   The old rule counted the lead in DELIVERING days and answered Wednesday the
   16th, charging the closed Sunday and Monday twice: once for not counting,
   and again for not being landable. */
test("Saturday, couriers shut Sunday and Monday, two days' lead: Tuesday", () => {
  const d = normalizeDelivery({ lead_days: 2, closed_weekdays: [0, 1] });
  assert.equal(earliestDeliveryDate(d, "2026-09-12"), "2026-09-15");
});

test("and the same with the cut-off already passed, which cannot make it sooner", () => {
  const d = normalizeDelivery({
    lead_days: 2,
    closed_weekdays: [0, 1],
    cutoff_enabled: true,
    cutoff_time: "12:00",
  });
  // 12 -> 13 for the cut-off, + 2 = the 15th, a Tuesday, which is open.
  assert.equal(earliestDeliveryDate(d, "2026-09-12", 16 * 60), "2026-09-15");
  // Before noon: 12 + 2 = the 14th, a Monday, rolled to the 15th. Same answer,
  // because the closed Monday absorbs the difference.
  assert.equal(earliestDeliveryDate(d, "2026-09-12", 10 * 60), "2026-09-15");
});

test("the lead is calendar days, so a closed day does not lengthen it", () => {
  const d = normalizeDelivery({ lead_days: 2, closed_weekdays: [0] });
  // Thursday 17th + 2 = Saturday 19th, which is a delivering day.
  assert.equal(earliestDeliveryDate(d, "2026-09-17"), "2026-09-19");
  // Friday 18th + 2 = Sunday 20th, closed, so Monday 21st.
  assert.equal(earliestDeliveryDate(d, "2026-09-18"), "2026-09-21");
  // Saturday 19th + 2 = Monday 21st, open.
  assert.equal(earliestDeliveryDate(d, "2026-09-19"), "2026-09-21");
});

test("closing both weekend days moves the landing day, not the count", () => {
  const d = normalizeDelivery({ lead_days: 2, closed_weekdays: [0, 6] });
  // Thursday 17th + 2 = Saturday 19th, closed, Sunday closed, so Monday 21st.
  assert.equal(earliestDeliveryDate(d, "2026-09-17"), "2026-09-21");
  // Tuesday 15th + 2 = Thursday 17th, open. Untouched by the weekend.
  assert.equal(earliestDeliveryDate(d, "2026-09-15"), "2026-09-17");
});

test("earliest date never lands on a closed weekday", () => {
  const d = normalizeDelivery({ lead_days: 0, closed_weekdays: [0] });
  // Lead 0 on a Sunday must still move off the Sunday.
  assert.equal(earliestDeliveryDate(d, "2026-09-13"), "2026-09-14");
});

test("a lead of 0 offers today when today is deliverable", () => {
  const d = normalizeDelivery({ lead_days: 0, closed_weekdays: [0] });
  assert.equal(earliestDeliveryDate(d, "2026-09-15"), "2026-09-15");
});

test("earliest date steps over a blackout date", () => {
  const d = normalizeDelivery({
    lead_days: 2,
    closed_weekdays: [0],
    blackout_dates: [{ date: "2026-09-19", note: "no courier" }],
  });
  // 17 + 2 = the 19th, blocked; the 20th is a Sunday; so Monday the 21st.
  assert.equal(earliestDeliveryDate(d, "2026-09-17"), "2026-09-21");
});

test("the cut-off pushes the start to tomorrow, and only when enabled", () => {
  const on = normalizeDelivery({ lead_days: 1, cutoff_enabled: true, cutoff_time: "14:00" });
  // Thursday 17th, 13:00 -> starts today -> Friday 18th.
  assert.equal(earliestDeliveryDate(on, "2026-09-17", 13 * 60), "2026-09-18");
  // 15:00 -> starts tomorrow -> Saturday 19th.
  assert.equal(earliestDeliveryDate(on, "2026-09-17", 15 * 60), "2026-09-19");
  const off = normalizeDelivery({ lead_days: 1, cutoff_enabled: false, cutoff_time: "14:00" });
  assert.equal(earliestDeliveryDate(off, "2026-09-17", 15 * 60), "2026-09-18");
});

test("a cut-off with no clock passed in is ignored rather than guessed", () => {
  const d = normalizeDelivery({ lead_days: 1, cutoff_enabled: true, cutoff_time: "00:01" });
  assert.equal(earliestDeliveryDate(d, "2026-09-17"), "2026-09-18");
});

test("the earliest-date walk always terminates", () => {
  const d = normalizeDelivery({ lead_days: 30, closed_weekdays: [0, 1, 2, 3, 4, 5] });
  const got = earliestDeliveryDate(d, "2026-09-17");
  assert.match(got, /^\d{4}-\d{2}-\d{2}$/);
});

test("summary reads as a sentence, names the date and the closed days", () => {
  const text = summarizeDelivery({ lead_days: 2, closed_weekdays: [0, 6] }, "2026-09-17");
  assert.match(text, /standard shipping and a chosen delivery date/);
  assert.match(text, /needs 2 days to get an order out/);
  assert.match(text, /Monday 21 September/);
  assert.match(text, /No deliveries on Sunday, Saturday/);
});

test("the summary applies the cut-off when given the time", () => {
  const rules = { lead_days: 1, closed_weekdays: [], cutoff_enabled: true, cutoff_time: "12:00" };
  assert.match(summarizeDelivery(rules, "2026-09-17", 10 * 60), /Friday 18 September/);
  assert.match(summarizeDelivery(rules, "2026-09-17", 14 * 60), /Saturday 19 September/);
});

test("summary says so plainly when delivery is off", () => {
  assert.match(summarizeDelivery({ enabled: false }), /switched off/);
});

// --- the two halves together --------------------------------------------------

test("settings saved before this release gain delivery defaults, unchanged", () => {
  const legacy = {
    timezone: "Europe/London",
    booking_horizon_days: 14,
    slot_interval_minutes: 30,
    weekly_hours: openWeek,
    collection_location_name: "Italian Bear Chocolate",
    customer_checkout_message: "x",
  };
  const s = normalizeSettings(legacy);
  assert.equal(s.pickup_enabled, true, "absent pickup_enabled must mean on");
  assert.deepEqual(s.delivery, DEFAULT_DELIVERY);
  // And every pickup value the storefront already reads is untouched.
  assert.equal(s.booking_horizon_days, 14);
  assert.equal(s.slot_interval_minutes, 30);
  assert.equal(s.collection_location_name, "Italian Bear Chocolate");
  assert.equal(s.weekly_hours.sunday.enabled, true);
});

test("turning pickup off stops pickup rules blocking a save", () => {
  const s = liveish({ pickup_enabled: false, weekly_hours: DEFAULT_SETTINGS.weekly_hours });
  assert.deepEqual(validateSettings(s), {});
});

test("turning both halves off is refused", () => {
  const s = liveish({ pickup_enabled: false, delivery: { enabled: false } });
  assert.ok(validateSettings(s).pickup_enabled);
});

test("a delivery error surfaces through the top-level validator", () => {
  const s = liveish({ delivery: { lead_days: 99 } });
  assert.ok(validateSettings(s)["delivery.lead_days"]);
});

test("pickup errors still surface when pickup is on", () => {
  const s = liveish({ booking_horizon_days: 0 });
  assert.ok(validateSettings(s).booking_horizon_days);
});
