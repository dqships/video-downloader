import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS Vercel function module
import { clearPriceCache, describeOffer, money, offerFor, subscriptionPriceIds, variantIndex } from "../../api/_prices.js";

const prices: Record<string, unknown> = {
  "/v1/prices/price_year": { unit_amount: 99, currency: "usd", recurring: { interval: "year", interval_count: 1 } },
  "/v1/prices/price_week": { unit_amount: 99, currency: "usd", recurring: { interval: "week", interval_count: 1 } },
  "/v1/prices/price_quarter": { unit_amount: 700, currency: "usd", recurring: { interval: "month", interval_count: 3 } },
  "/v1/prices/price_life": { unit_amount: 900, currency: "usd", recurring: null },
};
let calls = 0;
const stripe = async (_method: string, path: string) => {
  calls++;
  if (!(path in prices)) throw new Error(`unexpected ${path}`);
  return prices[path];
};
const env = { STRIPE_PRICE_SUBSCRIPTIONS: "price_year, price_week,price_quarter", STRIPE_PRICE_LIFETIME: "price_life" };

beforeEach(() => {
  clearPriceCache();
  calls = 0;
});

describe("prices", () => {
  it("writes prices the way the pages say them", () => {
    const words = (interval: string, count: number, amount = 99) => describeOffer({ variant: "a", subscription: { amount, currency: "usd", interval, count }, lifetime: { amount: 900, currency: "usd" } });
    expect(words("year", 1)).toMatchObject({ subscription: "$0.99 a year", subscriptionName: "Yearly", renews: "every year", lifetime: "$9 once", lifetimeAmount: "$9" });
    expect(words("week", 1)).toMatchObject({ subscription: "$0.99 a week", subscriptionName: "Weekly", renews: "every week" });
    expect(words("month", 3, 700)).toMatchObject({ subscription: "$7 every 3 months", subscriptionName: "Quarterly", renews: "every 3 months" });
    expect(money(1250)).toBe("$12.50");
  });

  it("reads the list of prices under test, or the single yearly one", () => {
    expect(subscriptionPriceIds(env)).toEqual(["price_year", "price_week", "price_quarter"]);
    expect(subscriptionPriceIds({ STRIPE_PRICE_YEARLY: "price_year" })).toEqual(["price_year"]);
    expect(subscriptionPriceIds({})).toEqual([]);
  });

  it("splits installs into even groups that never change for one install", () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[variantIndex(crypto.randomUUID(), 3)]!++;
    for (const n of counts) expect(n).toBeGreaterThan(850);
    const id = crypto.randomUUID();
    expect(variantIndex(id, 3)).toBe(variantIndex(id, 3));
    expect(variantIndex(id, 1)).toBe(0);
    expect(variantIndex(undefined, 3)).toBe(0);
  });

  it("offers each install its group's price, and the public pages the first group's", async () => {
    // 0x...00 → group a, 0x...01 → b, 0x...02 → c
    const b = await offerFor(stripe, env, "00000001-0000-4000-8000-000000000000");
    expect(b.variant).toBe("b");
    expect(b.priceIds).toEqual({ subscription: "price_week", lifetime: "price_life" });
    expect(describeOffer(b).subscription).toBe("$0.99 a week");
    const c = await offerFor(stripe, env, "00000002-0000-4000-8000-000000000000");
    expect(describeOffer(c).subscription).toBe("$7 every 3 months");
    const anyone = await offerFor(stripe, env, undefined);
    expect(anyone.variant).toBe("a");
    expect(describeOffer(anyone).subscription).toBe("$0.99 a year");
  });

  it("asks Stripe for a price once every few minutes, not on every request", async () => {
    await offerFor(stripe, env, undefined, 0);
    await offerFor(stripe, env, undefined, 60_000);
    expect(calls).toBe(2);
    await offerFor(stripe, env, undefined, 11 * 60_000);
    expect(calls).toBe(4);
  });

  it("says so when the prices aren't set up", async () => {
    await expect(offerFor(stripe, {}, undefined)).rejects.toThrow(/set up/);
  });
});
