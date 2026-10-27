// Per-tab list of detected media. Lives in memory, mirrored to
// chrome.storage.session (debounced) so it survives service-worker restarts
// and so the UI can simply read storage.

import { storageKeys } from "../shared/messages";
import type { MediaItem, TabMedia } from "../shared/types";

const MAX_PER_TYPE = 10;
/** With a DASH manifest on the page, small direct files are its segments. */
const DASH_SEGMENT_BYTES = 20 * 1024 * 1024;
const WRITE_DELAY_MS = 300;

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

/** Pure merge rules, kept apart from storage so they can be tested. */
export function mergeMedia(list: MediaItem[], item: MediaItem): { list: MediaItem[]; changed: boolean } {
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

  if (list.some((m) => isMirror(m, item))) return { list, changed: false };

  const hasDash = list.some((m) => m.type === "dash");
  if (hasDash && isLikelyDashSegment(item)) return { list, changed: false };
  // A quality or audio playlist of a master we already list.
  if (list.some((m) => m.childUrls?.includes(item.url))) return { list, changed: false };

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
  async add(item: MediaItem): Promise<boolean> {
    const tab = (await this.get(item.tabId)) ?? { tabId: item.tabId, pageUrl: item.pageUrl, media: [] };
    const { list, changed } = mergeMedia(tab.media, item);
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
