// House ads, service worker side: keeps the ad list fresh, queues an ad
// before a download when the schedule says so, and counts saves. The popup
// shows the ad and starts the download after it (ui/ads-view.ts).

import { ADS_FEED_URL, adBeforeDownload, countSave, emptyAdState, parseFeed, type AdFeed, type AdState } from "../shared/ads";
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

/** A download is about to start. Returns whether an ad must run first. */
export async function gateDownload(): Promise<boolean> {
  const [state, feed] = await Promise.all([loadAdState(), loadFeed()]);
  const next = adBeforeDownload(state, feed, Date.now());
  if (next !== state) await chrome.storage.local.set({ [storageKeys.ads]: next });
  return Boolean(next.due);
}

/** Counts one completed save. Returns whether an ad ran before it. */
export async function countSaveForAds(): Promise<boolean> {
  const state = await loadAdState();
  await chrome.storage.local.set({ [storageKeys.ads]: countSave(state) });
  return Boolean(state.adThisSave);
}
