// Telling Shopify a courier order is on its way, so Shopify tells the customer.
//
// WHY THIS AND NOT A CUSTOM EMAIL
// -------------------------------
// Shopify already has a shipping-confirmation email, an order status page and
// a customer order history, and all three show a fulfillment's tracking URL.
// Creating the fulfillment with `notifyCustomer: true` sends the customer
// their link through the channel they already expect it on, in the shop's own
// branding, with no second sending domain to warm up and no extra app.
//
// It also does a job that has to happen anyway: a courier order that is never
// fulfilled sits in the admin looking unshipped forever.
//
// TWO STAGES, BECAUSE THEY ANSWER DIFFERENT QUESTIONS
// ---------------------------------------------------
//   1. `fulfilWithTracking`  — the rider is booked. Create the fulfillment,
//      attach the tracker, notify. The customer gets a link that works
//      immediately and shows a job that has not been collected yet.
//   2. `updateTracking`      — Gophr reports progress. The fulfillment already
//      exists, so only the tracking is touched, and `notify` is normally FALSE
//      because the customer has already been emailed once and does not want an
//      email per status change.
//
// GOPHR IS NOT A CARRIER SHOPIFY KNOWS, so `company` is a plain label and the
// URL is given explicitly. Shopify's own note on the matter: it builds URLs
// from tracking numbers only for carriers on its list, and guesses — wrongly,
// sometimes — for numbers that merely look familiar. Passing the URL removes
// the guess.

const FULFILMENT_ORDERS = `
  query CourierFulfilmentOrders($id: ID!) {
    order(id: $id) {
      id
      name
      displayFulfillmentStatus
      fulfillmentOrders(first: 10, query: "status:open") {
        nodes {
          id
          status
          deliveryMethod { methodType }
        }
      }
    }
  }
`;

const FULFILMENT_CREATE = `
  mutation CourierFulfil($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo { url company number }
      }
      userErrors { field message }
    }
  }
`;

const TRACKING_UPDATE = `
  mutation CourierTracking(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment { id trackingInfo { url } }
      userErrors { field message }
    }
  }
`;

const EXISTING_FULFILMENTS = `
  query CourierExistingFulfilments($id: ID!) {
    order(id: $id) {
      id
      fulfillments(first: 10) { id status trackingInfo { url } }
    }
  }
`;

const FULFILMENT_EVENT = `
  mutation CourierFulfilmentEvent($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      fulfillmentEvent { id status happenedAt }
      userErrors { field message }
    }
  }
`;

const ORDER_FULFILMENTS = `
  query CourierOrderFulfilments($q: String!) {
    orders(first: 2, query: $q) {
      nodes {
        id
        name
        displayFulfillmentStatus
        fulfillments(first: 10) { id status }
      }
    }
  }
`;

export const CARRIER_NAME = "Gophr";

const log = (...parts) => console.log("[ibc-courier:fulfil]", ...parts);

function firstUserError(errors, what) {
  const list = errors || [];
  if (!list.length) return null;
  const message = list.map((e) => e.message).join("; ");
  log(what, "refused:", message);
  return message;
}

/**
 * Create the fulfillment and hand the customer their tracking link.
 *
 * Returns { ok, fulfillmentId, reason }. Never throws for an ordinary refusal
 * — a courier that is booked and a customer who was not emailed is a much
 * smaller problem than a booking rolled back because an email failed, and the
 * caller has a rider on the road either way.
 */
export async function fulfilWithTracking(admin, { orderGid, trackingUrl, notify = true }) {
  if (!orderGid) return { ok: false, reason: "no_order" };

  const response = await admin.graphql(FULFILMENT_ORDERS, { variables: { id: orderGid } });
  const { data } = await response.json();
  const order = data?.order;
  if (!order) return { ok: false, reason: "order_not_found" };

  /* ONLY THE SHIPPING FULFILLMENT ORDER.
   *
   * A basket can be split — some lines shipped, some collected — and Shopify
   * models each as its own fulfillment order. Fulfilling a PICK_UP one
   * because a courier was booked would tell a customer their collection is on
   * its way to them, which it is not. */
  const open = (order.fulfillmentOrders?.nodes || []).filter(
    (node) => node?.deliveryMethod?.methodType !== "PICK_UP"
  );

  if (!open.length) {
    /* Already fulfilled, or nothing left to fulfil. Not an error: the most
     * likely cause is this having run already. */
    return { ok: false, reason: "nothing_open" };
  }

  const fulfillment = {
    notifyCustomer: Boolean(notify),
    lineItemsByFulfillmentOrder: open.map((node) => ({ fulfillmentOrderId: node.id })),
  };
  /* Tracking is optional here on purpose. A job booked before Gophr has given
   * us a tracker still deserves to be marked fulfilled; the link can be
   * attached afterwards by updateTracking(). */
  if (trackingUrl) {
    fulfillment.trackingInfo = { url: String(trackingUrl), company: CARRIER_NAME };
  }

  const created = await admin.graphql(FULFILMENT_CREATE, { variables: { fulfillment } });
  const { data: createdData } = await created.json();
  const error = firstUserError(createdData?.fulfillmentCreate?.userErrors, "fulfillmentCreate");
  if (error) return { ok: false, reason: "refused", message: error };

  const id = createdData?.fulfillmentCreate?.fulfillment?.id || null;
  log(order.name, "fulfilled", id, notify ? "and the customer was emailed" : "quietly");
  return { ok: true, fulfillmentId: id };
}

/**
 * Attach or correct the tracking link on a fulfillment that already exists.
 *
 * `notify` defaults to FALSE. Gophr sends a status update for every leg of a
 * journey, and a customer who gets an email each time a rider moves will
 * unsubscribe from the shop entirely. The one email that matters was sent
 * when the fulfillment was created.
 */
export async function updateTracking(admin, { orderGid, trackingUrl, notify = false }) {
  if (!orderGid || !trackingUrl) return { ok: false, reason: "nothing_to_do" };

  const response = await admin.graphql(EXISTING_FULFILMENTS, { variables: { id: orderGid } });
  const { data } = await response.json();
  const fulfillments = data?.order?.fulfillments || [];

  /* SUCCESS and OPEN are the live ones. A CANCELLED fulfillment is history,
   * and writing a tracking link onto history helps nobody. */
  const live = fulfillments.find((f) => f.status !== "CANCELLED");
  if (!live) return { ok: false, reason: "no_fulfillment" };

  /* Nothing to say. Rewriting the same URL would be a no-op to Shopify and,
   * with notify on, an email to the customer saying nothing changed. */
  if (live.trackingInfo?.some?.((t) => t.url === trackingUrl)) {
    return { ok: true, fulfillmentId: live.id, reason: "unchanged" };
  }

  const updated = await admin.graphql(TRACKING_UPDATE, {
    variables: {
      fulfillmentId: live.id,
      trackingInfoInput: { url: String(trackingUrl), company: CARRIER_NAME },
      notifyCustomer: Boolean(notify),
    },
  });
  const { data: updatedData } = await updated.json();
  const error = firstUserError(
    updatedData?.fulfillmentTrackingInfoUpdate?.userErrors,
    "fulfillmentTrackingInfoUpdate"
  );
  if (error) return { ok: false, reason: "refused", message: error };

  return { ok: true, fulfillmentId: live.id };
}


/* ==================================================================== */
/* FULFILMENT EVENTS — the missing half of telling the customer          */
/*                                                                       */
/* A LOCAL DELIVERY ORDER DOES NOT GET A SHIPPING CONFIRMATION. Order    */
/* #1095 was fulfilled with notifyCustomer: true and Shopify logged the  */
/* fulfilment and sent nothing — no "shipping confirmation email was     */
/* sent" event at all. Shopify has its own local-delivery notifications  */
/* ("Out for local delivery"), and the evidence says they are driven by  */
/* a fulfilment EVENT rather than by the fulfilment itself.              */
/*                                                                       */
/* That is a hypothesis. It is also cheap to test, which is why this is  */
/* a diagnostic that can be pointed at any order rather than a guess     */
/* wired into the booking path. Find the status that emails the          */
/* customer, THEN commit to it.                                          */
/*                                                                       */
/* Needs the `write_fulfillments` scope, which the app did not have —    */
/* the Permissions card on the Courier page says whether it does now.    */

/** Post an event against an order's live fulfilment, by order name. */
export async function postFulfilmentEventByOrderName(admin, { orderName, status, message }) {
  const name = String(orderName || "").replace(/^#/, "").trim();
  if (!name) return { ok: false, reason: "no_order_name" };

  const response = await admin.graphql(ORDER_FULFILMENTS, {
    variables: { q: `name:${name}` },
  });
  const { data } = await response.json();
  const orders = data?.orders?.nodes || [];
  if (orders.length !== 1) {
    return { ok: false, reason: "order_not_found", found: orders.length };
  }

  const order = orders[0];
  const live = (order.fulfillments || []).find((f) => f.status !== "CANCELLED");
  if (!live) {
    return { ok: false, reason: "no_fulfillment", order: order.name };
  }

  return postFulfilmentEvent(admin, {
    fulfillmentId: live.id,
    status,
    message,
    orderName: order.name,
  });
}

/**
 * Post one event against a fulfilment.
 *
 * `happenedAt` is sent explicitly rather than left to default, because an
 * event with no time is an event Shopify may place anywhere in the order's
 * history, and the sequence is what a customer reads as a story.
 */
export async function postFulfilmentEvent(admin, { fulfillmentId, status, message, orderName }) {
  if (!fulfillmentId || !status) return { ok: false, reason: "missing_input" };

  const fulfillmentEvent = {
    fulfillmentId,
    status,
    happenedAt: new Date().toISOString(),
  };
  if (message) fulfillmentEvent.message = String(message);

  const response = await admin.graphql(FULFILMENT_EVENT, {
    variables: { fulfillmentEvent },
  });
  const { data } = await response.json();
  const error = firstUserError(
    data?.fulfillmentEventCreate?.userErrors,
    "fulfillmentEventCreate"
  );
  if (error) return { ok: false, reason: "refused", message: error };

  const event = data?.fulfillmentEventCreate?.fulfillmentEvent;
  log(orderName || fulfillmentId, "event", status, "->", event?.id || "(no id)");
  return { ok: true, event, fulfillmentId };
}
