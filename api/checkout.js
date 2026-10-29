// POST /api/checkout {plan: "subscription" | "lifetime", id: installId}
// Starts a Stripe Checkout for the ad-free upgrade, at the prices of the
// install's test group, and returns its address.
import { offerFor } from "./_prices.js";
import { checkoutParams, isInstallId, json, stripeClient } from "./_stripe.js";

/** "yearly" is what pages from before the price test send. */
const PLANS = { subscription: "subscription", yearly: "subscription", lifetime: "lifetime" };

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const plan = PLANS[body.plan];
  if (!plan || !isInstallId(body.id)) return json({ error: "Bad request" }, 400);
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: "Payments aren't set up yet" }, 503);
  try {
    const stripe = stripeClient(process.env.STRIPE_SECRET_KEY);
    const offer = await offerFor(stripe, process.env, body.id);
    const session = await stripe("POST", "/v1/checkout/sessions", checkoutParams(plan, body.id, offer));
    return json({ url: session.url });
  } catch (err) {
    console.error("checkout failed", err);
    return json({ error: "Couldn't start the checkout. Try again in a minute." }, 502);
  }
}
