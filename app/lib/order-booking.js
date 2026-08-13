// Pure helpers for booking a collection slot against an existing Shopify order.
// No I/O — mirrors the availability.js pattern so it stays unit-testable.
//
// Context: collection slots are chosen after payment, on the Thank you and
// Order status pages, rather than in the cart. The availability engine is
// unchanged — computeAvailability only ever needed { totalPence, items }, and
// an order supplies both. These helpers do the translation.

export const PICKUP_ATTRIBUTE_KEYS = [
  "ibc_pickup_requested",
  "ibc_pickup_date",
  "ibc_pickup_slot_start",
  "ibc_pickup_slot_end",
  "ibc_pickup_slot_label",
  "ibc_pickup_delay_minutes",
  "ibc_pickup_location",
  "ibc_pickup_address",
  "ibc_pickup_map_url",
];

/** Accept "1234", "gid://shopify/Order/1234" or "#1234" -> GID, or null. */
export function normalizeOrderGid(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(value)) return value;
  const digits = value.replace(/\D/g, "");
  return digits ? `gid://shopify/Order/${digits}` : null;
}

/** customAttributes array -> plain object. */
export function attributesToObject(customAttributes) {
  const out = {};
  for (const entry of customAttributes || []) {
    if (entry && typeof entry.key === "string") out[entry.key] = entry.value ?? "";
  }
  return out;
}

/**
 * Merge updates into the order's existing attributes.
 *
 * orderUpdate replaces customAttributes wholesale, so every existing key must
 * be carried through. Dropping ibc_pickup_requested in particular would remove
 * the order from buildOrderCounts and silently stop it consuming capacity.
 *
 * A null/undefined value clears the key; empty string is preserved as a value.
 */
export function mergeAttributes(existing, updates) {
  const merged = { ...attributesToObject(existing) };
  for (const [key, value] of Object.entries(updates || {})) {
    if (value === null || value === undefined) delete merged[key];
    else merged[key] = String(value);
  }
  return Object.entries(merged).map(([key, value]) => ({ key, value }));
}

/**
 * Is this order a collection order?
 *
 * Per the spec's §14, the fulfilment method is the primary source of truth —
 * an old pickup attribute alone must not classify an order as pickup. The
 * attribute is only consulted when no delivery method is available yet, which
 * happens on the Thank you page before the order is fully created.
 */
export function orderIsPickup(order) {
  const methods = (order?.fulfillmentOrders?.nodes || [])
    .map((node) => node?.deliveryMethod?.methodType)
    .filter(Boolean);

  if (methods.length > 0) return methods.includes("PICK_UP");

  const attributes = attributesToObject(order?.customAttributes);
  return String(attributes.ibc_pickup_requested) === "true";
}

/** Order line items -> the { totalPence, items } shape computeAvailability wants. */
export function orderToCartInput(order) {
  const amount = Number(order?.currentTotalPriceSet?.shopMoney?.amount ?? 0);
  const totalPence = Number.isFinite(amount) ? Math.round(amount * 100) : 0;

  const items = [];
  for (const line of order?.lineItems?.nodes || []) {
    const product = line?.product;
    if (!product) continue; // deleted product — no rules to apply
    const rawDelay = product.delay?.value;
    const rawAvailable = product.available?.value;
    items.push({
      delayMinutes: rawDelay != null ? Number(rawDelay) : null,
      pickupAvailable: rawAvailable == null ? true : rawAvailable === "true",
    });
  }

  return { totalPence, items };
}

/** Find a slot by its ISO start across the availability response. */
export function findSlot(availability, startIso) {
  const wanted = String(startIso ?? "").trim();
  if (!wanted) return null;
  for (const date of availability?.dates || []) {
    for (const slot of date.slots || []) {
      if (slot.start_iso === wanted) return { ...slot, date: date.date };
    }
  }
  return null;
}

/** The attribute payload written when a slot is booked. */
export function bookingAttributes(slot, { delayMinutes, locationName }) {
  return {
    // Reasserted, not assumed: buildOrderCounts ignores any order without it,
    // and under post-purchase booking the cart may never have set it.
    ibc_pickup_requested: "true",
    ibc_pickup_date: slot.date,
    ibc_pickup_slot_start: slot.start_iso,
    ibc_pickup_slot_end: slot.end_iso,
    ibc_pickup_slot_label: slot.label,
    ibc_pickup_delay_minutes: String(delayMinutes),
    ...(locationName ? { ibc_pickup_location: locationName } : {}),
  };
}

/** The slot currently saved on an order, or null. Used to render "already booked". */
export function currentBooking(order) {
  const attributes = attributesToObject(order?.customAttributes);
  const start = String(attributes.ibc_pickup_slot_start || "").trim();
  const label = String(attributes.ibc_pickup_slot_label || "").trim();
  if (!start && !label) return null;
  return {
    date: attributes.ibc_pickup_date || null,
    start_iso: start || null,
    end_iso: attributes.ibc_pickup_slot_end || null,
    label: label || null,
  };
}
