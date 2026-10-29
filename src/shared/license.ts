// The ad-free upgrade, extension side. Each install has a random ID, kept in
// chrome.storage.sync so it follows the person's Chrome profile to their other
// computers. Buying on the website tags the Stripe purchase with that ID, and
// the license check on the website (api/license.js) answers from Stripe.
// The ID says nothing about the person; it is all the extension ever sends.

import { storageKeys } from "./messages";

export const SITE_ORIGIN = "https://vidzilla.followusai.com";
export const UPGRADE_URL = `${SITE_ORIGIN}/upgrade`;
export const LICENSE_URL = `${SITE_ORIGIN}/api/license`;
/** What removing the ads costs this install (prices can be under test). */
export const PRICES_URL = `${SITE_ORIGIN}/api/prices`;
/** How long the prices shown in Settings are used before they're asked for again. */
export const PRICES_TTL_MS = 6 * 3_600_000;
/** Opens Stripe's customer portal for this install's subscription. */
export const PORTAL_URL = `${SITE_ORIGIN}/api/portal`;
/** The page Stripe returns to after a purchase. */
export const THANKS_PATH = "/upgrade-thanks";
/** How often a paid license is checked again (a yearly plan can lapse). */
export const LICENSE_TTL_MS = 24 * 3_600_000;
/** How often a copy checks after another computer on the profile reported a purchase. */
export const PAID_ELSEWHERE_RETRY_MS = 10 * 60_000;
/** A purchase reported elsewhere is trusted over a "no" for this long (Stripe's search lags). */
export const PAID_ELSEWHERE_GRACE_MS = 24 * 3_600_000;

export interface License {
  adFree: boolean;
  plan?: "subscription" | "lifetime";
  /** When a subscription's paid period ends (ms); none for lifetime. */
  until?: number | null;
  /** When the website last answered. */
  checkedAt: number;
}

export const noLicense: License = { adFree: false, checkedAt: 0 };

export async function getInstallId(): Promise<string> {
  const stored = (await chrome.storage.sync.get(storageKeys.installId))[storageKeys.installId];
  if (typeof stored === "string" && stored) return stored;
  const id = crypto.randomUUID();
  await chrome.storage.sync.set({ [storageKeys.installId]: id });
  return id;
}

export async function loadLicense(): Promise<License> {
  const stored = (await chrome.storage.local.get(storageKeys.license))[storageKeys.license] as Partial<License> | undefined;
  return { ...noLicense, ...stored };
}

/** The upgrade page for this install. */
export async function upgradeLink(base = UPGRADE_URL): Promise<string> {
  return `${base}?id=${encodeURIComponent(await getInstallId())}`;
}

/** Reads the website's answer; anything unexpected counts as no answer. */
export function parseLicense(json: unknown, now: number): License | undefined {
  if (!json || typeof json !== "object" || typeof (json as { adFree?: unknown }).adFree !== "boolean") return undefined;
  const j = json as { adFree: boolean; plan?: unknown; until?: unknown };
  if (!j.adFree) return { adFree: false, checkedAt: now };
  // "yearly" is what the website said before subscriptions could be weekly or quarterly.
  const plan = j.plan === "subscription" || j.plan === "yearly" ? "subscription" : j.plan === "lifetime" ? "lifetime" : undefined;
  const until = typeof j.until === "number" ? j.until : null;
  return { adFree: true, plan, until, checkedAt: now };
}

/** Ad-free right now: paid, and a subscription's period hasn't run out. */
export function isAdFree(license: License, now: number): boolean {
  return license.adFree && (license.until == null || license.until > now);
}

/**
 * Whether to ask the website now, without the user asking. Only copies that
 * paid check daily (a subscription can lapse, a payment can be refunded):
 * free copies would otherwise cost every install two Stripe searches a day.
 * A free copy checks when another computer on the same Chrome profile saw a
 * purchase (`paidAt`, synced), until it hears yes. Buying (the thanks page)
 * and Check again in Settings always ask.
 */
export function shouldCheck(license: License, paidAt: number | undefined, now: number): boolean {
  if (license.adFree) return now - license.checkedAt >= LICENSE_TTL_MS;
  // At once for a purchase newer than our last answer, then every few minutes.
  return paidAt !== undefined && (license.checkedAt < paidAt || now - license.checkedAt >= PAID_ELSEWHERE_RETRY_MS);
}

/**
 * The synced purchase mark after a check: set when this copy is paid, kept
 * while a fresh mark may just be ahead of Stripe's search, cleared once the
 * answer stays no (refunded, or a subscription ran out).
 */
export function nextPaidAt(paidAt: number | undefined, adFree: boolean, now: number): number | undefined {
  if (adFree) return paidAt ?? now;
  return paidAt !== undefined && now - paidAt < PAID_ELSEWHERE_GRACE_MS ? paidAt : undefined;
}

export interface Prices {
  /** "$0.99 a year" */
  subscription: string;
  /** "$9 once" */
  lifetime: string;
  fetchedAt: number;
}

/** Reads the website's prices; anything unexpected counts as no answer. */
export function parsePrices(json: unknown, now: number): Prices | undefined {
  const j = (json && typeof json === "object" ? json : {}) as { subscription?: unknown; lifetime?: unknown };
  const ok = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 40;
  return ok(j.subscription) && ok(j.lifetime) ? { subscription: j.subscription, lifetime: j.lifetime, fetchedAt: now } : undefined;
}

export async function loadPrices(): Promise<Prices | undefined> {
  return (await chrome.storage.local.get(storageKeys.prices))[storageKeys.prices] as Prices | undefined;
}

/** Asks the website what removing the ads costs this install, unless asked lately. */
export async function refreshPrices(now = Date.now()): Promise<Prices | undefined> {
  const cached = await loadPrices();
  if (cached && now - cached.fetchedAt < PRICES_TTL_MS) return cached;
  try {
    const url = new URL(PRICES_URL);
    url.searchParams.set("id", await getInstallId());
    const res = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(5000) });
    const fresh = res.ok ? parsePrices(await res.json(), now) : undefined;
    if (fresh) {
      await chrome.storage.local.set({ [storageKeys.prices]: fresh });
      return fresh;
    }
  } catch {
    // Offline: the last prices, if any, stay.
  }
  return cached;
}
