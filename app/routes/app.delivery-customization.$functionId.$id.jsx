// The switch that turns the delivery gate on.
//
// WHY THIS FILE EXISTS
// --------------------
// A Shopify function is not running because it was deployed. Deploying makes
// it AVAILABLE; a merchant then has to create a delivery customization from
// it in Settings > Shipping and delivery, and Shopify hands them to the app
// to do that. `[extensions.ui.paths]` in the extension's toml says where.
//
// Ours said `/` — the scaffold's placeholder, never filled in. So the merchant
// picked the function, Shopify sent them to the app's home page, nothing was
// created, and the gate never ran. It sat there fully written, fully tested
// and switched off for its whole life, and no test could have caught it:
// every test order PAID for same-day, and stopping people who have not paid
// is the gate's entire job.
//
// Order #1102 is what that cost. A customer in SE1 chose standard postage,
// was offered "Local delivery — Free" because nothing was hiding it, and
// quite reasonably took it.
//
// WHAT THE GATE DOES, for whoever reads this next:
//   · no same-day in the basket  -> Local delivery is hidden, so the £0 rate
//     that exists to carry a paid courier order cannot be taken for free
//   · same-day in the basket     -> postage is hidden instead, so nobody pays
//     twice, and the address must still be the one the price was quoted for
//
// THE FUNCTION ID IS LOOKED UP, NOT TAKEN FROM THE URL. The path segment is
// whatever the toml put there, and a wrong one would fail at the mutation
// with a message about an id nobody recognises. Asking the shop which of its
// functions is the delivery customization is one query and cannot drift.

import { useState } from "react";
import { useLoaderData, useActionData, useNavigation, Form } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

const API_TYPE = "delivery_customization";
const DEFAULT_TITLE = "Same-day gate — hide free local delivery";

/* Every function this app has on the shop, so the right one can be picked by
 * its API type rather than by a name somebody might rename. */
const FUNCTIONS_QUERY = `#graphql
  query ShopifyFunctions {
    shopifyFunctions(first: 50) {
      nodes {
        id
        title
        apiType
        app { title }
      }
    }
  }
`;

const READ_QUERY = `#graphql
  query DeliveryCustomization($id: ID!) {
    deliveryCustomization(id: $id) {
      id
      title
      enabled
      functionId
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation DeliveryCustomizationCreate($input: DeliveryCustomizationInput!) {
    deliveryCustomizationCreate(deliveryCustomization: $input) {
      deliveryCustomization { id title enabled }
      userErrors { field message }
    }
  }
`;

const UPDATE_MUTATION = `#graphql
  mutation DeliveryCustomizationUpdate($id: ID!, $input: DeliveryCustomizationInput!) {
    deliveryCustomizationUpdate(id: $id, deliveryCustomization: $input) {
      deliveryCustomization { id title enabled }
      userErrors { field message }
    }
  }
`;

function gidFor(id) {
  const raw = String(id || "");
  return raw.startsWith("gid://") ? raw : `gid://shopify/DeliveryCustomization/${raw}`;
}

/** The shop's own delivery-customization function, or null when it has none —
 *  which means the app was never deployed to this shop and no page can help. */
async function findFunction(admin, fallback) {
  try {
    const response = await admin.graphql(FUNCTIONS_QUERY);
    const body = await response.json();
    const nodes = body?.data?.shopifyFunctions?.nodes || [];
    const mine = nodes.filter((node) => node.apiType === API_TYPE);
    if (mine.length) return { id: mine[0].id, all: nodes, resolved: true };
    return { id: fallback || "", all: nodes, resolved: false };
  } catch (error) {
    /* The lookup is a convenience, not the point. If it fails, fall back to
     * whatever the URL carried and let the mutation report the real problem. */
    return { id: fallback || "", all: [], resolved: false, error: String(error?.message || error) };
  }
}

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const found = await findFunction(admin, params.functionId);

  let existing = null;
  if (params.id && params.id !== "new") {
    try {
      const response = await admin.graphql(READ_QUERY, {
        variables: { id: gidFor(params.id) },
      });
      const body = await response.json();
      existing = body?.data?.deliveryCustomization || null;
    } catch (error) {
      existing = null;
    }
  }

  return {
    functionId: found.id,
    resolved: found.resolved,
    lookupError: found.error || null,
    functions: found.all,
    existing,
    isNew: !params.id || params.id === "new",
  };
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const title = String(form.get("title") || "").trim() || DEFAULT_TITLE;
  const enabled = String(form.get("enabled") || "") === "true";
  const functionId = String(form.get("functionId") || "").trim();

  if (!functionId) {
    return {
      ok: false,
      errors: [
        {
          message:
            "No delivery customization function is installed on this shop. Deploy the app first, then come back.",
        },
      ],
    };
  }

  const isNew = !params.id || params.id === "new";

  try {
    const response = isNew
      ? await admin.graphql(CREATE_MUTATION, {
          variables: { input: { functionId, title, enabled } },
        })
      : await admin.graphql(UPDATE_MUTATION, {
          variables: { id: gidFor(params.id), input: { title, enabled } },
        });

    const body = await response.json();
    const payload = isNew
      ? body?.data?.deliveryCustomizationCreate
      : body?.data?.deliveryCustomizationUpdate;

    /* A GraphQL error and a userError are different failures and the merchant
     * needs to see whichever happened, in words, rather than a blank page. */
    if (body?.errors?.length) {
      return { ok: false, errors: body.errors.map((e) => ({ message: e.message })) };
    }
    if (payload?.userErrors?.length) {
      return { ok: false, errors: payload.userErrors };
    }

    return {
      ok: true,
      created: isNew,
      customization: payload?.deliveryCustomization || null,
    };
  } catch (error) {
    return { ok: false, errors: [{ message: String(error?.message || error) }] };
  }
};

export default function DeliveryCustomizationPage() {
  const { functionId, resolved, lookupError, functions, existing, isNew } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [title, setTitle] = useState(existing?.title || DEFAULT_TITLE);
  const [enabled, setEnabled] = useState(existing ? !!existing.enabled : true);

  const saved = actionData?.ok;
  const errors = actionData?.errors || [];

  return (
    <Page
      title={isNew ? "Switch the delivery gate on" : "Delivery gate"}
      subtitle="Hides free local delivery from anyone who has not paid for a same-day courier."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {saved ? (
              <Banner tone="success" title={actionData.created ? "The gate is on" : "Saved"}>
                <p>
                  It is now listed under <b>Settings &rsaquo; Shipping and delivery &rsaquo;
                  Delivery customizations</b>. Place a test order to a central London postcode
                  without choosing same-day: Local delivery should not appear, and you should see
                  postage only.
                </p>
              </Banner>
            ) : null}

            {errors.length ? (
              <Banner tone="critical" title="That did not save">
                <List>
                  {errors.map((error, i) => (
                    <List.Item key={i}>{error.message}</List.Item>
                  ))}
                </List>
              </Banner>
            ) : null}

            {!functionId ? (
              <Banner tone="critical" title="No function found on this shop">
                <p>
                  This shop has no delivery-customization function installed, so there is nothing
                  to switch on. Deploy the app and come back.
                  {lookupError ? ` The lookup said: ${lookupError}` : ""}
                </p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">What this does</Text>
                <List>
                  <List.Item>
                    <b>No same-day in the basket</b> — Local delivery is hidden. That £0 rate
                    exists only to carry a courier the customer has already paid for in the
                    basket; without this, anyone in the delivery postcodes can take it for
                    nothing.
                  </List.Item>
                  <List.Item>
                    <b>Same-day in the basket</b> — postage is hidden instead, so nobody pays for
                    the parcel twice, and the delivery address must still be the postcode the
                    price was quoted for.
                  </List.Item>
                </List>
                <Text as="p" tone="subdued">
                  It can hide, rename and reorder delivery options. It cannot change a price —
                  which is why the courier fee rides in the basket as a line item.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <Form method="post">
                <BlockStack gap="400">
                  <TextField
                    label="Name"
                    name="title"
                    value={title}
                    onChange={setTitle}
                    autoComplete="off"
                    helpText="Only you see this. It appears in the list under Shipping and delivery."
                  />
                  <Checkbox
                    label="Active"
                    checked={enabled}
                    onChange={setEnabled}
                    helpText="Off leaves it listed but does nothing — free local delivery would be available to everyone again."
                  />
                  <input type="hidden" name="enabled" value={enabled ? "true" : "false"} />
                  <input type="hidden" name="functionId" value={functionId} />
                  <InlineStack align="end">
                    <Button submit variant="primary" loading={busy} disabled={!functionId}>
                      {isNew ? "Switch it on" : "Save"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingSm">Function</Text>
                  {resolved ? (
                    <Badge tone="success">Found on this shop</Badge>
                  ) : (
                    <Badge tone="attention">Using the id from the link</Badge>
                  )}
                </InlineStack>
                <Text as="p" tone="subdued" breakWord>
                  {functionId || "none"}
                </Text>
                {functions?.length ? (
                  <Box paddingBlockStart="200">
                    <Text as="p" tone="subdued">Every function this shop has:</Text>
                    <List>
                      {functions.map((fn) => (
                        <List.Item key={fn.id}>
                          {fn.title} — <code>{fn.apiType}</code>
                          {fn.app?.title ? ` (${fn.app.title})` : ""}
                        </List.Item>
                      ))}
                    </List>
                  </Box>
                ) : null}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
