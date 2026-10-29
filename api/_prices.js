// What the ad-free upgrade costs, and which price each install is offered.
// The prices live in Stripe; Vercel's environment names them:
//   STRIPE_PRICE_SUBSCRIPTIONS  the subscription prices under test, comma
//                               separated (falls back to STRIPE_PRICE_YEARLY)
//   STRIPE_PRICE_LIFETIME       the one-time price
// With more than one subscription price, installs are split into equal
// groups (a, b, c...) by their random install ID, so one person always sees
// the same price. The website build, the upgrade page, the extension's
// Settings and the checkout all read them from here. See docs/ad-free-upgrade.md.

/** Shown when Stripe can't be asked (a local build, or no key yet). */
export const DEFAULT_OFFER = {
  variant: "a",
  subscription: { amount: 99, currency: "usd", interval: "year", count: 1 },
  lifetime: { amount: 900, currency: "usd" },
};

export function subscriptionPriceIds(env) {
  return (env.STRIPE_PRICE_SUBSCRIPTIONS || env.STRIPE_PRICE_YEARLY || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** The test group of an install: its ID is random, so the groups come out even. */
export function variantIndex(installId, groups) {
  if (!installId || groups <= 1) return 0;
  return parseInt(installId.replace(/-/g, "").slice(0, 8), 16) % groups;
}

export const variantName = (index) => String.fromCharCode(97 + index);

/** "$0.99", "$9" */
export function money(amount, currency = "usd") {
  const value = amount / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

const EVERY = { day: "day", week: "week", month: "month", year: "year" };
const NAMES = { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" };

/** Words for an offer, as the pages and Settings print them. */
export function describeOffer(offer) {
  const { subscription: s, lifetime: l } = offer;
  const unit = EVERY[s.interval] ?? s.interval;
  const every = s.count === 1 ? `every ${unit}` : `every ${s.count} ${unit}s`;
  const name = s.count === 1 ? (NAMES[s.interval] ?? "Subscription") : s.interval === "month" && s.count === 3 ? "Quarterly" : `Every ${s.count} ${unit}s`;
  return {
    variant: offer.variant,
    /** "$0.99 a year", "$7 every 3 months" */
    subscription: `${money(s.amount, s.currency)} ${s.count === 1 ? `a ${unit}` : every}`,
    /** "Yearly", "Weekly", "Quarterly" */
    subscriptionName: name,
    /** "every year" */
    renews: every,
    /** "$9 once" */
    lifetime: `${money(l.amount, l.currency)} once`,
    /** "$9" */
    lifetimeAmount: money(l.amount, l.currency),
  };
}

/** A Stripe price, reduced to what the pages need. */
function readPrice(price) {
  return {
    amount: price.unit_amount,
    currency: price.currency,
    ...(price.recurring ? { interval: price.recurring.interval, count: price.recurring.interval_count } : {}),
  };
}

const CACHE_MS = 10 * 60_000;
const cache = new Map();

async function loadPrice(stripe, id, now) {
  const hit = cache.get(id);
  if (hit && now - hit.at < CACHE_MS) return hit.price;
  const price = readPrice(await stripe("GET", `/v1/prices/${id}`));
  cache.set(id, { price, at: now });
  return price;
}

/**
 * The offer for one install (or, without an ID, the first group's, which the
 * public pages show), with the Stripe price IDs a checkout needs.
 */
export async function offerFor(stripe, env, installId, now = Date.now()) {
  const ids = subscriptionPriceIds(env);
  if (!ids.length || !env.STRIPE_PRICE_LIFETIME) throw new Error("Prices aren't set up yet");
  const index = variantIndex(installId, ids.length);
  const [subscription, lifetime] = await Promise.all([loadPrice(stripe, ids[index], now), loadPrice(stripe, env.STRIPE_PRICE_LIFETIME, now)]);
  return {
    variant: variantName(index),
    subscription,
    lifetime,
    priceIds: { subscription: ids[index], lifetime: env.STRIPE_PRICE_LIFETIME },
  };
}

/** Forgets cached prices (tests). */
export const clearPriceCache = () => cache.clear();
