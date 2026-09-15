// Same-day zones — kept here only as the name the Courier page already
// imports. THE LISTS THEMSELVES LIVE IN lib/sameday.js.
//
// This file used to hold its own copy. Two copies of a postcode list is the
// same mistake as two copies of a rate name: they agree on the day they are
// written and disagree quietly afterwards, and the disagreement shows up as
// one customer in a zone the basket says is covered and Shopify says is not.
//
// Everything below is a re-export. Add nothing to it.

export {
  DEFAULT_ZONES as ZONES,
  ALWAYS_SUBDIVIDED,
  outwardCode,
  zoneForPostcode,
  shopifyPostcodeList,
  parseOutwards,
} from "./sameday.js";

/**
 * A deliberately tiny zone for proving the plumbing before the real ones are
 * switched on: the shop's own outward code and nothing else, so the only
 * address that can match is one you control.
 */
export const TEST_ZONE = {
  id: "TEST",
  name: "Test zone",
  description: "The shop's own outward code. Nothing else can match.",
  outwards: ["W1T"],
};
