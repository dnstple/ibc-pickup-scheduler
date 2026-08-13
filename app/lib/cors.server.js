// CORS for the order-scoped endpoints called by the checkout UI extension.
//
// The extension runs on https://extensions.shopifycdn.com, so every request to
// this app is cross-origin and the browser sends a preflight OPTIONS first.
//
// Preflights carry no Authorization header by design, so they must be answered
// BEFORE authenticating — otherwise authenticate.public.checkout rejects them
// with a bare 401 and the browser reports "No 'Access-Control-Allow-Origin'
// header is present", which is what it looks like from the extension side.
//
// A wildcard origin is safe here: these routes authenticate with a bearer
// session token, never cookies, so there are no credentials for a hostile
// origin to ride on.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/** JSON response with CORS headers always attached. */
export const corsJson = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });

/**
 * Answer a preflight, or return null if this isn't one.
 *
 * Called from both loader and action: Remix routes OPTIONS to one or the other
 * depending on version, and guessing wrong costs another deploy cycle.
 */
export function handlePreflight(request) {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
