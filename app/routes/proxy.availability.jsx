// App proxy endpoint. Reached by the theme at:
//   POST /apps/ibc-pickup/availability   (storefront)
// Shopify forwards to {app_url}/proxy/availability with a signed request.
// All Admin API credentials and business logic stay server-side — the theme
// only ever sees the computed availability JSON.

import { authenticate } from "../shopify.server";
import { loadSettings } from "../lib/settings.server";
import { fetchPickupOrderCounts } from "../lib/orders.server";
import { computeAvailability, maxPrepDelayMinutes } from "../lib/availability";

const PRODUCT_METAFIELDS_QUERY = `
  query CartProductPickupData($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        delay: metafield(namespace: "custom", key: "pickup_delay_minutes") { value }
        available: metafield(namespace: "custom", key: "pickup_available") { value }
      }
    }
  }
`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const loader = async ({ request }) => {
  // Health check: GET /apps/ibc-pickup/availability
  await authenticate.public.appProxy(request);
  return json({ ok: true });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) return json({ error: "app_not_installed" }, 503);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }

  const rawItems = Array.isArray(payload?.items) ? payload.items.slice(0, 100) : [];
  const totalPence = Number(payload?.total_price ?? 0);

  // 1. Settings (single shop metafield — the source of truth).
  const { settings } = await loadSettings(admin);

  // 2. Actual product metafields for the cart lines (never trusted from the client).
  const productIds = [
    ...new Set(
      rawItems
        .map((i) => String(i.product_id || "").replace(/\D/g, ""))
        .filter(Boolean)
        .map((id) => `gid://shopify/Product/${id}`)
    ),
  ];

  let items = [];
  if (productIds.length > 0) {
    const response = await admin.graphql(PRODUCT_METAFIELDS_QUERY, {
      variables: { ids: productIds },
    });
    const { data } = await response.json();
    items = (data?.nodes || [])
      .filter(Boolean)
      .map((node) => ({
        delayMinutes: node.delay?.value != null ? Number(node.delay.value) : null,
        pickupAvailable:
          node.available?.value == null ? true : node.available.value === "true",
      }));
  }

  // 3. Capacity counts from existing Shopify pickup orders.
  const orderCounts = await fetchPickupOrderCounts(admin, {
    horizonDays: settings.booking_horizon_days,
    timeZone: settings.timezone,
  });

  // 4. Compute.
  const availability = computeAvailability({
    settings,
    now: new Date(),
    cart: { totalPence, items },
    orderCounts,
  });

  return json({
    ...availability,
    max_delay_minutes: maxPrepDelayMinutes(items),
    generated_at: new Date().toISOString(),
  });
};
