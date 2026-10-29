// Vidzilla website: the ad-free upgrade. On /upgrade the buttons start a
// Stripe Checkout for the install ID the extension put in the address, and
// the prices shown switch to that install's (the page is built with the
// first test group's; see api/_prices.js); on
// /upgrade-thanks the page confirms the purchase. The extension learns about
// it on its own (it watches for the thanks page and asks the license API).

import { setupTheme } from "./theme.js";

setupTheme();

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "";
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });

/**
 * The offer running now (its code is applied at checkout) and the rounds
 * before it, with how many people they reached. See api/_promos.js.
 */
function showOffer(promo, past) {
  const box = document.getElementById("offer");
  const list = document.getElementById("offer-past");
  list.replaceChildren(
    ...past
      .filter((line) => typeof line === "string")
      .map((line) => Object.assign(document.createElement("li"), { textContent: line })),
  );
  if (promo) {
    document.getElementById("offer-edge").textContent = `${promo.label} · code ${promo.code}, applied for you`;
    document.getElementById("offer-title").textContent = promo.headline;
    const ends = typeof promo.endsAt === "number" ? `ends ${DAY.format(promo.endsAt)}` : "";
    document.getElementById("offer-status").textContent = [promo.claimed, ends].filter(Boolean).join(" · ");
    for (const el of document.querySelectorAll("[data-offer]")) {
      el.textContent = promo[el.dataset.offer] ?? "";
      el.hidden = !el.textContent;
    }
    for (const button of document.querySelectorAll(".plan-buy")) {
      const label = promo[`${button.dataset.plan}Button`];
      if (typeof label === "string") button.textContent = label;
    }
  }
  box.classList.toggle("offer--ended", !promo);
  box.hidden = !promo && !list.children.length;
}

/** Shows this install's prices: the [data-price] spans name what they hold. */
async function showPrices() {
  try {
    const res = await fetch(`/api/prices?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const prices = await res.json();
    for (const el of document.querySelectorAll("[data-price]")) {
      const text = prices[el.dataset.price];
      if (typeof text === "string") el.textContent = text;
    }
    showOffer(prices.promo ?? null, Array.isArray(prices.pastPromos) ? prices.pastPromos : []);
  } catch {
    // The built-in prices stay.
  }
}

function setupBuy() {
  const status = document.getElementById("upgrade-status");
  const buttons = [...document.querySelectorAll(".plan-buy")];
  document.getElementById("upgrade-missing").hidden = validId;
  // The buttons wait for this install's prices, so nobody clicks a price they won't pay.
  if (validId) void showPrices().finally(() => buttons.forEach((b) => (b.disabled = false)));
  for (const button of buttons) {
    button.addEventListener("click", async () => {
      buttons.forEach((b) => (b.disabled = true));
      status.textContent = "Opening the secure checkout";
      try {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: button.dataset.plan, id }),
        });
        const body = await res.json();
        if (!res.ok || !body.url) throw new Error(body.error || "Checkout didn't open");
        location.href = body.url;
      } catch (err) {
        status.textContent = `${err.message}. Try again in a minute.`;
        buttons.forEach((b) => (b.disabled = false));
      }
    });
  }
}

async function confirmThanks() {
  const title = document.getElementById("thanks-title");
  const edge = document.getElementById("thanks-edge");
  const text = document.getElementById("thanks-text");
  const session = params.get("session_id") ?? "";
  if (!validId || !session) {
    text.textContent = "This page doesn't carry a purchase to confirm.";
    return;
  }
  try {
    const res = await fetch(`/api/license?id=${encodeURIComponent(id)}&session=${encodeURIComponent(session)}`);
    const license = await res.json();
    if (!license.adFree) throw new Error("not confirmed");
    title.textContent = "Thanks, the ads are off";
    edge.textContent = license.until ? `Subscription · paid until ${DATE.format(license.until)}` : "Lifetime · paid once";
    text.textContent = "Thank you for supporting Vidzilla. You can close this tab.";
  } catch {
    edge.textContent = "Not confirmed yet";
    text.textContent = "Stripe hasn't confirmed the payment yet. Give it a minute, then use Check again in Vidzilla's Settings.";
  }
}

if (location.pathname.startsWith("/upgrade-thanks")) void confirmThanks();
else setupBuy();
