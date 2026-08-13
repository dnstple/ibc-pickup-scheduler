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
  ineligibleMessage
} from './booking-client.js';

export default function extension() {
  render(<PickupSlotPicker />, document.body);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function PickupSlotPicker() {
  const [phase, setPhase] = useState('loading'); // loading | ready | booked | hidden | error
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
      // Editor preview, or an ID we can't read. Show the shell so the merchant
      // can see the block exists, but don't call the API.
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

      if (result.status === 202) {
        setPhase('error');
        setMessage(
          'We could not load collection times just yet. Your confirmation email has a link to choose one.'
        );
        return;
      }

      if (!result.ok) {
        setPhase('error');
        setMessage(
          'We could not load collection times. Your confirmation email has a link to choose one.'
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
          'There are no collection times available at the moment. Please contact us and we will arrange one.'
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
        'We could not load collection times. Your confirmation email has a link to choose one.'
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

      setMessage('We could not save that time. Please try again.');
    } catch (error) {
      setMessage('We could not save that time. Please try again.');
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

  if (phase === 'hidden') return null;

  if (phase === 'loading') {
    return (
      <s-stack direction="inline" gap="small" blockAlignment="center">
        <s-spinner accessibilityLabel="Loading collection times" />
        <s-text>Loading collection times…</s-text>
      </s-stack>
    );
  }

  if (phase === 'preview') {
    return (
      <s-banner heading="Choose a collection time">
        <s-text>
          Customers will pick their collection date and time here after paying.
        </s-text>
      </s-banner>
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
      <s-stack direction="block" gap="base">
        <s-banner tone="success" heading="Your collection time is booked">
          <s-stack direction="block" gap="small-200">
            <s-text>{booking?.label}</s-text>
            {availability?.location ? <s-text>{availability.location}</s-text> : null}
            {availability?.instructions ? (
              <s-text tone="subdued">{availability.instructions}</s-text>
            ) : null}
          </s-stack>
        </s-banner>
        <s-button variant="secondary" onClick={changeBooking}>
          Change collection time
        </s-button>
      </s-stack>
    );
  }

  const slots = slotsForDate(availability, dateKey);

  return (
    <s-stack direction="block" gap="base">
      <s-heading>Choose your collection time</s-heading>
      <s-text tone="subdued">
        Your order will be ready to collect from {availability?.location} at the time you choose.
      </s-text>

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
    </s-stack>
  );
}
