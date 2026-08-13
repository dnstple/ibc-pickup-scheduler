import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  resolveOrderId,
  isPlaceholderOrderId,
  loadAvailability,
  fetchAvailability,
  bookSlot,
  slotsForDate,
  initialSelection,
  ineligibleMessage,
  RETRY_DELAYS_MS
} from './booking-client.js';

const AVAILABILITY = {
  eligible: true,
  location: 'Italian Bear Chocolate — Fitzrovia',
  dates: [
    {
      date: '2026-08-14',
      date_label: 'Friday 14 August',
      slots: [
        { start_iso: '2026-08-14T14:00:00+01:00', time_label: '2:00–2:30pm' },
        { start_iso: '2026-08-14T14:30:00+01:00', time_label: '2:30–3:00pm' }
      ]
    },
    {
      date: '2026-08-15',
      date_label: 'Saturday 15 August',
      slots: [{ start_iso: '2026-08-15T10:00:00+01:00', time_label: '10:00–10:30am' }]
    }
  ]
};

/** Minimal fetch double: returns queued responses in order, records calls. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = queue.shift() ?? { status: 500, body: {} };
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body
    };
  };
  impl.calls = calls;
  return impl;
}

describe('resolveOrderId', () => {
  it('reads the Thank you page path', () => {
    const api = {
      orderConfirmation: { current: { order: { id: 'gid://shopify/OrderIdentity/42' } } }
    };
    assert.strictEqual(resolveOrderId(api), 'gid://shopify/OrderIdentity/42');
  });

  it('falls back to the Order status page path', () => {
    const api = { order: { current: { id: 'gid://shopify/Order/42' } } };
    assert.strictEqual(resolveOrderId(api), 'gid://shopify/Order/42');
  });

  it('returns null rather than throwing when nothing is there', () => {
    assert.strictEqual(resolveOrderId({}), null);
    assert.strictEqual(resolveOrderId(null), null);
  });

  it('survives a getter that throws', () => {
    const api = {};
    Object.defineProperty(api, 'orderConfirmation', {
      get() { throw new Error('nope'); }
    });
    assert.strictEqual(resolveOrderId(api), null);
  });
});

describe('isPlaceholderOrderId', () => {
  it('recognises the editor preview order', () => {
    // The checkout editor renders with OrderIdentity/0.
    assert.strictEqual(isPlaceholderOrderId('gid://shopify/OrderIdentity/0'), true);
    assert.strictEqual(isPlaceholderOrderId(''), true);
    assert.strictEqual(isPlaceholderOrderId(null), true);
  });

  it('accepts a real order', () => {
    assert.strictEqual(isPlaceholderOrderId('gid://shopify/OrderIdentity/6543210'), false);
  });
});

describe('fetchAvailability', () => {
  it('posts the order id with a bearer token', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { eligible: true, dates: [] } }]);
    await fetchAvailability({
      orderId: 'gid://shopify/OrderIdentity/7',
      token: 'jwt-here',
      fetchImpl,
      origin: 'https://example.test'
    });

    const call = fetchImpl.calls[0];
    assert.strictEqual(call.url, 'https://example.test/api/pickup/availability-for-order');
    assert.strictEqual(call.options.headers.Authorization, 'Bearer jwt-here');
    assert.deepStrictEqual(call.body, { orderId: 'gid://shopify/OrderIdentity/7' });
  });

  it('does not throw on a non-JSON body', async () => {
    const fetchImpl = async () => ({
      status: 502,
      ok: false,
      json: async () => { throw new Error('not json'); }
    });
    const result = await fetchAvailability({ orderId: '1', token: 't', fetchImpl });
    assert.strictEqual(result.status, 502);
    assert.strictEqual(result.payload, null);
  });
});

describe('loadAvailability retry', () => {
  it('returns immediately on a 200', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { eligible: true, dates: [] } }]);
    const slept = [];
    const result = await loadAvailability({
      orderId: '1',
      getToken: async () => 't',
      fetchImpl,
      sleep: async (ms) => slept.push(ms)
    });
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(slept, []);
  });

  it('retries while the order is still being created, then succeeds', async () => {
    const fetchImpl = fakeFetch([
      { status: 202, body: { status: 'order_pending' } },
      { status: 202, body: { status: 'order_pending' } },
      { status: 200, body: { eligible: true, dates: [] } }
    ]);
    const slept = [];
    const result = await loadAvailability({
      orderId: '1',
      getToken: async () => 't',
      fetchImpl,
      sleep: async (ms) => slept.push(ms)
    });
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(slept, [RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]);
  });

  it('gives up after the configured attempts rather than looping forever', async () => {
    const fetchImpl = fakeFetch(
      Array.from({ length: 20 }, () => ({ status: 202, body: { status: 'order_pending' } }))
    );
    const slept = [];
    const result = await loadAvailability({
      orderId: '1',
      getToken: async () => 't',
      fetchImpl,
      sleep: async (ms) => slept.push(ms),
      delays: [10, 20]
    });
    assert.strictEqual(result.status, 202);
    assert.strictEqual(fetchImpl.calls.length, 3); // initial + 2 retries
    assert.deepStrictEqual(slept, [10, 20]);
  });

  it('fetches a fresh token on every attempt', async () => {
    // Tokens are short-lived; reusing a stale one across a long retry would 401.
    let issued = 0;
    const fetchImpl = fakeFetch([
      { status: 202, body: {} },
      { status: 200, body: { eligible: true, dates: [] } }
    ]);
    await loadAvailability({
      orderId: '1',
      getToken: async () => `token-${++issued}`,
      fetchImpl,
      sleep: async () => {},
      delays: [1]
    });
    assert.strictEqual(issued, 2);
    assert.strictEqual(fetchImpl.calls[1].options.headers.Authorization, 'Bearer token-2');
  });

  it('stops retrying on a non-202 failure', async () => {
    const fetchImpl = fakeFetch([{ status: 401, body: { error: 'unauthorized' } }]);
    const result = await loadAvailability({
      orderId: '1',
      getToken: async () => 't',
      fetchImpl,
      sleep: async () => {}
    });
    assert.strictEqual(result.status, 401);
    assert.strictEqual(fetchImpl.calls.length, 1);
  });
});

describe('bookSlot', () => {
  it('posts the chosen slot', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { status: 'booked' } }]);
    await bookSlot({
      orderId: '9',
      startIso: '2026-08-14T14:00:00+01:00',
      token: 't',
      fetchImpl,
      origin: 'https://example.test'
    });
    assert.strictEqual(fetchImpl.calls[0].url, 'https://example.test/api/pickup/book');
    assert.deepStrictEqual(fetchImpl.calls[0].body, {
      orderId: '9',
      startIso: '2026-08-14T14:00:00+01:00'
    });
  });

  it('surfaces a 409 rather than throwing', async () => {
    const fetchImpl = fakeFetch([{ status: 409, body: { error: 'slot_unavailable' } }]);
    const result = await bookSlot({ orderId: '9', startIso: 'x', token: 't', fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.payload.error, 'slot_unavailable');
  });
});

describe('slotsForDate', () => {
  it('returns the slots for a date', () => {
    assert.strictEqual(slotsForDate(AVAILABILITY, '2026-08-14').length, 2);
  });

  it('returns an empty array for an unknown date', () => {
    assert.deepStrictEqual(slotsForDate(AVAILABILITY, '2026-01-01'), []);
    assert.deepStrictEqual(slotsForDate(null, '2026-08-14'), []);
  });
});

describe('initialSelection', () => {
  it('highlights the first slot when nothing is booked', () => {
    const selection = initialSelection(AVAILABILITY, null);
    assert.strictEqual(selection.dateKey, '2026-08-14');
    assert.strictEqual(selection.startIso, '2026-08-14T14:00:00+01:00');
  });

  it('restores an existing booking', () => {
    const selection = initialSelection(AVAILABILITY, {
      start_iso: '2026-08-15T10:00:00+01:00'
    });
    assert.strictEqual(selection.dateKey, '2026-08-15');
    assert.strictEqual(selection.startIso, '2026-08-15T10:00:00+01:00');
  });

  it('falls back to the first slot when the booked one has gone', () => {
    // Never silently move the customer — the UI shows the picker again so they
    // choose deliberately.
    const selection = initialSelection(AVAILABILITY, {
      start_iso: '2026-08-20T09:00:00+01:00'
    });
    assert.strictEqual(selection.dateKey, '2026-08-14');
  });

  it('copes with no dates at all', () => {
    assert.deepStrictEqual(initialSelection({ dates: [] }, null), {
      dateKey: null,
      startIso: null
    });
    assert.deepStrictEqual(initialSelection(null, null), { dateKey: null, startIso: null });
  });
});

describe('ineligibleMessage', () => {
  it('renders nothing for a delivery order', () => {
    assert.strictEqual(ineligibleMessage({ reason: 'not_pickup' }), null);
  });

  it('explains an uncollectable product', () => {
    assert.match(ineligibleMessage({ reason: 'products_unavailable' }), /cannot be collected/);
  });

  it('has a fallback for an unrecognised reason', () => {
    assert.match(ineligibleMessage({ reason: 'something_new' }), /contact us/);
    assert.match(ineligibleMessage({}), /contact us/);
  });
});
