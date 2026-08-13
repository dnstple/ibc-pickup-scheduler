// Book a collection slot against an existing order.
//
//   POST /api/pickup/book   { "orderId": "...", "startIso": "2026-08-14T14:00:00+01:00" }
//
// The posted slot is never trusted. Availability is recomputed and the slot must
// still be present in the result — that is what rejects a slot which filled,
// passed the preparation threshold, or was blacked out between the extension
// rendering and the customer submitting.
//
// Writes the same ibc_pickup_* attributes the cart scheduler used to write, so
// the orders dashboard needs no changes.

import { authenticate, unauthenticated } from "../shopify.server";
import { loadSettings } from "../lib/settings.server";
import { fetchPickupOrderCounts } from "../lib/orders.server";
import { computeAvailability, maxPrepDelayMinutes } from "../lib/availability";
import { corsJson, handlePreflight } from "../lib/cors.server";
import {
  normalizeOrderGid,
  orderIsPickup,
  orderToCartInput,
  findSlot,
  mergeAttributes,
  bookingAttributes,
} from "../lib/order-booking";
import { ORDER_CONTEXT_QUERY, shopFromSessionToken } from "./api.pickup.availability-for-order";

const ORDER_UPDATE_MUTATION = `
  mutation SavePickupSlot($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id customAttributes { key value } }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }) => {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  const { sessionToken } = await authenticate.public.checkout(request);

  const shop = shopFromSessionToken(sessionToken);
  if (!shop) return corsJson({ error: "unknown_shop" }, 401);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return corsJson({ error: "invalid_payload" }, 400);
  }

  const orderGid = normalizeOrderGid(payload?.orderId);
  if (!orderGid) return corsJson({ error: "invalid_order_id" }, 400);

  const startIso = String(payload?.startIso || "").trim();
  if (!startIso) return corsJson({ error: "missing_slot" }, 400);

  const { admin } = await unauthenticated.admin(shop);

  const contextResponse = await admin.graphql(ORDER_CONTEXT_QUERY, {
    variables: { id: orderGid },
  });
  const { data } = await contextResponse.json();
  const order = data?.order;

  if (!order) return corsJson({ status: "order_pending" }, 202);
  if (order.cancelledAt) return corsJson({ error: "order_cancelled" }, 409);
  if (!orderIsPickup(order)) return corsJson({ error: "not_pickup" }, 409);

  const { settings } = await loadSettings(admin);
  const cart = orderToCartInput(order);

  const orderCounts = await fetchPickupOrderCounts(admin, {
    horizonDays: settings.booking_horizon_days,
    timeZone: settings.timezone,
  });

  const availability = computeAvailability({
    settings,
    now: new Date(),
    cart,
    orderCounts,
  });

  if (!availability.eligible) {
    return corsJson({ error: "not_eligible", reason: availability.reason }, 409);
  }

  const slot = findSlot(availability, startIso);
  if (!slot) {
    // Gone since the picker rendered. The extension refetches and re-prompts
    // rather than silently moving the customer to a different time.
    return corsJson({ error: "slot_unavailable" }, 409);
  }

  const updates = bookingAttributes(slot, {
    delayMinutes: maxPrepDelayMinutes(cart.items),
    locationName: settings.collection_location_name,
  });

  const merged = mergeAttributes(order.customAttributes, updates);

  const updateResponse = await admin.graphql(ORDER_UPDATE_MUTATION, {
    variables: { input: { id: orderGid, customAttributes: merged } },
  });
  const updateBody = await updateResponse.json();
  const userErrors = updateBody?.data?.orderUpdate?.userErrors || [];

  if (userErrors.length > 0) {
    console.error("[ibc-pickup] orderUpdate failed:", JSON.stringify(userErrors));
    return corsJson({ error: "save_failed", details: userErrors }, 502);
  }

  return corsJson({
    status: "booked",
    booking: {
      date: slot.date,
      start_iso: slot.start_iso,
      end_iso: slot.end_iso,
      label: slot.label,
    },
  });
};

export const loader = async ({ request }) => {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  return corsJson({ ok: true });
};
