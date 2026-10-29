import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS Vercel function module
import { checkLicense, checkoutParams, formEncode, isInstallId, portalSession, stripeClient } from "../../api/_stripe.js";

const ID = "3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b";

/** A fake Stripe that answers by path. */
function fake(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; params: Record<string, unknown> }[] = [];
  const stripe = async (method: string, path: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, path, params });
    if (!(path in routes)) throw new Error(`unexpected ${path}`);
    return routes[path];
  };
  return { stripe, calls };
}

const empty = { data: [] };

describe("checkout", () => {
  const offer = { variant: "b", priceIds: { subscription: "price_s", lifetime: "price_l" } };

  it("sells the subscription at the install's group price, tagged with the install ID and group", () => {
    const p = checkoutParams("subscription", ID, offer);
    expect(p.mode).toBe("subscription");
    expect(p.line_items[0]).toEqual({ quantity: 1, price: "price_s" });
    expect(p.subscription_data.metadata).toEqual({ install_id: ID, variant: "b" });
    expect(p.client_reference_id).toBe(ID);
    expect(p.allow_promotion_codes).toBe(true);
    expect(p.success_url).toContain("{CHECKOUT_SESSION_ID}");
  });

  it("sells lifetime as a one-time payment tagged with the install ID and group", () => {
    const p = checkoutParams("lifetime", ID, offer);
    expect(p.mode).toBe("payment");
    expect(p.line_items[0].price).toBe("price_l");
    expect(p.payment_intent_data.metadata).toEqual({ install_id: ID, variant: "b" });
    expect(p.allow_promotion_codes).toBe(true);
  });

  it("form-encodes nested params the way Stripe reads them", () => {
    const body = formEncode({ line_items: { 0: { price: "p", quantity: 1 } }, expand: ["a"], skip: undefined });
    expect(body.toString()).toBe("line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&expand%5B0%5D=a");
  });

  it("only accepts a random UUID as the install ID", () => {
    expect(isInstallId(ID)).toBe(true);
    expect(isInstallId("x' OR status:'succeeded")).toBe(false);
    expect(isInstallId(undefined)).toBe(false);
  });
});

describe("license", () => {
  it("is ad-free for good after a paid, unrefunded one-time payment", async () => {
    const { stripe } = fake({
      "/v1/payment_intents/search": { data: [{ status: "succeeded", latest_charge: { refunded: false } }] },
    });
    expect(await checkLicense(stripe, ID)).toEqual({ adFree: true, plan: "lifetime", until: null });
  });

  it("isn't ad-free after a refund", async () => {
    const { stripe } = fake({
      "/v1/payment_intents/search": { data: [{ status: "succeeded", latest_charge: { refunded: true } }] },
      "/v1/subscriptions/search": empty,
    });
    expect(await checkLicense(stripe, ID)).toEqual({ adFree: false });
  });

  it("is ad-free until the end of a live subscription, not after it lapses", async () => {
    const live = fake({
      "/v1/payment_intents/search": empty,
      "/v1/subscriptions/search": { data: [{ status: "active", current_period_end: 1_900_000_000 }] },
    });
    expect(await checkLicense(live.stripe, ID)).toEqual({ adFree: true, plan: "subscription", until: 1_900_000_000_000 });
    const lapsed = fake({
      "/v1/payment_intents/search": empty,
      "/v1/subscriptions/search": { data: [{ status: "canceled", current_period_end: 1_700_000_000 }] },
    });
    expect(await checkLicense(lapsed.stripe, ID)).toEqual({ adFree: false });
  });

  it("searches by the install ID", async () => {
    const { stripe, calls } = fake({ "/v1/payment_intents/search": empty, "/v1/subscriptions/search": empty });
    await checkLicense(stripe, ID);
    expect(calls[0]!.params.query).toBe(`metadata['install_id']:'${ID}' AND status:'succeeded'`);
    expect(calls[1]!.params.query).toBe(`metadata['install_id']:'${ID}'`);
  });

  it("trusts the thanks page's checkout only when it belongs to this install", async () => {
    const paid = fake({
      [`/v1/checkout/sessions/cs_live_abcdefghijkl`]: {
        client_reference_id: ID,
        status: "complete",
        payment_status: "paid",
        mode: "payment",
        payment_intent: { status: "succeeded", latest_charge: { refunded: false } },
      },
    });
    expect(await checkLicense(paid.stripe, ID, "cs_live_abcdefghijkl")).toEqual({ adFree: true, plan: "lifetime", until: null });
    const other = fake({
      [`/v1/checkout/sessions/cs_live_abcdefghijkl`]: { client_reference_id: "someone-else", status: "complete", payment_status: "paid", mode: "payment" },
      "/v1/payment_intents/search": empty,
      "/v1/subscriptions/search": empty,
    });
    expect(await checkLicense(other.stripe, ID, "cs_live_abcdefghijkl")).toEqual({ adFree: false });
  });

  it("keeps a one-time purchase a 100% off coupon made free, through its checkout", async () => {
    const { stripe } = fake({
      [`/v1/checkout/sessions/cs_live_abcdefghijkl`]: { client_reference_id: ID, status: "complete", payment_status: "no_payment_required", mode: "payment", payment_intent: null },
    });
    expect(await checkLicense(stripe, ID, "cs_live_abcdefghijkl")).toEqual({ adFree: true, plan: "lifetime", until: null });
  });

  it("doesn't let a refunded or lapsed checkout keep the ads off", async () => {
    const refunded = fake({
      [`/v1/checkout/sessions/cs_live_abcdefghijkl`]: {
        client_reference_id: ID,
        status: "complete",
        payment_status: "paid",
        mode: "payment",
        payment_intent: { status: "succeeded", latest_charge: { refunded: true } },
      },
      "/v1/payment_intents/search": empty,
      "/v1/subscriptions/search": empty,
    });
    expect(await checkLicense(refunded.stripe, ID, "cs_live_abcdefghijkl")).toEqual({ adFree: false });
    const lapsed = fake({
      [`/v1/checkout/sessions/cs_live_abcdefghijkl`]: { client_reference_id: ID, status: "complete", payment_status: "paid", mode: "subscription", subscription: { status: "canceled" } },
      "/v1/payment_intents/search": empty,
      "/v1/subscriptions/search": empty,
    });
    expect(await checkLicense(lapsed.stripe, ID, "cs_live_abcdefghijkl")).toEqual({ adFree: false });
  });

  it("calls Stripe with the key, a pinned version and form encoding", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "cs_1" }), { status: 200 }));
    const stripe = stripeClient("sk_test_x", fetchImpl);
    await stripe("POST", "/v1/checkout/sessions", { mode: "payment" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_x");
    expect((init.headers as Record<string, string>)["Stripe-Version"]).toBeTruthy();
    expect(String(init.body)).toBe("mode=payment");
  });
});

describe("customer portal", () => {
  it("opens the portal for the customer of this install's live subscription", async () => {
    const { stripe, calls } = fake({
      "/v1/subscriptions/search": {
        data: [
          { status: "canceled", created: 20, customer: "cus_old" },
          { status: "active", created: 10, customer: "cus_live" },
        ],
      },
      "/v1/billing_portal/sessions": { url: "https://billing.stripe.com/p/session/x" },
    });
    expect(await portalSession(stripe, ID)).toBe("https://billing.stripe.com/p/session/x");
    expect(calls[0]!.params.query).toBe(`metadata['install_id']:'${ID}'`);
    expect(calls[1]).toMatchObject({ method: "POST", params: { customer: "cus_live", return_url: "https://vidzilla.followusai.com" } });
  });

  it("has nothing to open for an install without a subscription", async () => {
    const { stripe, calls } = fake({ "/v1/subscriptions/search": empty });
    expect(await portalSession(stripe, ID)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
