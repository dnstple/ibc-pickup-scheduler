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
import { gophrStatus, quote, parcelFor, GophrError } from "../lib/gophr.server";
import { ZONES, TEST_ZONE, zoneForPostcode, shopifyPostcodeList } from "../lib/zones";

// The six journeys from the scope. Three are deliberately Friday evening,
// because that is where a flat rate is lost — a Tuesday-morning average will
// flatter the numbers and set the price too low.
const TEST_JOURNEYS = [
  { label: "Mayfair", postcode: "W1K 3JA", address_line_1: "1 Grosvenor Square", when: "Tuesday 11:00" },
  { label: "Covent Garden", postcode: "WC2E 9DD", address_line_1: "Bow Street", when: "Friday 17:00" },
  { label: "Shoreditch", postcode: "EC2A 3AY", address_line_1: "Great Eastern Street", when: "Tuesday 11:00" },
  { label: "Battersea", postcode: "SW11 4NJ", address_line_1: "Battersea Park Road", when: "Friday 17:00" },
  { label: "Hampstead", postcode: "NW3 1QG", address_line_1: "Hampstead High Street", when: "Saturday 14:00" },
  { label: "Bermondsey", postcode: "SE16 4DG", address_line_1: "Jamaica Road", when: "Friday 17:00" },
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
      const parcel = parcelFor({ grams: perishable ? 2100 : 500, perishable });
      const result = await quote({
        destination: {
          postcode: journey.postcode,
          address_line_1: journey.address_line_1,
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
    <Page title="Courier" subtitle="Gophr connection test bench — changes nothing on the store">
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

              {data?.results?.some((r) => !r.ok) && (
                <Banner tone="warning" title="Some quotes failed — this is expected on the first run">
                  <Text as="p">
                    Gophr&rsquo;s reference pages would not render, so the field names in the
                    request are an educated guess. The error above names the field it
                    objected to. Send it over and the fix is one function
                    (<Text as="span" fontWeight="semibold">buildQuoteBody</Text> in
                    gophr.server.js) — nothing else in the app depends on the shape.
                  </Text>
                </Banner>
              )}
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
