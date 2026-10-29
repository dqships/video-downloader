// GET /api/prices[?id=<installId>]
// What removing the ads costs: for an install, at its test group's prices;
// without one, the first group's (what the public pages show). With it, the
// offer running now and the finished ones (see _promos.js).
import { describeOffer, offerFor } from "./_prices.js";
import { describePastPromo, describePromo, promosFor } from "./_promos.js";
import { isInstallId, json, stripeClient } from "./_stripe.js";

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (id && !isInstallId(id)) return json({ error: "Bad request" }, 400);
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: "Payments aren't set up yet" }, 503);
  try {
    const stripe = stripeClient(process.env.STRIPE_SECRET_KEY);
    const [offer, promos] = await Promise.all([offerFor(stripe, process.env, id || undefined), promosFor(stripe, process.env)]);
    return json(
      {
        ...describeOffer(offer),
        subscriptionPrice: offer.subscription,
        lifetimePrice: offer.lifetime,
        promo: promos.current ? describePromo(promos.current, offer) : null,
        pastPromos: promos.past.map(describePastPromo),
      },
      200,
      // Short, so the claimed count keeps up; a price change shows within ten minutes.
      "public, max-age=60, s-maxage=60",
    );
  } catch (err) {
    console.error("price lookup failed", err);
    return json({ error: "Couldn't look up the prices" }, 502);
  }
}
