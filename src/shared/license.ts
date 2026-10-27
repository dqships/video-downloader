// The ad-free upgrade, extension side. Each install has a random ID, kept in
// chrome.storage.sync so it follows the person's Chrome profile to their other
// computers. Buying on the website tags the Stripe purchase with that ID, and
// the license check on the website (api/license.js) answers from Stripe.
// The ID says nothing about the person; it is all the extension ever sends.

import { storageKeys } from "./messages";

export const SITE_ORIGIN = "https://vidzilla.followusai.com";
export const UPGRADE_URL = `${SITE_ORIGIN}/upgrade`;
export const LICENSE_URL = `${SITE_ORIGIN}/api/license`;
/** The page Stripe returns to after a purchase. */
export const THANKS_PATH = "/upgrade-thanks";
/** How often a paid license is checked again (a yearly plan can lapse). */
export const LICENSE_TTL_MS = 24 * 3_600_000;

export interface License {
  adFree: boolean;
  plan?: "yearly" | "lifetime";
  /** When a yearly plan's paid period ends (ms); none for lifetime. */
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
  const plan = j.plan === "yearly" || j.plan === "lifetime" ? j.plan : undefined;
  const until = typeof j.until === "number" ? j.until : null;
  return { adFree: true, plan, until, checkedAt: now };
}

/** Ad-free right now: paid, and a yearly plan's period hasn't run out. */
export function isAdFree(license: License, now: number): boolean {
  return license.adFree && (license.until == null || license.until > now);
}
