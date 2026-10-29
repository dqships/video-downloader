// POST /api/portal {id: installId}
// Opens Stripe's customer portal for that install's subscription (cancel it,
// change the card) and returns its address.
import { isInstallId, json, portalSession, stripeClient } from "./_stripe.js";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (!isInstallId(body.id)) return json({ error: "Bad request" }, 400);
  const { STRIPE_SECRET_KEY } = process.env;
  if (!STRIPE_SECRET_KEY) return json({ error: "Payments aren't set up yet" }, 503);
  try {
    const url = await portalSession(stripeClient(STRIPE_SECRET_KEY), body.id);
    return url ? json({ url }) : json({ error: "No subscription was found for this copy" }, 404);
  } catch (err) {
    console.error("portal failed", err);
    return json({ error: "Couldn't open the billing page. Try again in a minute." }, 502);
  }
}
