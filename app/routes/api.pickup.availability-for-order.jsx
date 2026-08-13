// Collection availability for an existing order.
//
//   POST /api/pickup/availability-for-order   { "orderId": "gid://shopify/Order/123" }
//
// Called by the Thank you / Order status UI extension, authenticated with the
// extension's session token. The app-proxy route (proxy.availability.jsx) does
// the same job for the cart; this one differs only in where the line items and
// total come from. The availability engine itself is untouched.
//
// Thank-you-page caveat: Shopify creates the order asynchronously, so the ID
// exists before the order does. When the lookup misses we return
// { status: "order_pending" } with 202 and let the extension poll — rather than
// trusting item data sent from the client, which this app deliberately never does.

import { authenticate, unauthenticated } from "../shopify.server";
import { loadSettings } from "../lib/settings.server";
import { fetchPickupOrderCounts } from "../lib/orders.server";
import { computeAvailability, maxPrepDelayMinutes } from "../lib/availability";
import { corsJson, handlePreflight } from "../lib/cors.server";
import {
  normalizeOrderGid,
  orderIsPickup,
  orderToCartInput,
  currentBooking,
} from "../lib/order-booking";

export const ORDER_CONTEXT_QUERY = `
  query PickupOrderContext($id: ID!) {
    order(id: $id) {
      id
      name
      cancelledAt
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customAttributes { key value }
      fulfillmentOrders(first: 5) {
        nodes { deliveryMethod { methodType } }
      }
      lineItems(first: 100) {
        nodes {
          quantity
          product {
            id
            delay: metafield(namespace: "custom", key: "pickup_delay_minutes") { value }
            available: metafield(namespace: "custom", key: "pickup_available") { value }
          }
        }
      }
    }
  }
`;

/** sessionToken.dest is an origin ("https://shop.myshopify.com"); we need the host. */
export function shopFromSessionToken(sessionToken) {
  const dest = String(sessionToken?.dest || "");
  if (!dest) return null;
  try {
    return new URL(dest).host;
  } catch {
    return dest.replace(/^https?:\/\//, "").replace(/\/$/, "") || null;
  }
}

export const action = async ({ request }) => {
  // Preflight first — it carries no Authorization header, so authenticating it
  // would 401 without CORS headers and the browser would block the real call.
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

  const { admin } = await unauthenticated.admin(shop);

  const response = await admin.graphql(ORDER_CONTEXT_QUERY, {
    variables: { id: orderGid },
  });
  const { data } = await response.json();
  const order = data?.order;

  // Not an error — the order is very likely still being created.
  if (!order) return corsJson({ status: "order_pending" }, 202);

  if (order.cancelledAt) {
    return corsJson({ eligible: false, reason: "order_cancelled", dates: [] });
  }

  if (!orderIsPickup(order)) {
    return corsJson({ eligible: false, reason: "not_pickup", dates: [] });
  }

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

  return corsJson({
    ...availability,
    status: "ready",
    order_name: order.name,
    current_booking: currentBooking(order),
    max_delay_minutes: maxPrepDelayMinutes(cart.items),
    generated_at: new Date().toISOString(),
  });
};

// Remix routes OPTIONS to the loader in some versions and the action in others,
// so both answer preflights.
export const loader = async ({ request }) => {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;
  return corsJson({ ok: true });
};
