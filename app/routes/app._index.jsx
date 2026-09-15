import { useCallback, useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  DescriptionList,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { loadSettings, saveSettings, loadProductRules } from "../lib/settings.server";
import {
  normalizeSettings,
  validateSettings,
  summarizeSettings,
  WEEKDAY_KEYS,
  DEFAULT_PREP_MINUTES,
} from "../lib/availability";
import {
  summarizeDelivery,
  earliestDeliveryDate,
  weekdayIndex,
  WEEKDAY_INDEX_LABELS,
} from "../lib/delivery";
import { normalizeSameday, windowsFor } from "../lib/sameday";
import { zonedParts, dateLabel } from "../lib/timezone";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const [{ settings, shopId, exists }, { products, truncated }] = await Promise.all([
    loadSettings(admin),
    loadProductRules(admin),
  ]);
  /* THE SHOP'S OWN CLOCK, read on the server.
     Both the banner and the Delivery tab's preview have to apply the daily
     cut-off, or they promise a date the basket will not offer after noon. It
     is read here rather than in the browser because a value computed during
     render would differ between the server pass and the client pass and React
     would throw a hydration mismatch. It goes stale as the page sits open,
     which is why the preview says "right now". */
  const nowParts = zonedParts(new Date(), settings.timezone || "Europe/London");
  const today = nowParts.dateStr;
  const nowMinutes = nowParts.minutesOfDay;
  return {
    settings,
    shopId,
    settingsExist: exists,
    products,
    productsTruncated: truncated,
    today,
    nowMinutes,
    summary: summarizeSettings(settings),
    deliverySummary: summarizeDelivery(settings.delivery, today, nowMinutes),
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const body = await request.json();
  const settings = normalizeSettings(body.settings);
  const errors = validateSettings(settings);
  if (Object.keys(errors).length > 0) {
    return Response.json({ ok: false, errors }, { status: 422 });
  }
  const { shopId } = await loadSettings(admin);
  await saveSettings(admin, shopId, settings);
  const nowParts = zonedParts(new Date(), settings.timezone || "Europe/London");
  return Response.json({
    ok: true,
    summary: summarizeSettings(settings),
    deliverySummary: summarizeDelivery(
      settings.delivery,
      nowParts.dateStr,
      nowParts.minutesOfDay
    ),
  });
};

const DAY_LABELS = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

const INTERVAL_OPTIONS = [
  { label: "15 minutes", value: "15" },
  { label: "30 minutes", value: "30" },
  { label: "60 minutes", value: "60" },
];

/* ONE SENTENCE AT THE TOP OF EVERY TAB, saying what it changes and where the
   customer sees it. The commonest question about a settings screen is not
   "what does this field do" but "which screen am I editing", and a tab
   heading alone does not answer it. */
function TabIntro({ children }) {
  return (
    <Banner tone="info">
      <Text as="p">{children}</Text>
    </Banner>
  );
}

const emptyBlackout = { date: "", all_day: true, start_time: "", end_time: "", note: "" };
const emptyOverride = { date: "", slot_start: "", max_orders: "", note: "" };
const emptyDeliveryBlackout = { date: "", note: "" };

export default function FulfilmentSettingsPage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [settings, setSettings] = useState(data.settings);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState(0);
  const [summary, setSummary] = useState(data.summary);
  const [deliverySummary, setDeliverySummary] = useState(data.deliverySummary);

  const errors = fetcher.data?.ok === false ? fetcher.data.errors || {} : {};
  const saving = fetcher.state !== "idle";

  /* WHICH TAB THE PROBLEM IS ON. Validation errors are keyed by field path,
     and a merchant staring at a red banner on the Delivery tab should not have
     to open the other five to find the field that stopped the save. */
  const errorTabs = useMemo(() => {
    const keys = Object.keys(errors);
    const named = new Set();
    keys.forEach((key) => {
      if (key.startsWith("delivery.") || key.startsWith("sameday.") ||
          key.startsWith("booking.")) named.add("Delivery");
      else if (key.startsWith("blackout_dates.")) named.add("Collection Closures");
      else if (key.startsWith("capacity_overrides.")) named.add("Collection Capacity");
      else named.add("Collection");
    });
    return [...named];
  }, [errors]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setDirty(false);
      setSummary(fetcher.data.summary);
      setDeliverySummary(fetcher.data.deliverySummary);
      shopify.toast.show("Fulfilment settings saved");
    }
    if (fetcher.state === "idle" && fetcher.data?.ok === false) {
      shopify.toast.show("Please fix the highlighted fields", { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const update = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  const updateDelivery = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, delivery: { ...prev.delivery, ...patch } }));
    setDirty(true);
  }, []);

  // Same-day sits two levels down (settings.delivery.sameday), and its zones
  // three, so each needs its own handler rather than the top-level ones.
  const updateSameday = useCallback((patch) => {
    setSettings((prev) => ({
      ...prev,
      delivery: {
        ...prev.delivery,
        sameday: { ...prev.delivery.sameday, ...patch },
      },
    }));
    setDirty(true);
  }, []);

  /* The booking block is what happens AFTER a same-day order is paid for, so
   * it sits beside `sameday` rather than inside it: one is what the customer
   * is offered, the other is what the shop spends. */
  const updateBooking = useCallback((patch) => {
    setSettings((prev) => ({
      ...prev,
      delivery: {
        ...prev.delivery,
        booking: { ...(prev.delivery.booking || {}), ...patch },
      },
    }));
    setDirty(true);
  }, []);

  const updateSamedayZone = useCallback((index, patch) => {
    setSettings((prev) => ({
      ...prev,
      delivery: {
        ...prev.delivery,
        sameday: {
          ...prev.delivery.sameday,
          zones: prev.delivery.sameday.zones.map((z, i) =>
            i === index ? { ...z, ...patch } : z
          ),
        },
      },
    }));
    setDirty(true);
  }, []);

  const updateDay = useCallback((day, patch) => {
    setSettings((prev) => ({
      ...prev,
      weekly_hours: {
        ...prev.weekly_hours,
        [day]: { ...prev.weekly_hours[day], ...patch },
      },
    }));
    setDirty(true);
  }, []);

  const updateListItem = useCallback((listKey, index, patch) => {
    setSettings((prev) => {
      const list = prev[listKey].map((item, i) => (i === index ? { ...item, ...patch } : item));
      return { ...prev, [listKey]: list };
    });
    setDirty(true);
  }, []);

  const addListItem = useCallback((listKey, item) => {
    setSettings((prev) => ({ ...prev, [listKey]: [...prev[listKey], { ...item }] }));
    setDirty(true);
  }, []);

  const removeListItem = useCallback((listKey, index) => {
    setSettings((prev) => ({
      ...prev,
      [listKey]: prev[listKey].filter((_, i) => i !== index),
    }));
    setDirty(true);
  }, []);

  // The delivery blackout list lives inside settings.delivery, so it needs its
  // own three handlers rather than the top-level listKey ones.
  const updateDeliveryBlackout = useCallback((index, patch) => {
    setSettings((prev) => ({
      ...prev,
      delivery: {
        ...prev.delivery,
        blackout_dates: prev.delivery.blackout_dates.map((b, i) =>
          i === index ? { ...b, ...patch } : b
        ),
      },
    }));
    setDirty(true);
  }, []);

  const addDeliveryBlackout = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      delivery: {
        ...prev.delivery,
        blackout_dates: [...prev.delivery.blackout_dates, { ...emptyDeliveryBlackout }],
      },
    }));
    setDirty(true);
  }, []);

  const removeDeliveryBlackout = useCallback((index) => {
    setSettings((prev) => ({
      ...prev,
      delivery: {
        ...prev.delivery,
        blackout_dates: prev.delivery.blackout_dates.filter((_, i) => i !== index),
      },
    }));
    setDirty(true);
  }, []);

  const save = useCallback(() => {
    fetcher.submit({ settings }, { method: "post", encType: "application/json" });
  }, [fetcher, settings]);

  const tabs = useMemo(
    () => [
      { id: "delivery", content: "Delivery" },
      { id: "schedule", content: "Collection" },
      { id: "blackouts", content: "Collection Closures" },
      { id: "capacity", content: "Collection Capacity" },
      { id: "products", content: "Product Preparation Rules" },
      { id: "help", content: "How this works" },
    ],
    []
  );

  const saveAction = {
    content: "Save settings",
    onAction: save,
    loading: saving,
    disabled: !dirty && fetcher.data?.ok !== false,
  };

  return (
    <Page
      title="Fulfilment Settings"
      subtitle="Delivery and collection rules for the basket, cart drawer and checkout. New here? Open How this works."
      primaryAction={saveAction}
    >
      <BlockStack gap="400">
        {/* FIRST RUN. Until this page has been saved once the metafield does
            not exist, and everything on screen is a default rather than
            something the shop chose — which is worth saying, because the
            defaults have every collection day switched OFF. */}
        {!data.settingsExist && (
          <Banner tone="warning" title="These settings have never been saved">
            <Text as="p">
              Nothing on these tabs is live yet. What you are looking at is the built-in
              defaults, and the basket is running on its own fallback rules until you
              press Save settings once. Check the Collection tab before you do &mdash;
              the defaults have every collection day switched off.
            </Text>
          </Banner>
        )}

        <Banner
          tone={settings.delivery?.enabled === false ? "warning" : "info"}
          title="Delivery"
        >
          <Text as="p">{deliverySummary}</Text>
        </Banner>

        <Banner
          tone={
            settings.pickup_enabled === false ||
            summary.startsWith("Collection is currently unavailable")
              ? "warning"
              : "info"
          }
          title="Collection"
        >
          <Text as="p">
            {settings.pickup_enabled === false
              ? "Collection is switched off. The basket hides the collection option entirely."
              : summary}
          </Text>
        </Banner>

        {Object.keys(errors).length > 0 && (
          <Banner tone="critical" title="Nothing was saved">
            <BlockStack gap="200">
              <Text as="p">
                Fix the highlighted fields and save again. Until then the shop is still
                running on the last settings that saved cleanly &mdash; a failed save
                changes nothing, so the basket is not in a half-edited state.
              </Text>
              <Text as="p">
                {errorTabs.length > 1
                  ? `The problems are on the ${errorTabs.slice(0, -1).join(", ")} and ${
                      errorTabs[errorTabs.length - 1]
                    } tabs.`
                  : `The problem is on the ${errorTabs[0]} tab.`}
              </Text>
            </BlockStack>
          </Banner>
        )}

        <Tabs tabs={tabs} selected={tab} onSelect={setTab} />

        {tab === 0 && (
          <DeliveryTab
            delivery={settings.delivery}
            errors={errors}
            today={data.today}
            nowMinutes={data.nowMinutes}
            updateDelivery={updateDelivery}
            updateSameday={updateSameday}
            updateSamedayZone={updateSamedayZone}
            updateBooking={updateBooking}
            weeklyHours={settings.weekly_hours}
            updateDeliveryBlackout={updateDeliveryBlackout}
            addDeliveryBlackout={addDeliveryBlackout}
            removeDeliveryBlackout={removeDeliveryBlackout}
          />
        )}
        {tab === 1 && (
          <ScheduleTab settings={settings} errors={errors} update={update} updateDay={updateDay} />
        )}
        {tab === 2 && (
          <BlackoutsTab
            settings={settings}
            errors={errors}
            updateListItem={updateListItem}
            addListItem={addListItem}
            removeListItem={removeListItem}
          />
        )}
        {tab === 3 && (
          <CapacityTab
            settings={settings}
            errors={errors}
            updateListItem={updateListItem}
            addListItem={addListItem}
            removeListItem={removeListItem}
          />
        )}
        {tab === 4 && (
          <ProductsTab products={data.products} truncated={data.productsTruncated} />
        )}
        {tab === 5 && <HelpTab summary={summary} deliverySummary={deliverySummary} />}

        <InlineStack align="end">
          <Button
            variant="primary"
            onClick={save}
            loading={saving}
            disabled={!dirty && fetcher.data?.ok !== false}
          >
            Save settings
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}

/* ============================================================================
   BOOKING THE COURIER — what happens after a same-day order is paid for
   ========================================================================== */

/**
 * The settings behind the orders/paid webhook.
 *
 * SEPARATE FROM THE SAME-DAY CARD ON PURPOSE. That one is about what the
 * customer is offered — zones, windows, cut-offs. This is about what the shop
 * SPENDS, and the two are edited by the same person in different moods.
 *
 * The card shows what each limit means in real money against the shop's own
 * zone prices, because "1.6" and "2500" are not numbers anybody can judge in
 * the abstract. A ceiling that no zone can ever reach looks like protection
 * and is decoration — that mistake was shipped once already and caught by a
 * test, so the arithmetic is on screen now rather than in a comment.
 */
function BookingCard({ booking, sameday, errors, updateBooking }) {
  const b = booking || {};
  const multiple = Number(b.ceiling_multiple ?? 1.6);
  const headroom = Number(b.headroom_pence ?? 500);
  const ceiling = Number(b.ceiling_pence ?? 2500);

  const pounds = (pence) => `£${(Number(pence || 0) / 100).toFixed(2)}`;

  /* What each zone could actually cost the shop before a job is held back. */
  const bands = (sameday?.zones || []).map((zone) => {
    const band = Math.round(Number(String(zone.price || "0").replace(/[^0-9.]/g, "")) * 100);
    const byMultiple = Math.max(Math.round(band * multiple), band + headroom);
    const allowed = Math.min(byMultiple, ceiling);
    return {
      id: zone.id,
      band,
      allowed,
      /* Which of the two rules actually bites. A zone where the ceiling never
       * binds is a zone the ceiling is not protecting. */
      binding: ceiling < byMultiple ? "ceiling" : "band",
    };
  });

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="150">
          <Text as="h3" variant="headingMd">Booking the courier</Text>
          <Text as="p" tone="subdued">
            What happens after a same-day order is paid for. Same-day has to be
            switched on above for any of this to run.
          </Text>
        </BlockStack>

        <Checkbox
          label="Book the rider automatically"
          checked={b.auto_book === true}
          onChange={(v) => updateBooking({ auto_book: v })}
          helpText={
            b.auto_book === true
              ? "A paid same-day order books a rider on its own, unless the price trips one of the limits below."
              : "OFF: every same-day order still gets a real Gophr price written onto it and a draft job waiting in Gophr — but no rider is booked until you confirm it yourself. Leave it here until you have a fortnight of real prices to look at."
          }
        />

        <Divider />

        <BlockStack gap="150">
          <Text as="h4" variant="headingSm">When to ask you first</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Three limits, and the TIGHTEST one wins. A job over it is left as an
            unconfirmed draft with a note on the order, rather than booked.
          </Text>
        </BlockStack>

        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
          <TextField
            label="Multiple of the zone price"
            type="number"
            step={0.1}
            min={1}
            value={String(b.ceiling_multiple ?? 1.6)}
            onChange={(v) => updateBooking({ ceiling_multiple: Number(v) })}
            error={errors["booking.ceiling_multiple"]}
            helpText="1.6 allows a job up to 1.6× what the customer paid."
            autoComplete="off"
          />
          <TextField
            label="Always allow this much over (pence)"
            type="number"
            min={0}
            value={String(b.headroom_pence ?? 500)}
            onChange={(v) => updateBooking({ headroom_pence: Number(v) })}
            error={errors["booking.headroom_pence"]}
            helpText="Stops a cheap zone tripping on pennies."
            autoComplete="off"
          />
          <TextField
            label="Hard ceiling (pence)"
            type="number"
            min={100}
            value={String(b.ceiling_pence ?? 2500)}
            onChange={(v) => updateBooking({ ceiling_pence: Number(v) })}
            error={errors["booking.ceiling_pence"]}
            helpText="Nothing books above this, whatever the zone."
            autoComplete="off"
          />
        </InlineGrid>

        {bands.length > 0 && (
          <Box background="bg-surface-secondary" padding="300" borderRadius="200">
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                What that means for your zones
              </Text>
              {bands.map((z) => (
                <Text as="p" key={z.id} variant="bodySm">
                  <Text as="span" fontWeight="semibold">Zone {z.id}</Text> — charged{" "}
                  {pounds(z.band)}, books itself up to{" "}
                  <Text as="span" fontWeight="semibold">{pounds(z.allowed)}</Text>{" "}
                  <Text as="span" tone="subdued">
                    ({z.binding === "ceiling" ? "held by the hard ceiling" : "held by the multiple"})
                  </Text>
                </Text>
              ))}
              {bands.every((z) => z.binding === "band") && (
                <Text as="p" variant="bodySm" tone="subdued">
                  The hard ceiling never bites on any of your zones, so it is doing
                  nothing. Lower it if you want it to be a real limit.
                </Text>
              )}
            </BlockStack>
          </Box>
        )}

        <Divider />

        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <TextField
            label="Ask for the rider this many minutes before the window opens"
            type="number"
            min={0}
            max={240}
            value={String(b.pickup_offset_minutes ?? 30)}
            onChange={(v) => updateBooking({ pickup_offset_minutes: Number(v) })}
            error={errors["booking.pickup_offset_minutes"]}
            helpText="The window is when it should ARRIVE. The rider has to collect before that."
            autoComplete="off"
          />
          <TextField
            label="Grace period on a window that has just passed (minutes)"
            type="number"
            min={0}
            max={240}
            value={String(b.grace_minutes ?? 15)}
            onChange={(v) => updateBooking({ grace_minutes: Number(v) })}
            error={errors["booking.grace_minutes"]}
            helpText="Covers a slow payment. Past this, the order is flagged instead of booked."
            autoComplete="off"
          />
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

/* ============================================================================
   DELIVERY
   ========================================================================== */

function DeliveryTab({
  delivery,
  errors,
  today,
  nowMinutes,
  updateDelivery,
  updateSameday,
  updateSamedayZone,
  updateBooking,
  weeklyHours,
  updateDeliveryBlackout,
  addDeliveryBlackout,
  removeDeliveryBlackout,
}) {
  const d = delivery || {};
  const closed = new Set((d.closed_weekdays || []).map(Number));

  const toggleWeekday = (index, open) => {
    const next = new Set(closed);
    if (open) next.delete(index);
    else next.add(index);
    updateDelivery({ closed_weekdays: [...next].sort((a, b) => a - b) });
  };

  /* THE EARLIEST DATE THESE RULES WOULD OFFER RIGHT NOW, from the same
     function the basket's rule mirrors, so what is shown is what a customer
     gets. nowMinutes is included because the cut-off is a time-of-day rule —
     without it the preview promised a date that stopped being available at
     noon. */
  let earliest = null;
  if (d.enabled && d.dated_enabled && today) {
    try {
      const iso = earliestDeliveryDate(
        { ...d, closed_weekdays: [...closed] },
        today,
        typeof nowMinutes === "number" ? nowMinutes : null
      );
      /* The un-rolled landing day too, so the sentence can show its working
         when the two differ — that is the step people expect to be wrong. */
      const landed = earliestDeliveryDate(
        { ...d, closed_weekdays: [], blackout_dates: [] },
        today,
        typeof nowMinutes === "number" ? nowMinutes : null
      );
      earliest = { iso, label: dateLabel(iso).label, landed, rolled: landed !== iso };
    } catch {
      earliest = null;
    }
  }

  return (
    <Layout>
      <Layout.Section>
        <BlockStack gap="400">
          <TabIntro>
            These rules drive the <Text as="span" fontWeight="semibold">Shipping</Text>{" "}
            tile in the basket and the cart drawer &mdash; which dates its calendar
            offers, and the words on it. They do not set postage prices; those are
            Shopify&rsquo;s shipping rates.
          </TabIntro>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                What the basket offers
              </Text>
              <Text as="p" tone="subdued">
                The customer sees up to two shipping choices. Untick one and it
                disappears from the basket; untick both and this page will not save.
              </Text>
              <Checkbox
                label="Offer delivery"
                checked={d.enabled !== false}
                onChange={(v) => updateDelivery({ enabled: v })}
                helpText="Off hides the Shipping option in the basket and cart drawer completely."
              />
              <Divider />
              <Checkbox
                label={`Standard shipping — "${d.standard_label || ""}"`}
                checked={Boolean(d.standard_enabled)}
                onChange={(v) => updateDelivery({ standard_enabled: v })}
                disabled={d.enabled === false}
                helpText="The no-date choice. Customers can check out without picking a day."
              />
              <Checkbox
                label={`Dated delivery — "${d.scheduled_label || ""}"`}
                checked={Boolean(d.dated_enabled)}
                onChange={(v) => updateDelivery({ dated_enabled: v })}
                disabled={d.enabled === false}
                helpText="Reveals a calendar and writes the chosen date onto the order and the checkout rate name."
              />
              {errors["delivery.enabled"] && (
                <Banner tone="critical">
                  <Text as="p">{errors["delivery.enabled"]}</Text>
                </Banner>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Which dates the calendar offers
              </Text>
              <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                <TextField
                  label="Lead time (days)"
                  type="number"
                  min={0}
                  max={30}
                  value={String(d.lead_days ?? "")}
                  onChange={(v) => updateDelivery({ lead_days: v === "" ? "" : Number(v) })}
                  error={errors["delivery.lead_days"]}
                  disabled={d.enabled === false}
                  helpText="How many days you need to make the order and get it to the courier. Plain calendar days — a day the courier is shut does not make the baking take longer. If the date it lands on is not a delivery day, it moves to the next one that is."
                  autoComplete="off"
                />
                <TextField
                  label="Booking horizon (days)"
                  type="number"
                  min={1}
                  max={365}
                  value={String(d.horizon_days ?? "")}
                  onChange={(v) => updateDelivery({ horizon_days: v === "" ? "" : Number(v) })}
                  error={errors["delivery.horizon_days"]}
                  disabled={d.enabled === false}
                  helpText="The furthest ahead a customer can book. 60 lets someone order in September for late November; 14 keeps it to a fortnight."
                  autoComplete="off"
                />
              </InlineGrid>

              {earliest && (
                <Banner tone="success">
                  <BlockStack gap="200">
                    <Text as="p">
                      Right now, the earliest date a customer can choose is{" "}
                      <Text as="span" fontWeight="semibold">
                        {earliest.label}
                      </Text>
                      .
                    </Text>
                    {earliest.rolled && (
                      <Text as="p">
                        {d.lead_days} {Number(d.lead_days) === 1 ? "day" : "days"} from
                        now is {dateLabel(earliest.landed).label}, which is not a day
                        couriers deliver, so it moves to the next one that is.
                      </Text>
                    )}
                  </BlockStack>
                </Banner>
              )}

              <Divider />

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Days couriers deliver
                </Text>
                <Text as="p" tone="subdued">
                  An unticked day is greyed out in the calendar. It does{" "}
                  <Text as="span" fontWeight="semibold">not</Text> add to the lead time
                  above &mdash; that is your own preparation time and runs regardless.
                  When the lead lands on an unticked day, the date simply moves forward
                  to the next ticked one.
                </Text>
                <InlineStack gap="400" wrap>
                  {WEEKDAY_INDEX_LABELS.map((label, index) => (
                    <Checkbox
                      key={label}
                      label={label}
                      checked={!closed.has(index)}
                      onChange={(v) => toggleWeekday(index, v)}
                      disabled={d.enabled === false}
                    />
                  ))}
                </InlineStack>
                {errors["delivery.closed_weekdays"] && (
                  <Text as="p" tone="critical">
                    {errors["delivery.closed_weekdays"]}
                  </Text>
                )}
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Daily order cut-off
                </Text>
                <Text as="p" tone="subdued">
                  Use this if there is a time of day after which an order will not make
                  that day&rsquo;s courier collection.
                </Text>
                <Checkbox
                  label="Stop counting today after a set time"
                  checked={Boolean(d.cutoff_enabled)}
                  onChange={(v) => updateDelivery({ cutoff_enabled: v })}
                  disabled={d.enabled === false}
                />
                <TextField
                  label="Cut-off time"
                  type="time"
                  value={d.cutoff_time || ""}
                  onChange={(v) => updateDelivery({ cutoff_time: v })}
                  disabled={d.enabled === false || !d.cutoff_enabled}
                  error={errors["delivery.cutoff_time"]}
                  helpText="An order after this time starts its lead time tomorrow instead of today, so it is offered one day later. Leave it off if you can still get an evening order out the next morning."
                  autoComplete="off"
                />
              </BlockStack>
            </BlockStack>
          </Card>

          <SamedayCard
            sameday={d.sameday || {}}
            errors={errors}
            weeklyHours={weeklyHours}
            nowMinutes={nowMinutes}
            today={today}
            updateSameday={updateSameday}
            updateSamedayZone={updateSamedayZone}
          />

          <BookingCard
            booking={d.booking || {}}
            sameday={d.sameday || {}}
            errors={errors}
            updateBooking={updateBooking}
          />

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Blocked delivery dates
              </Text>
              <Text as="p" tone="subdued">
                Bank holidays and any other day you will not dispatch for. These dates are
                greyed out in the delivery calendar. Collection closures are on their own
                tab &mdash; the two lists are deliberately separate, because the shop can
                be open when couriers are not.
              </Text>
              {(d.blackout_dates || []).length === 0 && (
                <Text as="p" tone="subdued">
                  No blocked delivery dates yet.
                </Text>
              )}
              {(d.blackout_dates || []).map((b, i) => (
                <Box
                  key={i}
                  borderColor="border"
                  borderWidth="025"
                  borderRadius="200"
                  padding="300"
                >
                  <InlineGrid columns={{ xs: 1, md: 3 }} gap="300" alignItems="end">
                    <TextField
                      label="Date"
                      type="date"
                      value={b.date || ""}
                      onChange={(v) => updateDeliveryBlackout(i, { date: v })}
                      error={errors[`delivery.blackout_dates.${i}.date`]}
                      disabled={d.enabled === false}
                      autoComplete="off"
                    />
                    <TextField
                      label="Internal note"
                      value={b.note || ""}
                      onChange={(v) => updateDeliveryBlackout(i, { note: v })}
                      placeholder="e.g. Bank holiday, no courier collection"
                      disabled={d.enabled === false}
                      autoComplete="off"
                    />
                    <Button
                      tone="critical"
                      variant="tertiary"
                      onClick={() => removeDeliveryBlackout(i)}
                    >
                      Remove
                    </Button>
                  </InlineGrid>
                </Box>
              ))}
              <InlineStack>
                <Button onClick={addDeliveryBlackout} disabled={d.enabled === false}>
                  Add blocked date
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Wording in the basket
              </Text>
              <Text as="p" tone="subdued">
                The basket reads these straight from here, so changing the wording is a
                save on this page rather than a theme edit. Laid out for the customer
                like this:
              </Text>
              <Box borderColor="border" borderWidth="025" borderRadius="200" padding="300">
                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">
                    {d.standard_label || "—"}
                  </Text>
                  <Text as="p" tone="subdued">
                    {d.standard_note || "—"}
                  </Text>
                  <Divider />
                  <Text as="p" fontWeight="semibold">
                    {d.scheduled_label || "—"}
                  </Text>
                  <Text as="p" tone="subdued">
                    {d.scheduled_note || "—"}
                  </Text>
                  <Divider />
                  <Text as="p" tone="caution">
                    {d.caution || "—"}
                  </Text>
                </BlockStack>
              </Box>
              <Text as="p" tone="subdued">
                Headings are the tappable line. Descriptions are the small grey line under
                it. The caution appears only once a date has been chosen, directly above
                the checkout button &mdash; which is why it needs to stay to a sentence or
                two.
              </Text>
              <TextField
                label="Standard shipping heading"
                value={d.standard_label || ""}
                onChange={(v) => updateDelivery({ standard_label: v })}
                error={errors["delivery.standard_label"]}
                disabled={d.enabled === false}
                autoComplete="off"
              />
              <TextField
                label="Standard shipping description"
                value={d.standard_note || ""}
                onChange={(v) => updateDelivery({ standard_note: v })}
                disabled={d.enabled === false}
                multiline={2}
                autoComplete="off"
              />
              <TextField
                label="Dated delivery heading"
                value={d.scheduled_label || ""}
                onChange={(v) => updateDelivery({ scheduled_label: v })}
                error={errors["delivery.scheduled_label"]}
                disabled={d.enabled === false}
                autoComplete="off"
              />
              <TextField
                label="Dated delivery description"
                value={d.scheduled_note || ""}
                onChange={(v) => updateDelivery({ scheduled_note: v })}
                disabled={d.enabled === false}
                multiline={2}
                autoComplete="off"
              />
              <TextField
                label="Caution shown with a chosen date"
                value={d.caution || ""}
                onChange={(v) => updateDelivery({ caution: v })}
                error={errors["delivery.caution"]}
                disabled={d.enabled === false}
                multiline={3}
                helpText="Keep it to one or two sentences. On a phone this sits between the chosen date and the checkout button, and a paragraph there pushes the button off the screen."
                autoComplete="off"
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                What this tab does not control
              </Text>
              <List>
                <List.Item>
                  <Text as="span" fontWeight="semibold">
                    Shipping prices and zones.
                  </Text>{" "}
                  Those are Shopify&rsquo;s own, in Settings &rarr; Shipping and delivery.
                  Nothing here sets a price.
                </List.Item>
                <List.Item>
                  <Text as="span" fontWeight="semibold">
                    Which rate appears at checkout.
                  </Text>{" "}
                  The delivery-gate function hides the collection rate for shipping
                  baskets and the shipping rates for collection baskets, and renames the
                  one that survives to carry the chosen date. That lives in the
                  delivery-method-gate app and needs a deploy to change.
                </List.Item>
                <List.Item>
                  <Text as="span" fontWeight="semibold">
                    The collection address and map link.
                  </Text>{" "}
                  Theme settings, under the collection point fields.
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </BlockStack>
      </Layout.Section>
    </Layout>
  );
}


/* ----------------------------------------------------------------------------
   SAME-DAY COURIER
   --------------------------------------------------------------------------
   The third shipping choice, and the only one with a geography. Two things
   make this card different from the rest of the tab:

   1. THE POSTCODES ARE WRITTEN DOWN TWICE. Shopify's Local delivery settings
      are what actually gate the rate at checkout; this copy lets the basket
      answer "can you reach me?" before the customer gets there, with no
      network call. Shopify's API does not expose local delivery at all, so
      nothing can reconcile the two automatically — hence the banner.

   2. IT IS OFF BY DEFAULT and stays off until switched on here. Until then
      the basket shows two choices as it always has, and the delivery-gate
      function's same-day branch is unreachable.
   -------------------------------------------------------------------------- */

function SamedayCard({
  sameday,
  errors,
  weeklyHours,
  nowMinutes,
  today,
  updateSameday,
  updateSamedayZone,
}) {
  const s = sameday || {};
  const zones = s.zones || [];
  const on = s.enabled === true;

  /* WHAT IT WOULD OFFER RIGHT NOW, from the same function the basket uses.
     A list of rules is hard to read back; the windows they produce are not. */
  const todayKey = today ? WEEKDAY_KEYS[weekdayIndex(today)] : null;
  const openToday = todayKey && weeklyHours ? weeklyHours[todayKey] : null;
  const preview = useMemo(
    () => (on ? windowsFor(normalizeSameday(s), nowMinutes, openToday) : null),
    [on, s, nowMinutes, openToday]
  );

  const NO_WINDOWS = {
    closed_today: "the shop is closed today",
    past_cutoff: `it is past the ${s.cutoff_time} cut-off`,
    too_late_today: "there is not enough of the day left",
    misconfigured: "the times are not valid",
  };

  const totalCodes = zones.reduce((n, z) => n + (z.outwards || []).length, 0);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Same-day courier &mdash; London
          </Text>
          {on ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
        </InlineStack>

        <Checkbox
          label="Offer same-day delivery"
          checked={on}
          onChange={(v) => updateSameday({ enabled: v })}
          helpText="A third choice inside Shipping, beside next day and a chosen date. Off until you turn it on — nothing in the basket changes before then."
        />

        {on && (
          <>
            <Banner tone={preview?.windows?.length ? "success" : "warning"}>
              <Text as="p">
                {preview?.windows?.length
                  ? `Right now this would offer ${preview.windows.length} ${
                      preview.windows.length === 1 ? "window" : "windows"
                    }: ${preview.windows.map((w) => w.label).join(" · ")}`
                  : `Right now this would offer nothing, because ${
                      NO_WINDOWS[preview?.reason] || "no window fits"
                    }.`}
              </Text>
            </Banner>

            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <TextField
                label="Orders close at"
                type="time"
                value={s.cutoff_time || ""}
                onChange={(v) => updateSameday({ cutoff_time: v })}
                error={errors["sameday.cutoff_time"]}
                helpText="The last moment someone can order for delivery today."
                autoComplete="off"
              />
              <TextField
                label="Last delivery at"
                type="time"
                value={s.day_end || ""}
                onChange={(v) => updateSameday({ day_end: v })}
                error={errors["sameday.day_end"]}
                helpText="No window ends after this."
                autoComplete="off"
              />
              <TextField
                label="Time from order to first window (minutes)"
                type="number"
                value={String(s.lead_minutes ?? "")}
                onChange={(v) => updateSameday({ lead_minutes: v === "" ? "" : Number(v) })}
                error={errors["sameday.lead_minutes"]}
                helpText="Making the order plus the rider getting here. Gophr's own estimate on the six test journeys was 38 to 62 minutes, and preparation is 60."
                autoComplete="off"
              />
              <TextField
                label="Length of each window (minutes)"
                type="number"
                value={String(s.window_minutes ?? "")}
                onChange={(v) => updateSameday({ window_minutes: v === "" ? "" : Number(v) })}
                error={errors["sameday.window_minutes"]}
                helpText="Two hours reads well and is easy to keep. Shorter windows mean more of them."
                autoComplete="off"
              />
            </InlineGrid>

            <Checkbox
              label={`Also offer a catch-all: "${s.open_window_label || ""}"`}
              checked={s.open_window_enabled !== false}
              onChange={(v) => updateSameday({ open_window_enabled: v })}
              helpText="The widest promise, and therefore the easiest to keep. Customers who do not mind when it arrives will pick it."
            />

            <Divider />

            <Text as="h3" variant="headingSm">
              Wording in the basket
            </Text>
            <TextField
              label="Heading"
              value={s.label || ""}
              onChange={(v) => updateSameday({ label: v })}
              error={errors["sameday.label"]}
              autoComplete="off"
            />
            <TextField
              label="Description"
              value={s.note || ""}
              onChange={(v) => updateSameday({ note: v })}
              multiline={2}
              autoComplete="off"
            />
            <TextField
              label="Shown when the postcode is outside every zone"
              value={s.out_of_area || ""}
              onChange={(v) => updateSameday({ out_of_area: v })}
              error={errors["sameday.out_of_area"]}
              multiline={2}
              helpText="This is the message most same-day visitors will see, so it should point somewhere useful rather than just saying no."
              autoComplete="off"
            />

            <Divider />

            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">
                Zones
              </Text>
              <Badge>{`${totalCodes} postcode ${totalCodes === 1 ? "area" : "areas"}`}</Badge>
            </InlineStack>

            <Banner tone="warning" title="These postcodes are written down twice">
              <BlockStack gap="200">
                <Text as="p">
                  Shopify&rsquo;s <Text as="span" fontWeight="semibold">Local delivery</Text>{" "}
                  settings are what actually decide whether a customer is offered
                  same-day at checkout. The list here is what the basket checks
                  against, so it can answer before they get that far.
                </Text>
                <Text as="p">
                  <Text as="span" fontWeight="semibold">Shopify&rsquo;s API cannot read local
                  delivery</Text>, so nothing can keep the two in step
                  automatically. Change one, change the other.
                </Text>
              </BlockStack>
            </Banner>

            {errors["sameday.zones"] && (
              <Banner tone="critical">
                <Text as="p">{errors["sameday.zones"]}</Text>
              </Banner>
            )}

            {zones.map((z, i) => (
              <Box
                key={i}
                background="bg-surface-secondary"
                padding="400"
                borderRadius="200"
              >
                <BlockStack gap="300">
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                    <TextField
                      label="Zone name"
                      value={z.name || ""}
                      onChange={(v) => updateSamedayZone(i, { name: v })}
                      error={errors[`sameday.zones.${i}.name`]}
                      helpText="Internal only. The customer never sees it."
                      autoComplete="off"
                    />
                    <TextField
                      label="Price"
                      prefix="£"
                      value={String(z.price ?? "")}
                      onChange={(v) => updateSamedayZone(i, { price: v })}
                      error={errors[`sameday.zones.${i}.price`]}
                      helpText="Must match the price on the matching Shopify local delivery zone."
                      autoComplete="off"
                    />
                  </InlineGrid>
                  <TextField
                    label="Postcodes"
                    value={(z.outwards || []).join(", ")}
                    onChange={(v) => updateSamedayZone(i, { outwards: v })}
                    error={errors[`sameday.zones.${i}.outwards`]}
                    multiline={3}
                    helpText={`${(z.outwards || []).length} codes. Complete outward codes only — W1T, not W1 or W1*. An asterisk looks tidy and quietly catches W10 to W14 as well.`}
                    autoComplete="off"
                  />
                </BlockStack>
              </Box>
            ))}
          </>
        )}
      </BlockStack>
    </Card>
  );
}

/* ============================================================================
   COLLECTION
   ========================================================================== */

function ScheduleTab({ settings, errors, update, updateDay }) {
  const off = settings.pickup_enabled === false;
  return (
    <Layout>
      <Layout.Section>
        <BlockStack gap="400">
          <TabIntro>
            These rules drive the <Text as="span" fontWeight="semibold">Store pickup</Text>{" "}
            tile in the basket and the cart drawer &mdash; which days its calendar offers
            and which times appear once a day is chosen. One-off closures and busy-day
            limits have their own tabs.
          </TabIntro>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Click and collect
              </Text>
              <Checkbox
                label="Offer collection"
                checked={!off}
                onChange={(v) => update({ pickup_enabled: v })}
                helpText="Off hides the Collect option in the basket and cart drawer completely. Everything below keeps its value and takes effect again when you switch it back on."
              />
              {errors.pickup_enabled && (
                <Banner tone="critical">
                  <Text as="p">{errors.pickup_enabled}</Text>
                </Banner>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">General</Text>
              <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                <TextField
                  label="Store timezone"
                  value={settings.timezone}
                  onChange={(v) => update({ timezone: v })}
                  helpText="IANA timezone name. Leave as Europe/London for UK stores — British Summer Time is handled automatically."
                  autoComplete="off"
                />
                <TextField
                  label="Booking horizon (days)"
                  type="number"
                  min={1}
                  max={90}
                  value={String(settings.booking_horizon_days ?? "")}
                  onChange={(v) => update({ booking_horizon_days: v === "" ? "" : Number(v) })}
                  error={errors.booking_horizon_days}
                  disabled={off}
                  helpText="The furthest ahead a customer can book a collection. 14 keeps it to a fortnight."
                  autoComplete="off"
                />
              </InlineGrid>
              <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                <Select
                  label="Slot interval"
                  options={INTERVAL_OPTIONS}
                  value={String(settings.slot_interval_minutes)}
                  onChange={(v) => update({ slot_interval_minutes: Number(v) })}
                  error={errors.slot_interval_minutes}
                  disabled={off}
                  helpText={`How long each collection window is. 10:00 to 21:00 at ${
                    settings.slot_interval_minutes || 30
                  }-minute slots gives the customer ${Math.max(
                    0,
                    Math.floor(660 / (Number(settings.slot_interval_minutes) || 30))
                  )} times to choose from.`}
                />
                <TextField
                  label="Collection location name"
                  value={settings.collection_location_name || ""}
                  onChange={(v) => update({ collection_location_name: v })}
                  error={errors.collection_location_name}
                  disabled={off}
                  helpText="Written onto every collection order as ibc_pickup_location. Your existing orders say “Italian Bear Chocolate” — changing this changes it for future orders only."
                  autoComplete="off"
                />
              </InlineGrid>
              <TextField
                label="Collection instructions"
                value={settings.collection_instructions || ""}
                onChange={(v) => update({ collection_instructions: v })}
                multiline={2}
                disabled={off}
                helpText="Shown to customers beneath their selected collection time."
                autoComplete="off"
              />
              <TextField
                label="Checkout reminder shown to customers"
                value={settings.customer_checkout_message || ""}
                onChange={(v) => update({ customer_checkout_message: v })}
                multiline={3}
                disabled={off}
                error={errors.customer_checkout_message}
                helpText="Kept from the previous widget. The current basket does not display it — the delivery-gate function now leaves only the collection rate at checkout, so there is nothing for the customer to get wrong."
                autoComplete="off"
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Weekly collection hours</Text>
              <Text as="p" tone="subdued">
                The times the shop will hand orders over. The last slot offered is the
                last one that <Text as="span" fontWeight="semibold">ends</Text> by the
                closing time, so 10:00 to 21:00 in half-hours finishes at 20:30&ndash;21:00
                rather than starting one at 21:00. Untick a day to leave it out of the
                calendar entirely.
              </Text>
              {errors.weekly_hours && (
                <Banner tone="critical"><Text as="p">{errors.weekly_hours}</Text></Banner>
              )}
              <BlockStack gap="300">
                {WEEKDAY_KEYS.map((day) => {
                  const d = settings.weekly_hours[day];
                  return (
                    <Box key={day} paddingBlockEnd="200">
                      <InlineGrid columns={{ xs: 1, md: 3 }} gap="300" alignItems="start">
                        <Box paddingBlockStart="500">
                          <Checkbox
                            label={DAY_LABELS[day]}
                            checked={Boolean(d.enabled)}
                            onChange={(v) => updateDay(day, { enabled: v })}
                            disabled={off}
                          />
                        </Box>
                        <TextField
                          label="Collection starts from"
                          type="time"
                          value={d.start_time || ""}
                          onChange={(v) => updateDay(day, { start_time: v })}
                          disabled={off || !d.enabled}
                          error={errors[`weekly_hours.${day}.start_time`]}
                          autoComplete="off"
                        />
                        <TextField
                          label="Final collection slot ends at"
                          type="time"
                          value={d.end_time || ""}
                          onChange={(v) => updateDay(day, { end_time: v })}
                          disabled={off || !d.enabled}
                          error={errors[`weekly_hours.${day}.end_time`]}
                          autoComplete="off"
                        />
                      </InlineGrid>
                      <Divider />
                    </Box>
                  );
                })}
              </BlockStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Same-day collection</Text>
              <Checkbox
                label="Allow same-day collection"
                checked={Boolean(settings.same_day_pickup_enabled)}
                onChange={(v) => update({ same_day_pickup_enabled: v })}
                disabled={off}
              />
              <TextField
                label="Same-day collection cut-off time"
                type="time"
                value={settings.same_day_pickup_cutoff_time || ""}
                onChange={(v) => update({ same_day_pickup_cutoff_time: v })}
                disabled={off || !settings.same_day_pickup_enabled}
                error={errors.same_day_pickup_cutoff_time}
                helpText="After this time, today stops being offered at all. Separate from preparation time below, which removes individual slots that are too soon; this removes the whole day."
                autoComplete="off"
              />
              <Banner tone="info" title="Preparation time">
                <BlockStack gap="200">
                  <Text as="p">
                    Every basket needs at least {DEFAULT_PREP_MINUTES} minutes before it can
                    be collected, and individual products can need longer &mdash; your whole
                    cakes are set to 180. The longest single delay in the basket wins; they
                    are never added together.
                  </Text>
                  <Text as="p">
                    The basket applies this to the minute, so a three-hour basket at 7pm
                    sees no slots left today and the day greys out. Set it per product on
                    the Product Preparation Rules tab. The {DEFAULT_PREP_MINUTES}-minute
                    floor itself is fixed and not editable here.
                  </Text>
                </BlockStack>
              </Banner>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Minimum pickup order value</Text>
              <Checkbox
                label="Require a minimum basket value for collection"
                checked={Boolean(settings.minimum_pickup_order_value_enabled)}
                onChange={(v) => update({ minimum_pickup_order_value_enabled: v })}
                disabled={off}
              />
              <TextField
                label="Minimum basket value"
                type="number"
                prefix="£"
                min={0}
                step={0.5}
                value={settings.minimum_pickup_order_value == null ? "" : String(settings.minimum_pickup_order_value)}
                onChange={(v) => update({ minimum_pickup_order_value: v === "" ? null : Number(v) })}
                disabled={off || !settings.minimum_pickup_order_value_enabled}
                error={errors.minimum_pickup_order_value}
                helpText='Customers below this value see: "Collection is available for orders over £15.00."'
                autoComplete="off"
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Pickup order limits</Text>
              <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                <TextField
                  label="Maximum collections per day"
                  type="number"
                  min={1}
                  value={settings.maximum_pickup_orders_per_day == null ? "" : String(settings.maximum_pickup_orders_per_day)}
                  onChange={(v) => update({ maximum_pickup_orders_per_day: v === "" ? null : Number(v) })}
                  error={errors.maximum_pickup_orders_per_day}
                  disabled={off}
                  helpText="Leave blank for no limit."
                  autoComplete="off"
                />
                <TextField
                  label="Maximum collections per slot"
                  type="number"
                  min={1}
                  value={settings.maximum_pickup_orders_per_slot == null ? "" : String(settings.maximum_pickup_orders_per_slot)}
                  onChange={(v) => update({ maximum_pickup_orders_per_slot: v === "" ? null : Number(v) })}
                  error={errors.maximum_pickup_orders_per_slot}
                  disabled={off}
                  helpText="Leave blank for no limit."
                  autoComplete="off"
                />
              </InlineGrid>
              <Banner tone="warning">
                <Text as="p">
                  These two limits are <Text as="span" fontWeight="semibold">carried but not
                  yet enforced</Text> by the basket. Counting orders already placed needs a
                  server call the basket does not make. Until then, treat them as a stated
                  intention rather than a guard.
                </Text>
              </Banner>
            </BlockStack>
          </Card>
        </BlockStack>
      </Layout.Section>
    </Layout>
  );
}

function BlackoutsTab({ settings, errors, updateListItem, addListItem, removeListItem }) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">Collection closures</Text>
        <Text as="p" tone="subdued">
          One-off days and part-days the shop will not hand orders over, on top of the
          weekly hours. Use the weekly hours for &ldquo;we are never open on
          Sundays&rdquo; and this for &ldquo;we are shut on the 25th&rdquo;.
        </Text>
        <List>
          <List.Item>
            <Text as="span" fontWeight="semibold">Closed all day</Text> ticked &mdash; the
            date does not appear in the collection calendar at all.
          </List.Item>
          <List.Item>
            <Text as="span" fontWeight="semibold">Closed all day</Text> unticked &mdash;
            only the slots overlapping the times you give are hidden. For &ldquo;nothing
            after 2pm&rdquo;, enter 14:00 to 23:59.
          </List.Item>
          <List.Item>
            Couriers are separate. A bank holiday you cannot dispatch on goes in{" "}
            <Text as="span" fontWeight="semibold">Blocked delivery dates</Text> on the
            Delivery tab &mdash; being shut and the courier being shut are different
            facts, and a closure here does not stop a delivery going out.
          </List.Item>
        </List>
        {settings.blackout_dates.length === 0 && (
          <Text as="p" tone="subdued">No collection closures yet.</Text>
        )}
        {settings.blackout_dates.map((b, i) => (
          <Box key={i} borderColor="border" borderWidth="025" borderRadius="200" padding="300">
            <BlockStack gap="300">
              <InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
                <TextField
                  label="Date"
                  type="date"
                  value={b.date || ""}
                  onChange={(v) => updateListItem("blackout_dates", i, { date: v })}
                  error={errors[`blackout_dates.${i}.date`]}
                  autoComplete="off"
                />
                <Box paddingBlockStart="500">
                  <Checkbox
                    label="Closed all day"
                    checked={Boolean(b.all_day)}
                    onChange={(v) => updateListItem("blackout_dates", i, { all_day: v })}
                  />
                </Box>
                <TextField
                  label="Closed from"
                  type="time"
                  value={b.start_time || ""}
                  onChange={(v) => updateListItem("blackout_dates", i, { start_time: v })}
                  disabled={Boolean(b.all_day)}
                  error={errors[`blackout_dates.${i}.start_time`]}
                  autoComplete="off"
                />
                <TextField
                  label="Closed until"
                  type="time"
                  value={b.end_time || ""}
                  onChange={(v) => updateListItem("blackout_dates", i, { end_time: v })}
                  disabled={Boolean(b.all_day)}
                  error={errors[`blackout_dates.${i}.end_time`]}
                  helpText="Use 23:59 to close for the rest of the day."
                  autoComplete="off"
                />
              </InlineGrid>
              <InlineStack gap="300" blockAlign="end" wrap={false}>
                <Box width="100%">
                  <TextField
                    label="Internal note"
                    value={b.note || ""}
                    onChange={(v) => updateListItem("blackout_dates", i, { note: v })}
                    placeholder="e.g. Christmas Day, Private event, Kitchen maintenance"
                    autoComplete="off"
                  />
                </Box>
                <Button tone="critical" variant="tertiary" onClick={() => removeListItem("blackout_dates", i)}>
                  Remove
                </Button>
              </InlineStack>
            </BlockStack>
          </Box>
        ))}
        <InlineStack>
          <Button onClick={() => addListItem("blackout_dates", emptyBlackout)}>
            Add collection closure
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function CapacityTab({ settings, errors, updateListItem, addListItem, removeListItem }) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">Collection capacity overrides</Text>
        <Text as="p" tone="subdued">
          A different limit for one date, or for one date and one time slot. Leave the
          slot time blank to cap the whole day. An override replaces the general limits
          from the Collection tab for that date or slot rather than adding to them, and a
          slot override beats a whole-day one.
        </Text>
        <List>
          <List.Item>
            Valentine&rsquo;s Day, only 10 collections: date = 14 February, slot blank,
            maximum = 10.
          </List.Item>
          <List.Item>
            A wedding blocking one hour: two rows, one per slot, maximum = 0. Or use a
            partial closure on the Collection Closures tab, which is less typing.
          </List.Item>
        </List>
        {settings.capacity_overrides.length === 0 && (
          <Text as="p" tone="subdued">No capacity overrides yet.</Text>
        )}
        {settings.capacity_overrides.map((o, i) => (
          <Box key={i} borderColor="border" borderWidth="025" borderRadius="200" padding="300">
            <InlineGrid columns={{ xs: 1, md: 5 }} gap="300" alignItems="end">
              <TextField
                label="Date"
                type="date"
                value={o.date || ""}
                onChange={(v) => updateListItem("capacity_overrides", i, { date: v })}
                error={errors[`capacity_overrides.${i}.date`]}
                autoComplete="off"
              />
              <TextField
                label="Slot start (optional)"
                type="time"
                value={o.slot_start || ""}
                onChange={(v) => updateListItem("capacity_overrides", i, { slot_start: v || "" })}
                error={errors[`capacity_overrides.${i}.slot_start`]}
                helpText="Blank = whole day"
                autoComplete="off"
              />
              <TextField
                label="Maximum collections"
                type="number"
                min={0}
                value={o.max_orders === "" || o.max_orders == null ? "" : String(o.max_orders)}
                onChange={(v) => updateListItem("capacity_overrides", i, { max_orders: v === "" ? "" : Number(v) })}
                error={errors[`capacity_overrides.${i}.max_orders`]}
                autoComplete="off"
              />
              <TextField
                label="Note"
                value={o.note || ""}
                onChange={(v) => updateListItem("capacity_overrides", i, { note: v })}
                placeholder="e.g. Market day"
                autoComplete="off"
              />
              <Button tone="critical" variant="tertiary" onClick={() => removeListItem("capacity_overrides", i)}>
                Remove
              </Button>
            </InlineGrid>
          </Box>
        ))}
        <InlineStack>
          <Button onClick={() => addListItem("capacity_overrides", emptyOverride)}>
            Add capacity override
          </Button>
        </InlineStack>
        <Banner tone="warning" title="Not yet enforced in the basket">
          <Text as="p">
            A zero here will not currently stop a customer booking that slot. The basket
            reads the schedule, the closures and the horizon, but counting orders already
            placed needs a server call it does not make. Keep the overrides — they are
            ready for when it does — but do not rely on them to protect a busy day.
          </Text>
        </Banner>
      </BlockStack>
    </Card>
  );
}

function ProductsTab({ products, truncated }) {
  /* EVERY PRODUCT CARRYING ANY OF THE THREE RULES, de-duplicated. pickup_only
     was missing from this list until now, which made a rule set on the wrong
     product invisible from the admin — the only way to find out was a customer
     losing the Shipping tile. */
  const flagged = [
    ...new Map(
      products
        .filter(
          (p) =>
            p.delayMinutes != null || p.pickupAvailable === false || p.pickupOnly === true
        )
        .map((p) => [p.id, p])
    ).values(),
  ];
  const rows = flagged.map((p) => [
    <Link
      key={p.id}
      url={`shopify:admin/products/${p.numericId}`}
      target="_blank"
      removeUnderline
    >
      {p.title}
    </Link>,
    p.delayMinutes != null ? `${p.delayMinutes} minutes` : `Default (${DEFAULT_PREP_MINUTES} minutes)`,
    p.pickupAvailable === false ? (
      <Badge tone="critical" key="u">Shipping only</Badge>
    ) : p.pickupOnly ? (
      <Badge tone="attention" key="o">Collection only</Badge>
    ) : (
      <Badge tone="success" key="a">Either</Badge>
    ),
  ]);

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">Product preparation rules</Text>
          <Text as="p">
            These three live on each product rather than here, so Shopify stays the source
            of truth and a new product inherits nothing it should not.{" "}
            <Text as="span" fontWeight="semibold">To change one:</Text> Products &rarr;
            open the product &rarr; scroll to Metafields &rarr; edit &rarr; Save. The
            basket picks it up on the next page load.
          </Text>
          <DescriptionList
            items={[
              {
                term: "Pickup delay (minutes)",
                description: (
                  <Text as="span">
                    How long this product needs before it can be collected. Blank means the
                    default {DEFAULT_PREP_MINUTES} minutes. In a mixed basket the single
                    longest delay applies &mdash; three whole cakes take three hours, not
                    nine. Field name: custom.pickup_delay_minutes.
                  </Text>
                ),
              },
              {
                term: "Available for pickup",
                description: (
                  <Text as="span">
                    Set to <Text as="span" fontWeight="semibold">false</Text> for something
                    you will not hand over in the shop. One such product in the basket
                    removes the Store pickup tile entirely, for the whole basket. Blank or
                    true means available. Field name: custom.pickup_available.
                  </Text>
                ),
              },
              {
                term: "Pickup only",
                description: (
                  <Text as="span">
                    Set to <Text as="span" fontWeight="semibold">true</Text> for something
                    that must not be posted. One such product removes the Shipping tile for
                    the whole basket. Blank or false means either is fine. Anything set
                    this way is listed below as{" "}
                    <Text as="span" fontWeight="semibold">Collection only</Text>. Field
                    name: custom.pickup_only.
                  </Text>
                ),
              },
            ]}
          />
          <Banner tone="info">
            <Text as="p">
              If one product says pickup-only and another in the same basket says
              not-available-for-pickup, the basket has been asked for two impossible things
              at once. Rather than leave the customer unable to check out, both tiles are
              shown. Worth avoiding by not marking a product both ways.
            </Text>
          </Banner>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">Products with custom pickup rules</Text>
          <Text as="p" tone="subdued">
            Read-only, and a way to spot a rule set on the wrong product. Click a name to
            open it.
          </Text>
          {rows.length === 0 ? (
            <Text as="p" tone="subdued">
              No products have custom pickup rules yet. All products use the default{" "}
              {DEFAULT_PREP_MINUTES}-minute preparation time and are available for pickup.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text"]}
              headings={["Product", "Preparation time", "How it can be fulfilled"]}
              rows={rows}
            />
          )}
          {truncated && (
            <Text as="p" tone="subdued">
              Showing the first 300 products. Products beyond this still follow their own
              metafields in the cart — this list is informational only.
            </Text>
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

/* ============================================================================
   HOW THIS WORKS

   Written as recipes and symptoms rather than as a description of the fields,
   because the fields already describe themselves on their own tabs. What is
   hard to find out from a settings screen is "which of these six tabs do I
   open to do the thing I came here to do", and "why is the basket not showing
   what I just saved".
   ========================================================================== */

function HelpTab({ summary, deliverySummary }) {
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Right now
          </Text>
          <Text as="p">{deliverySummary}</Text>
          <Text as="p">{summary}</Text>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            If you want to&hellip;
          </Text>
          <DescriptionList
            items={[
              {
                term: "Close the shop for Christmas",
                description:
                  "Collection Closures → Add collection closure → the date, Closed all day ticked. Then Delivery → Add blocked date for each day the courier is not running. Both lists, because they are two different facts.",
              },
              {
                term: "Stop taking collections on Sundays",
                description:
                  "Collection → Weekly collection hours → untick Sunday. Not a closure — closures are for single dates.",
              },
              {
                term: "Shut at 6pm on Saturdays instead of 9pm",
                description:
                  "Collection → Weekly collection hours → Saturday → set the final slot to end at 18:00.",
              },
              {
                term: "Stop offering chosen delivery dates for a busy fortnight",
                description:
                  "Delivery → untick Dated delivery. Standard shipping carries on, and nobody is offered a date you cannot keep. Tick it back on afterwards — nothing is lost.",
              },
              {
                term: "Need longer to prepare something for collection",
                description:
                  "Products → the product → Metafields → Pickup delay (minutes). There is no shop-wide version of this: the 60-minute floor every basket gets is fixed, so anything needing longer is set per product. For shipping, the equivalent is the Delivery lead time.",
              },
              {
                term: "Stop a product being posted",
                description:
                  "Products → the product → Metafields → Pickup only → true. The Shipping tile then disappears for any basket containing it.",
              },
              {
                term: "Change the wording in the basket",
                description:
                  "Delivery → Wording in the basket. All five strings, with a preview of how they stack up for the customer.",
              },
              {
                term: "Turn one method off completely",
                description:
                  "Delivery → Offer delivery, or Collection → Offer collection. The basket then shows a single full-width tile. Both off is refused.",
              },
              {
                term: "Change a postage price",
                description:
                  "Not here. Shopify admin → Settings → Shipping and delivery. Nothing on these tabs sets a price.",
              },
            ]}
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            When something looks wrong
          </Text>
          <DescriptionList
            items={[
              {
                term: "I saved, and the basket has not changed",
                description:
                  "Reload the basket page first — the theme reads these settings when the page renders. If it is still wrong, open the cart drawer, right-click the delivery/collection area, Inspect, find the element whose class starts ibc-fulfil and read data-rules-source. “metafield” means this page is driving the basket. “builtin” means the theme cannot read these settings and is using safe defaults instead — nothing you change here will have any effect until that is fixed.",
              },
              {
                term: "A day I expected is greyed out in the collection calendar",
                description:
                  "Four things grey out a day: it is outside the booking horizon; it is a closure on the Collection Closures tab; that weekday is unticked in the weekly hours; or every slot on it has already gone past, once the basket's preparation time is added. The last one is the surprising one and it only affects today and occasionally tomorrow.",
              },
              {
                term: "A delivery date I expected is greyed out",
                description:
                  "The lead time has not been met, that weekday is unticked, the date is a blocked delivery date, or it is past the horizon. The green line on the Delivery tab tells you the earliest date the current rules allow — check that first.",
              },
              {
                term: "The customer only sees one tile",
                description:
                  "Something in their basket is marked Pickup only, or marked not available for pickup, or you have switched a method off. The Product Preparation Rules tab lists every product carrying a rule.",
              },
              {
                term: "The checkout button will not light up",
                description:
                  "It stays dead until the choice is complete: a shipping speed, or a collection date AND time. It also goes dead if a product added later contradicts the choice already made — that is deliberate, and the customer is being asked to choose again rather than being bounced out of checkout.",
              },
              {
                term: "Collection is offered but there are no times on any day",
                description:
                  "Either no weekday is enabled — the banner at the top of this page says so outright — or the hours are the wrong way round on every day, with the closing time at or before the opening one.",
              },
            ]}
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            What this app does not control
          </Text>
          <DescriptionList
            items={[
              {
                term: "Postage prices and zones",
                description:
                  "Shopify admin → Settings → Shipping and delivery. A £0 rate named exactly “Store pickup” has to exist there for collection to work — the checkout function matches that name character for character, so renaming the rate breaks collection until the app is redeployed.",
              },
              {
                term: "Which rate the customer sees at checkout",
                description:
                  "The delivery-gate function in the delivery-method-gate app. It hides the rates that do not match the basket's choice and renames the survivor to carry the chosen date — “Delivery — Est. Sat 20th Sept”, or “Store pickup — Sunday 20 September, 6:00–6:30pm”. Changing that needs a deploy, not a save.",
              },
              {
                term: "The collection address and the map link",
                description:
                  "Theme editor → Theme settings → the collection point fields. The basket derives its one-line version from the address there, so there is one address and not two.",
              },
              {
                term: "Whether checkout can be blocked outright",
                description:
                  "The delivery-validation function, switched with a GraphQL mutation. It refuses checkout when no choice has been made at all — the backstop behind the greyed-out button.",
              },
            ]}
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Before you make a big change
          </Text>
          <Text as="p">
            Every setting on these tabs is stored in one place: the shop metafield{" "}
            <Text as="span" fontWeight="semibold">
              custom.pickup_scheduler_settings
            </Text>
            . There is no version history and no undo, so if you are about to rework the
            hours or clear a list, copy the current value out first. One query in the
            Shopify GraphiQL app:
          </Text>
          {/* A plain <pre> rather than Polaris Text: Text's `as` does not
              accept "pre", and a query the merchant has to copy exactly must
              keep its line breaks and its spacing. */}
          <Box background="bg-surface-secondary" borderRadius="200" padding="300">
            <pre
              style={{
                margin: 0,
                overflowX: "auto",
                fontSize: "0.8125rem",
                lineHeight: 1.5,
              }}
            >
              {'query {\n  shop {\n    metafield(namespace: "custom", key: "pickup_scheduler_settings") { value }\n  }\n}'}
            </pre>
          </Box>
          <Text as="p" tone="subdued">
            Paste the result somewhere safe. That string is the whole configuration, and
            it is everything needed to put it back.
          </Text>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            What is honestly not finished
          </Text>
          <List>
            <List.Item>
              <Text as="span" fontWeight="semibold">
                The two collection limits are not enforced.
              </Text>{" "}
              Maximum collections per day and per slot, and everything on the Collection
              Capacity tab, are stored and carried but do not yet stop a booking. Counting
              orders already placed needs a server call the basket does not make. Treat
              them as a stated intention.
            </List.Item>
            <List.Item>
              <Text as="span" fontWeight="semibold">
                Minimum pickup order value is not applied
              </Text>{" "}
              by the basket either.
            </List.Item>
            <List.Item>
              <Text as="span" fontWeight="semibold">
                Collection instructions are not displayed
              </Text>{" "}
              anywhere yet, and the checkout reminder is a leftover from the previous
              widget — the basket no longer needs it, because the checkout function
              leaves only the matching rate.
            </List.Item>
            <List.Item>
              <Text as="span" fontWeight="semibold">
                The timezone field is not used
              </Text>{" "}
              for the cut-offs. Both cut-offs and the preparation floor are judged against
              the customer&rsquo;s own clock, which is right for almost everyone and
              slightly wrong for a customer browsing from abroad.
            </List.Item>
          </List>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
