// Launch offers: promotion codes that checkout applies for the buyer, shown on
// the upgrade page with how many were claimed. The codes live in Stripe;
// Vercel's environment names them, oldest first:
//   STRIPE_PROMO_CODES  e.g. "LAUNCH100,LAUNCH50"
// The last one still running is applied to every checkout. Earlier ones that
// were used stay on the page as finished rounds. Everything else (discount,
// duration, cap, end date, how many were claimed) is read from Stripe, so the
// page follows it without a deploy. See docs/ad-free-upgrade.md.

import { money } from "./_prices.js";

export function promoCodes(env) {
  return (env.STRIPE_PROMO_CODES || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

/** A Stripe promotion code and its coupon, reduced to what the page needs. */
export function readPromo(p, now) {
  const c = p.coupon ?? {};
  const caps = [p.max_redemptions, c.max_redemptions].filter((n) => typeof n === "number");
  const ends = [p.expires_at, c.redeem_by].filter((n) => typeof n === "number");
  const max = caps.length ? Math.min(...caps) : null;
  const endsAt = ends.length ? Math.min(...ends) * 1000 : null;
  const redeemed = p.times_redeemed ?? 0;
  return {
    id: p.id,
    code: p.code,
    name: c.name || null,
    percentOff: c.percent_off ?? null,
    amountOff: c.amount_off ?? null,
    currency: c.currency ?? null,
    duration: c.duration,
    months: c.duration_in_months ?? null,
    redeemed,
    max,
    endsAt,
    running: Boolean(p.active && c.valid !== false && (max === null || redeemed < max) && (endsAt === null || now < endsAt)),
  };
}

// Short, so the claimed count on the page keeps up.
const CACHE_MS = 60_000;
const cache = new Map();

async function loadPromo(stripe, code, now) {
  const hit = cache.get(code);
  if (hit && now - hit.at < CACHE_MS) return hit.promo;
  const list = await stripe("GET", "/v1/promotion_codes", { code, limit: 1 });
  const promo = list.data?.[0] ? readPromo(list.data[0], now) : null;
  cache.set(code, { promo, at: now });
  return promo;
}

/**
 * The offer running now (the last running code in the list) and the finished
 * rounds people used. A code Stripe can't find, or a Stripe error, leaves
 * that code out: checkout then works at full price with the code box.
 */
export async function promosFor(stripe, env, now = Date.now()) {
  const promos = await Promise.all(
    promoCodes(env).map((code) =>
      loadPromo(stripe, code, now).catch((err) => {
        console.error(`promotion code ${code} lookup failed`, err);
        return null;
      }),
    ),
  );
  const found = promos.filter(Boolean);
  const current = found.filter((p) => p.running).at(-1) ?? null;
  const past = found.filter((p) => !p.running && p.redeemed > 0);
  return { current, past };
}

/** What an amount costs with the code. */
function discounted(promo, amount, currency) {
  if (promo.percentOff !== null) return Math.round((amount * (100 - promo.percentOff)) / 100);
  if (promo.amountOff !== null && promo.currency === currency) return Math.max(0, amount - promo.amountOff);
  return amount;
}

/** "year", "week", "3 months" */
function periodWords(s) {
  return s.count === 1 ? s.interval : `${s.count} ${s.interval}s`;
}

/** Months in one billing period, or null for weeks and days. */
function periodMonths(s) {
  if (s.interval === "year") return 12 * s.count;
  if (s.interval === "month") return s.count;
  return null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * How long the discount lasts on this subscription: "for as long as you stay
 * subscribed", or the periods it covers ("your first year"). A repeating
 * coupon covers every invoice within its months, so it rounds up to whole
 * billing periods.
 */
function term(promo, s) {
  if (promo.duration === "forever") return null;
  if (promo.duration === "once" || !promo.months) return `your first ${periodWords(s)}`;
  const per = periodMonths(s);
  if (!per) return `your first ${plural(promo.months, "month", "months")}`;
  const covered = Math.ceil(promo.months / per) * per;
  if (covered === per) return `your first ${periodWords(s)}`;
  return covered % 12 === 0 ? `your first ${covered / 12} years` : `your first ${covered} months`;
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** The words for the offer running now, for one install's prices. */
export function describePromo(promo, offer) {
  const s = offer.subscription;
  const l = offer.lifetime;
  const subNow = discounted(promo, s.amount, s.currency);
  const lifeNow = discounted(promo, l.amount, l.currency);
  const free = subNow === 0;
  const off = promo.percentOff !== null ? `${promo.percentOff}% off` : `${money(promo.amountOff ?? 0, promo.currency ?? "usd")} off`;
  const every = (amount) => `${money(amount, s.currency)} ${s.count === 1 ? `a ${s.interval}` : `every ${periodWords(s)}`}`;
  const regular = every(s.amount);
  const covers = term(promo, s);

  let headline;
  let subscriptionLine;
  if (!covers) {
    headline = free ? "Free for as long as you stay subscribed." : `${capitalize(off)} for as long as you stay subscribed.`;
    subscriptionLine = free ? "Free for as long as you stay subscribed." : `${every(subNow)} instead of ${money(s.amount, s.currency)}, for as long as you stay subscribed.`;
  } else {
    headline = free ? `${capitalize(covers)} free.` : `${capitalize(off)} ${covers}.`;
    subscriptionLine = `${free ? "Free" : money(subNow, s.currency)} for ${covers}, then ${regular}.`;
  }

  let claimed = "";
  if (promo.max !== null) claimed = promo.redeemed ? `${promo.redeemed} of ${promo.max} claimed` : `${promo.max} available`;
  else if (promo.redeemed) claimed = `${promo.redeemed} claimed`;

  return {
    label: promo.name || "Offer",
    code: promo.code,
    headline,
    claimed,
    endsAt: promo.endsAt,
    subscriptionLine,
    subscriptionButton: free ? "Get it free" : `Pay ${money(subNow, s.currency)} today`,
    lifetimeLine: lifeNow === 0 ? `Free with this offer, normally ${money(l.amount, l.currency)}.` : `${money(lifeNow, l.currency)} with this offer, normally ${money(l.amount, l.currency)}.`,
    lifetimeButton: lifeNow === 0 ? "Get it free" : `Pay ${money(lifeNow, l.currency)}`,
  };
}

/** A finished round: "Launch offer: 100 people got Vidzilla ad-free for free." */
export function describePastPromo(promo) {
  const who = plural(promo.redeemed, "person", "people");
  const what = promo.percentOff === 100 ? "Vidzilla ad-free for free" : promo.percentOff !== null ? `${promo.percentOff}% off` : `${money(promo.amountOff ?? 0, promo.currency ?? "usd")} off`;
  return `${promo.name || `Code ${promo.code}`}: ${who} got ${what}.`;
}

/** Forgets cached codes (tests). */
export const clearPromoCache = () => cache.clear();
