# COURIER-2 — book the rider automatically

Two halves. The **app** half is below. The **theme** half is SAMEDAY-3, a
separate package, and the two need each other: the theme writes the delivery
window as a real timestamp, and the app refuses to book without it.

**Nothing books a rider until you tick a box that is off by default.** See
"The safety catch" below before you worry about that.

---

## What goes where

Copy over `C:\Claude Apps\IBC Pickup Scheduler`, keeping the folder structure.

| File | New? | What it is |
|---|---|---|
| `app/lib/courier-booking.js` | **new** | Every rule about whether to book, at what price, and what to write back. Pure — no network, no Shopify. 49 tests. |
| `app/lib/gophr.server.js` | replaces | Adds `bookJob`, `cancelJob`, `buildJobBody`, `readJob` |
| `app/lib/delivery.js` | replaces | Carries the new booking settings through save and validation |
| `app/routes/webhooks.orders.paid.jsx` | **new** | The webhook. Plumbing only. |
| `app/routes/app.courier.jsx` | replaces | Adds "Book a test job" to the bench |
| `tests/courier-booking.test.mjs` | **new** | The 49 tests |
| `shopify.app.toml` | replaces | Subscribes to `orders/paid` |
| `package.json` | replaces | **Fixes the test script** — see below |

### The test script was only running one file in five

Yours said:

```
"test": "node --test tests/availability.test.mjs"
```

So `delivery`, `sameday`, `zones` and `order-booking` were never run by
`npm test`. It now runs all of them. Expect the number to jump to **210**.

### No new permissions

`read_orders` and `write_orders` were already granted. Adding this webhook does
not invalidate your access token, so there is nothing to re-approve.

---

## Deploy

```powershell
cd "C:\Claude Apps\IBC Pickup Scheduler"
npm test
shopify app deploy      # registers the orders/paid webhook
git add -A ; git commit -m "Courier booking" ; git push     # or: vercel --prod
```

`shopify app deploy` is what registers the webhook. The Vercel push is what
puts the code behind it. **Both are needed** — this is the distinction that
cost us an afternoon last time.

### One new environment variable

In Vercel, alongside `GOPHR_API_KEY` and `GOPHR_ENV`:

```
GOPHR_PICKUP_MOBILE = <the shop's mobile number>
```

Gophr needs a number for the collection. Without it the bench says so plainly
and no booking is attempted.

---

## The safety catch

`auto_book` is **false** by default, and it is not a placeholder.

With it off, the webhook still runs on every same-day order, still asks Gophr
for a real price, and still writes that price onto the order — it simply does
not book. Every same-day order lands tagged `courier-review` carrying
`ibc_courier_quote_pence`.

That gives you a fortnight of real numbers: what Gophr would have charged
against what the customer paid, order by order, before anything books itself.
Turn it on when you have looked at them and not before.

### The circuit breaker

Even with automatic booking on, a job is flagged rather than booked when it is
too dear. Three limits, and the tightest one wins:

| Limit | Default | Why |
|---|---|---|
| Multiple of the zone price | 1.6× | The normal case |
| Flat headroom | £5 | So a cheap zone is not tripped by pennies |
| Hard ceiling | **£25** | So the dearest zone cannot authorise the dearest jobs |

The ceiling was £40 in the first draft. That was decoration: 1.6 × £19.95 is
£31.92, so a £40 ceiling could never bite on any zone you sell. A test caught
it. £25 against a £19.95 charge is a £5 loss you can absorb; £32 is one you
would rather be asked about.

---

## Expect the first test booking to fail

`POST /job` has never been called. The quote shape took four attempts to
establish, each settled by sending something and reading the answer — flat
prefixed address fields but *bare* parcel dimensions, prices as objects rather
than numbers. None of that was in the documentation.

The booking shape is an inference from the same evidence, and the "Book a test
job" button on the Courier page exists to correct it the same way.

**So: press it, and send me what comes back.** A 422 with a list of field
names is the tool working, not a bug. It shows you exactly what was sent
alongside what came back, because the one time that was left out, a stale
deploy and a wrong payload looked identical.

It refuses outright if `GOPHR_ENV` is anything but `sandbox`. Refuses, not
warns — a button whose job is to send malformed requests until one sticks
should not be one environment variable away from a real rider turning up at
Rathbone Place.

---

## What the webhook writes onto an order

| Attribute | Meaning |
|---|---|
| `ibc_courier_status` | `booked`, `needs_review` or `failed` |
| `ibc_courier_job_id` | Gophr's job. Its presence is what stops a retry double-booking. |
| `ibc_courier_tracking_url` | For the customer |
| `ibc_courier_quote_pence` | What Gophr charged, gross |
| `ibc_courier_note` | Why it needs a look, in a sentence |

Plus a tag: `courier-booked` or `courier-review`, so you can filter the orders
list.

Existing attributes are merged, never replaced. `orderUpdate` replaces the
whole attribute list, so a careless write would delete the collection slot and
the delivery window along with it.

---

## Things it deliberately will not do

- **Book twice.** An order carrying a job id is left alone, however many times
  Shopify re-sends the webhook.
- **Book a collection order.** An order marked `pickup` that still carries a
  stale `sameday` option is ignored. Sending a rider to deliver an order
  somebody is walking in to collect is the worst mistake available here.
- **Book against a window that has passed.** Flagged instead, with the window
  named.
- **Retry for 48 hours.** Shopify retries a failed webhook nineteen times over
  two days. For same-day that is useless — the window is long gone. Retries
  are allowed for 20 minutes and then the order is flagged for a human.
- **Guess the window from the label.** One of the windows is called "Any time
  before 9pm" and has no time in it at all. An order without a machine-readable
  window is flagged, not parsed.

---

## Tests

```
210 passing
```

Five of those exist because they caught something while being written:

1. `Number(null)` is `0`, and `0` is finite — so a half-saved settings blob
   read as a **£0 ceiling**, flagging every job.
2. The £40 hard ceiling could never bite (above).
3. A £26 job on a £12.95 band was reported as "over the £25 ceiling" when the
   useful answer names the band. The binding limit is now the one reported.
4. `courierPlan` was handing the pickup-time calculation the whole settings
   blob instead of the booking block. It worked only by accident — that blob
   has none of those keys, so every lookup missed and the defaults applied. It
   would have started silently obeying the wrong numbers the day anybody added
   a top-level key called `grace_minutes`.
5. A booking that succeeds but returns no job id is now treated as a
   **failure**, not a success. Without an id there is nothing to cancel,
   nothing to track, and no protection against a retry booking a second rider.
