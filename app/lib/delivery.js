// Delivery rules. The other half of fulfilment.
//
// These live in the SAME shop metafield as the pickup rules
// (custom.pickup_scheduler_settings) under a nested "delivery" key, so there is
// one save, one backup and one thing for the theme to read. Adding a nested key
// is additive: anything that does not know about it carries on unchanged.
//
// Pure — no I/O, fully unit-testable.

import { timeToMinutes, addDays } from "./timezone.js";

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
  // Working days between ordering and the earliest date the calendar offers.
  lead_days: 2,
  // How far ahead the delivery calendar runs, in calendar days.
  horizon_days: 60,
  // Weekdays couriers do not deliver, as Sunday=0 indices.
  closed_weekdays: [0],
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

  d.blackout_dates = Array.isArray(d.blackout_dates) ? d.blackout_dates : [];

  return d;
}

export function validateDelivery(d) {
  const errors = {};
  if (!d.enabled) return errors; // nothing below matters when delivery is off

  if (!d.standard_enabled && !d.dated_enabled) {
    errors["delivery.enabled"] =
      "Turn on standard shipping or dated delivery, or customers have no " +
      "shipping choice at all.";
  }

  const lead = Number(d.lead_days);
  if (!Number.isInteger(lead) || lead < 0 || lead > 30) {
    errors["delivery.lead_days"] = "Enter a whole number of working days between 0 and 30.";
  }

  const horizon = Number(d.horizon_days);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 365) {
    errors["delivery.horizon_days"] = "Enter a whole number of days between 1 and 365.";
  }

  if (d.closed_weekdays.length >= 7) {
    errors["delivery.closed_weekdays"] =
      "Couriers cannot be closed every day. Leave at least one weekday open.";
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
 * Counts lead_days forward, skipping closed weekdays, then skips blackout
 * dates. Mirrors addWorkingDays() in assets/ibc-fulfilment.js — if you change
 * one, change both, or the basket and the admin preview will disagree.
 *
 * @param {object} d        normalized delivery settings
 * @param {string} todayStr "YYYY-MM-DD" in the shop's timezone
 * @param {number|null} nowMinutes minutes past local midnight, for the cut-off
 */
export function earliestDeliveryDate(d, todayStr, nowMinutes = null) {
  const closed = new Set(d.closed_weekdays.map(Number));
  const blacked = new Set(d.blackout_dates.map((b) => b.date));

  let cursor = todayStr;
  let remaining = Number(d.lead_days) || 0;

  // Past the cut-off, today does not count towards the lead time.
  if (d.cutoff_enabled && nowMinutes !== null) {
    const cutoff = timeToMinutes(d.cutoff_time);
    if (cutoff !== null && nowMinutes >= cutoff) cursor = addDays(cursor, 1);
  }

  let guard = 0;
  while (remaining > 0 && guard < 400) {
    cursor = addDays(cursor, 1);
    guard += 1;
    if (!closed.has(weekdayIndex(cursor))) remaining -= 1;
  }
  // The landing day itself must also be one the courier delivers on.
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

export function summarizeDelivery(rawDelivery, todayStr = null) {
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
    text +=
      ` The earliest date offered is ${lead} working ${lead === 1 ? "day" : "days"} ahead`;
    if (todayStr) {
      text += ` (${earliestDeliveryDate(d, todayStr)})`;
    }
    text += `, running ${d.horizon_days} days out.`;
    if (closedNames.length > 0) {
      text += ` No deliveries on ${closedNames.join(", ")}.`;
    }
    if (d.blackout_dates.length > 0) {
      text += ` ${d.blackout_dates.length} blocked ${
        d.blackout_dates.length === 1 ? "date" : "dates"
      }.`;
    }
  }
  if (d.cutoff_enabled) {
    text += ` Orders after ${d.cutoff_time} count from the next day.`;
  }
  return text;
}
