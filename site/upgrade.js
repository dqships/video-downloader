// Vidzilla website: the ad-free upgrade. On /upgrade the buttons start a
// Stripe Checkout for the install ID the extension put in the address; on
// /upgrade-thanks the page confirms the purchase. The extension learns about
// it on its own (it watches for the thanks page and asks the license API).

import { setupTheme } from "./theme.js";

setupTheme();

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "";
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

function setupBuy() {
  const status = document.getElementById("upgrade-status");
  const buttons = [...document.querySelectorAll(".plan-buy")];
  document.getElementById("upgrade-missing").hidden = validId;
  for (const button of buttons) {
    button.disabled = !validId;
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
    edge.textContent = license.until ? `Yearly · until ${DATE.format(license.until)}` : "Lifetime · paid once";
    text.textContent = "Thank you for supporting Vidzilla. You can close this tab.";
  } catch {
    edge.textContent = "Not confirmed yet";
    text.textContent = "Stripe hasn't confirmed the payment yet. Give it a minute, then use Check again in Vidzilla's Settings.";
  }
}

if (location.pathname.startsWith("/upgrade-thanks")) void confirmThanks();
else setupBuy();
