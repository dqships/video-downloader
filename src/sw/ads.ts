// House ads, service worker side: keeps the ad list fresh and queues an ad
// after a save when the schedule says so. The popup shows it (ui/ads-view.ts).

import { ADS_FEED_URL, adAfterSave, emptyAdState, parseFeed, type AdFeed, type AdState } from "../shared/ads";
import { storageKeys } from "../shared/messages";

/** How long a fetched ad list is used before it's fetched again. */
const FEED_TTL_MS = 6 * 3_600_000;

interface CachedFeed {
  feed: AdFeed;
  fetchedAt: number;
}

/**
 * The ad list from the website, cached for a few hours. The request carries
 * no cookies and nothing about the user. Offline, or before the first fetch
 * works, the copy bundled with the extension stands in.
 */
export async function loadFeed(now = Date.now()): Promise<AdFeed> {
  const cached = (await chrome.storage.local.get(storageKeys.adFeed))[storageKeys.adFeed] as CachedFeed | undefined;
  if (cached && now - cached.fetchedAt < FEED_TTL_MS) return cached.feed;
  try {
    const res = await fetch(ADS_FEED_URL, { credentials: "omit", cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feed = parseFeed(await res.json());
    await chrome.storage.local.set({ [storageKeys.adFeed]: { feed, fetchedAt: now } satisfies CachedFeed });
    return feed;
  } catch {
    if (cached) return cached.feed;
    const bundled = await fetch(chrome.runtime.getURL("ads.json")).then((r) => r.json()).catch(() => ({}));
    return parseFeed(bundled);
  }
}

export async function loadAdState(): Promise<AdState> {
  const stored = (await chrome.storage.local.get(storageKeys.ads))[storageKeys.ads] as Partial<AdState> | undefined;
  return { ...emptyAdState, ...stored };
}

/**
 * Counts one completed save. `askDue` says the review or share prompt is up
 * for this save, in which case no ad comes with it. Returns whether an ad is
 * now waiting to be shown.
 */
export async function noteSavedForAds(askDue: boolean): Promise<boolean> {
  const [state, feed] = await Promise.all([loadAdState(), loadFeed()]);
  const next = adAfterSave(state, feed, Date.now(), askDue);
  await chrome.storage.local.set({ [storageKeys.ads]: next });
  return Boolean(next.due);
}
