import { redirect } from "@remix-run/node";
import { login } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return await login(request);
};

export default function Index() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>Pickup Scheduler Settings</h1>
      <p>Open this app from your Shopify admin.</p>
    </main>
  );
}
