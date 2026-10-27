// POST /api/checkout {plan: "yearly" | "lifetime", id: installId}
// Starts a Stripe Checkout for the ad-free upgrade and returns its address.
import { checkoutParams, isInstallId, json, stripeClient } from "./_stripe.js";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (!["yearly", "lifetime"].includes(body.plan) || !isInstallId(body.id)) return json({ error: "Bad request" }, 400);
  const { STRIPE_SECRET_KEY, STRIPE_PRICE_YEARLY, STRIPE_PRICE_LIFETIME } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_YEARLY || !STRIPE_PRICE_LIFETIME) return json({ error: "Payments aren't set up yet" }, 503);
  try {
    const stripe = stripeClient(STRIPE_SECRET_KEY);
    const session = await stripe("POST", "/v1/checkout/sessions", checkoutParams(body.plan, body.id, { yearly: STRIPE_PRICE_YEARLY, lifetime: STRIPE_PRICE_LIFETIME }));
    return json({ url: session.url });
  } catch (err) {
    console.error("checkout failed", err);
    return json({ error: "Couldn't start the checkout. Try again in a minute." }, 502);
  }
}
