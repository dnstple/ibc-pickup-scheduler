// Count existing Shopify pickup orders so capacity limits can be enforced.
// No booking database: Shopify orders + their ibc_pickup_* attributes are the
// only record of demand. See README for the race-condition limitation.

import { buildOrderCounts } from "./availability.js";

const ORDERS_QUERY = `
  query PickupOrderCounts($q: String!, $after: String) {
    orders(first: 250, query: $q, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        cancelledAt
        customAttributes { key value }
        fulfillmentOrders(first: 5) {
          nodes { deliveryMethod { methodType } }
        }
      }
    }
  }
`;

export async function fetchPickupOrderCounts(admin, { horizonDays, timeZone }) {
  // Orders can only carry a future pickup date within the booking horizon, so
  // anything created more than (horizon + 2) days ago cannot still matter.
  const lookback = Math.min(Number(horizonDays) + 2, 92);
  const since = new Date(Date.now() - lookback * 86400000).toISOString();
  const q = `created_at:>='${since}' status:any`;

  const orders = [];
  try {
    let after = null;
    for (let page = 0; page < 4; page += 1) {
      const response = await admin.graphql(ORDERS_QUERY, { variables: { q, after } });
      const { data } = await response.json();
      const conn = data?.orders;
      if (!conn) break;
      for (const node of conn.nodes) {
        const attributes = {};
        for (const a of node.customAttributes || []) attributes[a.key] = a.value;
        if (!attributes.ibc_pickup_requested) continue;
        const methods = (node.fulfillmentOrders?.nodes || [])
          .map((f) => f.deliveryMethod?.methodType)
          .filter(Boolean);
        orders.push({
          cancelled: Boolean(node.cancelledAt),
          // Delivery orders must be ignored even if pickup attributes are present.
          // If methodType is unavailable, count the order (safe, conservative).
          isPickup: methods.length === 0 ? true : methods.includes("PICK_UP"),
          attributes,
        });
      }
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  } catch (error) {
    // Fail soft: if order counting is unavailable (e.g. missing scope), the
    // scheduler still works — capacity limits just aren't enforced for this
    // request. Logged so it shows up in the host's runtime logs.
    console.error("[ibc-pickup] capacity counting failed:", error?.message || error);
    return { byDate: {}, bySlot: {} };
  }
  return buildOrderCounts(orders, timeZone);
}
