// Gophr Commercial API v2 client. SERVER ONLY — never import this into
// anything that reaches the browser.
//
// CREDENTIALS
// -----------
// The API key is read from the environment and is never stored in the settings
// metafield, never written to the theme, and never logged. Set it in Vercel:
//
//     GOPHR_API_KEY   = <the key from Gophr's Developer Hub>
//     GOPHR_ENV       = sandbox | production     (default: sandbox)
//
// The default is sandbox on purpose. Production has to be asked for by name,
// so nobody dispatches a real rider by changing one unrelated thing.
//
// WHAT IS AND IS NOT CONFIRMED
// ----------------------------
// Confirmed from Gophr's documentation:
//   · auth is the `API-KEY` request header
//   · sandbox    https://api-sandbox.gophr.com/v2-commercial-api
//   · production https://api.gophr.com/v2-commercial-api
//   · sandbox jobs are NOT dispatched to real couriers
//   · POST /quotes takes `pickups` and `dropoffs` arrays
//   · vehicle is chosen by Gophr from parcel size, weight and distance —
//     there is no documented code to force one
//
// Confirmed by a real 422 from the sandbox on 14 September 2026, which listed
// every field it wanted by name:
//   · fields are FLAT and PREFIXED, not nested objects —
//     pickup_address1, pickup_postcode, pickup_country_code,
//     dropoff_address1, dropoff_postcode, dropoff_country_code
//   · `parcels` is required on BOTH the pickup and the dropoff, minimum one
//   · each parcel needs a `parcel_external_id` string
//   · unknown fields are ignored rather than rejected — the first attempt sent
//     `sequence`, `address` and `contact` objects and Gophr complained only
//     about what was missing, never about what was extra
//
// Also confirmed, by a second 422 once the shape above was right:
//   · parcel dimensions are NOT prefixed. They are bare `length`, `width`,
//     `height` and `weight`, and each must be a number greater than zero.
//     The convention is mixed — `parcel_external_id` carries the prefix and
//     the dimensions do not — which is exactly why it could not be guessed
//     from the other field names.
//
// And confirmed by the first successful quote, 14 September 2026:
//   · the response is
//       { data: { job_priority, vehicle_type, price_net, price_gross,
//                 pickup_eta, delivery_eta, min_realistic_time } }
//   · prices are OBJECTS — { amount: 7.5, currency: "GBP" } — not numbers,
//     and in pounds rather than pence
//   · price_gross is price_net x 1.2, so net is ex-VAT and gross inc-VAT
//   · vehicle_type is a numeric code, not a name
//
// STILL INFERRED:
//   · the UNIT of `weight`. Sent as kilograms, because Gophr's published
//     vehicle table is in kg (pushbike 10kg, cargo bike 100kg). If it wants
//     grams, a 2.1kg cake reads as 2.1 grams and gets a pushbike.
//     ⚠️ The proof is comparative: quote the same journey as a small parcel
//     and as a cake. A different `vehicle_type` code means size and weight
//     reached the decision. The same code on both means they did not.

const BASE_URLS = {
  sandbox: "https://api-sandbox.gophr.com/v2-commercial-api",
  production: "https://api.gophr.com/v2-commercial-api",
};

// Moves into the settings metafield in the next increment. It is here, once,
// rather than scattered through the call sites.
export const PICKUP = {
  name: "Italian Bear Chocolate",
  address1: "29 Rathbone Place",
  city: "London",
  postcode: "W1T 1JG",
  country_code: "GB", // ISO 3166-1 alpha-2
};

export function gophrEnv() {
  const value = (process.env.GOPHR_ENV || "sandbox").trim().toLowerCase();
  return value === "production" ? "production" : "sandbox";
}

/**
 * The key, with surrounding whitespace removed.
 *
 * Pasting into a hosting dashboard picks up a trailing newline more often than
 * anyone admits, and the header then carries it straight to the API, which
 * rejects it as a different key. Trimming costs nothing and removes a whole
 * category of "but I copied it correctly".
 */
export function gophrKey() {
  return (process.env.GOPHR_API_KEY || "").trim();
}

export function gophrConfigured() {
  return Boolean(gophrKey());
}

/**
 * Work out whether a key belongs to the environment it is being used against,
 * without knowing or revealing the key itself.
 *
 * Gophr's documented example of a sandbox key is
 * `sand-2a7df6bd-8ed3-48ad-b801-05093a866e66`, so sandbox keys carry a
 * `sand-` prefix and keys are environment-specific. A production key sent to
 * the sandbox endpoint gets a 401 that says nothing about why.
 *
 * Pure, so it can be tested without any environment at all.
 */
export function diagnoseKey(rawKey, environment) {
  const raw = typeof rawKey === "string" ? rawKey : "";
  const key = raw.trim();
  const looksSandbox = key.toLowerCase().startsWith("sand-");
  const hadWhitespace = raw !== key && raw.length > 0;

  let mismatch = null;
  if (key) {
    if (environment === "sandbox" && !looksSandbox) {
      mismatch = "production-key-on-sandbox";
    } else if (environment === "production" && looksSandbox) {
      mismatch = "sandbox-key-on-production";
    }
  }

  return {
    present: Boolean(key),
    looksSandbox,
    hadWhitespace,
    length: key.length,
    mismatch,
  };
}

/**
 * What the admin page is allowed to know about the credentials.
 * Never the key, and never any part of it — only shape and fit.
 */
export function gophrStatus() {
  const environment = gophrEnv();
  const key = diagnoseKey(process.env.GOPHR_API_KEY, environment);
  return {
    configured: key.present,
    environment,
    baseUrl: BASE_URLS[environment],
    dispatchesRealRiders: environment === "production",
    key,
  };
}

class GophrError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "GophrError";
    this.status = status;
    this.body = body;
  }
}

async function call(path, { method = "GET", body, timeoutMs = 8000 } = {}) {
  if (!gophrConfigured()) {
    throw new GophrError("GOPHR_API_KEY is not set in this environment.");
  }
  const url = `${BASE_URLS[gophrEnv()]}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "API-KEY": gophrKey(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new GophrError(`Gophr did not answer within ${timeoutMs}ms.`);
    }
    throw new GophrError(`Could not reach Gophr: ${error.message}`);
  }
  clearTimeout(timer);

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text }; // an HTML error page, most likely
  }

  if (!response.ok) {
    throw new GophrError(`Gophr returned ${response.status}.`, {
      status: response.status,
      body: parsed,
    });
  }
  return parsed;
}

/**
 * A parcel description for a basket.
 *
 * Gophr picks the vehicle from size, weight and distance, so this is how a
 * cake ends up on a cargo bike rather than a moped: give it dimensions a
 * pushbike cannot take. A pushbike caps at 40 × 30 × 30cm and 10kg; a cargo
 * bike at 100cm each way and 100kg.
 *
 * `perishable` therefore does real work here, not just in the copy.
 */
export function parcelFor({ grams = 500, perishable = false, id = "ibc-parcel-1" } = {}) {
  const dims = perishable
    ? { length: 45, width: 45, height: 30 }
    : { length: 30, width: 25, height: 20 };
  return {
    // Prefixed. The dimensions below are not — Gophr's own validator says so.
    parcel_external_id: id,
    // Centimetres, bare names, each must be greater than zero.
    length: dims.length,
    width: dims.width,
    height: dims.height,
    // Kilograms (see the header — unit still to be confirmed). A product with
    // no weight set must not quote as a 0kg parcel: Gophr rejects anything
    // that is not greater than zero.
    weight: Math.max(Number(grams) || 0, perishable ? 500 : 100) / 1000,
  };
}

/**
 * Build the quote request body.
 *
 * The same parcel object appears in both the pickup and the dropoff, carrying
 * the same `parcel_external_id`. That is how Gophr links the two ends: the id
 * says "the thing collected here is the thing delivered there". It is what
 * makes multi-drop work, and a single drop is just the one-item case.
 */
export function buildQuoteBody({ destination, parcel, earliestPickup = null }) {
  const pickup = {
    pickup_address1: PICKUP.address1,
    pickup_city: PICKUP.city,
    pickup_postcode: PICKUP.postcode,
    pickup_country_code: PICKUP.country_code,
    parcels: [parcel],
  };
  if (earliestPickup) pickup.earliest_pickup_time = earliestPickup;

  return {
    pickups: [pickup],
    dropoffs: [
      {
        dropoff_address1: destination.address1 || "",
        dropoff_city: destination.city || "London",
        dropoff_postcode: destination.postcode,
        dropoff_country_code: destination.country_code || "GB",
        parcels: [parcel],
      },
    ],
  };
}

/**
 * Read a money value, whatever form it arrives in.
 *
 * Gophr sends `{ "amount": 7.5, "currency": "GBP" }` — an object, not a
 * number, which is what the first working run revealed. Bare numbers and
 * numeric strings are still accepted so this does not become brittle if a
 * different endpoint answers differently.
 *
 * Returns { amount, currency } or null. Never invents a figure.
 */
export function readAmount(node) {
  if (node == null) return null;
  if (typeof node === "number") {
    return Number.isFinite(node) ? { amount: node, currency: null } : null;
  }
  if (typeof node === "string") {
    const n = Number(node);
    return Number.isFinite(n) && node.trim() !== "" ? { amount: n, currency: null } : null;
  }
  if (typeof node === "object" && "amount" in node) {
    const raw = node.amount;
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n === "number" && Number.isFinite(n)) {
      return { amount: n, currency: node.currency || null };
    }
  }
  return null;
}

/**
 * Everything worth knowing from a quote response.
 *
 * Confirmed shape, from a real sandbox quote:
 *   { data: { job_priority, vehicle_type, price_net: {amount,currency},
 *             price_gross: {amount,currency}, pickup_eta, delivery_eta,
 *             min_realistic_time } }
 *
 * `price_net` is ex-VAT and `price_gross` is inc-VAT — gross is exactly
 * net x 1.2 on every journey seen so far.
 */
export function readQuote(payload) {
  const d = payload && typeof payload === "object" && payload.data ? payload.data : payload;
  const gross = readAmount(d?.price_gross);
  const net = readAmount(d?.price_net);

  // Fallback for any shape we have not met, so an unexpected response degrades
  // to "no price" rather than to a wrong one.
  let fallback = null;
  if (!gross && !net) {
    for (const key of ["price", "total_price", "amount"]) {
      const found = readAmount(d?.[key]);
      if (found) { fallback = { value: found, path: key }; break; }
    }
  }

  const headline = gross || net || fallback?.value || null;

  return {
    amount: headline ? headline.amount : null,
    currency: headline?.currency || gross?.currency || net?.currency || null,
    path: gross ? "data.price_gross" : net ? "data.price_net" : fallback?.path || null,
    gross,
    net,
    // A numeric code. Gophr picks the vehicle itself; the code is the only
    // proof that size and weight reached the decision.
    vehicleType: typeof d?.vehicle_type === "number" ? d.vehicle_type : null,
    pickupEta: d?.pickup_eta || null,
    deliveryEta: d?.delivery_eta || null,
    // Gophr's own estimate of the realistic door-to-door time, in minutes.
    minRealisticMinutes:
      typeof d?.min_realistic_time === "number" ? d.min_realistic_time : null,
  };
}

/** Ask Gophr what a journey would cost. Returns the raw payload as well. */
export async function quote({ destination, parcel, earliestPickup = null }) {
  const body = buildQuoteBody({ destination, parcel, earliestPickup });
  const payload = await call("/quotes", { method: "POST", body });
  return { request: body, response: payload, price: readQuote(payload) };
}

export { GophrError, BASE_URLS };

/* ==================================================================== */
/* BOOKING A JOB — TWO STEPS, NOT ONE                                    */
/*                                                                       */
/* Settled by a 404 and then by the documentation it sent us back to:    */
/*                                                                       */
/*   POST  /jobs              creates a DRAFT. Dispatches nobody.        */
/*   PATCH /jobs/{job_id}     confirms it. THIS is what sends a rider.   */
/*                                                                       */
/* The first attempt used `POST /job`, singular, taken from an endpoint  */
/* listing. It returned 404 with an empty body — a routing answer, not a */
/* payload one, which is how it was told apart from the 422s that        */
/* settled the quote shape. Auth and base URL were never in doubt        */
/* because /quotes worked against exactly the same ones.                 */
/*                                                                       */
/* THE TWO STEPS ARE WHY THE CIRCUIT BREAKER MOVED.                      */
/*                                                                       */
/* Gophr's own words: "if a job is confirmed at a later point, a new     */
/* quote may be generated for that job and prices may change." So a      */
/* price read from POST /quotes is an estimate of an estimate — checking */
/* it and then confirming would police a number nobody is charged.       */
/* The draft carries its own price, and that is the one checked. Confirm */
/* follows immediately, so there is no "later point" for it to drift in. */
/*                                                                       */
/* ⚠️ STILL INFERRED: the CONFIRM BODY. PATCH takes something; what      */
/* exactly is unknown. The bench sends it as free text so a wrong guess  */
/* costs a click rather than a deploy.                                   */
/*                                                                       */
/* What is known about the body, and where from:                         */
/*   - creating a delivery separately requires pickup_person_name and    */
/*     pickup_mobile_number, which quotes never asked for — so a job     */
/*     needs contacts at both ends                                       */
/*   - deliveries carry an `external_id`, which Gophr echoes back on its */
/*     status webhooks, so it is the natural idempotency handle          */
/*   - parcel_external_id must be unique within a job                    */
/*                                                                       */
/* Every call returns the request alongside any error, because the one   */
/* time that was left out, a deploy that had not taken effect looked     */
/* exactly like a payload bug and cost a round trip.                     */

/**
 * The shop's own phone number, which Gophr needs for the collection.
 *
 * An env var rather than a constant because it is an operational detail that
 * differs between the sandbox and the real shop, and rather than a settings
 * field because a missing phone must stop a booking, not produce a form the
 * shop can save while empty.
 */
export function pickupMobile() {
  return (process.env.GOPHR_PICKUP_MOBILE || "").trim();
}

/**
 * Build the job request.
 *
 * `externalId` is the order — it is what ties a Gophr status webhook back to
 * something in Shopify, and it is the only thing standing between a retried
 * Shopify webhook and a second rider if Gophr enforces uniqueness on it.
 */
export function buildJobBody({
  destination,
  parcel,
  earliestPickup = null,
  externalId,
  reference = null,
  pickupNotes = null,
  dropoffNotes = null,
  /* WHERE THE COURIER COLLECTS, supplied by the caller.
   *
   * PICKUP remains as the default so the test bench and anything else that
   * does not care keeps working. But a shop address belongs in settings, not
   * in a constant: the constant is wrong the day the shop moves, and nobody
   * finds out until a rider is standing outside the old door. */
  origin = null,
}) {
  const from = { ...PICKUP, ...(origin || {}) };
  const pickup = {
    pickup_address1: from.address1,
    pickup_city: from.city,
    pickup_postcode: from.postcode,
    pickup_country_code: from.country_code || "GB",
    pickup_person_name: from.name,
    pickup_mobile_number: pickupMobile(),
    parcels: [parcel],
  };
  if (earliestPickup) pickup.earliest_pickup_time = earliestPickup;
  if (pickupNotes) pickup.pickup_instructions = String(pickupNotes);

  const dropoff = {
    dropoff_address1: destination.address1 || "",
    dropoff_city: destination.city || "London",
    dropoff_postcode: destination.postcode,
    dropoff_country_code: destination.country_code || "GB",
    dropoff_person_name: destination.name || "",
    dropoff_mobile_number: destination.mobile || "",
    parcels: [parcel],
    external_id: String(externalId || ""),
  };
  if (destination.address2) dropoff.dropoff_address2 = String(destination.address2);
  if (destination.email) dropoff.dropoff_email = String(destination.email);
  if (dropoffNotes) dropoff.dropoff_instructions = String(dropoffNotes);

  const body = {
    /* THE JOB'S OWN external_id, AT THE TOP LEVEL.
     *
     * Settled by a 422 carrying exactly one error: `"object": "external_id"`,
     * "Field \"external id\" should not be empty" — while an `external_id`
     * was already being sent on the dropoff. The unprefixed object name is
     * the tell: pickup and dropoff fields come back named `pickup_postcode`
     * and `dropoff_address1`, so a bare `external_id` is the job's.
     *
     * Both are kept. The dropoff's is what Gophr echoes on its status
     * webhooks, per its own webhook documentation, so removing it would cost
     * us the only handle tying a status update back to a Shopify order. */
    external_id: String(externalId || ""),
    pickups: [pickup],
    dropoffs: [dropoff],
  };
  if (reference) body.reference = String(reference);
  return body;
}

/**
 * Everything worth knowing from a job response.
 *
 * CONFIRMED SHAPE, from a real sandbox draft on 15 September 2026:
 *
 *   { data: { job_id, is_confirmed: 0, vehicle_type, distance,
 *             price_net: {amount,currency}, price_gross: {amount,currency},
 *             job_priority,
 *             deliveries: [ { delivery_id, status, leg_type,
 *                             private_job_url, public_tracker_url,
 *                             pickup_sequence_number, dropoff_sequence_number,
 *                             parcels: [{parcel_id, parcel_external_id,
 *                                        barcode_reference}] } ] } }
 *
 * TWO NAMES WERE GUESSED WRONG AND ARE FIXED HERE:
 *
 *   · the tracking link is `public_tracker_url` — trackER, not trackING, and
 *     on the DELIVERY rather than the job. The first draft looked for
 *     `tracking_url`, `public_tracking_url` and `url`, found none of them,
 *     and would have booked riders no customer could follow.
 *   · `private_job_url` is the shop's own link into Gophr's job management.
 *     Not guessed at all, and it is the thing a human actually needs when an
 *     order is flagged: one click to the job rather than an id to paste.
 *
 * Still read defensively. A booking that half-reads its own confirmation is
 * worse than one that reports nothing, and nothing here invents an id.
 */
export function readJob(payload) {
  const d = payload && typeof payload === "object" && payload.data ? payload.data : payload;
  if (!d || typeof d !== "object") return { jobId: null, deliveryId: null };

  const firstDelivery = Array.isArray(d.deliveries) && d.deliveries.length
    ? d.deliveries[0]
    : null;

  const pick = (...names) => {
    for (const source of [d, firstDelivery]) {
      if (!source) continue;
      for (const name of names) {
        const value = source[name];
        if (value !== null && value !== undefined && value !== "") return String(value);
      }
    }
    return null;
  };

  /* `is_confirmed` is 0 or 1, and 0 is falsy — so this cannot be written as
   * `Boolean(pick(...))`, which is how a draft would come back looking
   * confirmed the day somebody tidied it. */
  const confirmedRaw = d.is_confirmed ?? firstDelivery?.is_confirmed ?? null;

  return {
    jobId: pick("job_id", "id", "public_job_id"),
    deliveryId: pick("delivery_id"),
    trackingUrl: pick("public_tracker_url", "tracking_url", "public_tracking_url"),
    /* The shop's way in. Distinct from the tracker, which is the customer's. */
    jobUrl: pick("private_job_url"),
    status: pick("status", "job_status"),
    isConfirmed: confirmedRaw === null ? null : Number(confirmedRaw) === 1,
    distance: typeof d.distance === "number" ? d.distance : null,
    price: readQuote(payload),
  };
}

/**
 * The confirm body.
 *
 * `{ status: "confirmed" }` was the first guess and was never sent, because
 * the draft's own response answered the question first: it comes back
 * carrying `is_confirmed: 0`. A flag a resource reports about itself is the
 * flag a PATCH sets, and 0/1 rather than false/true because that is how Gophr
 * spelled it.
 *
 * The bench still sends this as free text, so if it is wrong the correction
 * costs a click rather than a deploy.
 */
export const CONFIRM_BODY = { is_confirmed: 1 };

/**
 * Step one: create the DRAFT.
 *
 * Safe. A draft is not dispatched — Gophr's dispatcher never sees it until it
 * is confirmed. So this can be run against the sandbox, read, and thrown away
 * without anything happening in the world.
 */
export async function createJob(options) {
  const body = buildJobBody(options);

  if (!pickupMobile()) {
    throw new GophrError(
      "GOPHR_PICKUP_MOBILE is not set, and Gophr needs a number for the collection.",
      { request: body }
    );
  }

  let payload;
  try {
    payload = await call("/jobs", { method: "POST", body, timeoutMs: 12000 });
  } catch (error) {
    if (error instanceof GophrError) error.request = body;
    throw error;
  }

  return { request: body, response: payload, job: readJob(payload) };
}

/**
 * Step two: confirm it, which dispatches a rider.
 *
 * `body` is configurable because the shape is not yet proven. Everything else
 * about this call is: the path and the method come from Gophr's own
 * "Confirming a Job" page.
 */
export async function confirmJob(jobId, body = CONFIRM_BODY) {
  if (!jobId) throw new GophrError("No job id to confirm.");
  const path = `/jobs/${encodeURIComponent(jobId)}`;

  let payload;
  try {
    payload = await call(path, { method: "PATCH", body, timeoutMs: 12000 });
  } catch (error) {
    if (error instanceof GophrError) error.request = { path, body };
    throw error;
  }

  return { request: { path, body }, response: payload, job: readJob(payload) };
}

/**
 * Both steps, with a decision in between.
 *
 * `approve` is called with the DRAFT'S OWN PRICE and decides whether to go
 * ahead. That ordering is the whole point: Gophr says a job confirmed later
 * may be re-quoted, so the only price worth policing is the one attached to
 * the thing about to be confirmed — not a separate /quotes call made moments
 * earlier against a slightly different question.
 *
 * A draft that is not approved is LEFT AS A DRAFT rather than cancelled.
 * Cancelling it would be tidier and is not worth the risk: an unconfirmed job
 * costs nothing, dispatches nobody and expires on Gophr's side, whereas a
 * cancel call against a half-understood API on the unhappy path is how a
 * confirmed job gets called off by mistake.
 */
export async function bookJob(options, { approve = null, confirmBody } = {}) {
  const draft = await createJob(options);

  if (!draft.job?.jobId) {
    throw new GophrError("Gophr created the job but returned no job id.", {
      body: draft.response,
      request: draft.request,
    });
  }

  if (typeof approve === "function") {
    const verdict = await approve(draft);
    if (!verdict || verdict.ok !== true) {
      return { draft, confirmed: null, refused: verdict || { ok: false } };
    }
  }

  const confirmed = await confirmJob(draft.job.jobId, confirmBody || CONFIRM_BODY);
  return { draft, confirmed, refused: null, job: confirmed.job || draft.job };
}

/**
 * Sandbox only: push a delivery to its next status and fire the webhook.
 *
 * Gophr's own testing hook —
 *   POST /jobs/{job_id}/deliveries/{delivery_id}/progress
 * "Hitting this endpoint will progress the delivery to the next status and
 * cause the status update webhook to be fired."
 *
 * This is the only way to exercise the status endpoint without a real rider
 * carrying a real parcel across London, so it is what proves that half of the
 * integration. Each call advances one step; there is no way to jump to a
 * chosen status, so getting to "delivered" means pressing it a few times.
 *
 * NOT GUARDED HERE. The guard belongs at the call site, where the environment
 * is already being checked for the other two buttons — a library function
 * that sometimes refuses is harder to reason about than one that always does
 * what it says.
 */
/**
 * What a DEADLINE costs.
 *
 * Gophr sells "book to a chosen deadline" and documents no field for it. The
 * live job that prompted this was quoted with no deadline at all, so Gophr
 * defaulted to 23:55 and the rider — entirely within his rights — kept taking
 * other work while the ETA slid. The customer's window was never passed on.
 *
 * THE PROBE EXPLOITS SOMETHING ALREADY PROVEN: Gophr IGNORES fields it does
 * not recognise rather than rejecting them. That was established by the first
 * 422, which complained only about what was missing and never about the
 * `sequence`, `address` and `contact` objects that had no business being
 * there. So a wrong guess is free and silent, and the name that is RIGHT is
 * the one whose price differs from the baseline.
 *
 * Each candidate is sent on its own, against the same journey, seconds apart.
 * Returns the baseline and every variant so the difference speaks for itself.
 */
export const DEADLINE_FIELDS = [
  /* Symmetry with `earliest_pickup_time`, which is unprefixed and sits inside
   * the pickup object. The dropoff mirror of that name is the strongest
   * guess, so it goes first. */
  "latest_dropoff_time",
  "dropoff_deadline",
  "deadline_time",
  "delivery_deadline",
  "dropoff_before",
  "latest_delivery_time",
];

/**
 * THE PRICE CURVE FOR A DEADLINE.
 *
 * `dropoff_deadline` is the field — settled by the probe below, which found
 * it by the only name that moved the price. What it COSTS turned out to be
 * the more interesting question: a 90-minute deadline on a Zone A journey
 * took £9.42 to £16.58, which is +76% and would make same-day loss-making on
 * every order.
 *
 * That number was frightening and misleading. 90 minutes is far tighter than
 * anything the shop actually promises: a customer ordering at three in the
 * afternoon picks a window ending at seven, which is four hours out. Gophr is
 * pricing URGENCY, so the question is not "what does a deadline cost" but
 * "what does THIS deadline cost", and the answer is a curve rather than a
 * number.
 *
 * Quotes are free. Measuring the curve is therefore free, and guessing at it
 * would be indefensible.
 */
export async function probeDeadlineCurve({ destination, parcel, minutesList }) {
  const rows = [];

  const base = await quote({ destination, parcel });
  const baseline = base.price?.gross?.amount ?? base.price?.amount ?? null;
  rows.push({ minutes: null, label: "no deadline", amount: baseline, delta: 0 });

  for (const minutes of minutesList) {
    const iso = new Date(Date.now() + minutes * 60000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "+00:00");
    const body = buildQuoteBody({ destination, parcel });
    body.dropoffs[0].dropoff_deadline = iso;
    try {
      const payload = await call("/quotes", { method: "POST", body });
      const price = readQuote(payload);
      const amount = price?.gross?.amount ?? price?.amount ?? null;
      rows.push({
        minutes,
        label: `${minutes} min (${Math.round((minutes / 60) * 10) / 10}h)`,
        amount,
        delta: amount != null && baseline != null
          ? Number((amount - baseline).toFixed(2))
          : null,
      });
    } catch (error) {
      rows.push({ minutes, label: `${minutes} min`, amount: null, error: error.message });
    }
  }

  return { baseline, rows };
}

export async function probeDeadline({ destination, parcel, deadlineIso }) {
  const results = [];

  /* The baseline, taken from the SAME journey seconds earlier. A price
   * compared against yesterday's quote for somewhere else would prove
   * nothing. */
  const base = await quote({ destination, parcel });
  results.push({
    field: null,
    label: "no deadline (what we send today)",
    amount: base.price?.gross?.amount ?? base.price?.amount ?? null,
    request: base.request,
  });

  for (const field of DEADLINE_FIELDS) {
    const body = buildQuoteBody({ destination, parcel });
    /* On the DROPOFF, because that is the end being deadlined. */
    body.dropoffs[0][field] = deadlineIso;
    try {
      const payload = await call("/quotes", { method: "POST", body });
      const price = readQuote(payload);
      results.push({
        field,
        label: field,
        amount: price?.gross?.amount ?? price?.amount ?? null,
        request: body,
      });
    } catch (error) {
      /* An error is INFORMATIVE here, not a failure: a field Gophr complains
       * about is a field it knows the name of. */
      results.push({
        field,
        label: field,
        amount: null,
        error: error.message,
        body: error instanceof GophrError ? error.body : undefined,
        request: body,
      });
    }
  }

  const baseline = results[0].amount;
  for (const r of results) {
    r.changed = r.amount !== null && baseline !== null && r.amount !== baseline;
    r.delta = r.amount !== null && baseline !== null
      ? Number((r.amount - baseline).toFixed(2))
      : null;
  }
  return { baseline, deadlineIso, results };
}

export async function progressDelivery(jobId, deliveryId, body = {}) {
  if (!jobId || !deliveryId) {
    throw new GophrError("Both a job id and a delivery id are needed to progress a delivery.");
  }
  const path = `/jobs/${encodeURIComponent(jobId)}/deliveries/${encodeURIComponent(deliveryId)}/progress`;

  let payload;
  try {
    payload = await call(path, { method: "POST", body, timeoutMs: 12000 });
  } catch (error) {
    if (error instanceof GophrError) error.request = { path, body };
    throw error;
  }
  return { request: { path, body }, response: payload, job: readJob(payload) };
}

/** Call off a rider. Used when a booking succeeded but the order was cancelled. */
export async function cancelJob(jobId, reason = "Order cancelled") {
  if (!jobId) throw new GophrError("No job id to cancel.");
  const payload = await call(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: { reason: String(reason) },
  });
  return payload;
}
