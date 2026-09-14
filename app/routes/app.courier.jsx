// Courier — the Gophr connection test bench.
//
// This page exists to answer three questions with evidence rather than
// assumption, before a line of storefront code is written:
//
//   1. Do the credentials work?
//   2. What does a quote request have to look like?
//   3. What do the six representative journeys actually cost?
//
// It makes no changes to the store, writes nothing, and is invisible to
// customers. Running it against the sandbox dispatches no riders.

import { useState } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  gophrStatus,
  quote,
  parcelFor,
  buildQuoteBody,
  GophrError,
} from "../lib/gophr.server";

// Bumped whenever the request shape changes. Shown on the page so "is the new
// code actually running?" is answered by looking, not by inferring from the
// error message.
const SHAPE_VERSION = "v2 — flat prefixed fields, parcels on both ends";
import { ZONES, TEST_ZONE, zoneForPostcode, shopifyPostcodeList } from "../lib/zones";

// The six journeys from the scope. Three are deliberately Friday evening,
// because that is where a flat rate is lost — a Tuesday-morning average will
// flatter the numbers and set the price too low.
const TEST_JOURNEYS = [
  { label: "Mayfair", postcode: "W1K 3JA", address1: "1 Grosvenor Square", when: "Tuesday 11:00" },
  { label: "Covent Garden", postcode: "WC2E 9DD", address1: "Bow Street", when: "Friday 17:00" },
  { label: "Shoreditch", postcode: "EC2A 3AY", address1: "Great Eastern Street", when: "Tuesday 11:00" },
  { label: "Battersea", postcode: "SW11 4NJ", address1: "Battersea Park Road", when: "Friday 17:00" },
  { label: "Hampstead", postcode: "NW3 1QG", address1: "Hampstead High Street", when: "Saturday 14:00" },
  { label: "Bermondsey", postcode: "SE16 4DG", address1: "Jamaica Road", when: "Friday 17:00" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return {
    status: gophrStatus(),
    journeys: TEST_JOURNEYS.map((j) => ({
      ...j,
      zone: zoneForPostcode(j.postcode)?.id || null,
    })),
    zones: ZONES.map((z) => ({
      id: z.id,
      name: z.name,
      description: z.description,
      count: z.outwards.length,
      list: shopifyPostcodeList(z),
    })),
    testZone: { ...TEST_ZONE, list: shopifyPostcodeList(TEST_ZONE) },
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const perishable = form.get("perishable") === "true";

  const results = [];
  for (const journey of TEST_JOURNEYS) {
    // Deliberately sequential. Six requests is nothing, and hammering a new
    // integration in parallel is how you meet a rate limit you did not know
    // existed on the first day.
    try {
      const parcel = parcelFor({
        grams: perishable ? 2100 : 500,
        perishable,
        id: `ibc-test-${journey.postcode.replace(/\s+/g, "")}`,
      });
      const result = await quote({
        destination: {
          postcode: journey.postcode,
          address1: journey.address1,
          city: "London",
        },
        parcel,
      });
      results.push({
        label: journey.label,
        postcode: journey.postcode,
        ok: true,
        price: result.price,
        request: result.request,
        response: result.response,
      });
    } catch (error) {
      results.push({
        label: journey.label,
        postcode: journey.postcode,
        ok: false,
        message: error.message,
        status: error instanceof GophrError ? error.status : undefined,
        body: error instanceof GophrError ? error.body : undefined,
        // The request is included on the FAILURE path too. Without it, an old
        // build and a genuinely wrong request produce identical-looking
        // output, and an afternoon goes on working out which you are looking
        // at. Showing what was sent removes the ambiguity entirely.
        request: buildQuoteBody({
          destination: {
            postcode: journey.postcode,
            address1: journey.address1,
            city: "London",
          },
          parcel: parcelFor({
            grams: perishable ? 2100 : 500,
            perishable,
            id: `ibc-test-${journey.postcode.replace(/\s+/g, "")}`,
          }),
        }),
      });
    }
  }
  return { results, perishable, ranAt: new Date().toISOString() };
};

function Money({ price }) {
  if (!price || price.amount == null) return <Text as="span" tone="subdued">—</Text>;
  // Gophr may send pence or pounds; until we know which, show both readings
  // rather than picking one and being quietly wrong by a factor of 100.
  const asPounds = price.amount > 200 ? (price.amount / 100).toFixed(2) : price.amount.toFixed(2);
  return (
    <BlockStack gap="050">
      <Text as="span" fontWeight="semibold">£{asPounds}</Text>
      <Text as="span" tone="subdued" variant="bodySm">raw {price.amount} · {price.path}</Text>
    </BlockStack>
  );
}

export default function Courier() {
  const { status, journeys, zones, testZone } = useLoaderData();
  const fetcher = useFetcher();
  const [showRaw, setShowRaw] = useState(false);
  const running = fetcher.state !== "idle";
  const data = fetcher.data;

  const run = (perishable) => {
    const body = new FormData();
    body.set("perishable", perishable ? "true" : "false");
    fetcher.submit(body, { method: "POST" });
  };

  return (
    <Page
      title="Courier"
      subtitle="Gophr connection test bench — changes nothing on the store"
      titleMetadata={<Badge tone="info">{`Request shape ${SHAPE_VERSION.split(" —")[0]}`}</Badge>}
    >
      <Layout>
        {/* ---------------------------------------------------- credentials */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Credentials</Text>
                {status.configured
                  ? <Badge tone="success">Key found</Badge>
                  : <Badge tone="critical">No key set</Badge>}
              </InlineStack>

              {!status.configured && (
                <Banner tone="warning" title="Set the API key in Vercel, not here">
                  <BlockStack gap="200">
                    <Text as="p">
                      Add these two environment variables to the project in Vercel, then
                      redeploy. The key is never stored in Shopify, never written into the
                      theme, and never shown on this page.
                    </Text>
                    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                      <Text as="p" fontWeight="semibold">GOPHR_API_KEY = your key from Gophr&rsquo;s Developer Hub</Text>
                      <Text as="p" fontWeight="semibold">GOPHR_ENV = sandbox</Text>
                    </Box>
                    <Text as="p" tone="subdued">
                      There is no field for it on this screen on purpose. A secret typed
                      into an admin form ends up in a database, in a backup and in a log;
                      an environment variable does not.
                    </Text>
                  </BlockStack>
                </Banner>
              )}

              <InlineStack gap="200" blockAlign="center">
                <Text as="span">Environment</Text>
                {status.dispatchesRealRiders
                  ? <Badge tone="critical">production — books real riders</Badge>
                  : <Badge tone="info">sandbox — no rider is dispatched</Badge>}
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">{status.baseUrl}</Text>

              {/* ---- why a 401 happens, answered before you have to ask ---- */}
              {status.key?.mismatch === "production-key-on-sandbox" && (
                <Banner tone="critical" title="This key does not belong to the sandbox">
                  <BlockStack gap="200">
                    <Text as="p">
                      Gophr&rsquo;s keys are environment-specific, and sandbox keys begin
                      with <Text as="span" fontWeight="semibold">sand-</Text>. Yours does
                      not, so it is a production key being sent to the sandbox endpoint —
                      which returns 401 without explaining why.
                    </Text>
                    <Text as="p" fontWeight="semibold">Two ways out:</Text>
                    <List>
                      <List.Item>
                        Generate a <Text as="span" fontWeight="semibold">sandbox</Text> key
                        in Gophr&rsquo;s Developer&rsquo;s Hub and replace
                        GOPHR_API_KEY. If you cannot see an environment option there, ask
                        Gophr to enable sandbox access — some accounts have it switched off.
                      </List.Item>
                      <List.Item>
                        Or set <Text as="span" fontWeight="semibold">GOPHR_ENV = production</Text>{" "}
                        and use the key you have. <Text as="span" fontWeight="semibold">Quoting
                        is free and dispatches nobody</Text>, so this page stays safe — but
                        the environment badge will turn red, and it should stay red until
                        the booking code exists.
                      </List.Item>
                    </List>
                  </BlockStack>
                </Banner>
              )}

              {status.key?.mismatch === "sandbox-key-on-production" && (
                <Banner tone="warning" title="A sandbox key is being sent to production">
                  The key begins with <Text as="span" fontWeight="semibold">sand-</Text>,
                  which is a sandbox key, but GOPHR_ENV is set to production. Set
                  GOPHR_ENV back to sandbox.
                </Banner>
              )}

              {status.key?.hadWhitespace && (
                <Banner tone="warning" title="The key had whitespace around it">
                  A trailing space or newline came along with the paste. It is being
                  trimmed before the request, so this is handled — but it is worth tidying
                  in Vercel so the next person is not chasing it.
                </Banner>
              )}

              {status.configured && (
                <Text as="p" tone="subdued" variant="bodySm">
                  Key check: {status.key.length} characters,{" "}
                  {status.key.looksSandbox ? "sandbox prefix present" : "no sandbox prefix"}.
                  The key itself is never read into this page.
                </Text>
              )}

              {status.dispatchesRealRiders && (
                <Banner tone="critical" title="This is the live environment">
                  Quotes are free, but anything that creates a job here sends a real rider
                  to Rathbone Place and charges your account. Set GOPHR_ENV to sandbox
                  while testing.
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* -------------------------------------------------- the six quotes */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">The six journeys</Text>
              <Text as="p" tone="subdued">
                Three of these are Friday evening on purpose. That is where a flat rate is
                lost, and it is the number that should set the prices — not the Tuesday one.
              </Text>

              <InlineStack gap="200">
                <Button
                  variant="primary"
                  loading={running}
                  disabled={!status.configured}
                  onClick={() => run(false)}
                >
                  Quote as a normal basket
                </Button>
                <Button
                  loading={running}
                  disabled={!status.configured}
                  onClick={() => run(true)}
                >
                  Quote as a cake (2.1kg, cargo bike)
                </Button>
              </InlineStack>

              <Text as="p" tone="subdued" variant="bodySm">
                Gophr chooses the vehicle from parcel size, weight and distance — there is
                no code to force one. A cake is quoted at dimensions a pushbike cannot
                take, which is what puts it on a cargo bike and keeps the box level.
              </Text>

              {data?.results && (
                <>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Destination", "Postcode", "Zone", "Quote"]}
                    rows={data.results.map((r) => [
                      r.label,
                      r.postcode,
                      journeys.find((j) => j.postcode === r.postcode)?.zone || "—",
                      r.ok
                        ? <Money price={r.price} />
                        : <Text as="span" tone="critical">
                            {r.status ? `${r.status} — ` : ""}{r.message}
                          </Text>,
                    ])}
                  />
                  <Button onClick={() => setShowRaw((v) => !v)} variant="plain">
                    {showRaw ? "Hide" : "Show"} the raw request and response
                  </Button>
                  {showRaw && (
                    <Box background="bg-surface-secondary" padding="300" borderRadius="200" overflowX="scroll">
                      <pre style={{ fontSize: 11, margin: 0, whiteSpace: "pre-wrap" }}>
                        {JSON.stringify(data.results, null, 2)}
                      </pre>
                    </Box>
                  )}
                </>
              )}

              {data?.results?.some((r) => !r.ok && r.status === 401) && (
                <Banner tone="critical" title="401 — the key was rejected, not the request">
                  <Text as="p">
                    Nothing is wrong with the request body: it never got that far. This is
                    authentication. Check the credentials card above — the commonest cause
                    is a production key being sent to the sandbox.
                  </Text>
                </Banner>
              )}

              {data?.results?.some((r) => !r.ok && r.status === 422) && (
                <Banner tone="warning" title="422 — Gophr rejected the request body">
                  <BlockStack gap="200">
                    <Text as="p">
                      <Text as="span" fontWeight="semibold">Open the raw view first and look at
                      the request</Text>, not just the errors. If it contains{" "}
                      <Text as="span" fontWeight="semibold">pickup_address1</Text> and a{" "}
                      <Text as="span" fontWeight="semibold">parcels</Text> array on the
                      dropoff, this build is current and the remaining errors are real.
                    </Text>
                    <Text as="p">
                      If instead you see nested{" "}
                      <Text as="span" fontWeight="semibold">address</Text> or{" "}
                      <Text as="span" fontWeight="semibold">contact</Text> objects, an older
                      build is still deployed — the badge beside the page title should read{" "}
                      <Text as="span" fontWeight="semibold">Request shape v2</Text>.
                    </Text>
                  </BlockStack>
                </Banner>
              )}

              <Text as="p" tone="subdued" variant="bodySm">
                Request shape: {SHAPE_VERSION}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ------------------------------------------------------- the zones */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Test zone — start here</Text>
              <Text as="p">
                Paste this into Shopify first. It is the shop&rsquo;s own outward code and
                nothing else, so the only address that can match is one you control. It
                proves the rate appears, the function keeps it and the attributes land,
                without any chance of a customer meeting it.
              </Text>
              <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                <Text as="p" fontWeight="semibold">{testZone.list}</Text>
              </Box>
              <Text as="p" tone="subdued" variant="bodySm">
                Settings &rarr; Shipping and delivery &rarr; Local delivery, on
                &ldquo;Fitzrovia — Choose your pickup time after checkout&rdquo;. That is the
                location your orders route to; setting it on the other one would do nothing.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">The real zones, for later</Text>
              <Banner tone="info">
                Shopify matches a whole postcode area or a complete outward code. There are
                no wildcards — &ldquo;W1&rdquo; matches nothing at all, because no real
                outward code is exactly W1. Every code is spelled out.
              </Banner>
              {zones.map((z) => (
                <BlockStack gap="200" key={z.id}>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">{z.name}</Text>
                    <Badge>{`${z.count} codes`}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">{z.description}</Text>
                  <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                    <Text as="p" variant="bodySm">{z.list}</Text>
                  </Box>
                </BlockStack>
              ))}
              <Text as="p" tone="subdued" variant="bodySm">
                These lists live in two places — here and in Shopify — and Shopify is the
                one that actually gates the rate at checkout. Keep them in step.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">What this page does not do</Text>
              <List>
                <List.Item>It writes nothing to the store and changes no settings.</List.Item>
                <List.Item>It creates no jobs. Quoting is free and dispatches nobody.</List.Item>
                <List.Item>It is invisible to customers — nothing here touches the storefront.</List.Item>
                <List.Item>It never displays, logs or stores the API key.</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
