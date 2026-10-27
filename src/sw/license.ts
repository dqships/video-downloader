// Keeps the ad-free license current: once a day, and right after a purchase
// (when the website's thanks page opens). A failed check keeps the last
// answer, so a network blip never brings ads back for someone who paid.

import { emptyAdState, type AdState } from "../shared/ads";
import { LICENSE_TTL_MS, LICENSE_URL, SITE_ORIGIN, THANKS_PATH, getInstallId, isAdFree, loadLicense, parseLicense } from "../shared/license";
import { storageKeys } from "../shared/messages";

/** A save waits for the daily check, so it mustn't hang. */
const CHECK_TIMEOUT_MS = 5000;

export async function refreshLicense(sessionId?: string): Promise<boolean> {
  const id = await getInstallId();
  const url = new URL(LICENSE_URL);
  url.searchParams.set("id", id);
  if (sessionId) url.searchParams.set("session", sessionId);
  const now = Date.now();
  let license = await loadLicense();
  try {
    const res = await fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const fresh = res.ok ? parseLicense(await res.json(), now) : undefined;
    if (fresh) license = fresh;
  } catch {
    // Offline or the site is down: keep what we had.
  }
  const stored = (await chrome.storage.local.get(storageKeys.ads))[storageKeys.ads] as Partial<AdState> | undefined;
  const adFree = isAdFree(license, now);
  await chrome.storage.local.set({
    [storageKeys.license]: license,
    [storageKeys.ads]: { ...emptyAdState, ...stored, adFree, ...(adFree ? { due: undefined } : {}) },
  });
  return adFree;
}

/** Checks again when the last answer is a day old. */
export async function refreshLicenseIfStale(): Promise<void> {
  const license = await loadLicense();
  if (Date.now() - license.checkedAt >= LICENSE_TTL_MS) await refreshLicense();
}

/** The thanks page carries the checkout's session ID, which confirms the purchase at once. */
export function watchThanksPage(): void {
  chrome.tabs.onUpdated.addListener((_tabId, change) => {
    if (!change.url?.startsWith(`${SITE_ORIGIN}${THANKS_PATH}`)) return;
    const session = new URL(change.url).searchParams.get("session_id") ?? undefined;
    void refreshLicense(session);
  });
}
