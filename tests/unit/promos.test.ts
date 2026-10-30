import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS Vercel function module
import { clearPromoCache, describePastPromo, describePromo, describePublicPromo, promoCodes, promosFor, readPromo } from "../../api/_promos.js";
// @ts-expect-error plain JS Vercel function module
import { checkoutParams } from "../../api/_stripe.js";

const NOW = Date.UTC(2026, 10, 1);
const DAY = 86_400;

/** A Stripe promotion code with its coupon. */
function code(code: string, coupon: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: `promo_${code}`, code, active: true, times_redeemed: 0, max_redemptions: null, expires_at: null, coupon: { valid: true, duration: "forever", percent_off: 100, ...coupon }, ...extra };
}

function fake(codes: Record<string, unknown>) {
  let calls = 0;
  const stripe = async (_method: string, path: string, params: { code: string }) => {
    calls++;
    if (path !== "/v1/promotion_codes") throw new Error(`unexpected ${path}`);
    if (params.code === "BROKEN") throw new Error("permission");
    return { data: params.code in codes ? [codes[params.code]] : [] };
  };
  return { stripe, calls: () => calls };
}

const offer = (interval: string, count: number, amount: number) => ({
  variant: "a",
  subscription: { amount, currency: "usd", interval, count },
  lifetime: { amount: 900, currency: "usd" },
});
const yearly = offer("year", 1, 99);
const weekly = offer("week", 1, 99);
const quarterly = offer("month", 3, 700);
const promo = (coupon: Record<string, unknown>, extra: Record<string, unknown> = {}) => readPromo(code("LAUNCH", { name: "Launch offer", ...coupon }, extra), NOW);

beforeEach(() => clearPromoCache());

describe("launch offers", () => {
  it("reads the codes from the environment, oldest first", () => {
    expect(promoCodes({ STRIPE_PROMO_CODES: "LAUNCH100, LAUNCH50," })).toEqual(["LAUNCH100", "LAUNCH50"]);
    expect(promoCodes({})).toEqual([]);
  });

  it("runs a code only while it's active, under its cap and before its end", () => {
    expect(promo({}).running).toBe(true);
    expect(promo({}, { max_redemptions: 100, times_redeemed: 100 }).running).toBe(false);
    expect(promo({ max_redemptions: 5 }, { max_redemptions: 100, times_redeemed: 5 }).running).toBe(false);
    expect(promo({}, { expires_at: NOW / 1000 - DAY }).running).toBe(false);
    expect(promo({ redeem_by: NOW / 1000 - DAY }).running).toBe(false);
    expect(promo({}, { active: false }).running).toBe(false);
    expect(promo({ valid: false }).running).toBe(false);
    expect(promo({ redeem_by: NOW / 1000 + 2 * DAY }, { expires_at: NOW / 1000 + DAY }).endsAt).toBe(NOW + DAY * 1000);
  });

  it("applies the last running code and keeps the used, finished ones as rounds", async () => {
    const { stripe } = fake({
      LAUNCH100: code("LAUNCH100", { name: "Launch offer" }, { max_redemptions: 100, times_redeemed: 100 }),
      UNUSED: code("UNUSED", {}, { active: false }),
      LAUNCH50: code("LAUNCH50", { name: "Round 2", percent_off: 50 }, { max_redemptions: 50, times_redeemed: 12 }),
    });
    const { current, past } = await promosFor(stripe, { STRIPE_PROMO_CODES: "LAUNCH100,UNUSED,MISSING,BROKEN,LAUNCH50" }, NOW);
    expect(current.code).toBe("LAUNCH50");
    expect(past.map((p: { code: string }) => p.code)).toEqual(["LAUNCH100"]);
    expect(describePastPromo(past[0])).toBe("Launch offer: 100 people got Vidzilla ad-free for free.");
  });

  it("asks Stripe about a code at most once a minute", async () => {
    const { stripe, calls } = fake({ LAUNCH: code("LAUNCH", {}) });
    const env = { STRIPE_PROMO_CODES: "LAUNCH" };
    await promosFor(stripe, env, NOW);
    await promosFor(stripe, env, NOW + 30_000);
    expect(calls()).toBe(1);
    await promosFor(stripe, env, NOW + 61_000);
    expect(calls()).toBe(2);
  });

  it("says how long a free subscription lasts, by duration and billing period", () => {
    expect(describePromo(promo({ duration: "forever" }), yearly)).toMatchObject({
      headline: "Free for as long as you stay subscribed.",
      subscriptionButton: "Get it free",
      lifetimeLine: "Free with this offer, normally $9.",
      lifetimeButton: "Get it free",
    });
    expect(describePromo(promo({ duration: "once" }), yearly)).toMatchObject({
      headline: "Your first year free.",
      subscriptionLine: "Free for your first year, then $0.99 a year.",
    });
    expect(describePromo(promo({ duration: "once" }), weekly).headline).toBe("Your first week free.");
    expect(describePromo(promo({ duration: "once" }), quarterly).subscriptionLine).toBe("Free for your first 3 months, then $7 every 3 months.");
    // A repeating coupon covers every invoice in its months: 4 months of a quarterly plan is two quarters.
    expect(describePromo(promo({ duration: "repeating", duration_in_months: 4 }), quarterly).headline).toBe("Your first 6 months free.");
    expect(describePromo(promo({ duration: "repeating", duration_in_months: 3 }), yearly).headline).toBe("Your first year free.");
    expect(describePromo(promo({ duration: "repeating", duration_in_months: 2 }), weekly).headline).toBe("Your first 2 months free.");
  });

  it("prices a partial discount", () => {
    expect(describePromo(promo({ percent_off: 50, duration: "once" }), quarterly)).toMatchObject({
      headline: "50% off your first 3 months.",
      subscriptionLine: "$3.50 for your first 3 months, then $7 every 3 months.",
      subscriptionButton: "Pay $3.50 today",
      lifetimeLine: "$4.50 with this offer, normally $9.",
      lifetimeButton: "Pay $4.50",
    });
    expect(describePromo(promo({ percent_off: 50, duration: "forever" }), yearly).subscriptionLine).toBe("$0.50 a year instead of $0.99, for as long as you stay subscribed.");
    expect(describePromo(promo({ percent_off: null, amount_off: 200, currency: "usd", duration: "once" }), quarterly).headline).toBe("$2 off your first 3 months.");
  });

  it("counts what's claimed, or what's available before anyone has", () => {
    expect(describePromo(promo({}, { max_redemptions: 100, times_redeemed: 63 }), yearly).claimed).toBe("63 of 100 claimed");
    expect(describePromo(promo({}, { max_redemptions: 100 }), yearly).claimed).toBe("100 available");
    expect(describePromo(promo({}, { times_redeemed: 7 }), yearly).claimed).toBe("7 claimed");
    expect(describePromo(promo({}), yearly).claimed).toBe("");
    expect(describePastPromo(promo({ percent_off: 50, name: "" }, { times_redeemed: 1 }))).toBe("Code LAUNCH: 1 person got 50% off.");
  });

  it("words the public offer without naming a subscription price or period", () => {
    expect(describePublicPromo(promo({}, { max_redemptions: 50, times_redeemed: 2 }), quarterly)).toEqual({
      label: "Launch offer",
      code: "LAUNCH",
      headline: "Free for as long as you stay subscribed.",
      claimed: "2 of 50 claimed",
      endsAt: null,
      lifetimeLine: "Lifetime: free with this offer, normally $9.",
    });
    expect(describePublicPromo(promo({ duration: "once" }), yearly).headline).toBe("Your first billing period free.");
    expect(describePublicPromo(promo({ duration: "repeating", duration_in_months: 3 }), yearly).headline).toBe("Your first 3 months free.");
    const half = describePublicPromo(promo({ percent_off: 50, duration: "forever" }), weekly);
    expect(half.headline).toBe("50% off for as long as you stay subscribed.");
    expect(half.lifetimeLine).toBe("Lifetime: $4.50 with this offer, normally $9.");
    for (const o of [yearly, weekly, quarterly]) {
      const words = Object.values(describePublicPromo(promo({ percent_off: 50, duration: "once" }), o)).join(" ");
      expect(words).not.toMatch(/\$0\.99|\$7\b|\$3\.50|year|week|3 months/);
    }
  });

  it("applies a running code at checkout instead of the code box", () => {
    const o = { variant: "a", priceIds: { subscription: "price_s", lifetime: "price_l" } };
    const withCode = checkoutParams("subscription", "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b", o, "promo_LAUNCH");
    expect(withCode.discounts).toEqual({ 0: { promotion_code: "promo_LAUNCH" } });
    expect(withCode.allow_promotion_codes).toBeUndefined();
    const without = checkoutParams("lifetime", "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b", o);
    expect(without.discounts).toBeUndefined();
    expect(without.allow_promotion_codes).toBe(true);
  });
});
