// Delivery rules. The other half of fulfilment.
//
// These live in the SAME shop metafield as the pickup rules
// (custom.pickup_scheduler_settings) under a nested "delivery" key, so there is
// one save, one backup and one thing for the theme to read. Adding a nested key
// is additive: anything that does not know about it carries on unchanged.
//
// Pure — no I/O, fully unit-testable.

import { timeToMinutes, addDays, dateLabel } from "./timezone.js";
import { DEFAULT_SAMEDAY, normalizeSameday, validateSameday } from "./sameday.js";
import { DEFAULT_BOOKING, normalizeBooking, validateBooking } from "./courier-booking.js";

// Sunday is 0 through Saturday is 6, matching JavaScript's getDay() and the
// theme's data-delivery-closed-days attribute. Do not renumber this: the
// storefront already reads these values.
export const WEEKDAY_INDEX_LABELS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

export const DEFAULT_DELIVERY = {
  enabled: true,
  // The plain "UK-wide shipping, 2-3 business days" choice.
  standard_enabled: true,
  // The "choose a delivery date" calendar.
  dated_enabled: true,
  // CALENDAR days between ordering and the earliest date the calendar offers.
  // Not "working days": see earliestDeliveryDate for why.
  lead_days: 2,
  // How far ahead the delivery calendar runs, in calendar days.
  horizon_days: 60,
  // Weekdays couriers do not deliver, as Sunday=0 indices.
  closed_weekdays: [0],
  // Weekdays a PERISHABLE item additionally cannot arrive on, same indices.
  //
  // A cake is not restricted by which days a courier runs. It is restricted by
  // how many nights it spends in the network, and a day is only reachable in
  // one night if the shop dispatches the day before. So the two rules are
  // different questions and want different lists:
  //
  //   closed_weekdays             nothing at all can be delivered
  //   perishable_closed_weekdays  a cake cannot, though chocolate can
  //
  // The second is added to the first, never instead of it, so a day closed
  // shop-wide stays closed for everything.
  //
  // DEFAULTED IN normalizeDelivery TO WHATEVER closed_weekdays HOLDS, not to a
  // literal here. A shop that saved its settings before this key existed must
  // keep its cakes exactly as restricted as they were, and the only value that
  // guarantees that is the one it already had. See the note there.
  perishable_closed_weekdays: null,
  // Orders placed after this local time count from the next day.
  cutoff_enabled: false,
  cutoff_time: "14:00",
  // Dates no delivery can be requested for, e.g. bank holidays.
  blackout_dates: [], // [{ date, note }]
  // Copy shown in the basket. Kept here so wording is a save, not a deploy.
  standard_label: "UK-wide shipping, 2–3 business days",
  standard_note: "Sent by tracked courier. Arrives in 2–3 business days.",
  scheduled_label: "Choose a delivery date",
  scheduled_note: "Pick the day you would like it to arrive.",
  caution:
    "Shipping services can experience delays. We recommend delivering a day " +
    "earlier than you need.",
  // The third shipping choice: a London courier, today. See lib/sameday.js.
  // Nested here rather than beside `delivery` because it IS a delivery speed,
  // and because the basket shows all three in one tile.
  sameday: DEFAULT_SAMEDAY,

  // What happens AFTER a same-day order is paid for: whether a rider is
  // booked automatically, and the price above which the shop is asked first.
  // Separate from `sameday` because that block is about what the customer is
  // offered and this one is about what the shop spends.
  booking: DEFAULT_BOOKING,
};

export function normalizeDelivery(raw) {
  const d = { ...DEFAULT_DELIVERY, ...(raw && typeof raw === "object" ? raw : {}) };

  // closed_weekdays tolerates the two shapes that have existed: an array of
  // numbers, and the comma string the theme used before this app owned it.
  let days = d.closed_weekdays;
  if (typeof days === "string") {
    days = days.split(",");
  }
  if (!Array.isArray(days)) {
    days = DEFAULT_DELIVERY.closed_weekdays;
  }
  d.closed_weekdays = [
    ...new Set(
      days
        .map((v) => Number(String(v).trim()))
        .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)
    ),
  ].sort((a, b) => a - b);

  // PERISHABLE DAYS INHERIT THE SHOP-WIDE LIST WHEN UNSET.
  //
  // null means "this shop has never been asked the question". Every such shop
  // was, until now, restricting cakes and chocolate identically, so inheriting
  // closed_weekdays reproduces its current behaviour exactly and the upgrade
  // is invisible. An explicit [] is a different statement -- "cakes have no
  // extra restriction" -- and is honoured.
  //
  // Note this runs AFTER closed_weekdays has been cleaned above, so the
  // inherited list is already normalized.
  let pDays = d.perishable_closed_weekdays;
  if (pDays === null || pDays === undefined) {
    pDays = d.closed_weekdays;
  }
  if (typeof pDays === "string") {
    pDays = pDays.split(",");
  }
  if (!Array.isArray(pDays)) {
    pDays = d.closed_weekdays;
  }
  d.perishable_closed_weekdays = [
    ...new Set(
      pDays
        .map((v) => Number(String(v).trim()))
        .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)
    ),
  ].sort((a, b) => a - b);

  d.blackout_dates = Array.isArray(d.blackout_dates) ? d.blackout_dates : [];
  d.sameday = normalizeSameday(d.sameday);
  d.booking = normalizeBooking(d.booking);

  return d;
}

export function validateDelivery(d) {
  const errors = {};
  if (!d.enabled) return errors; // nothing below matters when delivery is off

  if (!d.standard_enabled && !d.dated_enabled && !d.sameday.enabled) {
    errors["delivery.enabled"] =
      "Turn on standard shipping, dated delivery or same-day, or customers " +
      "have no shipping choice at all.";
  }

  Object.assign(errors, validateSameday(d.sameday));
  Object.assign(errors, validateBooking(d.booking));

  const lead = Number(d.lead_days);
  if (!Number.isInteger(lead) || lead < 0 || lead > 30) {
    errors["delivery.lead_days"] = "Enter a whole number of days between 0 and 30.";
  }

  const horizon = Number(d.horizon_days);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 365) {
    errors["delivery.horizon_days"] = "Enter a whole number of days between 1 and 365.";
  }

  if (d.closed_weekdays.length >= 7) {
    errors["delivery.closed_weekdays"] =
      "Couriers cannot be closed every day. Leave at least one weekday open.";
  }

  // THE TWO LISTS ADD UP, so the check is on the union rather than on the
  // perishable list alone. Three shop-wide closed days and four perishable
  // ones are each individually fine and together mean no cake can ever be
  // delivered -- which the calendar would render as sixty greyed-out squares
  // and no explanation.
  const perishableUnion = new Set([
    ...d.closed_weekdays.map(Number),
    ...d.perishable_closed_weekdays.map(Number),
  ]);
  if (perishableUnion.size >= 7) {
    errors["delivery.perishable_closed_weekdays"] =
      "Between them, these two lists close every day of the week, so a " +
      "perishable item could never be delivered. Open a day.";
  }

  if (d.cutoff_enabled && timeToMinutes(d.cutoff_time) === null) {
    errors["delivery.cutoff_time"] = "Enter a valid cut-off time (for example 14:00).";
  }

  for (const key of ["standard_label", "scheduled_label", "caution"]) {
    if (!d[key] || !String(d[key]).trim()) {
      errors[`delivery.${key}`] = "This wording appears in the basket and cannot be blank.";
    }
  }

  d.blackout_dates.forEach((b, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) {
      errors[`delivery.blackout_dates.${i}.date`] = "Enter a valid date.";
    }
  });

  // A rule set that can never offer a date is worse than one that errors, so
  // say so here rather than let the basket render an empty calendar.
  if (d.dated_enabled && !hasAnyOpenDay(d)) {
    errors["delivery.horizon_days"] =
      "With these closed weekdays and this horizon, no delivery date can ever " +
      "be offered. Widen the horizon or open a weekday.";
  }

  return errors;
}

// Does at least one date inside the horizon survive the closed weekdays?
// Cheap because the horizon is capped at 365.
function hasAnyOpenDay(d) {
  const closed = new Set(d.closed_weekdays.map(Number));
  const horizon = Number(d.horizon_days);
  if (!Number.isInteger(horizon) || horizon < 1) return false;
  for (let i = 0; i < Math.min(horizon, 14); i += 1) {
    // Weekday identity repeats every 7 days, so 14 is more than enough.
    if (!closed.has(i % 7)) return true;
  }
  return closed.size < 7;
}

/**
 * The earliest delivery date the calendar should offer.
 *
 * TWO STEPS, IN THIS ORDER, AND THEY ARE DIFFERENT QUESTIONS.
 *
 *   1. LEAD TIME IS CALENDAR DAYS. It is how long the shop needs to make the
 *      order and get it to the courier, and that is time on a clock — the
 *      courier being shut on Monday does not make a cake take longer to bake.
 *      So the count does not skip closed days.
 *
 *   2. THEN ROLL FORWARD TO A DAY THE COURIER ACTUALLY DELIVERS, stepping over
 *      closed weekdays and blocked dates.
 *
 * Worked through on a Saturday the 12th, lead 2, couriers closed Sunday and
 * Monday: 12 + 2 = the 14th, which is a Monday, so it rolls to Tuesday the
 * 15th. Ship on the Monday, arrive on the Tuesday.
 *
 * IT USED TO COUNT THE LEAD IN DELIVERING DAYS, which gave Wednesday the 16th
 * on that same Saturday — a day later than the shop can actually do it, because
 * the closed Sunday and Monday were charged twice: once by not counting towards
 * the lead, and again by not being deliverable. One closed day should cost one
 * day, not two.
 *
 * Mirrored by minDate() plus dayState() in assets/ibc-fulfilment.js: that pair
 * does step 1 as a plain day count and lets the calendar's own closed-day
 * shading do step 2. If you change this, change those.
 *
 * @param {object} d        normalized delivery settings
 * @param {string} todayStr "YYYY-MM-DD" in the shop's timezone
 * @param {number|null} nowMinutes minutes past local midnight, for the cut-off
 */
export function earliestDeliveryDate(d, todayStr, nowMinutes = null) {
  const closed = new Set(d.closed_weekdays.map(Number));
  const blacked = new Set(d.blackout_dates.map((b) => b.date));

  let cursor = todayStr;

  // Past the cut-off, today is gone: the lead time starts counting tomorrow.
  if (d.cutoff_enabled && nowMinutes !== null) {
    const cutoff = timeToMinutes(d.cutoff_time);
    if (cutoff !== null && nowMinutes >= cutoff) cursor = addDays(cursor, 1);
  }

  // Step 1: the shop's own time, in plain days.
  const lead = Number(d.lead_days);
  cursor = addDays(cursor, Number.isFinite(lead) && lead > 0 ? Math.floor(lead) : 0);

  // Step 2: the first day from there that a courier will actually deliver on.
  let guard = 0;
  while ((closed.has(weekdayIndex(cursor)) || blacked.has(cursor)) && guard < 400) {
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return cursor;
}

// Sunday = 0. Midday-anchored so a DST change cannot shift the date.
export function weekdayIndex(dateStr) {
  const [y, m, day] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day, 12, 0, 0)).getUTCDay();
}

export function summarizeDelivery(rawDelivery, todayStr = null, nowMinutes = null) {
  const d = normalizeDelivery(rawDelivery);
  if (!d.enabled) return "Delivery is switched off. Only collection is offered.";

  const parts = [];
  if (d.standard_enabled) parts.push("standard shipping");
  if (d.dated_enabled) parts.push("a chosen delivery date");
  let text = `Delivery offers ${parts.join(" and ")}.`;

  if (d.dated_enabled) {
    const closedNames = d.closed_weekdays
      .map((i) => WEEKDAY_INDEX_LABELS[i])
      .filter(Boolean);
    const lead = Number(d.lead_days);
    text += ` It needs ${lead} ${lead === 1 ? "day" : "days"} to get an order out`;
    if (todayStr) {
      const iso = earliestDeliveryDate(d, todayStr, nowMinutes);
      text += `, so the earliest date on offer right now is ${dateLabel(iso).label}`;
    }
    text += `. The calendar runs ${d.horizon_days} days out.`;
    if (closedNames.length > 0) {
      text += ` No deliveries on ${closedNames.join(", ")}.`;
    }

    // Only the days perishables lose ON TOP of the shop-wide ones are worth
    // saying. Repeating a day already named above reads as a contradiction.
    const perishableOnly = d.perishable_closed_weekdays
      .filter((i) => !d.closed_weekdays.includes(i))
      .map((i) => WEEKDAY_INDEX_LABELS[i])
      .filter(Boolean);
    if (perishableOnly.length > 0) {
      text += ` Perishable items also cannot arrive on ${perishableOnly.join(", ")}.`;
    }
    if (d.blackout_dates.length > 0) {
      text += ` ${d.blackout_dates.length} blocked ${
        d.blackout_dates.length === 1 ? "date" : "dates"
      }.`;
    }
  }
  if (d.cutoff_enabled) {
    text += ` Orders after ${d.cutoff_time} start counting from the next day.`;
  }
  return text;
}
