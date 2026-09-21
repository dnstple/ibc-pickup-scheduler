import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Fulfilment settings</Link>
        <Link to="/app/courier">Courier</Link>
        {/* A WAY IN THAT DOES NOT DEPEND ON SHOPIFY'S HANDOFF. Settings >
            Shipping and delivery is the usual route to this page, and while
            the handoff was misconfigured there was no other way to reach it
            at all. The function id is looked up by the page itself, so the
            segment here is only a label. */}
        <Link to="/app/delivery-customization/ibc-delivery-gate/new">Delivery gate</Link>
        <Link to="/app/checkout-guard/ibc-checkout-guard/new">Checkout guard</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
