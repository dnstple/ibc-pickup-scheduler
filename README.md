# Pickup Scheduler Settings — Italian Bear Chocolate

A pickup-only custom Shopify app plus theme scheduler for click-and-collect.
No shipping, delivery, dispatch-date, postcode or delivery-zone functionality
exists anywhere in this codebase, by design.

## 1. Architecture summary

**Shopify owns all data.** The app writes exactly one thing: the shop metafield
`custom.pickup_scheduler_settings` (JSON). Customer selections are stored as
`ibc_pickup_*` cart attributes via the Cart Ajax API, so they land on the
Shopify order. There is no booking/order/customer database — the only local
storage is the standard Prisma/SQLite table for OAuth sessions.

```
Shopify Admin (embedded app, Polaris)
  └─ reads/writes shop metafield custom.pickup_scheduler_settings   (only write)
  └─ reads product metafields + orders (read-only, for the UI and capacity)

Theme cart page (/cart)
  └─ snippets/ibc-pickup-scheduler.liquid  → renders <ibc-pickup-scheduler>
  └─ assets/ibc-pickup-scheduler.js        → POST /apps/ibc-pickup/availability
  └─ Cart Ajax API (/cart/update.js)       → saves/clears ibc_pickup_* attributes

App proxy (server-side, credentials never reach the theme)
  └─ /apps/ibc-pickup/availability
       reads settings metafield + cart products' pickup metafields
       counts existing Shopify pickup orders for capacity
       returns computed dates/slots JSON

Checkout: untouched. Customer must select "Pick up" natively.
  Pick up  + ibc_pickup_* attributes  = active collection order
  Delivery                            = ignore all ibc_pickup_* attributes
```

The customer-side flow: choose a slot in the cart (optional) → attributes are
saved to the cart → order is placed with native Pick up selected → a future
order tracker reads the attributes straight from the Shopify order.

## 2. Repository layout

```
app/
  routes/app._index.jsx        Admin UI: Pickup Schedule, Blackout Dates,
                               Capacity Overrides, Product Preparation Rules,
                               Help & Scheduler Health (Polaris, tabbed)
  routes/proxy.availability.jsx  App proxy endpoint (availability JSON)
  routes/app.jsx, _index.jsx, auth.$.jsx, webhooks.app.uninstalled.jsx
  lib/availability.js          Pure availability engine (unit-tested)
  lib/timezone.js              Europe/London-safe date/time helpers (no deps)
  lib/settings.server.js       Shop metafield read/write + product rules list
  lib/orders.server.js         Pickup-order capacity counting
theme/
  snippets/ibc-pickup-scheduler.liquid
  assets/ibc-pickup-scheduler.css
  assets/ibc-pickup-scheduler.js
  sections/main-cart-footer.liquid   (your live Dawn file + one render block)
tests/availability.test.mjs    23 tests, run with: npm test
```

## 3. Setup

### App (Shopify CLI)
1. `npm install`
2. `npm run config:link` — link to a new custom app in your Partner/store admin
   (this fills in `client_id`; keep the scopes below).
3. `npm run dev` to develop, `npm run deploy` + host (Fly/Render/Heroku etc.)
   for production. Set `.env` from `.env.example` when self-hosting.
4. The app proxy is configured in `shopify.app.toml`
   (prefix `apps`, subpath `ibc-pickup` → `{app_url}/proxy`), giving the theme
   `https://italianbearchocolate.com/apps/ibc-pickup/availability`.

### Theme (Dawn-based "Main Theme")
1. Upload `theme/assets/ibc-pickup-scheduler.css` and
   `theme/assets/ibc-pickup-scheduler.js` to the theme's Assets.
2. Upload `theme/snippets/ibc-pickup-scheduler.liquid` to Snippets.
3. Replace `sections/main-cart-footer.liquid` with the copy in this repo, or
   add these three lines inside `<div class="cart__blocks">`, directly above
   `{% for block in section.blocks %}`:

```liquid
{%- unless cart == empty -%}
  {% render 'ibc-pickup-scheduler' %}
{%- endunless -%}
```

This places the scheduler in the cart footer, directly above the subtotal and
checkout button, on the full /cart page only (no cart-drawer support in v1).

### Store prerequisites (already done on italianbearchocolate.com)
- Metafield definitions created (see §4) and the settings metafield seeded
  with your requested defaults (Tue–Sat, 30-minute slots, 3pm cut-off, £15
  minimum, 30/day, 5/slot).
- Native local pickup is enabled (Fitzrovia + Fitzrovia (Pickup Only), both
  "ready in 1 hour"), so "Pick up" appears in checkout. Keep it enabled.

## 4. Exact metafield definitions

**Shop** (the only thing the app writes):

| | |
|---|---|
| Namespace/key | `custom.pickup_scheduler_settings` |
| Type | `json` |
| Owner | Shop |

JSON shape (all keys, as seeded):

```json
{
  "timezone": "Europe/London",
  "booking_horizon_days": 14,
  "slot_interval_minutes": 30,
  "same_day_pickup_enabled": true,
  "same_day_pickup_cutoff_time": "15:00",
  "minimum_pickup_order_value_enabled": true,
  "minimum_pickup_order_value": 15,
  "maximum_pickup_orders_per_day": 30,
  "maximum_pickup_orders_per_slot": 5,
  "collection_location_name": "Italian Bear Chocolate",
  "collection_instructions": "Please collect from the counter and have your order number ready.",
  "customer_checkout_message": "At checkout, please select Pick up to confirm your collection time. If you select Delivery instead, this collection time will not apply.",
  "weekly_hours": { "monday": { "enabled": false, "start_time": null, "end_time": null }, "...": "…tuesday–sunday in the same shape…" },
  "blackout_dates":     [ { "date": "2026-12-25", "all_day": true,  "start_time": null,   "end_time": null,  "note": "Christmas Day" },
                          { "date": "2026-07-18", "all_day": false, "start_time": "14:00", "end_time": "23:59", "note": "Private event" } ],
  "capacity_overrides": [ { "date": "2026-07-11", "slot_start": null,    "max_orders": 15, "note": "Saturday 12 July: 15 max" },
                          { "date": "2026-07-11", "slot_start": "14:00", "max_orders": 2,  "note": "2–3pm: 2 max" } ]
}
```

**Product** (read-only for the app; edit on product pages):

| Definition | Namespace/key | Type | Behaviour |
|---|---|---|---|
| Pickup delay (minutes) | `custom.pickup_delay_minutes` | `number_integer` (min 0) | Blank → default 60 min. Basket uses the single highest value — delays are never added together. |
| Available for pickup | `custom.pickup_available` | `boolean` | Blank or `true` → available. `false` → scheduler disabled for any basket containing the product. |

Note: your store also has an older `custom.pickup_only` boolean. It is not used
by this app (opposite meaning); ignore or migrate it manually.

## 5. Exact Liquid render line and location

File: `sections/main-cart-footer.liquid`, inside `<div class="cart__blocks">`,
immediately before `{% for block in section.blocks %}`:

```liquid
{%- unless cart == empty -%}
  {% render 'ibc-pickup-scheduler' %}
{%- endunless -%}
```

## 6. Minimum Shopify API scopes

```
read_products, read_orders
```

- `read_products` — read `custom.pickup_delay_minutes` / `custom.pickup_available`
  for cart products (proxy) and the Product Preparation Rules tab.
- `read_orders` — count existing pickup orders for the per-day/per-slot limits.
- Shop metafield reads/writes need no additional scope (shop-owned metafields
  are covered by the app's authenticated Admin API session).
- No write access to products, orders, themes or anything else.

## 7. Test checklist

Settings assumed: Tue–Sat 10:00–18:00 (Sat to 17:00), 30-min slots, same-day
cut-off 15:00, £15 minimum, 30/day, 5/slot. All timings are Europe/London.

1. **Default 60-minute delay** — cart with a chocolate bar (no metafield) at
   12:15 on an open day → earliest offered slot is 1:30–2:00pm. ✅ unit-tested
2. **Longer product delay** — whole cake `pickup_delay_minutes = 180` at 12:15
   → earliest slot 3:30pm. ✅ unit-tested
3. **Multiple products** — bar + cake → 180 minutes applies (highest, not
   240). ✅ unit-tested
4. **Same-day cut-off** — at 15:05, today disappears from the date list even
   though the shop is open until 6pm. ✅ unit-tested
5. **Disabled days** — Sunday/Monday never appear. ✅ unit-tested
6. **Blackout date** — add 25 Dec all-day in the app → date absent from
   scheduler. ✅ unit-tested
7. **Partial closure** — closure 14:00–23:59 → morning slots remain, nothing
   from 2pm. ✅ unit-tested
8. **Minimum order value** — £12 cart → no times selectable; message
   "Collection is available for orders over £15.00." ✅ unit-tested
9. **Max orders per day** — with N pickup orders already on a date (attributes
   set, Pick up method), the date vanishes at the limit. ✅ unit-tested
10. **Max orders per slot** — a full slot vanishes; neighbours remain.
    ✅ unit-tested
11. **Product unavailable** — set `pickup_available = false` on one product,
    add to basket → scheduler disabled, "One or more items in your basket are
    not available for collection."  ✅ unit-tested
12. **Cart change invalidates selection** — select a slot with only a bar,
    then add the 180-min cake → selection cleared, calm message asks for a new
    time. Manual: watch the cart page after the Ajax update.
13. **Clearing a selection** — "Clear collection time" → all seven
    `ibc_pickup_*` attributes removed from /cart.js before the UI resets.
14. **Attributes on the order** — place a test order; Shopify admin → order →
    Additional details shows all `ibc_pickup_*` keys with ISO times carrying
    the correct +01:00/+00:00 offset.
15. **Pickup time in cart, Delivery at checkout** — attributes still appear on
    the order, but the fulfilment method is Delivery; the (future) tracker and
    this app's capacity counting both ignore it. ✅ unit-tested (counting side)
16. **Mobile** — scheduler is a single column, date/slot grids wrap, focus
    states visible, buttons ≥40px tall. Manual on a real phone.
17. **BST transitions** — 29 March 2026 and 25 October 2026 slots resolve to
    the right instants and offsets. ✅ unit-tested both directions.

Run the automated part with `npm test` (23 passing).

## 8. Limitations and assumptions

- **Capacity is advisory, not race-safe.** Limits are computed from orders
  already in Shopify at the moment of rendering. Two customers can select the
  last slot simultaneously and both complete checkout. Strictly enforcing the
  last slot would require temporary reservations (a short-lived hold store and
  expiry logic), which is outside this settings-only scope. Mitigation: the
  selection is re-validated every time the cart changes and when the page
  loads, so stale slots are cleared quickly.
- **Checkout is native.** Nothing hides, replaces or overrides Shopify's
  fulfilment selection (no Plus checkout customisation, no post-purchase
  edits, no webhooks). The scheduler shows the required reminder and the
  order data makes the customer's checkout choice authoritative.
- **Order scanning window.** Capacity counting scans orders created within the
  booking horizon + 2 days (max ~1,000 orders). Ample for current volumes; if
  the shop ever exceeds ~250 pickup orders per horizon window, raise the page
  limit in `app/lib/orders.server.js`.
- **Full cart page only.** The cart drawer is intentionally unsupported in v1.
- **Session storage.** Prisma/SQLite stores OAuth sessions only — not a
  booking database.
- **Metafield polarity.** The legacy `custom.pickup_only` field is ignored;
  only `custom.pickup_available` (false = excluded) is honoured.
