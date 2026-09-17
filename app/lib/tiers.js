// Delivery tiers — the four choices a same-day customer is offered, and the
// deadline each one buys from Gophr.
//
// THE IDEA
// --------
// Gophr prices urgency and nothing else. A job with three hours on it costs
// the base fare; the same job with sixty minutes on it cost £7.73 more when
// it was measured on 16 September. So the tiers are not marketing tiers with
// invented surcharges on top — each tier IS a deadline, and its price is
// whatever Gophr quotes for that deadline. There is no margin to invent
// because there is no margin wanted.
//
// That also means the prices move. Quiet Tuesday morning and wet Friday night
// are different prices for the same postcode, because they are different
// prices to us.
//
// THE CLOCK
// ---------
// Deadlines land on the hour, because "by 1pm" is a promise a person can hold
// in their head and "by 13:12" is not. Round the current time UP to the next
// hour, then add the tier's hours. Ordering at 11:48 gives 1pm, 2pm, 3pm —
// so the first tier is between sixty and a hundred and twenty minutes away
// depending on the minute somebody happens to order. That swing is real and
// it is priced: Gophr charged £17.15 at sixty minutes and £13.85 at a
// hundred and twenty. We quote each tier live rather than assuming, so the
// swing shows up in the price instead of in the margin.
//
// WHOLE CAKES
// -----------
// A cake needs an hour longer than a box of chocolates before it can leave —
// boxing, setting, and not being carried down a staircase at a run. That is
// modelled as preparation time rather than as a surcharge, so a cake does not
// cost more, it starts later. In practice the first tier disappears and the
// customer is told why.
//
// WHAT THIS MODULE IS NOT
// -----------------------
// It does no I/O, knows nothing about Gophr and nothing about Shopify. It
// turns a clock and a basket into a list of deadlines. Everything that can go
// wrong with a courier happens somewhere else, on purpose.

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * 60;

export const DEFAULT_TIER_SETTINGS = {
  /* Minutes to get an ordinary basket boxed and on the counter. */
  prep_minutes: 15,
  /* What a whole cake adds to that. The number the shop asked for. */
  cake_extra_minutes: 60,
  /* Journey plus slack. Covers the rider reaching Rathbone Place and the
   * drop itself — Zone A is about twenty minutes, Zone C nearer thirty-five,
   * and this is deliberately the pessimistic end. A tier offered and missed
   * is worse than a tier not offered. */
  travel_buffer_minutes: 40,
  /* The last minute of the day a courier may still be delivering. */
  day_end_minutes: 21 * 60,
  /* No same-day orders accepted after this. */
  cutoff_minutes: 19 * 60,
};

/**
 * The tiers, dearest and quickest first.
 *
 * `hours` is how many whole hours past the next o'clock the deadline sits.
 * `openEnded` marks the one that simply runs to the end of the day.
 */
export const TIERS = [
  {
    id: "express",
    hours: 1,
    name: "Express",
    blurb: "As fast as a rider can get there.",
  },
  {
    id: "priority",
    hours: 2,
    name: "Priority",
    blurb: "Ahead of the queue.",
  },
  {
    id: "standard",
    hours: 3,
    name: "Standard",
    blurb: "Same-day, at the usual price.",
  },
  {
    id: "anytime",
    hours: null,
    openEnded: true,
    name: "Any time today",
    blurb: "Whenever suits the rider best.",
  },
];

export function normalizeTierSettings(raw) {
  const s = { ...DEFAULT_TIER_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  for (const key of Object.keys(DEFAULT_TIER_SETTINGS)) {
    const n = Number(s[key]);
    s[key] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TIER_SETTINGS[key];
  }
  return s;
}

/** Minutes past midnight, rounded UP to the next whole hour. 11:48 -> 720. */
export function nextHourMinutes(nowMinutes) {
  const n = Number(nowMinutes);
  if (!Number.isFinite(n)) return null;
  return Math.ceil(n / MINUTES_PER_HOUR) * MINUTES_PER_HOUR;
}

/** 780 -> "1:00pm". The shop is in London and reads twelve-hour time. */
export function hourLabel(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return "";
  const total = ((Math.floor(m) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour24 = Math.floor(total / MINUTES_PER_HOUR);
  const mins = total % MINUTES_PER_HOUR;
  const suffix = hour24 >= 12 ? "pm" : "am";
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}:${String(mins).padStart(2, "0")}${suffix}`;
}

/**
 * How long this basket needs before it can leave the shop.
 *
 * `hasWholeCake` is passed in rather than worked out here, because deciding
 * what counts as a whole cake is a question about the shop's catalogue and
 * this module has no business holding an opinion about it.
 */
export function prepMinutesFor(hasWholeCake, settings = DEFAULT_TIER_SETTINGS) {
  const s = normalizeTierSettings(settings);
  return hasWholeCake ? s.prep_minutes + s.cake_extra_minutes : s.prep_minutes;
}

/**
 * The tiers on offer right now.
 *
 * Returns { tiers, prepMinutes, hasWholeCake, reason }. `tiers` carries one
 * entry per OFFERABLE tier; a tier the shop cannot physically meet is left
 * out rather than shown greyed, because a greyed-out option is a question the
 * customer then has to ask somebody.
 *
 * `reason` is set only when the list is empty, and says which rule emptied
 * it — the basket needs that to write an honest sentence rather than "no
 * options available".
 */
export function tiersFor({
  nowMinutes,
  hasWholeCake = false,
  settings = DEFAULT_TIER_SETTINGS,
  openToday = true,
} = {}) {
  const s = normalizeTierSettings(settings);
  const now = Number(nowMinutes);

  if (!Number.isFinite(now)) {
    return { tiers: [], prepMinutes: null, hasWholeCake, reason: "no_clock" };
  }
  if (!openToday) {
    return { tiers: [], prepMinutes: null, hasWholeCake, reason: "closed_today" };
  }
  if (now >= s.cutoff_minutes) {
    return { tiers: [], prepMinutes: null, hasWholeCake, reason: "past_cutoff" };
  }

  const prep = prepMinutesFor(hasWholeCake, s);
  /* THE EARLIEST HONEST DEADLINE. Preparation and the journey both have to
   * fit inside it, and neither is negotiable once a customer has paid. */
  const earliest = now + prep + s.travel_buffer_minutes;
  const nextHour = nextHourMinutes(now);

  const offered = [];
  for (const tier of TIERS) {
    const deadline = tier.openEnded
      ? s.day_end_minutes
      : nextHour + tier.hours * MINUTES_PER_HOUR;

    /* Past closing. An eight o'clock order cannot have a ten o'clock tier
     * however many hours the table says to add. */
    if (deadline > s.day_end_minutes) continue;
    /* Sooner than the shop can physically manage. */
    if (deadline < earliest) continue;

    /* TWO TIERS ON THE SAME HOUR. Late in the day the ladder collapses —
     * at 6:40pm, standard and any-time are both 9pm — and offering the same
     * deadline twice at two prices is indefensible. Keep the cheaper, which
     * is the later one in the table. */
    const clash = offered.findIndex((t) => t.deadlineMinutes === deadline);
    if (clash !== -1) offered.splice(clash, 1);

    offered.push({
      id: tier.id,
      name: tier.name,
      blurb: tier.blurb,
      deadlineMinutes: deadline,
      deadlineLabel: hourLabel(deadline),
      /* What the customer reads on the tile. "by 1:00pm" for a real hour;
       * the any-time tier says so in words because "by 9:00pm" invites
       * somebody to wait in all evening. */
      label: tier.openEnded ? `Any time before ${hourLabel(deadline)}` : `By ${hourLabel(deadline)}`,
      minutesAhead: deadline - now,
      openEnded: Boolean(tier.openEnded),
    });
  }

  if (!offered.length) {
    /* Nothing fits. Which rule did it is worth saying: too late in the day is
     * a different sentence from "your cake needs longer than today has left". */
    return {
      tiers: [],
      prepMinutes: prep,
      hasWholeCake,
      reason: earliest > s.day_end_minutes ? (hasWholeCake ? "cake_too_late" : "too_late_today") : "no_window",
    };
  }

  return { tiers: offered, prepMinutes: prep, hasWholeCake, reason: null };
}

/**
 * The line explaining why a cake basket starts later.
 *
 * Returned rather than rendered so the theme and the admin preview say the
 * same thing, and so it can be changed in one place when the shop decides
 * ninety minutes is more honest than sixty.
 */
export function cakeNotice(tiers, settings = DEFAULT_TIER_SETTINGS) {
  const s = normalizeTierSettings(settings);
  const first = Array.isArray(tiers) && tiers.length ? tiers[0] : null;
  if (!first) return "";
  return (
    `Whole cakes need an extra ${s.cake_extra_minutes} minutes to box and set, ` +
    `so same-day cake orders start from ${first.deadlineLabel}.`
  );
}

/**
 * The deadline as an instant, for Gophr.
 *
 * Gophr wants ISO8601 with an explicit offset and no milliseconds — settled
 * by a 422 that rejected what toISOString() produces. The conversion itself
 * lives in courier-booking.js; this only does the arithmetic, on a Date
 * supplied by the caller so that tests are not at the mercy of the clock.
 */
export function deadlineInstant(dayStart, deadlineMinutes) {
  const base = dayStart instanceof Date ? new Date(dayStart.getTime()) : null;
  const m = Number(deadlineMinutes);
  if (!base || Number.isNaN(base.getTime()) || !Number.isFinite(m)) return null;
  base.setHours(0, 0, 0, 0);
  return new Date(base.getTime() + m * 60 * 1000);
}
