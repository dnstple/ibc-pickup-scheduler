// Same-day courier rules. Run with: node --test tests/sameday.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SAMEDAY,
  DEFAULT_ZONES,
  normalizeSameday,
  validateSameday,
  windowsFor,
  summarizeSameday,
  outwardCode,
  zoneForPostcode,
  parseOutwards,
  shopifyPostcodeList,
} from "../app/lib/sameday.js";

const at = (h, m = 0) => h * 60 + m;
const open = { enabled: true, start_time: "10:00", end_time: "21:00" };
const on = (over = {}) => normalizeSameday({ ...DEFAULT_SAMEDAY, enabled: true, ...over });

/* ------------------------------------------------------------------ postcodes */

test("outward code is everything but the last three characters", () => {
  assert.equal(outwardCode("W1T 1JG"), "W1T");
  assert.equal(outwardCode("EC2A 3AY"), "EC2A");
  assert.equal(outwardCode("N1 9GU"), "N1");
});

test("a missing space does not break it — people leave it out constantly", () => {
  assert.equal(outwardCode("W1T1JG"), "W1T");
  assert.equal(outwardCode("sw114nj"), "SW11");
});

test("nonsense returns null rather than a guess", () => {
  // A wrong zone quotes a price for a journey nobody can make.
  for (const bad of ["", "LONDON", "W1T", "123456", null, 12345, "W1T 1JG 1JG"]) {
    assert.equal(outwardCode(bad), null, JSON.stringify(bad));
  }
});

test("each measured journey lands in the zone it was priced in", () => {
  const z = (p) => zoneForPostcode(p, DEFAULT_ZONES)?.id;
  assert.equal(z("W1T 1JG"), "A");  // the shop itself
  assert.equal(z("W1K 3JA"), "A");  // Mayfair
  assert.equal(z("WC2E 9DD"), "A"); // Covent Garden
  assert.equal(z("EC2A 3AY"), "B"); // Shoreditch
  assert.equal(z("SW11 4NJ"), "C"); // Battersea
  assert.equal(z("NW3 1QG"), "C");  // Hampstead
  assert.equal(z("SE16 4DG"), "C"); // Bermondsey
});

test("out of area returns null", () => {
  assert.equal(zoneForPostcode("M1 1AA", DEFAULT_ZONES), null);  // Manchester
  assert.equal(zoneForPostcode("E14 5AB", DEFAULT_ZONES), null); // Canary Wharf, excluded
  assert.equal(zoneForPostcode("W13 8AA", DEFAULT_ZONES), null); // Ealing
});

test("no outward code appears in two zones", () => {
  const seen = new Map();
  for (const zone of DEFAULT_ZONES) {
    for (const code of zone.outwards) {
      assert.equal(seen.has(code), false, `${code} is in ${seen.get(code)} and ${zone.id}`);
      seen.set(code, zone.id);
    }
  }
});

test("a pasted list is accepted however it was typed", () => {
  assert.deepEqual(parseOutwards("w1t, w1d\nW1F;  W1T "), ["W1T", "W1D", "W1F"]);
  assert.deepEqual(parseOutwards(["w1t", "W1D"]), ["W1T", "W1D"]);
  assert.deepEqual(parseOutwards(null), []);
});

test("the Shopify list is pasteable and inside the field's limit", () => {
  for (const zone of DEFAULT_ZONES) {
    const list = shopifyPostcodeList(zone);
    assert.ok(!list.includes(",,"));
    assert.ok(list.length < 3000, "Shopify caps the postcode field at 3,000 characters");
  }
});

/* ----------------------------------------------------------------- normalize */

test("defaults are off, so nothing changes until it is switched on", () => {
  assert.equal(DEFAULT_SAMEDAY.enabled, false);
  assert.equal(normalizeSameday(undefined).enabled, false);
  assert.equal(normalizeSameday({ enabled: "yes" }).enabled, false, "only true means true");
});

test("settings saved before this release gain same-day defaults unchanged", () => {
  const s = normalizeSameday({ cutoff_time: "18:00" });
  assert.equal(s.cutoff_time, "18:00");
  assert.equal(s.window_minutes, DEFAULT_SAMEDAY.window_minutes);
  assert.equal(s.zones.length, 3);
});

test("numbers arrive as strings from form fields and are coerced", () => {
  const s = normalizeSameday({ lead_minutes: "90", window_minutes: "60" });
  assert.equal(s.lead_minutes, 90);
  assert.equal(s.window_minutes, 60);
});

test("a hostile zone shape does not produce a hostile object", () => {
  const s = normalizeSameday({ zones: [{ outwards: "w1t w1d" }, {}] });
  assert.deepEqual(s.zones[0].outwards, ["W1T", "W1D"]);
  assert.equal(s.zones[1].id, "B");
  assert.deepEqual(s.zones[1].outwards, []);
});

/* ------------------------------------------------------------------ validate */

test("switched off, nothing is validated — a half-built draft still saves", () => {
  assert.deepEqual(validateSameday(normalizeSameday({ zones: [] })), {});
});

test("the defaults, switched on, are valid", () => {
  assert.deepEqual(validateSameday(on()), {});
});

test("a bare London district is refused, and says why it would fail silently", () => {
  // "W1" passes every pattern check — it looks exactly like an outward code.
  // It just does not exist: the real ones are W1A, W1T and so on, so Shopify
  // matches nothing and same-day never appears, with no error anywhere.
  const e = validateSameday(on({ zones: [{ name: "Z", price: "9", outwards: "W1" }] }));
  assert.match(e["sameday.zones.0.outwards"], /never a complete postcode/);
});

test("every always-subdivided district is caught", () => {
  for (const code of ["EC1", "EC2", "EC3", "EC4", "SW1", "W1", "WC1", "WC2"]) {
    const e = validateSameday(on({ zones: [{ name: "Z", price: "9", outwards: code }] }));
    assert.ok(e["sameday.zones.0.outwards"], `${code} was accepted`);
  }
});

test("districts that ARE real on their own are not caught", () => {
  // E1, N1, NW1 and SE1 exist both as themselves and with sub-divisions.
  // Refusing them would be wrong and would quietly shrink the zone.
  for (const code of ["E1", "N1", "NW1", "SE1", "W2", "SW3"]) {
    const e = validateSameday(on({ zones: [{ name: "Z", price: "9", outwards: code }] }));
    assert.equal(e["sameday.zones.0.outwards"], undefined, `${code} was refused`);
  }
});

test("an asterisk range is refused — the dialog offers it and it is a trap", () => {
  const e = validateSameday(on({ zones: [{ name: "Z", price: "9", outwards: "W1*" }] }));
  assert.ok(e["sameday.zones.0.outwards"]);
});

test("the same postcode in two zones is refused", () => {
  const e = validateSameday(
    on({
      zones: [
        { name: "Inner", price: "9", outwards: "W1T" },
        { name: "Outer", price: "19", outwards: "W1T" },
      ],
    })
  );
  assert.match(e["sameday.zones.1.outwards"], /already in Inner/);
});

test("a cut-off that cannot be delivered by the end of the day is refused", () => {
  // An order at 20:30 with a two-hour lead lands at 22:30, half an hour after
  // the last delivery. The tile would offer nothing and look broken.
  const e = validateSameday(on({ cutoff_time: "20:30", day_end: "21:00" }));
  assert.match(e["sameday.cutoff_time"], /could not be delivered/);
});

test("an impossibly short lead is refused", () => {
  assert.ok(validateSameday(on({ lead_minutes: 5 }))["sameday.lead_minutes"]);
});

test("blank basket wording is refused", () => {
  assert.ok(validateSameday(on({ label: "  " }))["sameday.label"]);
});

test("no zones at all is refused", () => {
  assert.ok(validateSameday(on({ zones: [] }))["sameday.zones"]);
});

/* -------------------------------------------------------------------- windows */

test("a mid-morning order gets a full afternoon of windows", () => {
  const { windows } = windowsFor(on(), at(11), open);
  assert.equal(windows[0].label, "1:00–3:00pm", "11:00 + 120 minutes");
  assert.equal(windows.at(-1).open, true, "the catch-all comes last");
  assert.equal(windows.at(-1).label, "Any time before 9pm");
});

test("window starts are rounded to the half hour, never to the minute", () => {
  // "2:07–4:07pm" reads as arithmetic rather than as a time somebody chose.
  const { windows } = windowsFor(on(), at(11, 7), open);
  assert.equal(windows[0].start % 30, 0);
  assert.equal(windows[0].label, "1:30–3:30pm");
});

test("no window ever ends after the last delivery time", () => {
  const { windows } = windowsFor(on(), at(11), open);
  for (const w of windows) assert.ok(w.end <= at(21), w.label);
});

test("past the cut-off there is nothing, and it says why", () => {
  const r = windowsFor(on({ cutoff_time: "19:00" }), at(19, 1), open);
  assert.deepEqual(r.windows, []);
  assert.equal(r.reason, "past_cutoff");
});

test("a sliver at the end of the day is not offered", () => {
  // 18:30 + 120 = 20:30, leaving half an hour. Below the 45-minute floor.
  const r = windowsFor(on(), at(18, 30), open);
  assert.deepEqual(r.windows, []);
  assert.equal(r.reason, "too_late_today");
});

test("an early-morning order waits for the shop to open", () => {
  // Ordering at 07:00 must not produce a 09:00 window: nobody is there to
  // hand the box over.
  const { windows } = windowsFor(on(), at(7), open);
  assert.ok(windows[0].start >= at(12), windows[0].label);
});

test("a closed day offers nothing", () => {
  const r = windowsFor(on(), at(11), { enabled: false, start_time: "10:00", end_time: "21:00" });
  assert.deepEqual(r.windows, []);
  assert.equal(r.reason, "closed_today");
});

test("switched off offers nothing whatever the clock says", () => {
  assert.deepEqual(windowsFor(normalizeSameday({}), at(11), open).windows, []);
});

test("the catch-all can be switched off", () => {
  const { windows } = windowsFor(on({ open_window_enabled: false }), at(11), open);
  assert.equal(windows.some((w) => w.open), false);
});

test("closing earlier than the last delivery time is respected", () => {
  // The shop shuts at 6, so a rider cannot collect at 7 however late the
  // day_end says deliveries can run.
  const { windows } = windowsFor(on(), at(11), {
    enabled: true, start_time: "10:00", end_time: "18:00",
  });
  for (const w of windows) assert.ok(w.end <= at(18), w.label);
});

test("windows never overlap and always run forwards", () => {
  const { windows } = windowsFor(on({ open_window_enabled: false }), at(11), open);
  for (let i = 0; i < windows.length; i += 1) {
    assert.ok(windows[i].end > windows[i].start);
    if (i > 0) assert.ok(windows[i].start >= windows[i - 1].end);
  }
});

/* ------------------------------------------------------------------ summary */

test("the summary reads as a sentence and names the first window", () => {
  const text = summarizeSameday({ ...DEFAULT_SAMEDAY, enabled: true }, at(11), open);
  assert.match(text, /99 postcode areas across 3 zones/);
  assert.match(text, /starting 1:00–3:00pm/);
});

test("the summary says plainly when nothing is on offer, and why", () => {
  const text = summarizeSameday({ ...DEFAULT_SAMEDAY, enabled: true }, at(20), open);
  assert.match(text, /past the cut-off/);
});

test("the summary says so when it is switched off", () => {
  assert.match(summarizeSameday({}), /switched off/);
});

/* --------------------------------------------------- wiring into settings */
// Same-day lives inside the delivery settings, in the one shop metafield.
// These prove the nesting is additive: an older saved settings object must
// gain the new key untouched, and nothing already saved may change meaning.

import {
  normalizeDelivery,
  validateDelivery,
  DEFAULT_DELIVERY,
} from "../app/lib/delivery.js";
import { normalizeSettings, validateSettings } from "../app/lib/availability.js";

test("settings saved before same-day existed gain it, switched off", () => {
  const d = normalizeDelivery({ lead_days: 2, cutoff_time: "12:00" });
  assert.equal(d.lead_days, 2, "existing values are untouched");
  assert.equal(d.sameday.enabled, false);
  assert.equal(d.sameday.zones.length, 3);
});

test("the live settings shape round-trips unchanged", () => {
  // The real object read off the shop on 14 September 2026.
  const live = {
    enabled: true, standard_enabled: true, dated_enabled: true,
    lead_days: 2, horizon_days: 60, closed_weekdays: [0, 1],
    cutoff_enabled: true, cutoff_time: "12:00", blackout_dates: [],
  };
  const d = normalizeDelivery(live);
  for (const k of Object.keys(live)) {
    assert.deepEqual(d[k], live[k], `${k} changed`);
  }
  assert.deepEqual(validateDelivery(d), {}, "the live settings must stay valid");
});

test("same-day alone is enough of a shipping choice", () => {
  // Turning off both older speeds used to be refused. It should not be when
  // same-day is the one being offered.
  const d = normalizeDelivery({
    standard_enabled: false,
    dated_enabled: false,
    sameday: { ...DEFAULT_SAMEDAY, enabled: true },
  });
  assert.equal(validateDelivery(d)["delivery.enabled"], undefined);
});

test("no shipping speed at all is still refused", () => {
  const d = normalizeDelivery({ standard_enabled: false, dated_enabled: false });
  assert.ok(validateDelivery(d)["delivery.enabled"]);
});

test("a same-day error surfaces through the top-level validator", () => {
  // The Delivery tab has to know which tab to send the merchant to.
  const s = normalizeSettings({
    delivery: {
      sameday: { ...DEFAULT_SAMEDAY, enabled: true, zones: [{ name: "Z", price: "9", outwards: "W1" }] },
    },
  });
  assert.ok(validateSettings(s)["sameday.zones.0.outwards"]);
});
