// Read/write the single shop metafield that owns all scheduler settings.
// This is the ONLY data the app writes anywhere: custom.pickup_scheduler_settings.

import { normalizeSettings } from "./availability.js";

export const SETTINGS_NAMESPACE = "custom";
export const SETTINGS_KEY = "pickup_scheduler_settings";

const SETTINGS_QUERY = `
  query PickupSettings {
    shop {
      id
      metafield(namespace: "${SETTINGS_NAMESPACE}", key: "${SETTINGS_KEY}") {
        id
        value
      }
    }
  }
`;

const SETTINGS_SET_MUTATION = `
  mutation SavePickupSettings($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id updatedAt }
      userErrors { field message code }
    }
  }
`;

export async function loadSettings(admin) {
  const response = await admin.graphql(SETTINGS_QUERY);
  const { data } = await response.json();
  let raw = null;
  if (data?.shop?.metafield?.value) {
    try {
      raw = JSON.parse(data.shop.metafield.value);
    } catch {
      raw = null; // corrupt JSON — fall back to defaults rather than crashing
    }
  }
  return {
    shopId: data?.shop?.id,
    settings: normalizeSettings(raw),
    exists: Boolean(data?.shop?.metafield?.value),
  };
}

export async function saveSettings(admin, shopId, settings) {
  const response = await admin.graphql(SETTINGS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: shopId,
          namespace: SETTINGS_NAMESPACE,
          key: SETTINGS_KEY,
          type: "json",
          value: JSON.stringify(normalizeSettings(settings)),
        },
      ],
    },
  });
  const { data } = await response.json();
  const errors = data?.metafieldsSet?.userErrors || [];
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.metafieldsSet.metafields[0];
}

// Product preparation data for the read-only "Product Preparation Rules" tab.
const PRODUCTS_QUERY = `
  query PickupProductRules($after: String) {
    products(first: 100, after: $after, sortKey: TITLE) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        status
        delay: metafield(namespace: "custom", key: "pickup_delay_minutes") { value }
        available: metafield(namespace: "custom", key: "pickup_available") { value }
      }
    }
  }
`;

export async function loadProductRules(admin, maxPages = 3) {
  const products = [];
  let after = null;
  let truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await admin.graphql(PRODUCTS_QUERY, { variables: { after } });
    const { data } = await response.json();
    const conn = data?.products;
    if (!conn) break;
    for (const node of conn.nodes) {
      products.push({
        id: node.id,
        numericId: node.id.split("/").pop(),
        title: node.title,
        status: node.status,
        delayMinutes: node.delay?.value != null ? Number(node.delay.value) : null,
        pickupAvailable: node.available?.value == null ? true : node.available.value === "true",
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (page === maxPages - 1) truncated = true;
  }
  return { products, truncated };
}
