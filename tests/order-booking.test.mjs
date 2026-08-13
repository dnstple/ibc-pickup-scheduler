import { describe, it } from "node:test";
import assert from "node:assert";

import {
  normalizeOrderGid,
  attributesToObject,
  mergeAttributes,
  orderIsPickup,
  orderToCartInput,
  findSlot,
  bookingAttributes,
  currentBooking,
} from "../app/lib/order-booking.js";

import { computeAvailability } from "../app/lib/availability.js";

describe("normalizeOrderGid", () => {
  it("accepts a GID, a numeric id and an order name", () => {
    const gid = "gid://shopify/Order/123";
    assert.strictEqual(normalizeOrderGid(gid), gid);
    assert.strictEqual(normalizeOrderGid("123"), gid);
    assert.strictEqual(normalizeOrderGid("#123"), gid);
  });

  it("rejects junk rather than building a malformed GID", () => {
    assert.strictEqual(normalizeOrderGid(""), null);
    assert.strictEqual(normalizeOrderGid(null), null);
    assert.strictEqual(normalizeOrderGid("abc"), null);
  });
});

describe("mergeAttributes", () => {
  const existing = [
    { key: "ibc_pickup_requested", value: "true" },
    { key: "ibc_pickup_location", value: "Italian Bear Chocolate — Fitzrovia" },
    { key: "ibc_pickup_address", value: "29 Rathbone Place, London W1T 1JG" },
    { key: "gift_note", value: "Happy birthday" },
  ];

  it("preserves every existing key", () => {
    const merged = attributesToObject(
      mergeAttributes(existing, { ibc_pickup_date: "2026-08-14" })
    );
    assert.strictEqual(merged.ibc_pickup_requested, "true");
    assert.strictEqual(merged.ibc_pickup_address, "29 Rathbone Place, London W1T 1JG");
    assert.strictEqual(merged.gift_note, "Happy birthday");
    assert.strictEqual(merged.ibc_pickup_date, "2026-08-14");
  });

  it("never drops ibc_pickup_requested, which capacity counting depends on", () => {
    const merged = attributesToObject(mergeAttributes(existing, {}));
    assert.strictEqual(merged.ibc_pickup_requested, "true");
  });

  it("overwrites an existing value", () => {
    const merged = attributesToObject(
      mergeAttributes(existing, { ibc_pickup_location: "Somewhere else" })
    );
    assert.strictEqual(merged.ibc_pickup_location, "Somewhere else");
  });

  it("clears a key when passed null", () => {
    const merged = attributesToObject(mergeAttributes(existing, { gift_note: null }));
    assert.ok(!("gift_note" in merged));
  });

  it("coerces values to strings, as Shopify requires", () => {
    const merged = attributesToObject(mergeAttributes([], { ibc_pickup_delay_minutes: 90 }));
    assert.strictEqual(merged.ibc_pickup_delay_minutes, "90");
  });

  it("copes with no existing attributes", () => {
    assert.deepStrictEqual(mergeAttributes(null, { a: "1" }), [{ key: "a", value: "1" }]);
  });
});

describe("orderIsPickup", () => {
  it("trusts the fulfilment method over the attribute", () => {
    const order = {
      fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: "SHIPPING" } }] },
      customAttributes: [{ key: "ibc_pickup_requested", value: "true" }],
    };
    assert.strictEqual(orderIsPickup(order), false);
  });

  it("recognises a pickup fulfilment method", () => {
    const order = {
      fulfillmentOrders: { nodes: [{ deliveryMethod: { methodType: "PICK_UP" } }] },
      customAttributes: [],
    };
    assert.strictEqual(orderIsPickup(order), true);
  });

  it("falls back to the attribute when no method is available yet", () => {
    // The Thank you page case: order still being created.
    const order = {
      fulfillmentOrders: { nodes: [] },
      customAttributes: [{ key: "ibc_pickup_requested", value: "true" }],
    };
    assert.strictEqual(orderIsPickup(order), true);
  });

  it("is false for an order with neither", () => {
    assert.strictEqual(orderIsPickup({}), false);
    assert.strictEqual(
      orderIsPickup({ fulfillmentOrders: { nodes: [] }, customAttributes: [] }),
      false
    );
  });
});

describe("orderToCartInput", () => {
  it("converts money to pence and reads product metafields", () => {
    const order = {
      currentTotalPriceSet: { shopMoney: { amount: "18.50" } },
      lineItems: {
        nodes: [
          { product: { delay: { value: "120" }, available: { value: "true" } } },
          { product: { delay: null, available: null } },
        ],
      },
    };
    const input = orderToCartInput(order);
    assert.strictEqual(input.totalPence, 1850);
    assert.deepStrictEqual(input.items, [
      { delayMinutes: 120, pickupAvailable: true },
      { delayMinutes: null, pickupAvailable: true },
    ]);
  });

  it("treats a missing pickup_available metafield as available", () => {
    const input = orderToCartInput({
      lineItems: { nodes: [{ product: { delay: null, available: null } }] },
    });
    assert.strictEqual(input.items[0].pickupAvailable, true);
  });

  it("honours an explicit false", () => {
    const input = orderToCartInput({
      lineItems: { nodes: [{ product: { available: { value: "false" } } }] },
    });
    assert.strictEqual(input.items[0].pickupAvailable, false);
  });

  it("skips deleted products rather than throwing", () => {
    const input = orderToCartInput({ lineItems: { nodes: [{ product: null }] } });
    assert.deepStrictEqual(input.items, []);
  });

  it("defaults an empty order to zero", () => {
    assert.deepStrictEqual(orderToCartInput({}), { totalPence: 0, items: [] });
    assert.deepStrictEqual(orderToCartInput(null), { totalPence: 0, items: [] });
  });
});

/* The slot lookup is what stops a stale pick being accepted, so it's tested
 * against real engine output rather than a hand-written fixture. */
describe("findSlot against real availability output", () => {
  const settings = {
    timezone: "Europe/London",
    booking_horizon_days: 7,
    slot_interval_minutes: 30,
    same_day_pickup_enabled: false,
    weekly_hours: {
      monday: { enabled: true, start_time: "10:00", end_time: "17:00" },
      tuesday: { enabled: true, start_time: "10:00", end_time: "17:00" },
      wednesday: { enabled: true, start_time: "10:00", end_time: "17:00" },
      thursday: { enabled: true, start_time: "10:00", end_time: "17:00" },
      friday: { enabled: true, start_time: "10:00", end_time: "17:00" },
      saturday: { enabled: true, start_time: "10:00", end_time: "14:00" },
      sunday: { enabled: false, start_time: null, end_time: null },
    },
  };

  const availability = computeAvailability({
    settings,
    now: new Date("2026-08-13T09:00:00Z"),
    cart: { totalPence: 4800, items: [] },
    orderCounts: { byDate: {}, bySlot: {} },
  });

  it("produced slots to test against", () => {
    assert.ok(availability.eligible);
    assert.ok(availability.dates.length > 0, "engine returned no dates");
  });

  it("finds a slot the engine actually offered", () => {
    const first = availability.dates[0].slots[0];
    const found = findSlot(availability, first.start_iso);
    assert.ok(found);
    assert.strictEqual(found.start_iso, first.start_iso);
    assert.strictEqual(found.date, availability.dates[0].date);
  });

  it("rejects a slot that was never offered", () => {
    assert.strictEqual(findSlot(availability, "2026-08-14T03:00:00+01:00"), null);
  });

  it("rejects empty and malformed input", () => {
    assert.strictEqual(findSlot(availability, ""), null);
    assert.strictEqual(findSlot(availability, null), null);
    assert.strictEqual(findSlot({}, "2026-08-14T14:00:00+01:00"), null);
  });

  it("never offers Sunday", () => {
    assert.ok(!availability.dates.some((d) => d.weekday.toLowerCase() === "sunday"));
  });
});

describe("bookingAttributes", () => {
  const slot = {
    date: "2026-08-14",
    start_iso: "2026-08-14T14:00:00+01:00",
    end_iso: "2026-08-14T14:30:00+01:00",
    label: "Friday 14 August, 2:00–2:30pm",
  };

  it("writes every attribute the dashboard reads", () => {
    const attrs = bookingAttributes(slot, {
      delayMinutes: 60,
      locationName: "Italian Bear Chocolate — Fitzrovia",
    });
    assert.strictEqual(attrs.ibc_pickup_requested, "true");
    assert.strictEqual(attrs.ibc_pickup_date, "2026-08-14");
    assert.strictEqual(attrs.ibc_pickup_slot_start, slot.start_iso);
    assert.strictEqual(attrs.ibc_pickup_slot_end, slot.end_iso);
    assert.strictEqual(attrs.ibc_pickup_slot_label, slot.label);
    assert.strictEqual(attrs.ibc_pickup_delay_minutes, "60");
    assert.strictEqual(attrs.ibc_pickup_location, "Italian Bear Chocolate — Fitzrovia");
  });

  it("keeps the offset on stored timestamps so BST is unambiguous", () => {
    const attrs = bookingAttributes(slot, { delayMinutes: 60 });
    assert.match(attrs.ibc_pickup_slot_start, /[+-]\d{2}:\d{2}$/);
  });

  it("omits the location rather than writing an empty one", () => {
    const attrs = bookingAttributes(slot, { delayMinutes: 60, locationName: "" });
    assert.ok(!("ibc_pickup_location" in attrs));
  });

  it("round-trips through mergeAttributes into buildOrderCounts shape", () => {
    const merged = attributesToObject(
      mergeAttributes([], bookingAttributes(slot, { delayMinutes: 60 }))
    );
    assert.strictEqual(merged.ibc_pickup_requested, "true");
    assert.match(merged.ibc_pickup_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(merged.ibc_pickup_slot_start, /T\d{2}:\d{2}/);
  });
});

describe("currentBooking", () => {
  it("returns null for an unbooked order", () => {
    assert.strictEqual(currentBooking({ customAttributes: [] }), null);
    assert.strictEqual(currentBooking({}), null);
  });

  it("returns the saved slot", () => {
    const booking = currentBooking({
      customAttributes: [
        { key: "ibc_pickup_date", value: "2026-08-14" },
        { key: "ibc_pickup_slot_start", value: "2026-08-14T14:00:00+01:00" },
        { key: "ibc_pickup_slot_label", value: "Friday 14 August, 2:00–2:30pm" },
      ],
    });
    assert.strictEqual(booking.date, "2026-08-14");
    assert.strictEqual(booking.start_iso, "2026-08-14T14:00:00+01:00");
  });

  it("treats whitespace-only values as unbooked", () => {
    assert.strictEqual(
      currentBooking({ customAttributes: [{ key: "ibc_pickup_slot_start", value: "   " }] }),
      null
    );
  });
});
