import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ladderRungs,
  ladderPrice,
  ladderVariants,
  rungPrice,
  rungLabel,
  rungSku,
  subsidyTotal,
  LADDER_FLOOR_PENCE,
  LADDER_CEILING_PENCE,
} from "../app/lib/ladder.js";

import {
  TIERS,
  DEFAULT_TIER_SETTINGS,
  tiersFor,
  prepMinutesFor,
  nextHourMinutes,
  hourLabel,
  cakeNotice,
  deadlineInstant,
  normalizeTierSettings,
} from "../app/lib/tiers.js";

/* ====================================================================== */
/* THE LADDER                                                             */
/* ====================================================================== */

test("the shop's own example: £9.42 charges £8.95", () => {
  const result = ladderPrice(942);
  assert.equal(result.pence, 895);
  assert.equal(rungLabel(result.pence), "£8.95");
  assert.equal(result.lossPence, 47);
  assert.equal(result.floored, false);
  assert.equal(result.capped, false);
});

test("a quote landing exactly on a rung still charges the rung BELOW", () => {
  /* The instruction was "the rate below the one we receive". Charging £9.95
   * for a £9.95 quote would be true to the arithmetic and false to that, and
   * would make delivery break even rather than cost a little — which is the
   * whole point of the model. */
  const result = ladderPrice(995);
  assert.equal(result.pence, 895);
  assert.equal(result.lossPence, 100);
});

test("a penny under a rung costs the shop nearly a pound", () => {
  const result = ladderPrice(994);
  assert.equal(result.pence, 895);
  assert.equal(result.lossPence, 99);
});

test("a penny over a rung costs the shop almost nothing", () => {
  const result = ladderPrice(996);
  assert.equal(result.pence, 995);
  assert.equal(result.lossPence, 1);
});

test("the loss is never more than one rung inside the ladder", () => {
  for (let quote = LADDER_FLOOR_PENCE + 1; quote <= LADDER_CEILING_PENCE; quote += 1) {
    const result = ladderPrice(quote);
    assert.ok(result.lossPence > 0, `quote ${quote} should always cost the shop something`);
    assert.ok(result.lossPence <= 100, `quote ${quote} lost ${result.lossPence}p`);
  }
});

test("the customer never pays more than the courier costs, inside the ladder", () => {
  for (let quote = LADDER_FLOOR_PENCE + 1; quote <= LADDER_CEILING_PENCE; quote += 7) {
    const result = ladderPrice(quote);
    assert.ok(result.pence < quote, `charged ${result.pence} for a ${quote} quote`);
  }
});

test("a quote below the floor charges the floor, and says so", () => {
  const result = ladderPrice(300);
  assert.equal(result.pence, LADDER_FLOOR_PENCE);
  assert.equal(result.floored, true);
  /* The one case where the customer pays over cost. Negative loss is the
   * honest way to record it — the shop is up, not down. */
  assert.equal(result.lossPence, 300 - LADDER_FLOOR_PENCE);
  assert.ok(result.lossPence < 0);
});

test("a quote off the top of the ladder is flagged as capped", () => {
  const result = ladderPrice(6000);
  assert.equal(result.pence, LADDER_CEILING_PENCE);
  assert.equal(result.capped, true);
  assert.ok(result.lossPence > 100);
});

test("the Chiswick basket that started this now prices honestly", () => {
  /* Two tiers came back reading £34.95 on a live W4 basket — the old ceiling
   * showing through on quotes above £35.95, with the shop absorbing the
   * difference unseen. Anything in that range now lands on a real rung. */
  for (const quote of [3600, 3800, 4200, 4600]) {
    const result = ladderPrice(quote);
    assert.equal(result.capped, false, `£${quote / 100} should not cap`);
    assert.ok(result.lossPence <= 100, `£${quote / 100} lost ${result.lossPence}p`);
  }
});

test("a quote just past the top rung is not capped — it is an ordinary rounding", () => {
  const result = ladderPrice(LADDER_CEILING_PENCE + 40);
  assert.equal(result.pence, LADDER_CEILING_PENCE);
  assert.equal(result.capped, false);
});

test("no quote returns no price rather than a guess", () => {
  for (const bad of [null, undefined, 0, -100, NaN, "banana"]) {
    const result = ladderPrice(bad);
    assert.equal(result.pence, null, `${bad} should not produce a price`);
    assert.equal(result.reason, "no_quote");
  }
});

test("every rung ends in 95", () => {
  for (const pence of ladderRungs()) {
    assert.equal(pence % 100, 95, `${pence} does not end in 95`);
  }
});

test("the ladder runs from £4.95 to £49.95 in pound steps", () => {
  const rungs = ladderRungs();
  assert.equal(rungs[0], 495);
  assert.equal(rungs[rungs.length - 1], 4995);
  assert.equal(rungs.length, 46);
  for (let i = 1; i < rungs.length; i += 1) {
    assert.equal(rungs[i] - rungs[i - 1], 100);
  }
});

test("the rung index points at the right variant", () => {
  const variants = ladderVariants();
  const result = ladderPrice(942);
  assert.equal(variants[result.rung].price, "8.95");
  assert.equal(variants[result.rung].sku, "IBC-DEL-0895");
});

test("SKUs are fixed width, so they sort and never collide", () => {
  assert.equal(rungSku(495), "IBC-DEL-0495");
  assert.equal(rungSku(3495), "IBC-DEL-3495");
  const skus = ladderVariants().map((v) => v.sku);
  assert.equal(new Set(skus).size, skus.length);
});

test("prices are written as money, not as floats", () => {
  assert.equal(rungPrice(895), "8.95");
  assert.equal(rungPrice(1000), "10.00");
  assert.equal(rungPrice(495), "4.95");
});

test("the subsidy across a day's orders adds up", () => {
  const day = [ladderPrice(942), ladderPrice(1213), ladderPrice(1607)];
  assert.equal(subsidyTotal(day), 47 + 18 + 12);
});

/* Every measured Gophr price, priced through the ladder. These are the real
 * figures from 15 and 16 September, and they are here so that a change to the
 * ladder shows up as a change to a number somebody recognises. */
test("the measured live quotes price as expected", () => {
  const measured = [
    ["Mayfair", 942, 895, 47],
    ["Covent Garden", 942, 895, 47],
    ["Shoreditch", 1213, 1195, 18],
    ["Hampstead", 1410, 1395, 15],
    ["Battersea", 1558, 1495, 63],
    ["Bermondsey", 1607, 1595, 12],
    ["Zone A, 120-minute deadline", 1385, 1295, 90],
    ["Zone A, 90-minute deadline", 1658, 1595, 63],
    ["Zone A, 60-minute deadline", 1715, 1695, 20],
  ];
  for (const [where, quote, expected, loss] of measured) {
    const result = ladderPrice(quote);
    assert.equal(result.pence, expected, where);
    assert.equal(result.lossPence, loss, where);
  }
});

test("the worst measured day still costs well under the £5 tolerance", () => {
  const worst = [1385, 1558, 1658].map((q) => ladderPrice(q));
  for (const result of worst) {
    assert.ok(result.lossPence < 500, `lost ${result.lossPence}p`);
  }
});

/* ====================================================================== */
/* THE TIERS                                                              */
/* ====================================================================== */

const AT = (h, m) => h * 60 + m;

test("ordering at 11:48 offers 1pm, 2pm, 3pm and any time", () => {
  const { tiers } = tiersFor({ nowMinutes: AT(11, 48) });
  assert.deepEqual(
    tiers.map((t) => t.label),
    ["By 1:00pm", "By 2:00pm", "By 3:00pm", "Any time before 9:00pm"]
  );
});

test("a whole cake loses the first tier and starts at 2pm", () => {
  const { tiers, prepMinutes } = tiersFor({ nowMinutes: AT(11, 48), hasWholeCake: true });
  assert.equal(prepMinutes, 75);
  assert.deepEqual(
    tiers.map((t) => t.label),
    ["By 2:00pm", "By 3:00pm", "Any time before 9:00pm"]
  );
  assert.equal(tiers[0].id, "priority");
});

test("the cake notice names the hour the customer can actually have", () => {
  const { tiers } = tiersFor({ nowMinutes: AT(11, 48), hasWholeCake: true });
  assert.match(cakeNotice(tiers), /start from 2:00pm/);
  assert.match(cakeNotice(tiers), /60 minutes/);
});

test("preparation is fifteen minutes, and an hour more for a cake", () => {
  assert.equal(prepMinutesFor(false), 15);
  assert.equal(prepMinutesFor(true), 75);
});

test("the next hour is the NEXT one, even at one minute past", () => {
  assert.equal(nextHourMinutes(AT(11, 1)), AT(12, 0));
  assert.equal(nextHourMinutes(AT(11, 59)), AT(12, 0));
  /* Exactly on the hour stays put — 12:00 plus one hour is 1pm, not 2pm. */
  assert.equal(nextHourMinutes(AT(12, 0)), AT(12, 0));
});

test("ordering on the hour gives a full hour, not fifty-nine minutes", () => {
  const { tiers } = tiersFor({ nowMinutes: AT(12, 0) });
  assert.equal(tiers[0].label, "By 1:00pm");
  assert.equal(tiers[0].minutesAhead, 60);
});

test("the express tier swings between sixty and a hundred and twenty minutes", () => {
  const onTheHour = tiersFor({ nowMinutes: AT(12, 0) }).tiers[0];
  const justAfter = tiersFor({ nowMinutes: AT(12, 1) }).tiers[0];
  assert.equal(onTheHour.minutesAhead, 60);
  assert.equal(justAfter.minutesAhead, 119);
});

test("a tier the shop cannot physically meet is not offered", () => {
  /* 12:59 — the one o'clock deadline is a minute away. Fifteen minutes of
   * packing and forty of riding do not fit inside it. */
  const { tiers } = tiersFor({ nowMinutes: AT(12, 59) });
  assert.equal(tiers[0].label, "By 2:00pm");
});

test("tiers fall away as the day ends, and never duplicate an hour", () => {
  const { tiers } = tiersFor({ nowMinutes: AT(18, 30) });
  const deadlines = tiers.map((t) => t.deadlineMinutes);
  assert.equal(new Set(deadlines).size, deadlines.length, "two tiers on the same hour");
  for (const deadline of deadlines) {
    assert.ok(deadline <= DEFAULT_TIER_SETTINGS.day_end_minutes);
  }
});

test("when two tiers collapse onto the same hour, the cheaper one wins", () => {
  /* At 6:30pm, standard is 9pm and so is any-time. Offering the same
   * deadline twice at two prices is indefensible. */
  const { tiers } = tiersFor({ nowMinutes: AT(18, 30) });
  const nine = tiers.filter((t) => t.deadlineMinutes === AT(21, 0));
  assert.equal(nine.length, 1);
  assert.equal(nine[0].id, "anytime");
});

test("past the cut-off nothing is offered, and it says why", () => {
  const { tiers, reason } = tiersFor({ nowMinutes: AT(19, 30) });
  assert.equal(tiers.length, 0);
  assert.equal(reason, "past_cutoff");
});

test("a closed shop offers nothing, whatever the clock says", () => {
  const { tiers, reason } = tiersFor({ nowMinutes: AT(11, 0), openToday: false });
  assert.equal(tiers.length, 0);
  assert.equal(reason, "closed_today");
});

test("a cake late in the day gets its own reason, not a generic one", () => {
  /* 6:50pm with a cake: 75 minutes of preparation plus 40 of riding lands at
   * 20:45, which is inside the day — so tiers still exist. Push to 7pm and
   * the cut-off stops it. Ten past six with a cake is the interesting case:
   * the earliest honest deadline is 8:05pm, so only nine o'clock survives. */
  const { tiers } = tiersFor({ nowMinutes: AT(18, 10), hasWholeCake: true });
  assert.deepEqual(tiers.map((t) => t.label), ["Any time before 9:00pm"]);
});

test("a nonsense clock refuses rather than inventing a morning", () => {
  const { tiers, reason } = tiersFor({ nowMinutes: "half eleven" });
  assert.equal(tiers.length, 0);
  assert.equal(reason, "no_clock");
});

test("hours read the way a Londoner says them", () => {
  assert.equal(hourLabel(AT(13, 0)), "1:00pm");
  assert.equal(hourLabel(AT(12, 0)), "12:00pm");
  assert.equal(hourLabel(AT(0, 0)), "12:00am");
  assert.equal(hourLabel(AT(9, 30)), "9:30am");
  assert.equal(hourLabel(AT(21, 0)), "9:00pm");
});

test("settings are clamped, not trusted", () => {
  const s = normalizeTierSettings({ prep_minutes: "banana", cake_extra_minutes: -5, travel_buffer_minutes: 25 });
  assert.equal(s.prep_minutes, DEFAULT_TIER_SETTINGS.prep_minutes);
  assert.equal(s.cake_extra_minutes, DEFAULT_TIER_SETTINGS.cake_extra_minutes);
  assert.equal(s.travel_buffer_minutes, 25);
});

test("a shop with a longer prep time offers fewer tiers", () => {
  const slow = tiersFor({ nowMinutes: AT(11, 48), settings: { prep_minutes: 45 } });
  assert.equal(slow.tiers[0].label, "By 2:00pm");
});

test("the deadline becomes a real instant on the right day", () => {
  const day = new Date("2026-09-17T08:00:00Z");
  const instant = deadlineInstant(day, AT(13, 0));
  assert.equal(instant.getHours(), 13);
  assert.equal(instant.getMinutes(), 0);
  assert.equal(instant.getDate(), day.getDate());
});

test("every tier in the table has a deadline rule", () => {
  for (const tier of TIERS) {
    assert.ok(tier.openEnded || Number.isFinite(tier.hours), `${tier.id} has no deadline rule`);
    assert.ok(tier.name && tier.blurb, `${tier.id} is missing its words`);
  }
});
