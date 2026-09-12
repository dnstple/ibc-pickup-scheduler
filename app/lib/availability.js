// Pure pickup-availability engine. No I/O — fully unit-testable.
// Shared by the app proxy (server) and the test suite.

import {
  zonedParts,
  wallTimeToInstant,
  toZonedISO,
  addDays,
  timeToMinutes,
  minutesToLabel,
  dateLabel,
} from "./timezone.js";
import {
  DEFAULT_DELIVERY,
  normalizeDelivery,
  validateDelivery,
} from "./delivery.js";

export const DEFAULT_PREP_MINUTES = 60; // fixed in v1 — deliberately not a setting
export const WEEKDAY_KEYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

export const DEFAULT_SETTINGS = {
  timezone: "Europe/London",
  // Master switch for click-and-collect. When false the basket hides the
  // collection tile entirely and every rule below stops mattering.
  pickup_enabled: true,
  booking_horizon_days: 14,
  slot_interval_minutes: 30,
  same_day_pickup_enabled: true,
  same_day_pickup_cutoff_time: "15:00",
  minimum_pickup_order_value_enabled: false,
  minimum_pickup_order_value: null,
  maximum_pickup_orders_per_day: null,
  maximum_pickup_orders_per_slot: null,
  collection_location_name: "Italian Bear Chocolate",
  collection_instructions: "",
  customer_checkout_message:
    "At checkout, please select Pick up to confirm your collection time. " +
    "If you select Delivery instead, this collection time will not apply.",
  weekly_hours: Object.fromEntries(
    WEEKDAY_KEYS.map((d) => [d, { enabled: false, start_time: null, end_time: null }])
  ),
  blackout_dates: [], // [{ date, all_day, start_time, end_time, note }]
  capacity_overrides: [], // [{ date, slot_start (HH:MM or null = whole day), max_orders, note }]
  // The delivery half of fulfilment. See lib/delivery.js.
  delivery: DEFAULT_DELIVERY,
};

// Merge stored JSON with defaults so missing keys never break the engine.
export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  s.weekly_hours = { ...DEFAULT_SETTINGS.weekly_hours, ...(s.weekly_hours || {}) };
  for (const day of WEEKDAY_KEYS) {
    s.weekly_hours[day] = {
      enabled: false, start_time: null, end_time: null,
      ...(s.weekly_hours[day] || {}),
    };
  }
  s.blackout_dates = Array.isArray(s.blackout_dates) ? s.blackout_dates : [];
  s.capacity_overrides = Array.isArray(s.capacity_overrides) ? s.capacity_overrides : [];
  s.pickup_enabled = s.pickup_enabled !== false; // absent means on, for settings saved before this key existed
  s.delivery = normalizeDelivery(s.delivery);
  return s;
}

// Validate everything before saving. Returns { fieldPath: message } — empty when
// valid. Pickup and delivery are checked separately so that switching one off
// cannot be blocked by the other one's rules.
export function validateSettings(s) {
  const errors = {};
  if (!s.pickup_enabled && !s.delivery?.enabled) {
    errors.pickup_enabled =
      "Turn on collection or delivery. With both off, nobody can check out.";
  }
  if (s.pickup_enabled) {
    Object.assign(errors, validatePickupSettings(s));
  }
  Object.assign(errors, validateDelivery(normalizeDelivery(s.delivery)));
  return errors;
}

// The collection half. Only reached when pickup is switched on.
export function validatePickupSettings(s) {
  const errors = {};
  const horizon = Number(s.booking_horizon_days);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 90) {
    errors.booking_horizon_days = "Enter a whole number of days between 1 and 90.";
  }
  if (![15, 30, 60].includes(Number(s.slot_interval_minutes))) {
    errors.slot_interval_minutes = "Slot interval must be 15, 30 or 60 minutes.";
  }
  if (s.same_day_pickup_enabled && timeToMinutes(s.same_day_pickup_cutoff_time) === null) {
    errors.same_day_pickup_cutoff_time = "Enter a valid cut-off time (for example 15:00).";
  }
  if (!s.collection_location_name || !String(s.collection_location_name).trim()) {
    errors.collection_location_name = "Enter the collection location name.";
  }
  if (!s.customer_checkout_message || !String(s.customer_checkout_message).trim()) {
    errors.customer_checkout_message = "Enter the checkout reminder shown to customers.";
  }
  if (s.minimum_pickup_order_value_enabled) {
    const v = Number(s.minimum_pickup_order_value);
    if (!Number.isFinite(v) || v <= 0) {
      errors.minimum_pickup_order_value = "Enter a minimum order value greater than 0.";
    }
  }
  for (const [key, label] of [
    ["maximum_pickup_orders_per_day", "Maximum collections per day"],
    ["maximum_pickup_orders_per_slot", "Maximum collections per slot"],
  ]) {
    const v = s[key];
    if (v !== null && v !== undefined && v !== "") {
      if (!Number.isInteger(Number(v)) || Number(v) < 1) {
        errors[key] = `${label} must be a whole number of 1 or more, or left blank for no limit.`;
      }
    }
  }
  let anyDayEnabled = false;
  for (const day of WEEKDAY_KEYS) {
    const d = s.weekly_hours[day] || {};
    if (!d.enabled) continue;
    anyDayEnabled = true;
    const start = timeToMinutes(d.start_time);
    const end = timeToMinutes(d.end_time);
    if (start === null) errors[`weekly_hours.${day}.start_time`] = "Enter a valid start time.";
    if (end === null) errors[`weekly_hours.${day}.end_time`] = "Enter a valid end time.";
    if (start !== null && end !== null && end <= start) {
      errors[`weekly_hours.${day}.end_time`] =
        "Final collection slot must end after collection starts.";
    }
  }
  if (!anyDayEnabled) {
    errors.weekly_hours = "Enable collection on at least one day, or customers can never book.";
  }
  s.blackout_dates.forEach((b, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) {
      errors[`blackout_dates.${i}.date`] = "Enter a valid date.";
    }
    if (!b.all_day) {
      const from = timeToMinutes(b.start_time);
      const to = timeToMinutes(b.end_time);
      if (from === null) errors[`blackout_dates.${i}.start_time`] = "Enter a valid time.";
      if (to === null) errors[`blackout_dates.${i}.end_time`] = "Enter a valid time.";
      if (from !== null && to !== null && to <= from) {
        errors[`blackout_dates.${i}.end_time`] = "Closure must end after it starts.";
      }
    }
  });
  s.capacity_overrides.forEach((o, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.date || ""))) {
      errors[`capacity_overrides.${i}.date`] = "Enter a valid date.";
    }
    if (o.slot_start && timeToMinutes(o.slot_start) === null) {
      errors[`capacity_overrides.${i}.slot_start`] = "Enter a valid slot start time.";
    }
    if (!Number.isInteger(Number(o.max_orders)) || Number(o.max_orders) < 0) {
      errors[`capacity_overrides.${i}.max_orders`] = "Enter 0 or a positive whole number.";
    }
  });
  return errors;
}

// Highest product prep delay in the basket, with the 60-minute floor.
// Delays are never added together — the single largest value wins.
export function maxPrepDelayMinutes(items) {
  let max = DEFAULT_PREP_MINUTES;
  for (const item of items || []) {
    const v = Number(item.delayMinutes);
    if (Number.isInteger(v) && v > max) max = v;
  }
  return max;
}

// "2:00pm" + "3:00pm" -> "2:00–3:00pm"; "11:30am" + "12:00pm" -> "11:30am–12:00pm".
export function rangeLabel(startMins, endMins) {
  const start = minutesToLabel(startMins);
  const end = minutesToLabel(endMins);
  const sameSuffix = start.slice(-2) === end.slice(-2);
  return sameSuffix ? `${start.slice(0, -2)}–${end}` : `${start}–${end}`;
}

function blackoutsFor(settings, dateStr) {
  return settings.blackout_dates.filter((b) => b.date === dateStr);
}

function dayCapacity(settings, dateStr) {
  const override = settings.capacity_overrides.find(
    (o) => o.date === dateStr && !o.slot_start
  );
  if (override) return Number(override.max_orders);
  const v = settings.maximum_pickup_orders_per_day;
  return v === null || v === undefined || v === "" ? Infinity : Number(v);
}

function slotCapacity(settings, dateStr, slotStartTime) {
  const override = settings.capacity_overrides.find(
    (o) => o.date === dateStr && o.slot_start === slotStartTime
  );
  if (override) return Number(override.max_orders);
  const v = settings.maximum_pickup_orders_per_slot;
  return v === null || v === undefined || v === "" ? Infinity : Number(v);
}

/**
 * Compute the full pickup availability picture for a cart.
 *
 * @param {object} args
 * @param {object} args.settings   raw settings JSON (normalized internally)
 * @param {Date}   args.now        current instant
 * @param {object} args.cart       { totalPence, items: [{ delayMinutes, pickupAvailable }] }
 * @param {object} args.orderCounts{ byDate: {"YYYY-MM-DD": n}, bySlot: {"YYYY-MM-DD HH:MM": n} }
 *                                 counts derived from existing Shopify pickup orders
 * @returns availability response consumed by the theme scheduler
 */
export function computeAvailability({ settings: rawSettings, now, cart, orderCounts }) {
  const settings = normalizeSettings(rawSettings);
  const tz = settings.timezone || "Europe/London";
  const counts = { byDate: {}, bySlot: {}, ...(orderCounts || {}) };
  const items = (cart && cart.items) || [];

  const base = {
    timezone: tz,
    location: settings.collection_location_name,
    instructions: settings.collection_instructions,
    checkout_message: settings.customer_checkout_message,
    max_delay_minutes: maxPrepDelayMinutes(items),
    slot_interval_minutes: Number(settings.slot_interval_minutes),
  };

  // Any product explicitly flagged pickup_available = false blocks the scheduler.
  if (items.some((i) => i.pickupAvailable === false)) {
    return { ...base, eligible: false, reason: "products_unavailable", dates: [] };
  }

  // Minimum order value gate.
  if (settings.minimum_pickup_order_value_enabled) {
    const minPence = Math.round(Number(settings.minimum_pickup_order_value) * 100);
    if (Number.isFinite(minPence) && Number(cart?.totalPence ?? 0) < minPence) {
      return {
        ...base,
        eligible: false,
        reason: "below_minimum",
        minimum_value_pence: minPence,
        dates: [],
      };
    }
  }

  const nowLocal = zonedParts(now, tz);
  const todayStr = nowLocal.dateStr;
  const earliestInstant = new Date(now.getTime() + base.max_delay_minutes * 60000);
  const interval = Number(settings.slot_interval_minutes) || 30;
  const horizon = Number(settings.booking_horizon_days) || 14;
  const cutoff = timeToMinutes(settings.same_day_pickup_cutoff_time);

  const dates = [];
  for (let offset = 0; offset < horizon; offset += 1) {
    const dateStr = addDays(todayStr, offset);
    const isToday = offset === 0;

    // Same-day rules.
    if (isToday) {
      if (!settings.same_day_pickup_enabled) continue;
      if (cutoff !== null && nowLocal.minutesOfDay >= cutoff) continue;
    }

    // Weekly hours.
    const { weekday, label } = dateLabel(dateStr);
    const day = settings.weekly_hours[weekday.toLowerCase()];
    if (!day || !day.enabled) continue;
    const dayStart = timeToMinutes(day.start_time);
    const dayEnd = timeToMinutes(day.end_time);
    if (dayStart === null || dayEnd === null || dayEnd <= dayStart) continue;

    // Blackouts.
    const blackouts = blackoutsFor(settings, dateStr);
    if (blackouts.some((b) => b.all_day)) continue;

    // Day-level capacity.
    const dayMax = dayCapacity(settings, dateStr);
    const dayUsed = Number(counts.byDate[dateStr] || 0);
    if (dayUsed >= dayMax) continue;

    // Build slots.
    const slots = [];
    for (let t = dayStart; t + interval <= dayEnd; t += interval) {
      const slotStartTime = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
      const startInstant = wallTimeToInstant(dateStr, slotStartTime, tz);

      // Preparation delay: slot must start at or after now + max delay.
      if (startInstant.getTime() < earliestInstant.getTime()) continue;

      // Partial closures block any overlapping slot.
      const tEnd = t + interval;
      const blocked = blackouts.some((b) => {
        if (b.all_day) return true;
        const from = timeToMinutes(b.start_time);
        const to = timeToMinutes(b.end_time);
        if (from === null || to === null) return false;
        return t < to && tEnd > from; // overlap
      });
      if (blocked) continue;

      // Slot-level capacity.
      const slotMax = slotCapacity(settings, dateStr, slotStartTime);
      const slotUsed = Number(counts.bySlot[`${dateStr} ${slotStartTime}`] || 0);
      if (slotUsed >= slotMax) continue;

      const endInstant = new Date(startInstant.getTime() + interval * 60000);
      const timeLabel = rangeLabel(t, tEnd);
      slots.push({
        start_time: slotStartTime,
        start_iso: toZonedISO(startInstant, tz),
        end_iso: toZonedISO(endInstant, tz),
        time_label: timeLabel,
        label: `${label}, ${timeLabel}`,
      });
    }

    if (slots.length > 0) {
      dates.push({ date: dateStr, weekday, date_label: label, is_today: isToday, slots });
    }
  }

  return { ...base, eligible: true, reason: null, dates };
}

// Turn stored Shopify pickup orders into capacity counts.
// orders: [{ cancelled, isPickup, attributes: { ibc_pickup_date, ibc_pickup_slot_start } }]
export function buildOrderCounts(orders, timeZone = "Europe/London") {
  const byDate = {};
  const bySlot = {};
  for (const o of orders || []) {
    if (o.cancelled) continue;
    if (o.isPickup === false) continue; // Delivery orders: ignore pickup attributes entirely
    const attrs = o.attributes || {};
    if (String(attrs.ibc_pickup_requested) !== "true") continue;
    const date = attrs.ibc_pickup_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) continue;
    byDate[date] = (byDate[date] || 0) + 1;
    const startIso = String(attrs.ibc_pickup_slot_start || "");
    const m = /T(\d{2}:\d{2})/.exec(startIso);
    if (m) {
      const key = `${date} ${m[1]}`;
      bySlot[key] = (bySlot[key] || 0) + 1;
    }
  }
  return { byDate, bySlot };
}

// Human summary used by the admin app ("current rules" banner).
export function summarizeSettings(rawSettings) {
  const s = normalizeSettings(rawSettings);
  const dayNames = {
    monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
    thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
  };
  const enabled = WEEKDAY_KEYS.filter((d) => s.weekly_hours[d]?.enabled);
  if (enabled.length === 0) {
    return "Collection is currently unavailable — no days are enabled.";
  }
  // Collapse consecutive runs (Monday-first week order).
  const runs = [];
  let run = null;
  WEEKDAY_KEYS.forEach((d, i) => {
    if (s.weekly_hours[d]?.enabled) {
      if (run && run.end === i - 1) run.end = i;
      else { run = { start: i, end: i }; runs.push(run); }
    }
  });
  const rangeText = runs
    .map((r) =>
      r.start === r.end
        ? dayNames[WEEKDAY_KEYS[r.start]]
        : `${dayNames[WEEKDAY_KEYS[r.start]]}–${dayNames[WEEKDAY_KEYS[r.end]]}`
    )
    .join(", ");
  let text = `Collection is currently available ${rangeText}.`;
  if (s.same_day_pickup_enabled) {
    const cutoffMins = timeToMinutes(s.same_day_pickup_cutoff_time);
    if (cutoffMins !== null) {
      text += ` Same-day collection closes at ${minutesToLabel(cutoffMins)}.`;
    }
  } else {
    text += " Same-day collection is off.";
  }
  if (s.minimum_pickup_order_value_enabled && Number(s.minimum_pickup_order_value) > 0) {
    text += ` Minimum order value: £${Number(s.minimum_pickup_order_value).toFixed(2)}.`;
  }
  return text;
}
