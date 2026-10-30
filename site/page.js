// Vidzilla website: script for the plain pages (about, pricing, contact, privacy, 404).
// On /pricing it also shows the launch offer, if one is running.

import { showOffer } from "./offer.js";
import { setupTheme } from "./theme.js";

setupTheme();

async function showPublicOffer() {
  try {
    const res = await fetch("/api/prices", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const prices = await res.json();
    const promo = prices.publicPromo ?? null;
    if (promo) document.getElementById("offer-lifetime").textContent = promo.lifetimeLine ?? "";
    showOffer(promo, Array.isArray(prices.pastPromos) ? prices.pastPromos : [], "applied at checkout");
  } catch {
    // No offer frame, then.
  }
}

if (document.getElementById("offer")) void showPublicOffer();
