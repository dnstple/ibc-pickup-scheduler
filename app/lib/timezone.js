// Minimal IANA timezone helpers with no dependencies.
// All conversions go through Intl.DateTimeFormat with an explicit zone, so
// Europe/London GMT/BST transitions are handled by the platform tz database.

const fmtCache = new Map();

function formatter(timeZone) {
  if (!fmtCache.has(timeZone)) {
    fmtCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "long",
      })
    );
  }
  return fmtCache.get(timeZone);
}

const pad = (n) => String(n).padStart(2, "0");

// Wall-clock parts of an instant in the given zone.
export function zonedParts(instant, timeZone) {
  const parts = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday.toLowerCase(), // "monday" ... "sunday"
    dateStr: `${parts.year}-${parts.month}-${parts.day}`, // YYYY-MM-DD (already 0-padded)
    minutesOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// UTC offset (in minutes) of `timeZone` at a given instant. BST => 60, GMT => 0.
export function offsetMinutes(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - instant.getTime()) / 60000);
}

// Convert wall-clock "YYYY-MM-DD" + "HH:MM" in `timeZone` to a real instant.
// Two-pass correction handles instants near DST transitions.
export function wallTimeToInstant(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const off = offsetMinutes(new Date(guess), timeZone);
    const candidate = target - off * 60000;
    if (candidate === guess) break;
    guess = candidate;
  }
  return new Date(guess);
}

// ISO 8601 with the zone's real offset, e.g. "2026-07-11T14:00:00+01:00".
export function toZonedISO(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  const off = offsetMinutes(instant, timeZone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// Add n calendar days to "YYYY-MM-DD" (pure date arithmetic, no zone needed).
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// "HH:MM" -> minutes since midnight. Returns null for invalid input.
export function timeToMinutes(timeStr) {
  if (typeof timeStr !== "string") return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeStr.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// minutes since midnight -> "2:00pm" / "10:30am" style UK label.
export function minutesToLabel(mins) {
  const h24 = Math.floor(mins / 60) % 24;
  const mm = mins % 60;
  const suffix = h24 < 12 ? "am" : "pm";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return mm === 0 ? `${h12}:00${suffix}` : `${h12}:${pad(mm)}${suffix}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS_FROM_DATE = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// "2026-07-11" -> { weekday: "Saturday", label: "Saturday 11 July" }
export function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = WEEKDAYS_FROM_DATE[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { weekday, label: `${weekday} ${d} ${MONTHS[m - 1]}` };
}
