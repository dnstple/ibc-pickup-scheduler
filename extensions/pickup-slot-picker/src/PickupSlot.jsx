/** @jsxImportSource preact */

// Collection slot picker for the Thank you and Order status pages.
//
// The pragma above is required. Without it esbuild compiles JSX to
// React.createElement, which throws in a runtime that has no React — producing
// a clean build and a completely blank block.
//
// Availability and booking are both computed server-side by the same engine the
// cart used to call. This component only renders and posts.

import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import {
  resolveOrderId,
  isPlaceholderOrderId,
  loadAvailability,
  bookSlot,
  slotsForDate,
  initialSelection,
  findSlot,
  ineligibleMessage
} from './booking-client.js';

export default function extension() {
  render(<PickupSlotPicker />, document.body);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function PickupSlotPicker() {
  const [phase, setPhase] = useState('loading'); // loading | ready | booked | hidden | preview | error
  const [availability, setAvailability] = useState(null);
  const [booking, setBooking] = useState(null);
  const [dateKey, setDateKey] = useState(null);
  const [startIso, setStartIso] = useState(null);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  const api = typeof shopify === 'undefined' ? null : shopify;
  const orderId = resolveOrderId(api);

  const load = useCallback(async () => {
    if (!orderId || isPlaceholderOrderId(orderId)) {
      setPhase('preview');
      return;
    }

    try {
      const result = await loadAvailability({
        orderId,
        getToken: () => api.sessionToken.get(),
        fetchImpl: (...args) => fetch(...args),
        sleep
      });

      if (result.status === 202 || !result.ok) {
        setPhase('error');
        setMessage(
          "We couldn't load collection times just now. Your confirmation email has a link to choose one."
        );
        return;
      }

      const payload = result.payload || {};

      if (!payload.eligible) {
        const text = ineligibleMessage(payload);
        if (!text) {
          setPhase('hidden');
          return;
        }
        setPhase('error');
        setMessage(text);
        return;
      }

      setAvailability(payload);
      setBooking(payload.current_booking || null);

      if (payload.current_booking?.start_iso) {
        setPhase('booked');
        return;
      }

      if ((payload.dates || []).length === 0) {
        setPhase('error');
        setMessage(
          'There are no collection times available at the moment. Please contact us and we will arrange one with you.'
        );
        return;
      }

      const initial = initialSelection(payload, null);
      setDateKey(initial.dateKey);
      setStartIso(initial.startIso);
      setPhase('ready');
    } catch (error) {
      setPhase('error');
      setMessage(
        "We couldn't load collection times. Your confirmation email has a link to choose one."
      );
      // eslint-disable-next-line no-console
      console.error('[ibc-pickup] availability failed:', error);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  const confirm = async () => {
    if (!startIso || saving) return;
    setSaving(true);
    setMessage(null);

    try {
      const token = await api.sessionToken.get();
      const result = await bookSlot({
        orderId,
        startIso,
        token,
        fetchImpl: (...args) => fetch(...args)
      });

      if (result.ok && result.payload?.booking) {
        setBooking(result.payload.booking);
        setPhase('booked');
        return;
      }

      if (result.status === 409 && result.payload?.error === 'slot_unavailable') {
        setMessage('Sorry — that time was taken while you were choosing. Please pick another.');
        await load();
        return;
      }

      setMessage("We couldn't save that time. Please try again.");
    } catch (error) {
      setMessage("We couldn't save that time. Please try again.");
      // eslint-disable-next-line no-console
      console.error('[ibc-pickup] booking failed:', error);
    } finally {
      setSaving(false);
    }
  };

  const changeBooking = () => {
    setPhase('ready');
    setMessage(null);
    const initial = initialSelection(availability, booking);
    setDateKey(initial.dateKey);
    setStartIso(initial.startIso);
  };

  /* ------------------------------------------------------------- states */

  if (phase === 'hidden') return null;

  if (phase === 'loading') {
    return (
      <s-box padding="base" border="base base solid" borderRadius="base" background="subdued">
        <s-stack direction="inline" gap="small-100" blockAlignment="center">
          <s-spinner accessibilityLabel="Loading collection times" />
          <s-text>Loading your collection times…</s-text>
        </s-stack>
      </s-box>
    );
  }

  if (phase === 'preview') {
    return (
      <s-box padding="base" border="base base solid" borderRadius="base" background="subdued">
        <s-stack direction="block" gap="small-100">
          <s-badge tone="neutral">Preview</s-badge>
          <s-heading>Choose your collection time</s-heading>
          <s-paragraph>
            Customers will pick their collection date and time here after paying.
            This placeholder only appears in the editor.
          </s-paragraph>
        </s-stack>
      </s-box>
    );
  }

  if (phase === 'error') {
    return (
      <s-banner tone="warning" heading="Collection time">
        <s-text>{message}</s-text>
      </s-banner>
    );
  }

  if (phase === 'booked') {
    return (
      <s-stack direction="block" gap="small-100">
        <s-banner tone="success" heading="Collection time booked">
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">{booking?.label}</s-text>
            {availability?.location ? (
              <s-text>at {availability.location}</s-text>
            ) : null}
            <s-text tone="subdued">
              We'll email you when your order is ready. Bring your confirmation with you.
            </s-text>
          </s-stack>
        </s-banner>
        <s-button variant="secondary" onClick={changeBooking}>
          Change collection time
        </s-button>
      </s-stack>
    );
  }

  /* ------------------------------------------------------- picker (ready) */

  const slots = slotsForDate(availability, dateKey);
  const selected = findSlot(availability, startIso);

  return (
    <s-box padding="base" border="large base solid" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-badge tone="critical" icon="alert-circle">One thing left</s-badge>

          <s-heading>Choose your collection time</s-heading>

          <s-paragraph>
            Your order is paid for, but it isn't scheduled yet. Pick when you'd
            like to collect from {availability?.location || 'our shop'} and
            we'll have it ready and waiting.
          </s-paragraph>
        </s-stack>

        <s-divider />

        <s-select
          label="Collection date"
          name="ibc-pickup-date"
          value={dateKey ?? ''}
          onChange={(event) => {
            const nextDate = event.currentTarget.value;
            setDateKey(nextDate);
            setStartIso(slotsForDate(availability, nextDate)[0]?.start_iso ?? null);
          }}
        >
          {(availability?.dates || []).map((date) => (
            <s-option key={date.date} value={date.date}>
              {date.date_label}
            </s-option>
          ))}
        </s-select>

        <s-select
          label="Collection time"
          name="ibc-pickup-time"
          value={startIso ?? ''}
          onChange={(event) => setStartIso(event.currentTarget.value)}
        >
          {slots.map((slot) => (
            <s-option key={slot.start_iso} value={slot.start_iso}>
              {slot.time_label}
            </s-option>
          ))}
        </s-select>

        {selected ? (
          <s-box padding="small-100" borderRadius="base" background="base">
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">You're booking</s-text>
              <s-text type="strong">{selected.label}</s-text>
            </s-stack>
          </s-box>
        ) : null}

        {message ? (
          <s-banner tone="warning">
            <s-text>{message}</s-text>
          </s-banner>
        ) : null}

        <s-button
          variant="primary"
          loading={saving}
          disabled={!startIso || saving}
          onClick={confirm}
        >
          Confirm collection time
        </s-button>

        <s-text tone="subdued">
          You can change this any time from your order status page.
          {availability?.instructions ? ` ${availability.instructions}` : ''}
        </s-text>
      </s-stack>
    </s-box>
  );
}
