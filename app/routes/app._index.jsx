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

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const [{ settings, shopId, exists }, { products, truncated }] = await Promise.all([
    loadSettings(admin),
    loadProductRules(admin),
  ]);
  return {
    settings,
    shopId,
    settingsExist: exists,
    products,
    productsTruncated: truncated,
    summary: summarizeSettings(settings),
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
  return Response.json({ ok: true, summary: summarizeSettings(settings) });
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

const emptyBlackout = { date: "", all_day: true, start_time: "", end_time: "", note: "" };
const emptyOverride = { date: "", slot_start: "", max_orders: "", note: "" };

export default function PickupSettingsPage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [settings, setSettings] = useState(data.settings);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState(0);
  const [summary, setSummary] = useState(data.summary);

  const errors = fetcher.data?.ok === false ? fetcher.data.errors || {} : {};
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setDirty(false);
      setSummary(fetcher.data.summary);
      shopify.toast.show("Pickup settings saved");
    }
    if (fetcher.state === "idle" && fetcher.data?.ok === false) {
      shopify.toast.show("Please fix the highlighted fields", { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const update = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
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

  const save = useCallback(() => {
    fetcher.submit({ settings }, { method: "post", encType: "application/json" });
  }, [fetcher, settings]);

  const tabs = useMemo(
    () => [
      { id: "schedule", content: "Pickup Schedule" },
      { id: "blackouts", content: "Blackout Dates" },
      { id: "capacity", content: "Capacity Overrides" },
      { id: "products", content: "Product Preparation Rules" },
      { id: "help", content: "Help & Scheduler Health" },
    ],
    []
  );

  return (
    <Page
      title="Pickup Scheduler Settings"
      subtitle="Rules for the click-and-collect scheduler shown in your cart"
      primaryAction={{
        content: "Save settings",
        onAction: save,
        loading: saving,
        disabled: !dirty && fetcher.data?.ok !== false,
      }}
    >
      <BlockStack gap="400">
        <Banner tone={summary.startsWith("Collection is currently unavailable") ? "warning" : "info"}>
          <Text as="p">{summary}</Text>
        </Banner>

        {Object.keys(errors).length > 0 && (
          <Banner tone="critical" title="Some settings need attention">
            <Text as="p">Fix the highlighted fields below, then save again.</Text>
          </Banner>
        )}

        <Tabs tabs={tabs} selected={tab} onSelect={setTab} />

        {tab === 0 && (
          <ScheduleTab settings={settings} errors={errors} update={update} updateDay={updateDay} />
        )}
        {tab === 1 && (
          <BlackoutsTab
            settings={settings}
            errors={errors}
            updateListItem={updateListItem}
            addListItem={addListItem}
            removeListItem={removeListItem}
          />
        )}
        {tab === 2 && (
          <CapacityTab
            settings={settings}
            errors={errors}
            updateListItem={updateListItem}
            addListItem={addListItem}
            removeListItem={removeListItem}
          />
        )}
        {tab === 3 && (
          <ProductsTab products={data.products} truncated={data.productsTruncated} />
        )}
        {tab === 4 && <HelpTab summary={summary} />}

        <InlineStack align="end">
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty && fetcher.data?.ok !== false}>
            Save settings
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}

function ScheduleTab({ settings, errors, update, updateDay }) {
  return (
    <Layout>
      <Layout.Section>
        <BlockStack gap="400">
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
                  helpText="How many days ahead customers can choose a collection date."
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
                />
                <TextField
                  label="Collection location name"
                  value={settings.collection_location_name || ""}
                  onChange={(v) => update({ collection_location_name: v })}
                  error={errors.collection_location_name}
                  autoComplete="off"
                />
              </InlineGrid>
              <TextField
                label="Collection instructions"
                value={settings.collection_instructions || ""}
                onChange={(v) => update({ collection_instructions: v })}
                multiline={2}
                helpText="Shown to customers beneath their selected collection time."
                autoComplete="off"
              />
              <TextField
                label="Checkout reminder shown to customers"
                value={settings.customer_checkout_message || ""}
                onChange={(v) => update({ customer_checkout_message: v })}
                multiline={3}
                error={errors.customer_checkout_message}
                helpText="Reminds customers to select Pick up in Shopify checkout. The cart scheduler never replaces Shopify's own fulfilment choice."
                autoComplete="off"
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Weekly collection hours</Text>
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
                          />
                        </Box>
                        <TextField
                          label="Collection starts from"
                          type="time"
                          value={d.start_time || ""}
                          onChange={(v) => updateDay(day, { start_time: v })}
                          disabled={!d.enabled}
                          error={errors[`weekly_hours.${day}.start_time`]}
                          autoComplete="off"
                        />
                        <TextField
                          label="Final collection slot ends at"
                          type="time"
                          value={d.end_time || ""}
                          onChange={(v) => updateDay(day, { end_time: v })}
                          disabled={!d.enabled}
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
              />
              <TextField
                label="Same-day collection cut-off time"
                type="time"
                value={settings.same_day_pickup_cutoff_time || ""}
                onChange={(v) => update({ same_day_pickup_cutoff_time: v })}
                disabled={!settings.same_day_pickup_enabled}
                error={errors.same_day_pickup_cutoff_time}
                helpText="After this time, customers cannot book collection for the current day, even if later time slots appear to be within opening hours."
                autoComplete="off"
              />
              <Banner tone="info">
                <Text as="p">
                  Every order needs at least {DEFAULT_PREP_MINUTES} minutes of preparation time.
                  Products can require longer via their &ldquo;Pickup delay (minutes)&rdquo;
                  metafield — the longest delay in the basket wins. The 60-minute default is
                  fixed in this version.
                </Text>
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
              />
              <TextField
                label="Minimum basket value"
                type="number"
                prefix="£"
                min={0}
                step={0.5}
                value={settings.minimum_pickup_order_value == null ? "" : String(settings.minimum_pickup_order_value)}
                onChange={(v) => update({ minimum_pickup_order_value: v === "" ? null : Number(v) })}
                disabled={!settings.minimum_pickup_order_value_enabled}
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
                  helpText="Leave blank for no limit."
                  autoComplete="off"
                />
              </InlineGrid>
              <Text as="p" tone="subdued">
                Limits are counted from existing Shopify pickup orders and their stored
                collection attributes. Use the Capacity Overrides tab for one-off dates.
              </Text>
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
        <Text as="h2" variant="headingMd">Blackout dates and partial closures</Text>
        <Text as="p" tone="subdued">
          Fully closed dates never appear in the cart scheduler. Partial closures hide
          only the affected time slots (for example, collection unavailable after 2:00pm).
        </Text>
        {settings.blackout_dates.length === 0 && (
          <Text as="p" tone="subdued">No blackout dates yet.</Text>
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
            Add blackout date
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
        <Text as="h2" variant="headingMd">Capacity overrides</Text>
        <Text as="p" tone="subdued">
          Set a different collection limit for one specific date, or for one date and
          time slot. Leave the slot time blank to limit the whole day. Overrides replace
          the general limits for that date or slot.
        </Text>
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
        <Banner tone="warning" title="About strict limits">
          <Text as="p">
            Limits are calculated from pickup orders already placed in Shopify. Two
            customers checking out in the same moment could both take the final slot,
            because fully race-safe locking would need temporary slot reservations —
            outside the scope of this settings-only app.
          </Text>
        </Banner>
      </BlockStack>
    </Card>
  );
}

function ProductsTab({ products, truncated }) {
  const withDelay = products.filter((p) => p.delayMinutes != null);
  const unavailable = products.filter((p) => p.pickupAvailable === false);
  const rows = [...new Map([...withDelay, ...unavailable].map((p) => [p.id, p])).values()].map((p) => [
    <Link
      key={p.id}
      url={`shopify:admin/products/${p.numericId}`}
      target="_blank"
      removeUnderline
    >
      {p.title}
    </Link>,
    p.delayMinutes != null ? `${p.delayMinutes} minutes` : `Default (${DEFAULT_PREP_MINUTES} minutes)`,
    p.pickupAvailable ? <Badge tone="success" key="a">Available</Badge> : <Badge tone="critical" key="u">Not available</Badge>,
  ]);

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">Product preparation rules</Text>
          <Text as="p">
            Preparation times live on each product, so Shopify stays the source of truth.
            Edit them on the product page in Shopify admin (Metafields section):
          </Text>
          <List>
            <List.Item>
              <Text as="span" fontWeight="semibold">Pickup delay (minutes)</Text>{" "}
              (custom.pickup_delay_minutes) — minutes needed before collection. Blank
              means the default {DEFAULT_PREP_MINUTES} minutes. When a basket has several
              products, the single highest delay applies. Delays are never added together.
            </List.Item>
            <List.Item>
              <Text as="span" fontWeight="semibold">Available for pickup</Text>{" "}
              (custom.pickup_available) — set to false to exclude a product from
              collection. Blank or true means available. If a basket contains an excluded
              product, the scheduler is disabled for that basket.
            </List.Item>
          </List>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">Products with custom pickup rules</Text>
          {rows.length === 0 ? (
            <Text as="p" tone="subdued">
              No products have custom pickup rules yet. All products use the default{" "}
              {DEFAULT_PREP_MINUTES}-minute preparation time and are available for pickup.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text"]}
              headings={["Product", "Preparation time", "Pickup availability"]}
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

function HelpTab({ summary }) {
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Current rules</Text>
          <Text as="p">{summary}</Text>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">How the scheduler works</Text>
          <List>
            <List.Item>
              Customers choose a collection date and time on the cart page. The choice is
              saved on the order as cart attributes (ibc_pickup_date, ibc_pickup_slot_start
              and friends) — Shopify remains the source of truth for all order data.
            </List.Item>
            <List.Item>
              The scheduler is optional and never replaces Shopify checkout. Customers
              must still select <Text as="span" fontWeight="semibold">Pick up</Text> at
              checkout. If they select Delivery, the collection time does not apply and
              should be ignored.
            </List.Item>
            <List.Item>
              Earliest slots respect the {DEFAULT_PREP_MINUTES}-minute default preparation
              time, any longer product delays in the basket, weekly hours, the same-day
              cut-off, blackout dates, capacity limits and the booking horizon.
            </List.Item>
          </List>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">Scheduler health checklist</Text>
          <List>
            <List.Item>
              Native local pickup must stay enabled in Settings → Shipping and delivery →
              Local pickup, so customers can select Pick up at checkout.
            </List.Item>
            <List.Item>
              The theme must include the snippet render line in
              sections/main-cart-footer.liquid (see the installation README).
            </List.Item>
            <List.Item>
              At least one weekday must be enabled above, and the shop metafield
              custom.pickup_scheduler_settings must exist (this app creates it on save).
            </List.Item>
            <List.Item>
              This app manages pickup scheduling settings only. It is not an
              order-management dashboard — view collection orders in Shopify Orders,
              where the ibc_pickup_* attributes appear under Additional details.
            </List.Item>
          </List>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
