// Ad-free purchases, server side. Stripe is the only record of who paid: a
// checkout carries the extension's random install ID in its metadata, and a
// license check searches Stripe for that ID. There is no database, and
// nothing about the buyer is kept here. See docs/ad-free-upgrade.md.

export const ORIGIN = "https://vidzilla.followusai.com";

/** Pinned so the fields read below don't move under us. */
const STRIPE_VERSION = "2024-06-20";

/** The extension makes one with crypto.randomUUID(). */
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

export const isInstallId = (id) => typeof id === "string" && INSTALL_ID.test(id);
export const isSessionId = (id) => typeof id === "string" && SESSION_ID.test(id);

/** Flattens {a: {b: 1}} into Stripe's form encoding, a[b]=1. */
export function formEncode(params, prefix = "", out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value && typeof value === "object") formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

/** A Stripe API caller: stripe("GET", "/v1/...", params). */
export function stripeClient(secretKey, fetchImpl = fetch) {
  return async (method, path, params = {}) => {
    const body = formEncode(params);
    const url = method === "GET" ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": STRIPE_VERSION,
        ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      body: method === "GET" ? undefined : body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message ?? `Stripe ${res.status}`);
    return json;
  };
}

/** The Checkout Session that sells one of the two plans to one install. */
export function checkoutParams(plan, installId, prices) {
  const common = {
    client_reference_id: installId,
    metadata: { install_id: installId, plan },
    success_url: `${ORIGIN}/upgrade-thanks?id=${installId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${ORIGIN}/upgrade?id=${installId}`,
  };
  if (plan === "yearly") {
    return {
      ...common,
      mode: "subscription",
      line_items: { 0: { quantity: 1, price: prices.yearly } },
      subscription_data: { metadata: { install_id: installId } },
    };
  }
  return {
    ...common,
    mode: "payment",
    customer_creation: "always",
    line_items: { 0: { quantity: 1, price: prices.lifetime } },
    payment_intent_data: { metadata: { install_id: installId } },
  };
}

const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due"]);

/** A subscription's period end in ms; newer API versions keep it on the item. */
function periodEnd(sub) {
  const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return typeof end === "number" ? end * 1000 : null;
}

const NONE = { adFree: false };

/**
 * Has this install paid? With the session ID from the thanks page, the answer
 * comes from that checkout directly (search lags behind by up to a minute).
 * Otherwise Stripe is searched for a live subscription or a paid, unrefunded
 * one-time payment carrying the install ID.
 */
export async function checkLicense(stripe, installId, sessionId) {
  if (sessionId) {
    const session = await stripe("GET", `/v1/checkout/sessions/${sessionId}`, { expand: ["subscription"] });
    if (session.client_reference_id === installId && session.status === "complete" && session.payment_status !== "unpaid") {
      if (session.mode === "subscription" && session.subscription) {
        return { adFree: true, plan: "yearly", until: periodEnd(session.subscription) };
      }
      if (session.mode === "payment") return { adFree: true, plan: "lifetime", until: null };
    }
  }

  const id = installId.replace(/'/g, "");
  const payments = await stripe("GET", "/v1/payment_intents/search", {
    query: `metadata['install_id']:'${id}' AND status:'succeeded'`,
    expand: ["data.latest_charge"],
  });
  if (payments.data.some((pi) => !pi.latest_charge?.refunded)) return { adFree: true, plan: "lifetime", until: null };

  const subs = await stripe("GET", "/v1/subscriptions/search", { query: `metadata['install_id']:'${id}'` });
  const live = subs.data.filter((s) => LIVE_SUBSCRIPTION.has(s.status));
  if (live.length) {
    const until = Math.max(...live.map((s) => periodEnd(s) ?? 0));
    return { adFree: true, plan: "yearly", until: until || null };
  }
  return NONE;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
