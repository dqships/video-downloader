// Keeps the ad-free license current: once a day for a copy that paid, and
// right after a purchase (when the website's thanks page opens, or when
// another computer on the same Chrome profile reports one). A failed check
// keeps the last answer, so a network blip never brings ads back for someone
// who paid. The checkout that confirmed a purchase is kept (synced with the
// Chrome profile) and sent with every later check: for a one-time purchase a
// 100% off coupon made free, it's the only record Stripe has.

import { emptyAdState, type AdState } from "../shared/ads";
import { LICENSE_URL, SITE_ORIGIN, THANKS_PATH, getInstallId, isAdFree, loadLicense, nextPaidAt, parseLicense, shouldCheck } from "../shared/license";
import { storageKeys } from "../shared/messages";

/** A save waits for the daily check, so it mustn't hang. */
const CHECK_TIMEOUT_MS = 5000;

async function loadPaidAt(): Promise<number | undefined> {
  const stored = (await chrome.storage.sync.get(storageKeys.paidAt))[storageKeys.paidAt];
  return typeof stored === "number" ? stored : undefined;
}

async function loadPaidSession(): Promise<string | undefined> {
  const stored = (await chrome.storage.sync.get(storageKeys.paidSession))[storageKeys.paidSession];
  return typeof stored === "string" ? stored : undefined;
}

export async function refreshLicense(sessionId?: string): Promise<boolean> {
  const id = await getInstallId();
  const kept = await loadPaidSession();
  const session = sessionId ?? kept;
  const url = new URL(LICENSE_URL);
  url.searchParams.set("id", id);
  if (session) url.searchParams.set("session", session);
  const now = Date.now();
  let license = await loadLicense();
  let answered = false;
  try {
    const res = await fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const fresh = res.ok ? parseLicense(await res.json(), now) : undefined;
    if (fresh) {
      license = fresh;
      answered = true;
    }
  } catch {
    // Offline or the site is down: keep what we had.
  }
  const stored = (await chrome.storage.local.get(storageKeys.ads))[storageKeys.ads] as Partial<AdState> | undefined;
  const adFree = isAdFree(license, now);
  await chrome.storage.local.set({
    [storageKeys.license]: license,
    [storageKeys.ads]: { ...emptyAdState, ...stored, adFree, ...(adFree ? { due: undefined } : {}) },
  });
  if (answered) {
    // Keep the checkout that just said yes; forget one that now says no (refunded, lapsed).
    if (adFree && sessionId && sessionId !== kept) await chrome.storage.sync.set({ [storageKeys.paidSession]: sessionId });
    if (!adFree && kept) await chrome.storage.sync.remove(storageKeys.paidSession);
    const paidAt = await loadPaidAt();
    const next = nextPaidAt(paidAt, adFree, now);
    if (next !== paidAt) await (next === undefined ? chrome.storage.sync.remove(storageKeys.paidAt) : chrome.storage.sync.set({ [storageKeys.paidAt]: next }));
  }
  return adFree;
}

/** Checks when a paid license is a day old, or another computer reported a purchase. */
export async function refreshLicenseIfStale(): Promise<void> {
  const [license, paidAt] = await Promise.all([loadLicense(), loadPaidAt()]);
  if (shouldCheck(license, paidAt, Date.now())) await refreshLicense();
}

/** The thanks page carries the checkout's session ID, which confirms the purchase at once. */
export function watchThanksPage(): void {
  chrome.tabs.onUpdated.addListener((_tabId, change) => {
    if (!change.url?.startsWith(`${SITE_ORIGIN}${THANKS_PATH}`)) return;
    const session = new URL(change.url).searchParams.get("session_id") ?? undefined;
    void refreshLicense(session);
  });
  // A purchase on another computer signed in to the same Chrome profile.
  chrome.storage.sync.onChanged.addListener((changes) => {
    if (typeof changes[storageKeys.paidAt]?.newValue === "number") void refreshLicenseIfStale();
  });
}
