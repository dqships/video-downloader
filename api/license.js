// GET /api/license?id=<installId>[&session=<checkout session id>]
// Answers whether that install paid to remove ads: {adFree, plan, until}.
import { checkLicense, isInstallId, isSessionId, json, stripeClient } from "./_stripe.js";

export async function GET(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const session = url.searchParams.get("session");
  if (!isInstallId(id) || (session && !isSessionId(session))) return json({ error: "Bad request" }, 400);
  const { STRIPE_SECRET_KEY } = process.env;
  if (!STRIPE_SECRET_KEY) return json({ error: "Payments aren't set up yet" }, 503);
  try {
    return json(await checkLicense(stripeClient(STRIPE_SECRET_KEY), id, session || undefined));
  } catch (err) {
    console.error("license check failed", err);
    return json({ error: "Couldn't check right now" }, 502);
  }
}
