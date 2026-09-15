// Same-day courier delivery. The third shipping choice.
//
// Lives inside the delivery settings, in the SAME shop metafield as everything
// else (custom.pickup_scheduler_settings → delivery → sameday), so there is one
// save, one backup and one thing for the theme to read.
//
// WHY THE POSTCODES ARE HERE AS WELL AS IN SHOPIFY
// ------------------------------------------------
// Shopify's Local delivery settings are what ACTUALLY gate the rate at
// checkout, decided server-side from the real address. This copy exists so the
// basket can answer "can you reach me?" before checkout, without a network
// call. Two lists, one truth — the admin screen says so on the page rather than
// letting a mismatch be found by a customer.
//
// Shopify's Admin API does not expose local delivery at all, so the two cannot
// be reconciled automatically. They are kept in step by hand, and that is a
// known cost of this design rather than an oversight.
//
// Pure — no I/O, fully unit-testable.

import { timeToMinutes, rangeLabel } from "./timezone.js";

/**
 * The eight London districts that are ALWAYS sub-divided.
 *
 * There is no such postcode as "W1 2AB" — only W1A, W1B, W1T and so on. So a
 * bare "W1" in Shopify's postcode field matches NOTHING, silently, and the
 * same-day rate simply never appears. It looks like a valid outward code to
 * any pattern check, which is exactly why it needs naming.
 *
 * E1, N1, NW1, SE1 are deliberately absent: those are real outward codes in
 * their own right as well as having sub-divisions.
 */
export const ALWAYS_SUBDIVIDED = ["EC1", "EC2", "EC3", "EC4", "SW1", "W1", "WC1", "WC2"];

/**
 * Zones as measured from 29 Rathbone Place, priced from twenty-four real Gophr
 * quotes taken on 14 September 2026. Every price covers the worst case in its
 * zone — weekend, cake, furthest point — with at least £2.40 left after VAT.
 *
 * ⚠️ Shopify matches a whole postcode area or a COMPLETE outward code. The
 * asterisk range its dialog offers is a trap here, not a shortcut: "W1*" also
 * catches W10 to W14, which is Notting Hill out to Ealing. Same for SW1*, N1*,
 * E1* and SE1*. Spelled out is the only safe form.
 */
export const DEFAULT_ZONES = [
  {
    id: "A",
    name: "Zone A — Fitzrovia, Soho, Mayfair, Bloomsbury, Covent Garden",
    price: "12.95",
    outwards: [
      "W1A", "W1B", "W1C", "W1D", "W1F", "W1G", "W1H", "W1J", "W1K", "W1S",
      "W1T", "W1U", "W1W",
      "WC1A", "WC1B", "WC1E", "WC1H", "WC1N", "WC1R", "WC1V", "WC1X",
      "WC2A", "WC2B", "WC2E", "WC2H", "WC2N", "WC2R",
    ],
  },
  {
    id: "B",
    name: "Zone B — the City, Islington, Camden, Westminster, Southwark",
    price: "15.95",
    outwards: [
      "EC1A", "EC1M", "EC1N", "EC1R", "EC1V", "EC1Y",
      "EC2A", "EC2M", "EC2N", "EC2R", "EC2V", "EC2Y",
      "EC3A", "EC3M", "EC3N", "EC3R", "EC3V",
      "EC4A", "EC4M", "EC4N", "EC4R", "EC4V", "EC4Y",
      "N1", "N1C", "NW1", "NW8", "SE1", "SE11",
      "SW1A", "SW1E", "SW1H", "SW1P", "SW1V", "SW1W", "SW1X", "SW1Y",
      "W2", "W8", "W9", "SW3", "SW7",
    ],
  },
  {
    id: "C",
    name: "Zone C — the Zone 2 ring",
    price: "19.95",
    outwards: [
      "E1", "E1W", "E2", "E8", "E9",
      "N4", "N5", "N7", "N16",
      "NW3", "NW5", "NW6",
      "SE5", "SE8", "SE15", "SE16", "SE17",
      "SW4", "SW5", "SW6", "SW8", "SW9", "SW10", "SW11",
      "W4", "W6", "W10", "W11", "W12", "W14",
    ],
  },
];

export const DEFAULT_SAMEDAY = {
  // OFF. Turning this on is a deliberate act, and until it happens nothing in
  // the basket changes and the delivery-gate function's same-day branch stays
  // unreachable.
  enabled: false,

  // The last moment an order can be placed for delivery today.
  cutoff_time: "19:00",

  // Minutes between an order being placed and the earliest window opening:
  // preparation plus the courier getting here. Gophr's own realistic
  // door-to-door estimate on the six test journeys ran 38 to 62 minutes, and
  // preparation is 60, so 120 is honest rather than optimistic.
  lead_minutes: 120,

  // Length of each offered window.
  window_minutes: 120,

  // No window may end after this.
  day_end: "21:00",

  // The shortest final window worth offering. Without a floor, an order at
  // 20:50 is offered "8:50–9:00pm", which nobody can deliver.
  min_window_minutes: 45,

  // Offer a cheap catch-all alongside the fixed windows. It is the widest
  // promise and therefore the easiest to keep.
  open_window_enabled: true,
  open_window_label: "Any time before 9pm",

  // Copy, kept here so wording is a save rather than a deploy.
  label: "Same-day delivery",
  note: "By courier, today. Central London only.",
  postcode_prompt: "Enter your postcode to check we can reach you today.",
  out_of_area:
    "We only deliver same-day inside central London. Choose a delivery date " +
    "instead and we will post it.",
  too_late: "Same-day orders close at {cutoff}. Choose a delivery date instead.",

  zones: DEFAULT_ZONES,
};

/* ------------------------------------------------------------------ postcodes */

/**
 * Pull the outward code out of a UK postcode.
 *
 * UK postcodes are "outward inward" where inward is always three characters,
 * so the outward is everything except the last three. Splitting on the space is
 * unreliable because people leave it out.
 *
 * Returns null for anything that cannot be one, rather than guessing. A wrong
 * zone quotes a price for a journey nobody can make.
 */
export function outwardCode(postcode) {
  if (typeof postcode !== "string") return null;
  const cleaned = postcode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length < 5 || cleaned.length > 7) return null;
  const outward = cleaned.slice(0, cleaned.length - 3);
  if (!/^[A-Z]{1,2}[0-9][0-9A-Z]?$/.test(outward)) return null;
  return outward;
}

/** Which zone covers this postcode, or null. */
export function zoneForPostcode(postcode, zones) {
  const outward = outwardCode(postcode);
  if (!outward) return null;
  for (const zone of zones || []) {
    if ((zone.outwards || []).includes(outward)) return zone;
  }
  return null;
}

/** The list as Shopify wants it pasted into a Local delivery postcode field. */
export function shopifyPostcodeList(zone) {
  return (zone.outwards || []).join(", ");
}

/** Accepts a pasted list in any of the shapes a person might type. */
export function parseOutwards(raw) {
  if (Array.isArray(raw)) raw = raw.join(",");
  if (typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
}

/* ----------------------------------------------------------------- normalize */

export function normalizeSameday(raw) {
  const s = { ...DEFAULT_SAMEDAY, ...(raw && typeof raw === "object" ? raw : {}) };

  s.enabled = s.enabled === true;
  s.open_window_enabled = s.open_window_enabled !== false;

  for (const key of ["lead_minutes", "window_minutes", "min_window_minutes"]) {
    const n = Number(s[key]);
    s[key] = Number.isFinite(n) ? Math.floor(n) : DEFAULT_SAMEDAY[key];
  }

  s.zones = (Array.isArray(s.zones) ? s.zones : DEFAULT_ZONES).map((z, i) => ({
    id: String(z.id || String.fromCharCode(65 + i)),
    name: String(z.name || `Zone ${String.fromCharCode(65 + i)}`),
    price: String(z.price == null ? "" : z.price).trim(),
    outwards: parseOutwards(z.outwards),
  }));

  return s;
}

/* ------------------------------------------------------------------ validate */

export function validateSameday(s) {
  const errors = {};
  // Nothing below matters when it is switched off, and refusing to save an
  // incomplete draft would stop anyone setting it up gradually.
  if (!s.enabled) return errors;

  if (timeToMinutes(s.cutoff_time) === null) {
    errors["sameday.cutoff_time"] = "Enter a valid cut-off time (for example 19:00).";
  }
  if (timeToMinutes(s.day_end) === null) {
    errors["sameday.day_end"] = "Enter a valid last delivery time (for example 21:00).";
  }

  const lead = Number(s.lead_minutes);
  if (!Number.isInteger(lead) || lead < 30 || lead > 480) {
    errors["sameday.lead_minutes"] =
      "Enter between 30 and 480 minutes. Below 30 leaves no time to make the " +
      "order and get a rider here.";
  }

  const win = Number(s.window_minutes);
  if (!Number.isInteger(win) || win < 30 || win > 480) {
    errors["sameday.window_minutes"] = "Enter a window length between 30 and 480 minutes.";
  }

  const minWin = Number(s.min_window_minutes);
  if (!Number.isInteger(minWin) || minWin < 15 || minWin > win) {
    errors["sameday.min_window_minutes"] =
      "Enter between 15 minutes and the window length.";
  }

  const cutoff = timeToMinutes(s.cutoff_time);
  const end = timeToMinutes(s.day_end);
  if (cutoff !== null && end !== null && cutoff + lead > end + 1) {
    // Not an error — a shop may deliberately close orders early — but it does
    // mean the last hour before the cut-off can offer nothing, which looks
    // broken from the outside.
    errors["sameday.cutoff_time"] =
      `With a ${lead}-minute lead, an order at ${s.cutoff_time} could not be ` +
      `delivered by ${s.day_end}. Move the cut-off earlier or the last ` +
      `delivery later.`;
  }

  for (const key of ["label", "note", "out_of_area"]) {
    if (!s[key] || !String(s[key]).trim()) {
      errors[`sameday.${key}`] = "This wording appears in the basket and cannot be blank.";
    }
  }

  if (s.zones.length === 0) {
    errors["sameday.zones"] = "Add at least one zone, or same-day can never be offered.";
  }

  const seen = new Map();
  s.zones.forEach((z, i) => {
    if (!String(z.name || "").trim()) {
      errors[`sameday.zones.${i}.name`] = "Give the zone a name.";
    }

    const price = Number(z.price);
    if (!Number.isFinite(price) || price < 0) {
      errors[`sameday.zones.${i}.price`] = "Enter a price, for example 12.95.";
    }

    if (z.outwards.length === 0) {
      errors[`sameday.zones.${i}.outwards`] = "Add at least one postcode.";
    }

    for (const code of z.outwards) {
      if (!/^[A-Z]{1,2}[0-9][0-9A-Z]?$/.test(code)) {
        errors[`sameday.zones.${i}.outwards`] =
          `"${code}" is not a complete outward code. Use W1T, not W1 or W1*.`;
        break;
      }
      if (ALWAYS_SUBDIVIDED.includes(code)) {
        errors[`sameday.zones.${i}.outwards`] =
          `"${code}" is never a complete postcode on its own — the real codes ` +
          `are ${code}A, ${code}B and so on. Shopify would match nothing at ` +
          `all and same-day would silently never appear.`;
        break;
      }
      // An overlap makes the zone depend on list order, which is the kind of
      // bug that shows up on exactly one postcode months later.
      if (seen.has(code) && seen.get(code) !== i) {
        errors[`sameday.zones.${i}.outwards`] =
          `"${code}" is already in ${s.zones[seen.get(code)].name}. A postcode ` +
          `can only be in one zone.`;
        break;
      }
      seen.set(code, i);
    }
  });

  return errors;
}

/* -------------------------------------------------------------------- windows */

/**
 * The delivery windows a customer can be offered right now.
 *
 * @param {object} s            normalized same-day settings
 * @param {number} nowMinutes   minutes past local midnight
 * @param {object} openHours    { enabled, start_time, end_time } for today
 * @returns {{ windows: Array, reason: string|null }}
 *
 * `reason` is why there are none, so the basket can say something useful
 * instead of showing an empty list.
 */
export function windowsFor(s, nowMinutes, openHours = null) {
  if (!s.enabled) return { windows: [], reason: "off" };

  if (openHours && openHours.enabled === false) {
    return { windows: [], reason: "closed_today" };
  }

  const cutoff = timeToMinutes(s.cutoff_time);
  if (cutoff !== null && nowMinutes >= cutoff) {
    return { windows: [], reason: "past_cutoff" };
  }

  const end = timeToMinutes(s.day_end);
  if (end === null) return { windows: [], reason: "misconfigured" };

  // The shop cannot hand a parcel over before it opens, so an order at 07:00
  // does not get a 09:00 window.
  const opens = openHours ? timeToMinutes(openHours.start_time) : null;
  const closes = openHours ? timeToMinutes(openHours.end_time) : null;

  let start = nowMinutes + Number(s.lead_minutes);
  if (opens !== null && start < opens + Number(s.lead_minutes)) {
    start = opens + Number(s.lead_minutes);
  }

  const lastPossible = closes === null ? end : Math.min(end, closes);
  if (start >= lastPossible) return { windows: [], reason: "too_late_today" };

  // Round up to the next half hour so the windows read as times rather than
  // as arithmetic: "2:30–4:30pm", never "2:07–4:07pm".
  start = Math.ceil(start / 30) * 30;
  if (start >= lastPossible) return { windows: [], reason: "too_late_today" };

  const width = Number(s.window_minutes);
  const floor = Number(s.min_window_minutes);
  const windows = [];

  for (let from = start; from < lastPossible; from += width) {
    const to = Math.min(from + width, lastPossible);
    // Never offer a sliver nobody can deliver in.
    if (to - from < floor) break;
    windows.push({
      start: from,
      end: to,
      label: rangeLabel(from, to),
    });
  }

  if (windows.length === 0) return { windows: [], reason: "too_late_today" };

  if (s.open_window_enabled) {
    windows.push({
      start,
      end: lastPossible,
      open: true,
      label: String(s.open_window_label || DEFAULT_SAMEDAY.open_window_label),
    });
  }

  return { windows, reason: null };
}

/* ------------------------------------------------------------------ summary */

export function summarizeSameday(raw, nowMinutes = null, openHours = null) {
  const s = normalizeSameday(raw);
  if (!s.enabled) return "Same-day courier delivery is switched off.";

  const codes = s.zones.reduce((n, z) => n + z.outwards.length, 0);
  let text =
    `Same-day courier delivery to ${codes} postcode ` +
    `${codes === 1 ? "area" : "areas"} across ${s.zones.length} ` +
    `${s.zones.length === 1 ? "zone" : "zones"}. ` +
    `Orders close at ${s.cutoff_time}, last delivery ${s.day_end}, ` +
    `${s.lead_minutes} minutes from order to the first window.`;

  if (nowMinutes !== null) {
    const { windows, reason } = windowsFor(s, nowMinutes, openHours);
    if (windows.length > 0) {
      text += ` Right now it would offer ${windows.length} ` +
        `${windows.length === 1 ? "window" : "windows"}, starting ${windows[0].label}.`;
    } else {
      text += ` Right now it would offer nothing: ${
        {
          closed_today: "the shop is closed today",
          past_cutoff: "it is past the cut-off",
          too_late_today: "there is not enough of the day left",
          misconfigured: "the times are not valid",
        }[reason] || "no window fits"
      }.`;
    }
  }

  return text;
}
