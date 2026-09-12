// Talks to the Pickup Scheduler app's order-scoped endpoints.
//
// Everything here takes its dependencies as arguments (fetch, sleep, the
// shopify global) so it can be unit-tested under Node without a browser or a
// live checkout.

export const APP_ORIGIN = 'https://ibc-pickup-scheduler.vercel.app';

/**
 * Where the order ID lives, in preference order.
 *
 * On the Thank you page this returns a gid://shopify/OrderIdentity/N — a
 * different type from an Order GID. The server normalises it back to
 * gid://shopify/Order/N, which is why only the numeric part matters here.
 */
export const ORDER_ID_PATHS = [
  'orderConfirmation.current.order.id',
  'order.current.id',
  'order.id'
];

export function getByPath(root, path) {
  let cursor = root;
  for (const key of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    try {
      cursor = cursor[key];
    } catch {
      return undefined;
    }
  }
  return cursor;
}

/** Pull the order ID off the shopify global, whichever surface we're on. */
export function resolveOrderId(api) {
  for (const path of ORDER_ID_PATHS) {
    const value = getByPath(api, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** The preview renders with order 0 — never worth calling the API for. */
export function isPlaceholderOrderId(orderId) {
  const digits = String(orderId ?? '').replace(/\D/g, '');
  return digits === '' || Number(digits) === 0;
}

async function postJson(url, body, { token, fetchImpl }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { status: response.status, ok: response.ok, payload };
}

export async function fetchAvailability({
  orderId,
  token,
  fetchImpl,
  origin = APP_ORIGIN
}) {
  return postJson(
    `${origin}/api/pickup/availability-for-order`,
    { orderId },
    { token, fetchImpl }
  );
}

export async function bookSlot({
  orderId,
  startIso,
  token,
  fetchImpl,
  origin = APP_ORIGIN
}) {
  return postJson(
    `${origin}/api/pickup/book`,
    { orderId, startIso },
    { token, fetchImpl }
  );
}

/**
 * The Thank you page renders before Shopify finishes creating the order, so a
 * 202 is expected rather than exceptional. Back off and try again; give up
 * quietly and let the customer use the emailed link instead of showing them an
 * error they can do nothing about.
 */
export const RETRY_DELAYS_MS = [800, 1200, 2000, 3000, 5000, 8000];

export async function loadAvailability({
  orderId,
  getToken,
  fetchImpl,
  sleep,
  origin = APP_ORIGIN,
  delays = RETRY_DELAYS_MS
}) {
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const token = await getToken();
    const result = await fetchAvailability({ orderId, token, fetchImpl, origin });

    if (result.status !== 202) return result;
    if (attempt === delays.length) return result; // still pending — caller decides
    await sleep(delays[attempt]);
  }
  return { status: 202, ok: false, payload: { status: 'order_pending' } };
}

/* ------------------------------------------------------------------ shaping */

/**
 * The slot matching an ISO start, across every date. Returns the slot with its
 * date attached, or null. Used to show "you're booking …" before the customer
 * commits, so two dropdowns don't leave them guessing what they picked.
 */
export function findSlot(availability, startIso) {
  const wanted = String(startIso ?? '').trim();
  if (!wanted) return null;
  for (const date of availability?.dates || []) {
    for (const slot of date.slots || []) {
      if (slot.start_iso === wanted) return { ...slot, date: date.date };
    }
  }
  return null;
}

/** Slots for one date key, or an empty array. */
export function slotsForDate(availability, dateKey) {
  const entry = (availability?.dates || []).find((d) => d.date === dateKey);
  return entry ? entry.slots || [] : [];
}

/**
 * Which date and slot should be selected when the picker first renders.
 * An existing booking wins, provided it's still on offer; otherwise the first
 * available slot is highlighted but NOT saved — per the spec, never choose a
 * slot on the customer's behalf.
 */
export function initialSelection(availability, currentBooking) {
  const dates = availability?.dates || [];
  if (dates.length === 0) return { dateKey: null, startIso: null };

  const bookedIso = currentBooking?.start_iso || null;
  if (bookedIso) {
    for (const date of dates) {
      const match = (date.slots || []).find((s) => s.start_iso === bookedIso);
      if (match) return { dateKey: date.date, startIso: match.start_iso };
    }
  }

  const first = dates[0];
  return {
    dateKey: first.date,
    startIso: first.slots?.[0]?.start_iso ?? null
  };
}

/** Customer-facing message for an ineligible or empty response. */
export function ineligibleMessage(payload) {
  switch (payload?.reason) {
    case 'not_pickup':
      return null; // delivery order — render nothing at all
    case 'products_unavailable':
      return 'One or more items in this order cannot be collected. Please contact us to arrange delivery.';
    case 'below_minimum':
      return 'This order is below the minimum value for collection. Please contact us.';
    case 'order_cancelled':
      return null;
    default:
      return 'Collection times are not available at the moment. Please contact us and we will arrange a time with you.';
  }
}
