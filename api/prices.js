// GET /api/prices[?id=<installId>]
// What removing the ads costs: for an install, at its test group's prices;
// without one, the first group's (what the public pages show).
import { describeOffer, offerFor } from "./_prices.js";
import { isInstallId, json, stripeClient } from "./_stripe.js";

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (id && !isInstallId(id)) return json({ error: "Bad request" }, 400);
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: "Payments aren't set up yet" }, 503);
  try {
    const offer = await offerFor(stripeClient(process.env.STRIPE_SECRET_KEY), process.env, id || undefined);
    // A price change shows within ten minutes.
    return json({ ...describeOffer(offer), subscriptionPrice: offer.subscription, lifetimePrice: offer.lifetime }, 200, "public, max-age=600, s-maxage=600");
  } catch (err) {
    console.error("price lookup failed", err);
    return json({ error: "Couldn't look up the prices" }, 502);
  }
}
