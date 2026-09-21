// The switch that turns the checkout guard on.
//
// The delivery gate's twin, and it exists for the same reason: a function is
// not running because it was deployed. This one had no [extensions.ui.paths]
// at all, so there was no way to reach a page even if one had existed.
//
// WHAT THE GUARD CATCHES that the gate cannot
// -------------------------------------------
// The gate can only HIDE an option. Hiding is not refusing, and two routes go
// round it:
//
//   1. THE FEE IS A DELETABLE LINE. The same-day courier charge rides in the
//      basket as an ordinary line item, because Shopify Basic will not let an
//      app price shipping at checkout. An ordinary line item can be removed.
//      Choose same-day, get quoted, delete the fee, check out — and the gate
//      still sees `delivery_option: sameday` and lets local delivery through,
//      because from where it stands this is a paid courier order.
//
//   2. EXPRESS CHECKOUTS. Shop Pay, PayPal, Apple Pay and Google Pay take a
//      different route through checkout, and a hidden option is not the same
//      as a refused order.
//
// The guard refuses both, in words, at the checkout itself.
//
// CREATE ONLY, DELIBERATELY. Enabling, disabling and deleting a validation
// all live in Shopify's own list under Settings > Checkout, with a proper
// confirmation on the delete. A second set of those controls here would be a
// second thing to keep in step for no gain.

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

const API_TYPE = "cart_checkout_validation";
const FUNCTION_HANDLE = "ibc-checkout-guard";
const DEFAULT_TITLE = "Same-day guard — refuse a basket with no courier fee";

const FUNCTIONS_QUERY = `#graphql
  query ShopifyFunctions {
    shopifyFunctions(first: 50) {
      nodes { id title apiType app { title } }
    }
  }
`;

/* What is already installed, so pressing the button twice cannot make two of
 * them — which is exactly what happened with the delivery gate an hour before
 * this file was written. */
const EXISTING_QUERY = `#graphql
  query Validations {
    validations(first: 50) {
      nodes { id title enabled }
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation ValidationCreate($validation: ValidationCreateInput!) {
    validationCreate(validation: $validation) {
      validation { id title enabled }
      userErrors { field message }
    }
  }
`;

async function lookup(admin, fallback) {
  const out = { functionId: fallback || "", functions: [], existing: [], resolved: false };
  try {
    const response = await admin.graphql(FUNCTIONS_QUERY);
    const body = await response.json();
    out.functions = body?.data?.shopifyFunctions?.nodes || [];
    const mine = out.functions.filter((node) => node.apiType === API_TYPE);
    if (mine.length) {
      out.functionId = mine[0].id;
      out.resolved = true;
    }
  } catch (error) {
    out.error = String(error?.message || error);
  }
  try {
    const response = await admin.graphql(EXISTING_QUERY);
    const body = await response.json();
    out.existing = body?.data?.validations?.nodes || [];
  } catch (error) {
    /* Not fatal. The duplicate warning is a courtesy; without it the page
     * still works and Shopify still accepts the create. */
    out.existing = [];
  }
  return out;
}

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const found = await lookup(admin, params.functionId);
  return {
    ...found,
    isNew: !params.id || params.id === "new",
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const title = String(form.get("title") || "").trim() || DEFAULT_TITLE;
  const blockOnFailure = String(form.get("blockOnFailure") || "") === "true";

  try {
    const response = await admin.graphql(CREATE_MUTATION, {
      variables: {
        validation: {
          functionHandle: FUNCTION_HANDLE,
          title,
          enable: true,
          blockOnFailure,
        },
      },
    });
    const body = await response.json();

    if (body?.errors?.length) {
      return { ok: false, errors: body.errors.map((e) => ({ message: e.message })) };
    }
    const payload = body?.data?.validationCreate;
    if (payload?.userErrors?.length) {
      return { ok: false, errors: payload.userErrors };
    }
    return { ok: true, validation: payload?.validation || null };
  } catch (error) {
    return { ok: false, errors: [{ message: String(error?.message || error) }] };
  }
};

export default function CheckoutGuardPage() {
  const { functionId, resolved, functions, existing, error } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [blockOnFailure, setBlockOnFailure] = useState(false);

  const mine = (existing || []).filter((v) => (v.title || "").includes("Same-day guard"));
  const already = mine.length > 0;

  return (
    <Page
      title="Switch the checkout guard on"
      subtitle="Refuses a same-day order whose courier fee has been taken out of the basket."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.ok ? (
              <Banner tone="success" title="The guard is on">
                <p>
                  It is now listed under <b>Settings &rsaquo; Checkout</b>. Test it: choose
                  same-day, then delete the courier fee line from your basket and try to check
                  out. You should be refused, with the reason in words.
                </p>
              </Banner>
            ) : null}

            {actionData?.errors?.length ? (
              <Banner tone="critical" title="That did not save">
                <List>
                  {actionData.errors.map((e, i) => (
                    <List.Item key={i}>{e.message}</List.Item>
                  ))}
                </List>
              </Banner>
            ) : null}

            {already && !actionData?.ok ? (
              <Banner tone="warning" title="One of these already exists">
                <p>
                  {mine.length === 1
                    ? "There is already a guard installed."
                    : `There are already ${mine.length} of these installed.`}{" "}
                  Creating another will not break anything, but it will run twice. Remove the
                  spare under <b>Settings &rsaquo; Checkout</b> rather than adding to it.
                </p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Why this is needed as well as the gate</Text>
                <Text as="p">
                  The delivery gate can only <b>hide</b> an option. Hiding is not refusing, and
                  two routes go round it:
                </Text>
                <List>
                  <List.Item>
                    <b>The courier fee is a deletable line.</b> It rides in the basket as an
                    ordinary line item, because Shopify Basic will not let an app price shipping
                    at checkout — and an ordinary line item can be removed. Choose same-day, get
                    quoted, delete the fee, check out. The gate still sees a same-day order and
                    lets local delivery through.
                  </List.Item>
                  <List.Item>
                    <b>Express checkouts.</b> Shop Pay, PayPal, Apple Pay and Google Pay take a
                    different route through checkout, and a hidden option is not a refused order.
                  </List.Item>
                </List>
                <Text as="p" tone="subdued">
                  The guard refuses both at the checkout itself, and says why — a postcode that
                  no longer matches the quote, a missing time, or a missing fee.
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
                    helpText="Only you see this. It appears in the list under Settings › Checkout."
                  />

                  <Checkbox
                    label="If the guard itself fails, stop the checkout"
                    checked={blockOnFailure}
                    onChange={setBlockOnFailure}
                    helpText="Off (recommended): if the guard ever crashes, checkout carries on without it — you might lose a delivery fee. On: a crash stops every checkout on the shop until it is fixed. Losing a fee is cheaper than losing a day's orders."
                  />
                  <input
                    type="hidden"
                    name="blockOnFailure"
                    value={blockOnFailure ? "true" : "false"}
                  />

                  <InlineStack align="end">
                    <Button submit variant="primary" loading={busy} disabled={!functionId}>
                      Switch it on
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
                    <Badge tone="attention">Not found</Badge>
                  )}
                </InlineStack>
                <Text as="p" tone="subdued" breakWord>
                  {functionId || "none"}
                  {error ? ` — ${error}` : ""}
                </Text>
                {functions?.length ? (
                  <Box paddingBlockStart="200">
                    <List>
                      {functions.map((fn) => (
                        <List.Item key={fn.id}>
                          {fn.title} — <code>{fn.apiType}</code>
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
