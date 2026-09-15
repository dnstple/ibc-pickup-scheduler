// Courier — the Gophr connection test bench.
//
// This page exists to answer four questions with evidence rather than
// assumption, before a line of storefront code is written:
//
//   1. Do the credentials work?                                    ✓ answered
//   2. What does a quote request have to look like?                ✓ answered
//   3. What do the six representative journeys actually cost?
//   4. Does Gophr put a cake on a cargo bike, or on a moped?
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
  Select,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  gophrStatus,
  gophrEnv,
  quote,
  parcelFor,
  buildQuoteBody,
  buildJobBody,
  bookJob,
  pickupMobile,
  GophrError,
} from "../lib/gophr.server";
import { ZONES, TEST_ZONE, zoneForPostcode, shopifyPostcodeList } from "../lib/zones";
import { zonedParts, addDays, dateLabel, wallTimeToInstant, toZonedISO } from "../lib/timezone";

// Bumped whenever the request shape changes. Shown on the page so "is the new
// code actually running?" is answered by looking, not by inferring from the
// error message.
const SHAPE_VERSION = "v4 — scheduled pickups, prices read as objects";

const TZ = "Europe/London";

// The six journeys from the scope.
const TEST_JOURNEYS = [
  { label: "Mayfair", postcode: "W1K 3JA", address1: "1 Grosvenor Square" },
  { label: "Covent Garden", postcode: "WC2E 9DD", address1: "Bow Street" },
  { label: "Shoreditch", postcode: "EC2A 3AY", address1: "Great Eastern Street" },
  { label: "Battersea", postcode: "SW11 4NJ", address1: "Battersea Park Road" },
  { label: "Hampstead", postcode: "NW3 1QG", address1: "Hampstead High Street" },
  { label: "Bermondsey", postcode: "SE16 4DG", address1: "Jamaica Road" },
];

/**
 * The next occurrence of a weekday at a given wall-clock time, in London.
 *
 * Always at least one day ahead, so "next Friday" never resolves to a time
 * that has already passed today. Computed on the SERVER and passed down —
 * a value derived from the clock during render differs between the server
 * pass and the client pass, and React calls that a hydration mismatch.
 */
function nextWeekdayAt(weekdayName, time, now = new Date()) {
  let dateStr = zonedParts(now, TZ).dateStr;
  for (let i = 1; i <= 8; i += 1) {
    const candidate = addDays(dateStr, i);
    if (dateLabel(candidate).weekday === weekdayName) {
      return toZonedISO(wallTimeToInstant(candidate, time, TZ), TZ);
    }
  }
  return null; // unreachable for a real weekday name
}

/**
 * When to quote for.
 *
 * "Right now" is the easy one and the least useful: a Tuesday-morning average
 * flatters the numbers. Friday at five is where a flat rate is lost, and it is
 * the figure that should set the prices.
 */
function pickupOptions(now = new Date()) {
  return [
    { value: "now", label: "Right now", iso: null },
    { value: "tue11", label: "Next Tuesday, 11:00", iso: nextWeekdayAt("Tuesday", "11:00", now) },
    { value: "fri17", label: "Next Friday, 17:00 — the one that matters", iso: nextWeekdayAt("Friday", "17:00", now) },
    { value: "sat14", label: "Next Saturday, 14:00", iso: nextWeekdayAt("Saturday", "14:00", now) },
    { value: "sun12", label: "Next Sunday, 12:00", iso: nextWeekdayAt("Sunday", "12:00", now) },
  ];
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return {
    status: gophrStatus(),
    pickups: pickupOptions().map(({ value, label, iso }) => ({ value, label, iso })),
    journeys: TEST_JOURNEYS.map((j) => ({
      ...j,
      zone: zoneForPostcode(j.postcode, ZONES)?.id || null,
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
  const when = form.get("when") || "now";

  if (form.get("intent") === "book") return bookTestJob({ perishable, when });


  // Recomputed here rather than trusted from the form. The client has no
  // business deciding what instant the server asks a courier about.
  const chosen = pickupOptions().find((o) => o.value === when) || { iso: null, label: "Right now" };

  const results = [];
  for (const journey of TEST_JOURNEYS) {
    // Deliberately sequential. Six requests is nothing, and hammering a new
    // integration in parallel is how you meet a rate limit you did not know
    // existed on the first day.
    const parcel = parcelFor({
      grams: perishable ? 2100 : 500,
      perishable,
      id: `ibc-test-${journey.postcode.replace(/\s+/g, "")}`,
    });
    const destination = {
      postcode: journey.postcode,
      address1: journey.address1,
      city: "London",
    };
    try {
      const result = await quote({ destination, parcel, earliestPickup: chosen.iso });
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
        request: buildQuoteBody({ destination, parcel, earliestPickup: chosen.iso }),
      });
    }
  }
  return {
    results,
    perishable,
    when: chosen.label,
    whenIso: chosen.iso,
    ranAt: new Date().toISOString(),
  };
};

/**
 * ONE booking, against the sandbox, to discover the request shape.
 *
 * The quote shape took four round trips to establish, because every one of
 * them was a guess checked against a real response. This is the same
 * instrument pointed at `POST /job`: send the best inference, read what Gophr
 * says it wanted, change it to that. A 422 here is the tool working.
 *
 * IT REFUSES TO RUN AGAINST PRODUCTION, and refuses rather than warns. A
 * button whose whole purpose is to send malformed requests until one sticks
 * has no business being one careless environment variable away from a real
 * rider arriving at 29 Rathbone Place.
 */
async function bookTestJob({ perishable, when }) {
  const environment = gophrEnv();
  if (environment !== "sandbox") {
    return {
      booking: {
        ok: false,
        refused: true,
        message:
          "This bench only runs against the sandbox. GOPHR_ENV is set to production, " +
          "and a test booking there dispatches a real rider to the shop.",
      },
    };
  }

  const chosen = pickupOptions().find((o) => o.value === when) || { iso: null, label: "Right now" };

  /* The shop's own address as the destination. If the shape is wrong the
   * request fails, and if it is right a sandbox rider is dispatched to nowhere
   * — but a real one would come here, which is the least surprising place for
   * a test parcel to be sent. */
  const destination = {
    name: "Test Recipient",
    mobile: pickupMobile(),
    address1: "29 Rathbone Place",
    city: "London",
    postcode: "W1T 1JG",
    country_code: "GB",
  };

  const options = {
    destination,
    parcel: parcelFor({
      grams: perishable ? 2100 : 500,
      perishable,
      id: `ibc-booktest-${Date.now()}`,
    }),
    earliestPickup: chosen.iso,
    externalId: `IBC-BENCH-${Date.now()}`,
    reference: "Test booking from the Courier bench",
    dropoffNotes: "TEST BOOKING — not a real order.",
  };

  if (!pickupMobile()) {
    return {
      booking: {
        ok: false,
        message:
          "GOPHR_PICKUP_MOBILE is not set. Gophr needs a number for the collection, " +
          "and a job cannot be created without one. Add it in Vercel and redeploy.",
        request: buildJobBody(options),
      },
    };
  }

  try {
    const result = await bookJob(options);
    return {
      booking: {
        ok: true,
        when: chosen.label,
        job: result.job,
        request: result.request,
        response: result.response,
      },
    };
  } catch (error) {
    return {
      booking: {
        ok: false,
        when: chosen.label,
        message: error.message,
        status: error instanceof GophrError ? error.status : undefined,
        body: error instanceof GophrError ? error.body : undefined,
        /* The request, on the failure path, for the same reason the quote
         * bench shows it: without it a stale deploy and a wrong payload look
         * identical. */
        request: error?.request || buildJobBody(options),
      },
    };
  }
}

const money = (m) => (m ? `£${m.amount.toFixed(2)}` : "—");

export default function Courier() {
  const { status, journeys, zones, testZone, pickups } = useLoaderData();
  const fetcher = useFetcher();
  const [showRaw, setShowRaw] = useState(false);
  const [when, setWhen] = useState("now");
  const running = fetcher.state !== "idle";
  const data = fetcher.data;
  /* The booking bench and the quote bench share one fetcher, so each reads
   * only its own half of the answer. Without this, a booking result would
   * leave the quote table rendering the previous run's rows as if they were
   * fresh. */
  const booking = fetcher.data?.booking || null;

  const run = (perishable) => {
    const body = new FormData();
    body.set("perishable", perishable ? "true" : "false");
    body.set("when", when);
    fetcher.submit(body, { method: "POST" });
  };

  const ok = data?.results?.filter((r) => r.ok) || [];
  const vehicles = [...new Set(ok.map((r) => r.price?.vehicleType).filter((v) => v != null))];
  const grossTotal = ok.reduce((sum, r) => sum + (r.price?.gross?.amount || 0), 0);

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

              {status.key?.mismatch === "production-key-on-sandbox" && (
                <Banner tone="critical" title="This key does not belong to the sandbox">
                  <BlockStack gap="200">
                    <Text as="p">
                      Gophr&rsquo;s keys are environment-specific, and sandbox keys begin
                      with <Text as="span" fontWeight="semibold">sand-</Text>. Yours does
                      not, so it is a production key being sent to the sandbox endpoint —
                      which returns 401 without explaining why.
                    </Text>
                  </BlockStack>
                </Banner>
              )}

              {status.key?.mismatch === "sandbox-key-on-production" && (
                <Banner tone="warning" title="A sandbox key is being sent to production">
                  The key begins with <Text as="span" fontWeight="semibold">sand-</Text>,
                  which is a sandbox key, but GOPHR_ENV is set to production.
                </Banner>
              )}

              {status.key?.hadWhitespace && (
                <Banner tone="warning" title="The key had whitespace around it">
                  A trailing space or newline came along with the paste. It is being
                  trimmed before the request, so this is handled — but worth tidying in
                  Vercel so the next person is not chasing it.
                </Banner>
              )}

              {status.configured && (
                <Text as="p" tone="subdued" variant="bodySm">
                  Key check: {status.key.length} characters,{" "}
                  {status.key.looksSandbox ? "sandbox prefix present" : "no sandbox prefix"}.
                  The key itself is never read into this page.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* -------------------------------------------------- the six quotes */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">The six journeys</Text>

              <Select
                label="Quote for"
                options={pickups.map((p) => ({ label: p.label, value: p.value }))}
                value={when}
                onChange={setWhen}
                helpText={
                  pickups.find((p) => p.value === when)?.iso ||
                  "Whatever the time is now, which on a quiet evening flatters the numbers."
                }
              />

              <Text as="p" tone="subdued">
                <Text as="span" fontWeight="semibold">Friday at five is the one that
                matters.</Text> A flat rate is a bet that the average job costs less than
                you charge, and central London on a Friday evening is where that bet is
                lost. Quote for it before setting any price.
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
                  Quote as a cake (2.1kg, 45&times;45&times;30cm)
                </Button>
              </InlineStack>

              {data?.results && (
                <>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={data.perishable ? "attention" : "info"}>
                      {data.perishable ? "Cake — 2.1kg" : "Normal basket — 500g"}
                    </Badge>
                    <Badge>{data.when}</Badge>
                    {vehicles.length === 1 && <Badge>{`vehicle_type ${vehicles[0]}`}</Badge>}
                  </InlineStack>

                  <DataTable
                    columnContentTypes={["text", "text", "text", "numeric", "numeric", "numeric"]}
                    headings={["Destination", "Zone", "Vehicle", "Net", "Gross", "Minutes"]}
                    rows={data.results.map((r) => [
                      r.label,
                      journeys.find((j) => j.postcode === r.postcode)?.zone || "—",
                      r.ok ? (r.price?.vehicleType ?? "—") : "—",
                      r.ok ? money(r.price?.net) : "",
                      r.ok
                        ? money(r.price?.gross)
                        : <Text as="span" tone="critical">
                            {r.status ? `${r.status} — ` : ""}{r.message}
                          </Text>,
                      r.ok ? (r.price?.minRealisticMinutes ?? "—") : "",
                    ])}
                    totals={["", "", "", "", `£${grossTotal.toFixed(2)}`, ""]}
                    showTotalsInFooter
                  />

                  <Text as="p" tone="subdued" variant="bodySm">
                    <Text as="span" fontWeight="semibold">Net is ex-VAT, gross is inc-VAT</Text>{" "}
                    (gross is exactly net &times; 1.2). If you are VAT registered, net is
                    your real cost and gross is the number to compare against what a
                    customer pays. Minutes is Gophr&rsquo;s own realistic door-to-door
                    estimate.
                  </Text>

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

              {ok.length > 0 && (
                <Banner
                  tone={data.perishable ? "info" : "success"}
                  title={
                    data.perishable
                      ? "Now compare this against the normal basket"
                      : "Now run it as a cake and compare"
                  }
                >
                  <BlockStack gap="200">
                    <Text as="p">
                      The <Text as="span" fontWeight="semibold">Vehicle</Text> column is the
                      evidence. A 500g parcel and a 2.1kg cake must not come back on the
                      same vehicle code at the same price.
                    </Text>
                    <Text as="p">
                      If they do, size and weight are not reaching Gophr&rsquo;s vehicle
                      decision — most likely because the weight unit is wrong — and a
                      cake would go out on a moped, arriving on its side.
                    </Text>
                  </BlockStack>
                </Banner>
              )}

              {data?.results?.some((r) => !r.ok && r.status === 401) && (
                <Banner tone="critical" title="401 — the key was rejected, not the request">
                  Nothing is wrong with the request body: it never got that far. Check the
                  credentials card above.
                </Banner>
              )}

              {data?.results?.some((r) => !r.ok && r.status === 422) && (
                <Banner tone="warning" title="422 — Gophr rejected the request body">
                  <Text as="p">
                    Open the raw view and read the request, not just the errors. Each
                    parcel should carry bare{" "}
                    <Text as="span" fontWeight="semibold">length / width / height / weight</Text>{" "}
                    alongside a prefixed{" "}
                    <Text as="span" fontWeight="semibold">parcel_external_id</Text>.
                  </Text>
                </Banner>
              )}

              <Text as="p" tone="subdued" variant="bodySm">
                Request shape: {SHAPE_VERSION}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ---------------------------------------------------- book a job */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Book a test job</Text>
                <Badge tone={status.environment === "sandbox" ? "success" : "critical"}>
                  {status.environment === "sandbox" ? "sandbox — safe" : "PRODUCTION — refused"}
                </Badge>
              </InlineStack>

              <Text as="p">
                A quote is a question; this is the booking. The quote request shape took
                four attempts to get right, and every one of them was settled by sending
                something and reading the answer. This does the same for{" "}
                <Text as="span" fontWeight="semibold">POST /job</Text>, which has never
                been called. <Text as="span" fontWeight="semibold">Expect the first
                attempt to fail with a list of field names</Text> — that list is the
                point, and it is what the webhook will be corrected against.
              </Text>

              <Text as="p" tone="subdued" variant="bodySm">
                It books from the shop to the shop, using the day and time selected
                above, and refuses outright if GOPHR_ENV is not sandbox.
              </Text>

              <InlineStack gap="300">
                <Button
                  onClick={() =>
                    fetcher.submit(
                      { intent: "book", perishable: "false", when },
                      { method: "POST" }
                    )
                  }
                  loading={fetcher.state !== "idle"}
                  disabled={status.environment !== "sandbox" || !status.configured}
                >
                  Send one test booking
                </Button>
              </InlineStack>

              {booking && booking.ok && (
                <Banner tone="success" title="Gophr accepted the booking">
                  <BlockStack gap="200">
                    <Text as="p">
                      Job {booking.job?.jobId || "(no id found in the response)"}
                      {booking.job?.deliveryId ? ` · delivery ${booking.job.deliveryId}` : ""}
                      {booking.job?.status ? ` · ${booking.job.status}` : ""}
                    </Text>
                    {!booking.job?.jobId && (
                      <Text as="p">
                        No job id could be read from the response. The shape below needs
                        to go into readJob() before the webhook can be trusted — without
                        an id there is nothing to cancel and nothing to stop a retry
                        booking a second rider.
                      </Text>
                    )}
                  </BlockStack>
                </Banner>
              )}

              {booking && !booking.ok && (
                <Banner tone={booking.refused ? "warning" : "critical"}
                        title={booking.refused ? "Refused" : `Booking failed${booking.status ? ` — ${booking.status}` : ""}`}>
                  <Text as="p">{booking.message}</Text>
                </Banner>
              )}

              {booking && (
                <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="p" fontWeight="semibold" variant="bodySm">What was sent</Text>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}>
                      {JSON.stringify(booking.request, null, 2)}
                    </pre>
                    <Text as="p" fontWeight="semibold" variant="bodySm">What came back</Text>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}>
                      {JSON.stringify(booking.body ?? booking.response ?? null, null, 2)}
                    </pre>
                  </BlockStack>
                </Box>
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
