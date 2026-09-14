// Zone and postcode rules. Run with: node --test tests/zones.test.mjs
//
// These are the pure parts — no network, no credentials. The Gophr client
// itself is deliberately not unit-tested here: its request shape is still
// unconfirmed, and a test written against my guess would only lock the guess
// in. The Courier admin page is what verifies it, against the real API.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ZONES,
  TEST_ZONE,
  outwardCode,
  zoneForPostcode,
  shopifyPostcodeList,
} from "../app/lib/zones.js";
import {
  parcelFor,
  readQuote,
  buildQuoteBody,
  diagnoseKey,
  PICKUP,
} from "../app/lib/gophr.server.js";

/* ------------------------------------------------------------ outward codes */

test("outward code is everything but the last three characters", () => {
  assert.equal(outwardCode("W1T 1JG"), "W1T");
  assert.equal(outwardCode("EC2A 3AY"), "EC2A");
  assert.equal(outwardCode("N1 9GU"), "N1");
});

test("a missing space does not break it — people leave it out constantly", () => {
  assert.equal(outwardCode("W1T1JG"), "W1T");
  assert.equal(outwardCode("sw114nj"), "SW11");
});

test("case and stray punctuation are tolerated", () => {
  assert.equal(outwardCode("  wc2e-9dd  "), "WC2E");
});

test("nonsense returns null rather than a guess", () => {
  // A wrong zone is worse than no zone: it quotes a price for a journey
  // nobody can make.
  assert.equal(outwardCode(""), null);
  assert.equal(outwardCode("LONDON"), null);
  assert.equal(outwardCode("W1T"), null); // outward only, no inward
  assert.equal(outwardCode("123456"), null);
  assert.equal(outwardCode(null), null);
  assert.equal(outwardCode(12345), null);
});

/* ------------------------------------------------------------------- zones */

test("the shop's own postcode is in Zone A", () => {
  assert.equal(zoneForPostcode("W1T 1JG")?.id, "A");
});

test("each test journey lands in the zone the scope claims", () => {
  assert.equal(zoneForPostcode("W1K 3JA")?.id, "A");  // Mayfair
  assert.equal(zoneForPostcode("WC2E 9DD")?.id, "A"); // Covent Garden
  assert.equal(zoneForPostcode("EC2A 3AY")?.id, "B"); // Shoreditch
  assert.equal(zoneForPostcode("SW11 4NJ")?.id, "C"); // Battersea
  assert.equal(zoneForPostcode("NW3 1QG")?.id, "C");  // Hampstead
  assert.equal(zoneForPostcode("SE16 4DG")?.id, "C"); // Bermondsey
});

test("out of area returns null", () => {
  assert.equal(zoneForPostcode("M1 1AA"), null);   // Manchester
  assert.equal(zoneForPostcode("E14 5AB"), null);  // Canary Wharf, excluded on purpose
  assert.equal(zoneForPostcode("W13 8AA"), null);  // Ealing
});

test("no outward code appears in two zones", () => {
  // Overlapping zones would make the band depend on list order, which is the
  // kind of bug that only shows up on one postcode.
  const seen = new Map();
  for (const zone of ZONES) {
    for (const code of zone.outwards) {
      assert.equal(seen.has(code), false, `${code} is in both ${seen.get(code)} and ${zone.id}`);
      seen.set(code, zone.id);
    }
  }
});

test("every outward code is a real shape", () => {
  for (const zone of [...ZONES, TEST_ZONE]) {
    for (const code of zone.outwards) {
      assert.match(code, /^[A-Z]{1,2}[0-9][0-9A-Z]?$/, `${code} in ${zone.id} is not an outward code`);
    }
  }
});

test("no zone contains a bare area letter — 'W1' is the classic trap", () => {
  // Shopify matches a whole area or a complete outward code. "W1" matches
  // nothing; "W" would reach Ealing. Both are silent failures.
  for (const zone of [...ZONES, TEST_ZONE]) {
    for (const code of zone.outwards) {
      assert.notEqual(code, "W1");
      assert.ok(code.length >= 2, `${code} is too short to be safe`);
    }
  }
});

test("the test zone is exactly the shop's own code and nothing else", () => {
  assert.deepEqual(TEST_ZONE.outwards, ["W1T"]);
  assert.equal(zoneForPostcode("W1K 3JA", [TEST_ZONE]), null);
  assert.equal(zoneForPostcode("W1T 1JG", [TEST_ZONE])?.id, "TEST");
});

test("the Shopify list is comma separated and pasteable", () => {
  const list = shopifyPostcodeList(ZONES[0]);
  assert.ok(list.startsWith("W1A, W1B"));
  assert.ok(!list.includes(",,"));
  assert.ok(list.length < 3000, "Shopify caps the postcode field at 3,000 characters");
});

/* ----------------------------------------------------------------- parcels */

test("a cake is too big for a pushbike, which is the point", () => {
  // Gophr picks the vehicle from the dimensions. A pushbike caps at
  // 40 x 30 x 30cm and 10kg. If a cake fits that, it goes by bike or moped
  // and arrives on its side.
  const cake = parcelFor({ grams: 2100, perishable: true });
  const fitsPushbike = cake.length <= 40 && cake.width <= 30 && cake.height <= 30;
  assert.equal(fitsPushbike, false);
});

test("a normal basket stays small enough for the cheap vehicle", () => {
  const jars = parcelFor({ grams: 900, perishable: false });
  assert.ok(jars.length <= 40 && jars.width <= 30 && jars.height <= 30);
});

test("weight is sent in kilograms, not grams", () => {
  assert.equal(parcelFor({ grams: 2100, perishable: true }).weight, 2.1);
  assert.equal(parcelFor({ grams: 500 }).weight, 0.5);
});

test("a weightless basket still gets a sane minimum", () => {
  // Products with no weight set must not quote as a 0kg parcel.
  assert.ok(parcelFor({ grams: 0 }).weight > 0);
  assert.ok(parcelFor({}).weight > 0);
});

/* ------------------------------------------------------------ quote request */

test("the pickup is always the Fitzrovia shop", () => {
  const body = buildQuoteBody({
    destination: { postcode: "W1K 3JA" },
    parcel: parcelFor({}),
  });
  assert.equal(body.pickups[0].address.postcode, "W1T 1JG");
  assert.equal(body.pickups[0].address.address_line_1, PICKUP.address_line_1);
  assert.equal(body.dropoffs[0].address.postcode, "W1K 3JA");
});

test("country code defaults to GB rather than being omitted", () => {
  const body = buildQuoteBody({ destination: { postcode: "N1 9GU" }, parcel: parcelFor({}) });
  assert.equal(body.dropoffs[0].address.country_code, "GB");
});

test("a scheduled pickup is only sent when one was asked for", () => {
  const plain = buildQuoteBody({ destination: { postcode: "N1 9GU" }, parcel: parcelFor({}) });
  assert.equal("earliest_pickup_time" in plain.pickups[0], false);

  const timed = buildQuoteBody({
    destination: { postcode: "N1 9GU" },
    parcel: parcelFor({}),
    earliestPickup: "2026-09-15T14:00:00+01:00",
  });
  assert.equal(timed.pickups[0].earliest_pickup_time, "2026-09-15T14:00:00+01:00");
});

/* ----------------------------------------------------------- reading a price */

test("a price is found wherever Gophr puts it, and says where", () => {
  assert.equal(readQuote({ price_gross: 1240 }).amount, 1240);
  assert.equal(readQuote({ data: { price: 9.5 } }).amount, 9.5);
  assert.equal(readQuote({ data: { price: 9.5 } }).path, "data.price");
});

test("a numeric string is read as a number", () => {
  assert.equal(readQuote({ price: "12.40" }).amount, 12.4);
});

test("an unrecognised shape reports no price rather than inventing one", () => {
  // The one thing this must never do is return a plausible number it made up.
  assert.equal(readQuote({ something: "else" }).amount, null);
  assert.equal(readQuote({ price: "not a number" }).amount, null);
  assert.equal(readQuote(null).amount, null);
  assert.equal(readQuote({ price: null }).amount, null);
});

/* --------------------------------------------------------- key diagnostics */
// The 401 we hit on the first run said only "You are not authorised". These
// tests cover the reasons it says that, so the page can name the cause
// instead of the next person guessing for an afternoon.

test("a sandbox key on the sandbox is fine", () => {
  const d = diagnoseKey("sand-2a7df6bd-8ed3-48ad-b801-05093a866e66", "sandbox");
  assert.equal(d.mismatch, null);
  assert.equal(d.looksSandbox, true);
  assert.equal(d.present, true);
});

test("a production key on the sandbox is the classic 401", () => {
  const d = diagnoseKey("2a7df6bd-8ed3-48ad-b801-05093a866e66", "sandbox");
  assert.equal(d.mismatch, "production-key-on-sandbox");
});

test("a sandbox key on production is caught too", () => {
  const d = diagnoseKey("sand-2a7df6bd-8ed3", "production");
  assert.equal(d.mismatch, "sandbox-key-on-production");
});

test("the sandbox prefix is matched regardless of case", () => {
  assert.equal(diagnoseKey("SAND-abc", "sandbox").looksSandbox, true);
});

test("whitespace from a paste is trimmed and reported", () => {
  // A trailing newline picked up from a hosting dashboard is sent verbatim in
  // the header and rejected as a different key.
  const d = diagnoseKey("sand-abc123\n", "sandbox");
  assert.equal(d.hadWhitespace, true);
  assert.equal(d.length, "sand-abc123".length); // the trimmed length, not the raw one
  assert.equal(d.mismatch, null);
});

test("no key at all is not reported as a mismatch", () => {
  // "Set a key" and "the key is the wrong sort" are different problems and
  // must not be shown as the same one.
  for (const empty of ["", "   ", undefined, null]) {
    const d = diagnoseKey(empty, "sandbox");
    assert.equal(d.present, false);
    assert.equal(d.mismatch, null);
  }
});

test("the diagnosis never carries the key itself", () => {
  const secret = "sand-do-not-leak-me";
  const d = diagnoseKey(secret, "sandbox");
  assert.equal(JSON.stringify(d).includes("do-not-leak"), false);
});
