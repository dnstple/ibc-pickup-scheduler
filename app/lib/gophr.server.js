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
// NOT confirmed, because the reference pages would not render for me:
//   · the exact field names inside a pickup / dropoff / parcel
//   · the exact shape of the quote response
//
// So `buildQuoteBody` below is a best guess, and `readQuote` reads the
// response defensively. The Courier admin page prints the request and the
// response verbatim, which is how we replace the guess with the truth in one
// round trip instead of several.

const BASE_URLS = {
  sandbox: "https://api-sandbox.gophr.com/v2-commercial-api",
  production: "https://api.gophr.com/v2-commercial-api",
};

// Moves into the settings metafield in the next increment. It is here, once,
// rather than scattered through the call sites.
export const PICKUP = {
  name: "Italian Bear Chocolate",
  address_line_1: "29 Rathbone Place",
  city: "London",
  postcode: "W1T 1JG",
  country_code: "GB",
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
export function parcelFor({ grams = 500, perishable = false } = {}) {
  return perishable
    ? { length: 45, width: 45, height: 30, weight: Math.max(grams, 500) / 1000 }
    : { length: 30, width: 25, height: 20, weight: Math.max(grams, 100) / 1000 };
}

/**
 * Build the quote request body.
 *
 * ⚠️ FIELD NAMES ARE UNCONFIRMED — see the header. If Gophr rejects this, the
 * Courier page will show exactly which field it objected to, and the fix is
 * this one function.
 */
export function buildQuoteBody({ destination, parcel, earliestPickup = null }) {
  const body = {
    pickups: [
      {
        sequence: 1,
        address: { ...PICKUP },
        contact: { name: PICKUP.name },
        parcels: [parcel],
      },
    ],
    dropoffs: [
      {
        sequence: 1,
        address: {
          address_line_1: destination.address_line_1 || "",
          city: destination.city || "London",
          postcode: destination.postcode,
          country_code: destination.country_code || "GB",
        },
        contact: { name: destination.name || "Customer" },
      },
    ],
  };
  if (earliestPickup) body.pickups[0].earliest_pickup_time = earliestPickup;
  return body;
}

/**
 * Pull a price out of whatever Gophr sends back.
 *
 * Written to survive not knowing the response shape: it walks a handful of
 * likely paths and reports which one matched, so the admin page can show
 * "found at data.price_gross" and we can then tighten this to one path.
 *
 * Returns { amount, currency, path } or { amount: null } — never throws, and
 * never invents a number.
 */
export function readQuote(payload) {
  const candidates = [
    ["price_gross"], ["price_net"], ["price"], ["total_price"],
    ["data", "price_gross"], ["data", "price_net"], ["data", "price"],
    ["data", "total_price"], ["quote", "price"], ["quote", "price_gross"],
    ["data", "quote", "price"],
  ];
  for (const path of candidates) {
    let node = payload;
    let ok = true;
    for (const key of path) {
      if (node == null || typeof node !== "object" || !(key in node)) { ok = false; break; }
      node = node[key];
    }
    if (!ok) continue;
    // Gophr may send pence as an integer or pounds as a string.
    const amount = typeof node === "string" ? Number(node) : node;
    if (typeof amount === "number" && Number.isFinite(amount)) {
      return { amount, currency: payload?.currency || payload?.data?.currency || "GBP", path: path.join(".") };
    }
  }
  return { amount: null, currency: null, path: null };
}

/** Ask Gophr what a journey would cost. Returns the raw payload as well. */
export async function quote({ destination, parcel, earliestPickup = null }) {
  const body = buildQuoteBody({ destination, parcel, earliestPickup });
  const payload = await call("/quotes", { method: "POST", body });
  return { request: body, response: payload, price: readQuote(payload) };
}

export { GophrError, BASE_URLS };
