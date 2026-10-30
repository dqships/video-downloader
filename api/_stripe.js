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

/**
 * The Checkout Session that sells one of the two plans to one install, at
 * the prices of its test group (see _prices.js). The group goes on the
 * payment too, so sales can be compared per group in Stripe. With an offer
 * running (see _promos.js) its promotion code is applied for the buyer;
 * otherwise they can enter one made from a Stripe coupon. Stripe allows one
 * or the other, not both.
 */
export function checkoutParams(plan, installId, offer, promoId) {
  const tags = { install_id: installId, variant: offer.variant };
  const common = {
    client_reference_id: installId,
    metadata: { ...tags, plan },
    ...(promoId ? { discounts: { 0: { promotion_code: promoId } } } : { allow_promotion_codes: true }),
    success_url: `${ORIGIN}/upgrade-thanks?id=${installId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${ORIGIN}/upgrade?id=${installId}`,
  };
  if (plan === "subscription") {
    return {
      ...common,
      mode: "subscription",
      line_items: { 0: { quantity: 1, price: offer.priceIds.subscription } },
      subscription_data: { metadata: tags },
    };
  }
  return {
    ...common,
    mode: "payment",
    customer_creation: "always",
    line_items: { 0: { quantity: 1, price: offer.priceIds.lifetime } },
    payment_intent_data: { metadata: tags },
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
 * The extension keeps that ID and sends it with every later check too, which
 * is the only record of a one-time purchase a 100% off coupon made free (no
 * payment exists to search for). Otherwise Stripe is searched for a live
 * subscription or a paid, unrefunded one-time payment carrying the install ID.
 */
export async function checkLicense(stripe, installId, sessionId) {
  if (sessionId) {
    const session = await stripe("GET", `/v1/checkout/sessions/${sessionId}`, { expand: ["subscription", "payment_intent.latest_charge"] });
    if (session.client_reference_id === installId && session.status === "complete" && session.payment_status !== "unpaid") {
      const sub = session.subscription;
      if (session.mode === "subscription" && sub && LIVE_SUBSCRIPTION.has(sub.status)) {
        return { adFree: true, plan: "subscription", until: periodEnd(sub) };
      }
      if (session.mode === "payment") {
        // A 100% off code leaves nothing to pay, so there's no PaymentIntent:
        // Stripe marks such a session "paid" with a total of 0 (or, in some
        // versions, "no_payment_required").
        const free = session.payment_status === "no_payment_required" || (session.amount_total === 0 && !session.payment_intent);
        const charge = session.payment_intent?.latest_charge;
        if (free || (session.payment_intent?.status === "succeeded" && !charge?.refunded)) return { adFree: true, plan: "lifetime", until: null };
      }
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
    return { adFree: true, plan: "subscription", until: until || null };
  }
  return NONE;
}

/**
 * A Stripe customer portal session for this install's subscription, where the
 * buyer can cancel it or change the card. The install ID finds the customer
 * through the subscription's metadata; undefined when it has no plan.
 */
export async function portalSession(stripe, installId) {
  const id = installId.replace(/'/g, "");
  const subs = await stripe("GET", "/v1/subscriptions/search", { query: `metadata['install_id']:'${id}'` });
  // The newest plan this install has, live ones first.
  const [sub] = [...subs.data].sort((a, b) => Number(LIVE_SUBSCRIPTION.has(b.status)) - Number(LIVE_SUBSCRIPTION.has(a.status)) || b.created - a.created);
  const customer = typeof sub?.customer === "string" ? sub.customer : sub?.customer?.id;
  if (!customer) return undefined;
  const session = await stripe("POST", "/v1/billing_portal/sessions", { customer, return_url: ORIGIN });
  return session.url;
}

export function json(body, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}
