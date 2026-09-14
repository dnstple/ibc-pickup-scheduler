// Same-day courier delivery zones, keyed on UK outward codes.
//
// This file is the ONE place the zone geography lives for the app. The same
// lists must also be entered into Shopify's Local delivery settings, because
// Shopify — not this file — is what actually gates the rate at checkout. This
// copy exists so the basket can show a price and a coverage answer *before*
// checkout, and so the booking code knows which band an order belongs to.
//
// Two lists, one truth. The admin screen says so on the page rather than
// letting a mismatch be discovered by a customer.
//
// ⚠️ Shopify matches a whole postcode AREA or a COMPLETE outward code. There
// are no wildcards. "W1" matches nothing at all, because no real outward code
// is exactly "W1" — they are W1T, W1D, W1F and so on. A bare "W" would reach
// Ealing. Every code below is therefore spelled out in full.

export const ZONES = [
  {
    id: "A",
    name: "Zone A",
    description: "Fitzrovia, Soho, Mayfair, Marylebone, Bloomsbury, Holborn, Covent Garden",
    // ~1.5 miles from 29 Rathbone Place. Walkable and cyclable.
    outwards: [
      "W1A", "W1B", "W1C", "W1D", "W1F", "W1G", "W1H", "W1J", "W1K", "W1S",
      "W1T", "W1U", "W1W",
      "WC1A", "WC1B", "WC1E", "WC1H", "WC1N", "WC1R", "WC1V", "WC1X",
      "WC2A", "WC2B", "WC2E", "WC2H", "WC2N", "WC2R",
    ],
  },
  {
    id: "B",
    name: "Zone B",
    description: "The City, Islington, Camden, Westminster, Southwark, Paddington, Kensington",
    // ~3 miles.
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
    name: "Zone C",
    description: "The Zone 2 ring",
    // ~5 miles. E14 (Canary Wharf) is deliberately absent: it is roughly this
    // far but the route is slow and the buildings are hard to deliver into.
    // Give it its own zone later if the demand appears.
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

// A deliberately tiny list for proving the plumbing works before the real
// zones are switched on. Only W1T — the shop's own outward code — so the only
// address that can match is one you control.
export const TEST_ZONE = {
  id: "TEST",
  name: "Test zone",
  description: "The shop's own outward code. Nothing else can match.",
  outwards: ["W1T"],
};

/**
 * Pull the outward code out of a UK postcode.
 *
 * UK postcodes are "outward inward", where inward is always three characters
 * (digit, letter, letter). Splitting on the space is unreliable because people
 * omit it, so we take everything except the last three characters.
 *
 * Returns null for anything that cannot be an outward code, rather than
 * guessing — a wrong zone is worse than no zone.
 */
export function outwardCode(postcode) {
  if (typeof postcode !== "string") return null;
  const cleaned = postcode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Shortest real UK postcode is 5 characters (e.g. W1A1AA is 6; M11AA is 5).
  if (cleaned.length < 5 || cleaned.length > 7) return null;
  const outward = cleaned.slice(0, cleaned.length - 3);
  // An outward code is one or two letters, then a digit, then an optional
  // digit or letter.
  if (!/^[A-Z]{1,2}[0-9][0-9A-Z]?$/.test(outward)) return null;
  return outward;
}

/**
 * Which zone, if any, covers this postcode.
 *
 * `zones` is passed in rather than read from the module so the caller can hand
 * it TEST_ZONE while testing, or a list loaded from settings later, without
 * this function knowing the difference.
 */
export function zoneForPostcode(postcode, zones = ZONES) {
  const outward = outwardCode(postcode);
  if (!outward) return null;
  for (const zone of zones) {
    if (zone.outwards.includes(outward)) return zone;
  }
  return null;
}

/** The list as Shopify wants it pasted into a Local delivery postcode field. */
export function shopifyPostcodeList(zone) {
  return zone.outwards.join(", ");
}
