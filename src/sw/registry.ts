// Per-tab list of detected media. Lives in memory, mirrored to
// chrome.storage.session (debounced) so it survives service-worker restarts
// and so the UI can simply read storage.

import { storageKeys } from "../shared/messages";
import type { MediaItem, TabMedia } from "../shared/types";

const MAX_PER_TYPE = 10;
/** With a DASH manifest on the page, small direct files are its segments. */
const DASH_SEGMENT_BYTES = 20 * 1024 * 1024;
const WRITE_DELAY_MS = 300;
/**
 * A player loads one stream per video, along with its tracks and mirrors in
 * the first seconds. Media that arrives this long after the last one means a
 * new video started (BBC plays the next one when the first ends).
 */
export const NEW_VIDEO_GAP_MS = 15_000;

function isLikelyDashSegment(item: MediaItem): boolean {
  return item.type === "http" && (item.sizeBytes ?? 0) < DASH_SEGMENT_BYTES;
}

/**
 * The same manifest from another CDN (players fail over between hosts that
 * serve identical paths, as BBC does).
 */
function isMirror(a: MediaItem, b: MediaItem): boolean {
  if (a.type !== b.type || (a.type !== "hls" && a.type !== "dash")) return false;
  try {
    const [ua, ub] = [new URL(a.url), new URL(b.url)];
    // A bare "/master.m3u8" says too little to call two streams the same.
    return ua.host !== ub.host && ua.pathname === ub.pathname && ua.pathname.split("/").filter(Boolean).length > 1;
  } catch {
    return false;
  }
}

/**
 * One stream under two URLs: the address a page declares before play and the
 * one its player loads, which often differ only in a token or a redirect flag.
 */
function isSameStream(a: MediaItem, b: MediaItem): boolean {
  if (a.type !== b.type || (a.type !== "hls" && a.type !== "dash")) return false;
  try {
    const [ua, ub] = [new URL(a.url), new URL(b.url)];
    return ua.host === ub.host && ua.pathname === ub.pathname && ua.pathname.split("/").filter(Boolean).length > 1;
  } catch {
    return false;
  }
}

/** What the page's player fetched; a player recording or the page's markup doesn't count. */
const isPlayback = (m: MediaItem) => m.sourceKind === "sniffer" && m.type !== "mse";

/**
 * Pure merge rules, kept apart from storage so they can be tested. `busy`
 * holds media with a download running, which is never dropped.
 */
export function mergeMedia(list: MediaItem[], item: MediaItem, busy: ReadonlySet<string> = new Set()): { list: MediaItem[]; changed: boolean } {
  const existing = list.findIndex((m) => m.id === item.id);
  if (existing >= 0) {
    const old = list[existing]!;
    // Keep the first sighting but fill in anything we learned since.
    const merged: MediaItem = {
      ...old,
      sizeBytes: old.sizeBytes ?? item.sizeBytes,
      supportsRanges: old.supportsRanges || item.supportsRanges,
      serverFilename: old.serverFilename ?? item.serverFilename,
      // The player's own request carries the cookies a page-declared URL lacks.
      sentHeaders:
        old.sourceKind === "page" && item.sourceKind === "sniffer"
          ? item.sentHeaders
          : Object.keys(old.sentHeaders).length
            ? old.sentHeaders
            : item.sentHeaders,
      sourceKind: old.sourceKind === "sniffer" || item.sourceKind === "sniffer" ? "sniffer" : "page",
      title: old.title ?? item.title,
      thumbnail: old.thumbnail ?? item.thumbnail,
      rank: old.rank ?? item.rank,
      variants: old.variants ?? item.variants,
      childUrls: old.childUrls ?? item.childUrls,
      durationSec: old.durationSec ?? item.durationSec,
      isLive: old.isLive ?? item.isLive,
      subtitles: old.subtitles ?? item.subtitles,
      hasDrm: old.hasDrm || item.hasDrm,
    };
    for (const key of ["variants", "childUrls", "durationSec", "isLive", "subtitles", "title", "thumbnail", "rank"] as const) {
      if (merged[key] === undefined) delete merged[key];
    }
    const changed = JSON.stringify(merged) !== JSON.stringify(old);
    if (!changed) return { list, changed: false };
    const next = list.slice();
    next[existing] = merged;
    return { list: next, changed: true };
  }

  // A player recording is a last resort: never next to a stream we can fetch
  // (one whose qualities are all WebM, which we can't save yet, doesn't count).
  const isStream = (m: MediaItem) => (m.type === "hls" || m.type === "dash") && m.variants?.length !== 0;
  if (item.type === "mse" && !item.recording && list.some(isStream)) return { list, changed: false };
  if (isStream(item)) list = list.filter((m) => m.type !== "mse" || m.recording);

  // A stream listed before play and the same stream loaded by the player: keep
  // the player's copy (fresh token, the page's cookies) under the page's name.
  if (item.sourceKind === "page") {
    const played = list.findIndex((m) => m.sourceKind === "sniffer" && isSameStream(m, item));
    if (played >= 0) {
      const old = list[played]!;
      const named = { ...old, title: old.title ?? item.title, thumbnail: old.thumbnail ?? item.thumbnail };
      for (const key of ["title", "thumbnail"] as const) if (named[key] === undefined) delete named[key];
      if (JSON.stringify(named) === JSON.stringify(old)) return { list, changed: false };
      const next = list.slice();
      next[played] = named;
      return { list: next, changed: true };
    }
  } else {
    const declared = list.find((m) => m.sourceKind === "page" && !busy.has(m.id) && isSameStream(m, item));
    if (declared) {
      list = list.filter((m) => m !== declared);
      item = { ...item, title: item.title ?? declared.title, thumbnail: item.thumbnail ?? declared.thumbnail };
      for (const key of ["title", "thumbnail"] as const) if (item[key] === undefined) delete item[key];
    }
  }

  if (list.some((m) => isMirror(m, item))) return { list, changed: false };

  const hasDash = list.some((m) => m.type === "dash");
  if (hasDash && isLikelyDashSegment(item)) return { list, changed: false };
  // A quality or audio playlist of a master we already list.
  if (list.some((m) => m.childUrls?.includes(item.url))) return { list, changed: false };

  // A new video is playing: list only it, not every video the page played before.
  const before = item.detectedAt - NEW_VIDEO_GAP_MS;
  if (isPlayback(item) && list.some((m) => isPlayback(m) && m.detectedAt <= before)) {
    list = list.filter((m) => m.detectedAt > before || m.recording || busy.has(m.id));
  }

  let next = [...list, item];
  if (item.type === "dash") next = next.filter((m) => !isLikelyDashSegment(m));
  if (item.childUrls?.length) {
    const children = new Set(item.childUrls);
    next = next.filter((m) => !children.has(m.url));
  }
  const sameType = next.filter((m) => m.type === item.type);
  if (sameType.length > MAX_PER_TYPE) {
    const drop = new Set(sameType.slice(0, sameType.length - MAX_PER_TYPE).map((m) => m.id));
    next = next.filter((m) => !drop.has(m.id));
  }
  return { list: next, changed: true };
}

export class Registry {
  private tabs = new Map<number, TabMedia>();
  private dirty = new Set<number>();
  private removed = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private onChange: (tab: TabMedia | undefined, tabId: number) => void = () => {}) {}

  async get(tabId: number): Promise<TabMedia | undefined> {
    const cached = this.tabs.get(tabId);
    if (cached) return cached;
    const key = storageKeys.tab(tabId);
    const stored = (await chrome.storage.session.get(key))[key] as TabMedia | undefined;
    if (stored && !this.tabs.has(tabId)) this.tabs.set(tabId, stored);
    return this.tabs.get(tabId);
  }

  /** Returns true when the item is new or changed something. */
  async add(item: MediaItem, busy?: ReadonlySet<string>): Promise<boolean> {
    const tab = (await this.get(item.tabId)) ?? { tabId: item.tabId, pageUrl: item.pageUrl, media: [] };
    const { list, changed } = mergeMedia(tab.media, item, busy);
    if (!changed) return false;
    this.put({ ...tab, media: list });
    return true;
  }

  async update(tabId: number, patch: Partial<Pick<TabMedia, "title" | "thumbnail" | "pageUrl" | "subtitles" | "drmKeySystem">>): Promise<void> {
    const tab = await this.get(tabId);
    if (tab) this.put({ ...tab, ...patch });
  }

  async findMedia(tabId: number, mediaId: string): Promise<{ tab: TabMedia; item: MediaItem } | undefined> {
    const tab = await this.get(tabId);
    const item = tab?.media.find((m) => m.id === mediaId);
    return tab && item ? { tab, item } : undefined;
  }

  clear(tabId: number): void {
    this.tabs.delete(tabId);
    this.dirty.delete(tabId);
    this.removed.add(tabId);
    this.onChange(undefined, tabId);
    this.schedule();
  }

  private put(tab: TabMedia): void {
    this.tabs.set(tab.tabId, tab);
    this.removed.delete(tab.tabId);
    this.dirty.add(tab.tabId);
    this.onChange(tab, tab.tabId);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), WRITE_DELAY_MS);
  }

  async flush(): Promise<void> {
    this.timer = undefined;
    const writes: Record<string, TabMedia> = {};
    for (const id of this.dirty) {
      const tab = this.tabs.get(id);
      if (tab) writes[storageKeys.tab(id)] = tab;
    }
    const removes = [...this.removed].map(storageKeys.tab);
    this.dirty.clear();
    this.removed.clear();
    if (Object.keys(writes).length) await chrome.storage.session.set(writes);
    if (removes.length) await chrome.storage.session.remove(removes);
  }
}
