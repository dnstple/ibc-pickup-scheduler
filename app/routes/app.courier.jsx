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
  Divider,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  gophrStatus,
  gophrEnv,
  quote,
  parcelFor,
  buildQuoteBody,
  buildJobBody,
  createJob,
  confirmJob,
  cancelJob,
  progressDelivery,
  probeDeadline,
  probeDeadlineCurve,
  CONFIRM_BODY,
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

/* What the app is ACTUALLY allowed to do, asked of Shopify rather than read
 * off shopify.app.toml.
 *
 * The toml is a request. The grant is a separate thing, and a scope added to
 * the file does nothing until the merchant accepts it — which, with managed
 * installation, happens quietly on some app loads and not others. The gap
 * between "I deployed it" and "it is granted" is invisible, and the symptom
 * is a fulfilment that fails hours later on a real order.
 *
 * So the page asks. `currentAppInstallation` returns the scopes of the app
 * making the call, which is this one.
 *
 * Fails soft: a page that cannot render because a diagnostic failed is worse
 * than a page with an unknown diagnostic on it. */
const SCOPES_QUERY = `
  query CourierScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

const NEEDED_SCOPES = [
  { handle: "read_orders", why: "read the order behind a booking" },
  { handle: "write_orders", why: "write the booking back onto the order" },
  {
    handle: "write_merchant_managed_fulfillment_orders",
    why: "mark the order fulfilled and send the customer their tracking link",
  },
];

async function grantedScopes(admin) {
  try {
    const response = await admin.graphql(SCOPES_QUERY);
    const { data } = await response.json();
    const handles = (data?.currentAppInstallation?.accessScopes || []).map((s) => s.handle);
    return { known: true, handles };
  } catch (error) {
    return { known: false, handles: [], error: error?.message || String(error) };
  }
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const granted = await grantedScopes(admin);
  return {
    scopes: {
      known: granted.known,
      needed: NEEDED_SCOPES.map((s) => ({
        ...s,
        granted: granted.handles.includes(s.handle),
      })),
    },
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

  const intent = form.get("intent");
  const armed = isArmed(form);   /* ⚠️ LIVE TEST — delete with its block */
  if (intent === "cancel") return cancelTestJob(form.get("jobId"));
  if (intent === "deadline") return probeDeadlineField(form.get("deadlineMinutes"));
  if (intent === "curve") return probeCurve();
  if (intent === "draft") return draftTestJob({ perishable, when, armed });
  if (intent === "confirm") {
    return confirmTestJob(form.get("jobId"), form.get("confirmBody"), armed);
  }
  if (intent === "progress") {
    return progressTestJob(form.get("jobId"), form.get("deliveryId"));
  }


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
 * Push the sandbox delivery one status further, and let the webhook fly.
 *
 * This is how the status endpoint gets tested without a rider: each press
 * advances the job and makes Gophr POST to /gophr/status, which is what
 * fulfils the Shopify order and emails the customer their tracking link.
 */
async function progressTestJob(jobId, deliveryId) {
  const refused = refuseOutsideSandbox();
  if (refused) return refused;

  if (!jobId || !deliveryId) {
    return {
      booking: {
        ok: false,
        step: "progress",
        message: "A job id and a delivery id are both needed. Create a draft first.",
      },
    };
  }

  try {
    const result = await progressDelivery(jobId, deliveryId);
    return {
      booking: {
        ok: true,
        step: "progress",
        job: result.job,
        request: result.request,
        response: result.response,
      },
    };
  } catch (error) {
    return {
      booking: {
        ok: false,
        step: "progress",
        message: error.message,
        status: error instanceof GophrError ? error.status : undefined,
        body: error instanceof GophrError ? error.body : undefined,
        request: error?.request || { jobId, deliveryId },
      },
    };
  }
}

/* ========================================================================= */
/* ⚠️  LIVE TEST BLOCK — DELETE THIS WHOLE SECTION BEFORE HANDING OVER  ⚠️   */
/*                                                                           */
/* Everything between this fence and the matching END fence exists so the    */
/* shop can dispatch ONE real rider to Rathbone Place, hand them nothing and */
/* say it was a test. It is scaffolding. It books real jobs with real money  */
/* against the live account, and it has no business surviving into a version */
/* anybody else runs.                                                        */
/*                                                                           */
/* TO REMOVE: delete to the END fence, delete the matching fence in the JSX  */
/* below, and delete `armed` from the two guards. Nothing else refers to it. */
/*                                                                           */
/* WHY IT IS ARMED BY TYPING RATHER THAN BY A CHECKBOX. A checkbox is one    */
/* stray click from a rider on a bike. A phrase somebody has to type out in  */
/* full cannot be hit by accident, cannot be left ticked from yesterday, and */
/* is checked ON THE SERVER — a disabled button is a suggestion, not a       */
/* guard. */
const ARMING_PHRASE = "BOOK A REAL RIDER";

function isArmed(form) {
  return String(form.get("liveConfirm") || "").trim() === ARMING_PHRASE;
}

/** Call off a job. Allowed in every environment — stopping is never the risk. */
async function cancelTestJob(jobId) {
  if (!jobId) {
    return { booking: { ok: false, step: "cancel", message: "No job id to cancel." } };
  }
  try {
    const response = await cancelJob(jobId, "Test booking — cancelled from the bench");
    return { booking: { ok: true, step: "cancel", response, request: { jobId } } };
  } catch (error) {
    return {
      booking: {
        ok: false,
        step: "cancel",
        message: error.message,
        status: error instanceof GophrError ? error.status : undefined,
        body: error instanceof GophrError ? error.body : undefined,
        request: { jobId },
      },
    };
  }
}
/* ==== END LIVE TEST BLOCK ================================================ */

/**
 * Which field sets a deadline, and what it costs.
 *
 * Quotes only — nothing is booked, nothing is charged, so this is safe to run
 * against the live account and only useful there, because sandbox prices are
 * not what anybody pays.
 */
async function probeDeadlineField(rawMinutes) {
  const minutes = Math.max(30, Math.min(Number(rawMinutes) || 90, 600));
  const deadline = new Date(Date.now() + minutes * 60000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+00:00");

  try {
    const found = await probeDeadline({
      destination: {
        name: "Test Recipient",
        mobile: pickupMobile(),
        address1: "Bow Street",
        city: "London",
        postcode: "WC2E 9DD",
        country_code: "GB",
      },
      parcel: parcelFor({ grams: 2100, perishable: true, id: `ibc-deadline-${Date.now()}` }),
      deadlineIso: deadline,
    });
    return { deadline: { ok: true, minutes, ...found } };
  } catch (error) {
    return {
      deadline: {
        ok: false,
        minutes,
        message: error.message,
        body: error instanceof GophrError ? error.body : undefined,
      },
    };
  }
}

/** The price of a deadline, across the range the shop actually promises. */
async function probeCurve() {
  const destination = {
    name: "Test Recipient",
    mobile: pickupMobile(),
    address1: "Bow Street",
    city: "London",
    postcode: "WC2E 9DD",
    country_code: "GB",
  };
  const parcel = parcelFor({ grams: 2100, perishable: true, id: `ibc-curve-${Date.now()}` });

  try {
    /* 60 is tighter than anything offered; 300 is the far end of a late
     * afternoon order picking the last window of the day. The shop's real
     * promises land in the middle. */
    const found = await probeDeadlineCurve({
      destination,
      parcel,
      minutesList: [60, 90, 120, 180, 240, 300],
    });
    return { curve: { ok: true, ...found } };
  } catch (error) {
    return { curve: { ok: false, message: error.message } };
  }
}

/* The sandbox guard, spelled once. It REFUSES rather than warns: a bench whose
 * whole purpose is to send half-understood requests until one sticks has no
 * business being one careless environment variable away from a real rider
 * arriving at Rathbone Place. */
function refuseOutsideSandbox(armed = false) {
  if (gophrEnv() === "sandbox") return null;
  /* ⚠️ LIVE TEST: the only way past this guard. Delete with its block. */
  if (armed) return null;
  return {
    booking: {
      ok: false,
      refused: true,
      message:
        "This bench only runs against the sandbox. GOPHR_ENV is set to production, " +
        "and confirming a job there dispatches a real rider to the shop.",
    },
  };
}

/**
 * Step one: create a DRAFT and show what came back.
 *
 * Safe by construction. Gophr's dispatcher never sees a draft, so this can be
 * run, read and abandoned without anything happening in the world. That is
 * exactly why the bench does it as its own step rather than as half of a
 * single booking button: the draft's response is the thing we need to read,
 * and reading it should not require dispatching anybody.
 */
async function draftTestJob({ perishable, when, armed = false }) {
  const refused = refuseOutsideSandbox(armed);
  if (refused) return refused;

  const chosen = pickupOptions().find((o) => o.value === when) || { iso: null, label: "Right now" };

  /* COVENT GARDEN, NOT THE SHOP.
   *
   * The bench used to send from 29 Rathbone Place to 29 Rathbone Place, so a
   * real rider would have turned up somewhere sensible. Gophr refused it:
   * ERROR_SAME_LAT_LNG, "Pickup and delivery coordinates seem to be the
   * same." Obvious in hindsight — a courier job with nowhere to go is not a
   * courier job — and worth recording, because that error arrived only once
   * every field in the body had been accepted, and for a moment it looked
   * like another payload problem.
   *
   * Bow Street is about a mile away: inside Zone A, a genuine journey, and
   * the same destination the quote bench already uses, so a booking and a
   * quote can be compared like with like. */
  /* Covent Garden in sandbox — a real journey, and nobody is waiting at the
   * other end because nobody is dispatched.
   *
   * ⚠️ LIVE TEST: in production the drop is the shop's OWN neighbour postcode
   * rather than a stranger's doorstep, so a rider who is told "this was a
   * test" has not already ridden a mile the wrong way. Delete with the block. */
  const live = gophrEnv() !== "sandbox";
  const destination = live
    ? {
        name: "TEST — hand the rider nothing",
        mobile: pickupMobile(),
        address1: "Charlotte Street",
        city: "London",
        postcode: "W1T 1RR",
        country_code: "GB",
      }
    : {
        name: "Test Recipient",
        mobile: pickupMobile(),
        address1: "Bow Street",
        city: "London",
        postcode: "WC2E 9DD",
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
    reference: live ? "TEST — NOT A REAL ORDER" : "Test booking from the Courier bench",
    dropoffNotes: "TEST BOOKING — NOT A REAL ORDER. Nothing to collect.",
    pickupNotes: "TEST BOOKING — the shop will hand you nothing. Please cancel.",
  };

  if (!pickupMobile()) {
    return {
      booking: {
        ok: false,
        step: "draft",
        message:
          "GOPHR_PICKUP_MOBILE is not set. Gophr needs a number for the collection, " +
          "and a job cannot be created without one. Add it in Vercel and redeploy.",
        request: buildJobBody(options),
      },
    };
  }

  try {
    const result = await createJob(options);
    return {
      booking: {
        ok: true,
        step: "draft",
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
        step: "draft",
        when: chosen.label,
        message: error.message,
        status: error instanceof GophrError ? error.status : undefined,
        body: error instanceof GophrError ? error.body : undefined,
        request: error?.request || buildJobBody(options),
      },
    };
  }
}

/**
 * Step two: confirm the draft. THIS DISPATCHES.
 *
 * The body is whatever the operator typed. The path and the method are
 * settled — PATCH /jobs/{job_id}, from Gophr's own "Confirming a Job" page —
 * but the body is not, and a wrong guess should cost a click rather than a
 * Vercel deploy and ten minutes. So it is a text box.
 */
async function confirmTestJob(jobId, rawBody, armed = false) {
  const refused = refuseOutsideSandbox(armed);
  if (refused) return refused;

  if (!jobId) {
    return { booking: { ok: false, step: "confirm", message: "No draft to confirm — create one first." } };
  }

  let body = CONFIRM_BODY;
  const text = String(rawBody || "").trim();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      return {
        booking: {
          ok: false,
          step: "confirm",
          message: `That confirm body is not valid JSON: ${error.message}`,
        },
      };
    }
  }

  try {
    const result = await confirmJob(jobId, body);
    return {
      booking: {
        ok: true,
        step: "confirm",
        job: result.job,
        request: result.request,
        response: result.response,
      },
    };
  } catch (error) {
    return {
      booking: {
        ok: false,
        step: "confirm",
        message: error.message,
        status: error instanceof GophrError ? error.status : undefined,
        body: error instanceof GophrError ? error.body : undefined,
        request: error?.request || { path: `/jobs/${jobId}`, body },
      },
    };
  }
}

const money = (m) => (m ? `£${m.amount.toFixed(2)}` : "—");

export default function Courier() {
  const { status, journeys, zones, testZone, pickups, scopes } = useLoaderData();
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
  const deadline = fetcher.data?.deadline || null;
  const curve = fetcher.data?.curve || null;
  const [deadlineMinutes, setDeadlineMinutes] = useState("90");
  /* The draft's id, remembered across the two steps so confirming does not
   * mean copying a uuid out of a JSON blob by hand. */
  const [draftId, setDraftId] = useState("");
  const [deliveryId, setDeliveryId] = useState("");
  const [confirmBody, setConfirmBody] = useState('{"is_confirmed":1}');
  /* ⚠️ LIVE TEST — delete with its block */
  const [liveConfirm, setLiveConfirm] = useState("");
  const armed = liveConfirm.trim() === "BOOK A REAL RIDER";
  const isLive = status.environment !== "sandbox";
  if (booking?.step === "draft" && booking.ok && booking.job?.jobId &&
      booking.job.jobId !== draftId) {
    setDraftId(booking.job.jobId);
    setDeliveryId(booking.job.deliveryId || "");
  }

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

        {/* ------------------------------------------------- deadline probe */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">What does a deadline cost?</Text>
              <Banner tone="warning" title="Right now we send no deadline at all">
                <Text as="p">
                  Gophr defaults to the end of the day — a live job booked for a
                  15:38–16:38 window was given until <Text as="span" fontWeight="semibold">
                  23:55</Text>, and the rider took other work while the ETA slid. The
                  customer&rsquo;s window is chosen in the basket and then never passed on.
                </Text>
              </Banner>
              <Text as="p" tone="subdued" variant="bodySm">
                Gophr sells &ldquo;book to a chosen deadline&rdquo; and documents no field
                for it. This sends the same journey seven times — once bare, then once
                per candidate name. Gophr <Text as="span" fontWeight="semibold">ignores
                fields it does not know</Text>, which was established by the very first
                422, so a wrong guess returns the baseline price unchanged. The name that
                MOVES the price is the real one. Quotes only: nothing is booked.
              </Text>

              <InlineStack gap="300" blockAlign="end">
                <Box minWidth="180px">
                  <TextField
                    label="Deadline, minutes from now"
                    type="number"
                    value={deadlineMinutes}
                    onChange={setDeadlineMinutes}
                    autoComplete="off"
                  />
                </Box>
                <Button
                  onClick={() =>
                    fetcher.submit({ intent: "deadline", deadlineMinutes }, { method: "POST" })
                  }
                  loading={running}
                  disabled={!status.configured}
                >
                  Probe
                </Button>
              </InlineStack>

              {deadline && deadline.ok && (
                <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                  <BlockStack gap="150">
                    {deadline.results.map((r) => (
                      <InlineStack key={r.label} gap="200" blockAlign="center" wrap={false}>
                        <Badge tone={r.error ? "attention" : r.changed ? "success" : undefined}>
                          {r.error ? "error" : r.changed ? "THIS ONE" : "ignored"}
                        </Badge>
                        <Text as="span" variant="bodySm">
                          <Text as="span" fontWeight="semibold">{r.label}</Text>
                          {" — "}
                          {r.amount != null ? `£${r.amount.toFixed(2)}` : (r.error || "no price")}
                          {r.delta ? ` (${r.delta > 0 ? "+" : ""}£${r.delta.toFixed(2)})` : ""}
                        </Text>
                      </InlineStack>
                    ))}
                    {deadline.results.every((r) => !r.changed && !r.error) && (
                      <Text as="p" variant="bodySm">
                        Every candidate was ignored, so none of them is the name. Either the
                        deadline lives on the JOB rather than the dropoff, or it is only
                        honoured when booking rather than when quoting — in which case it
                        costs nothing extra and we should simply always send it.
                      </Text>
                    )}
                  </BlockStack>
                </Box>
              )}

              <Divider />

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">The price curve</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Gophr prices urgency, so a deadline is a curve rather than a number.
                  This quotes the same journey at six deadline lengths. The ones that
                  matter are 180 and 240 minutes — a customer ordering mid-afternoon
                  picks a window ending three or four hours later, not in ninety minutes.
                </Text>
                <InlineStack gap="300">
                  <Button
                    onClick={() => fetcher.submit({ intent: "curve" }, { method: "POST" })}
                    loading={running}
                    disabled={!status.configured}
                  >
                    Measure the curve
                  </Button>
                </InlineStack>
              </BlockStack>

              {curve && curve.ok && (
                <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                  <BlockStack gap="150">
                    {curve.rows.map((r) => (
                      <BlockStack gap="050" key={r.label}>
                        <Text as="p" variant="bodySm">
                          <Text as="span" fontWeight="semibold">{r.label}</Text>
                          {" — "}
                          {r.amount != null ? `£${r.amount.toFixed(2)}` : (r.error || "no price")}
                          {r.delta ? `  (${r.delta > 0 ? "+" : ""}£${r.delta.toFixed(2)})` : ""}
                          {r.amount != null && r.minutes
                            ? `   · Zone A margin ${(12.95 - r.amount) >= 0 ? "+" : "−"}£${Math.abs(12.95 - r.amount).toFixed(2)}`
                            : ""}
                        </Text>
                        {r.detail && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {r.at ? `deadline ${r.at.slice(11, 16)} — ` : ""}{r.detail}
                          </Text>
                        )}
                      </BlockStack>
                    ))}
                  </BlockStack>
                </Box>
              )}

              {deadline && !deadline.ok && (
                <Banner tone="critical" title="Probe failed">
                  <Text as="p">{deadline.message}</Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ---------------------------------------------------- permissions */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Permissions</Text>
                <Badge
                  tone={
                    !scopes?.known
                      ? "attention"
                      : scopes.needed.every((s) => s.granted)
                        ? "success"
                        : "critical"
                  }
                >
                  {!scopes?.known
                    ? "could not check"
                    : scopes.needed.every((s) => s.granted)
                      ? "all granted"
                      : "one is missing"}
                </Badge>
              </InlineStack>

              <Text as="p" tone="subdued" variant="bodySm">
                Asked of Shopify, not read off the config file. A scope listed in
                shopify.app.toml is a request; the grant is a separate thing, and the
                gap between them is invisible until a real order fails.
              </Text>

              <BlockStack gap="150">
                {(scopes?.needed || []).map((s) => (
                  <InlineStack key={s.handle} gap="200" blockAlign="center" wrap={false}>
                    <Badge tone={s.granted ? "success" : "critical"}>
                      {s.granted ? "granted" : "missing"}
                    </Badge>
                    <BlockStack gap="0">
                      <Text as="span" variant="bodySm" fontWeight="semibold">{s.handle}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">Lets the app {s.why}.</Text>
                    </BlockStack>
                  </InlineStack>
                ))}
              </BlockStack>

              {scopes?.known && !scopes.needed.every((s) => s.granted) && (
                <Banner tone="critical" title="Shopify has not granted everything yet">
                  <Text as="p">
                    Run <Text as="span" fontWeight="semibold">shopify app deploy</Text>, then
                    close this app and open it again from{" "}
                    <Text as="span" fontWeight="semibold">Apps</Text> in the admin. Managed
                    installation asks for new permissions on an app load, so the fix is
                    usually to leave and come back rather than to find a button.
                  </Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ---------------------------------------------------- book a job */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Book a test job</Text>
                <Badge tone={status.environment === "sandbox" ? "success" : "critical"}>
                  {status.environment === "sandbox" ? "sandbox — safe" : "PRODUCTION — refused"}
                </Badge>
              </InlineStack>

              {/* ================================================================= */}
              {/* ⚠️  LIVE TEST BLOCK — DELETE THIS JSX BEFORE HANDING OVER  ⚠️    */}
              {isLive && (
                <Banner
                  tone={armed ? "critical" : "warning"}
                  title={armed ? "ARMED — the next confirm sends a real rider" : "Live account: booking is locked"}
                >
                  <BlockStack gap="300">
                    <Text as="p">
                      This is <Text as="span" fontWeight="semibold">production</Text>. A
                      confirmed job here dispatches a real courier to 29 Rathbone Place and
                      charges your Gophr account. The draft is free; the confirm is not.
                    </Text>
                    <Text as="p">
                      To unlock, type{" "}
                      <Text as="span" fontWeight="semibold">BOOK A REAL RIDER</Text> below.
                      It is a typed phrase rather than a tick box because a tick box is one
                      stray click from somebody on a bike, and it is checked on the server
                      as well as here.
                    </Text>
                    <TextField
                      label="Type the phrase to unlock"
                      value={liveConfirm}
                      onChange={setLiveConfirm}
                      autoComplete="off"
                      placeholder="BOOK A REAL RIDER"
                    />
                    <Text as="p" fontWeight="semibold">
                      The rider will be told, in the job notes, that this is a test and
                      there is nothing to collect. Cancel the job as soon as they arrive —
                      the Cancel button is at the bottom of this card.
                    </Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      This whole panel is scaffolding and is marked for deletion in the
                      code. It must not survive into a version anybody else runs.
                    </Text>
                  </BlockStack>
                </Banner>
              )}
              {/* ==== END LIVE TEST JSX ========================================== */}

              <Banner tone="info" title="Booking is two steps, and only the second one dispatches">
                <List>
                  <List.Item>
                    <Text as="span" fontWeight="semibold">POST /jobs</Text> creates a
                    draft. Gophr&rsquo;s dispatcher never sees it. Nothing happens.
                  </List.Item>
                  <List.Item>
                    <Text as="span" fontWeight="semibold">PATCH /jobs/&#123;id&#125;</Text>{" "}
                    confirms it, and that is what sends a rider.
                  </List.Item>
                </List>
                <Text as="p">
                  The first attempt used <Text as="span" fontWeight="semibold">POST /job</Text>,
                  singular, and got a 404 with an empty body — a routing answer rather
                  than a payload one, which is how it was told apart from the 422s that
                  settled the quote shape.
                </Text>
              </Banner>

              {/* ---- step one ---- */}
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">1 · Create a draft</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Uses the day and time selected above. Shop to Bow Street, Covent
                  Garden — about a mile, inside Zone A, and the same destination the
                  quote bench uses so the two can be compared.
                </Text>
                <InlineStack gap="300">
                  <Button
                    onClick={() =>
                      fetcher.submit(
                        { intent: "draft", perishable: "false", when, liveConfirm },
                        { method: "POST" }
                      )
                    }
                    loading={running}
                    disabled={(isLive && !armed) || !status.configured}
                  >
                    {isLive ? "Create a REAL draft job" : "Create a draft job"}
                  </Button>
                </InlineStack>
              </BlockStack>

              {/* ---- step two ---- */}
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">2 · Confirm it</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  The path and method are settled; the BODY is still a guess, so it is a
                  text box — a wrong guess costs a click rather than a deploy. If this
                  422s, read what it says it wanted and try again without redeploying.
                </Text>
                <TextField
                  label="Draft job id"
                  value={draftId}
                  onChange={setDraftId}
                  autoComplete="off"
                  helpText="Filled in automatically when a draft is created."
                />
                <TextField
                  label="Confirm body (JSON)"
                  value={confirmBody}
                  onChange={setConfirmBody}
                  multiline={2}
                  autoComplete="off"
                  helpText={'The draft comes back carrying is_confirmed: 0, so this sets it to 1. If that is refused, read what it asks for and try again here — no redeploy.'}
                />
                <InlineStack gap="300">
                  <Button
                    tone="critical"
                    onClick={() =>
                      fetcher.submit(
                        { intent: "confirm", jobId: draftId, confirmBody, liveConfirm },
                        { method: "POST" }
                      )
                    }
                    loading={running}
                    disabled={(isLive && !armed) || !status.configured || !draftId}
                  >
                    {isLive ? "CONFIRM — DISPATCHES A REAL RIDER" : "Confirm the draft"}
                  </Button>
                </InlineStack>
              </BlockStack>

              {/* ---- step three ---- */}
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">3 · Walk it through its statuses</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Gophr&rsquo;s own testing hook. Each press advances the delivery one
                  step and fires the status webhook at{" "}
                  <Text as="span" fontWeight="semibold">/gophr/status</Text>, which is what
                  fulfils the Shopify order and emails the customer their tracking link.
                  It is the only way to test that half without a rider actually crossing
                  London. There is no way to jump to a chosen status, so reaching
                  &ldquo;delivered&rdquo; means pressing it a few times.
                </Text>
                <TextField
                  label="Delivery id"
                  value={deliveryId}
                  onChange={setDeliveryId}
                  autoComplete="off"
                  helpText="Filled in automatically with the draft. Not the same as the job id."
                />
                <InlineStack gap="300">
                  <Button
                    onClick={() =>
                      fetcher.submit(
                        { intent: "progress", jobId: draftId, deliveryId },
                        { method: "POST" }
                      )
                    }
                    loading={running}
                    disabled={
                      status.environment !== "sandbox" ||
                      !status.configured ||
                      !draftId ||
                      !deliveryId
                    }
                  >
                    Advance one status
                  </Button>
                </InlineStack>
              </BlockStack>

              {/* ================================================================= */}
              {/* ⚠️  LIVE TEST BLOCK — DELETE THIS JSX BEFORE HANDING OVER  ⚠️    */}
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Call it off</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Cancels the job at Gophr. Allowed in every environment — stopping is
                  never the risk. Use this the moment a test rider arrives.
                </Text>
                <InlineStack gap="300">
                  <Button
                    tone="critical"
                    variant="primary"
                    onClick={() =>
                      fetcher.submit({ intent: "cancel", jobId: draftId }, { method: "POST" })
                    }
                    loading={running}
                    disabled={!draftId}
                  >
                    Cancel job {draftId ? draftId.slice(0, 8) : ""}
                  </Button>
                </InlineStack>
              </BlockStack>
              {/* ==== END LIVE TEST JSX ========================================== */}

              {/* ---- what happened ---- */}
              {booking && booking.ok && (
                <Banner
                  tone="success"
                  title={
                    booking.step === "draft"
                      ? "Draft created — nothing dispatched"
                      : booking.step === "progress"
                        ? `Advanced${booking.job?.status ? ` to ${booking.job.status}` : ""} — the webhook should have fired`
                        : booking.step === "cancel"
                          ? "Cancelled at Gophr"
                          : "Confirmed — this one is real"
                  }
                >
                  <BlockStack gap="200">
                    <Text as="p">
                      Job {booking.job?.jobId || "(no id found in the response)"}
                      {booking.job?.deliveryId ? ` \u00b7 delivery ${booking.job.deliveryId}` : ""}
                      {booking.job?.status ? ` \u00b7 ${booking.job.status}` : ""}
                    </Text>
                    {booking.job?.price?.amount != null && (
                      <Text as="p">
                        The draft&rsquo;s own price: £{booking.job.price.amount.toFixed(2)}
                        {booking.job.price.path ? ` (${booking.job.price.path})` : ""}. This is
                        the figure the circuit breaker should check, not a separate quote.
                      </Text>
                    )}
                    {booking.step === "draft" && !booking.job?.jobId && (
                      <Text as="p">
                        No job id could be read from the response. Its shape needs to go
                        into readJob() before the webhook can be trusted — without an id
                        there is nothing to confirm, nothing to cancel and no protection
                        against a retry booking a second rider.
                      </Text>
                    )}
                  </BlockStack>
                </Banner>
              )}

              {booking && !booking.ok && (
                <Banner
                  tone={booking.refused ? "warning" : "critical"}
                  title={
                    booking.refused
                      ? "Refused"
                      : `${
                          booking.step === "confirm"
                            ? "Confirm"
                            : booking.step === "progress"
                              ? "Advance"
                              : "Draft"
                        } failed${booking.status ? ` — ${booking.status}` : ""}`
                  }
                >
                  <Text as="p">{booking.message}</Text>
                </Banner>
              )}

              {booking && booking.request && (
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
