// Service worker entry. Listeners are registered synchronously at top level so
// Chrome wakes the worker for network traffic and messages.

import { hash53 } from "../shared/hash";
import type { Command, CommandResult } from "../shared/messages";
import type { MediaItem, TabMedia } from "../shared/types";
import type { FromOffscreenEnvelope } from "../shared/worker-protocol";
import { classify } from "./classify";
import { Downloads } from "./downloads";
import { HeaderCache, replayableHeaders } from "./headers";
import { probeDash } from "./dash-probe";
import { probeHls } from "./hls-probe";
import { Registry } from "./registry";
import { clearStaleRules } from "./replay";

const SNIFF_TYPES = ["xmlhttprequest", "media", "sub_frame", "other"] as chrome.webRequest.ResourceType[];
const BADGE_COLOR = "#C8781E";

const headerCache = new HeaderCache();
const registry = new Registry(updateBadge);
const downloads = new Downloads();
const metaRequested = new Set<number>();
/** Detected responses still being read and listed, per tab. */
const handling = new Map<number, Set<Promise<unknown>>>();

function track(tabId: number, work: Promise<unknown>): void {
  const set = handling.get(tabId) ?? new Set();
  handling.set(tabId, set);
  set.add(work);
  void work.finally(() => {
    set.delete(work);
    if (!set.size && handling.get(tabId) === set) handling.delete(tabId);
  });
}

function updateBadge(tab: TabMedia | undefined, tabId: number): void {
  const count = tab?.media.length ?? 0;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => headerCache.put(details.requestId, replayableHeaders(details.requestHeaders)),
  { urls: ["<all_urls>"], types: SNIFF_TYPES },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => onResponse(details),
  { urls: ["<all_urls>"], types: SNIFF_TYPES },
  ["responseHeaders", "extraHeaders"],
);

function onResponse(details: chrome.webRequest.OnResponseStartedDetails): void {
  if (details.tabId < 0) return;
  const found = classify({
    url: details.url,
    type: details.type,
    statusCode: details.statusCode,
    responseHeaders: details.responseHeaders ?? [],
    initiator: details.initiator,
  });
  if (!found) return;
  // A manifest seen earlier on this tab may own this URL (a player fetches the
  // master, then its quality playlists or track files), so media is listed in
  // arrival order, each after the ones before it are read.
  const earlier = [...(handling.get(details.tabId) ?? [])];
  track(details.tabId, handleResponse(details, found, earlier));
}

async function handleResponse(
  details: chrome.webRequest.OnResponseStartedDetails,
  found: NonNullable<ReturnType<typeof classify>>,
  earlier: Promise<unknown>[],
): Promise<void> {
  const tab = await chrome.tabs.get(details.tabId).catch(() => undefined);
  if (!tab) return;
  const sentHeaders = headerCache.get(details.requestId) ?? {};
  const known = await registry.get(details.tabId);
  // Quality playlists of a listed master, and repeat sightings, need no probe.
  const isStream = found.type !== "http";
  if (known?.media.some((m) => m.childUrls?.includes(details.url) || (isStream && m.url === details.url))) return;
  const streamDetails =
    found.type === "hls" ? await probeHls(details.url, sentHeaders) : found.type === "dash" ? await probeDash(details.url, sentHeaders) : {};
  await Promise.allSettled(earlier);
  const now = await registry.get(details.tabId);
  if (now?.media.some((m) => m.childUrls?.includes(details.url))) return;
  const item: MediaItem = {
    id: hash53(details.url),
    type: found.type,
    url: details.url,
    tabId: details.tabId,
    pageUrl: tab.url ?? details.initiator ?? "",
    mime: found.mime,
    ext: found.ext,
    sizeBytes: found.sizeBytes,
    supportsRanges: found.supportsRanges,
    serverFilename: found.serverFilename,
    sentHeaders,
    hasDrm: false,
    detectedAt: Date.now(),
    sourceKind: "sniffer",
    ...streamDetails,
  };
  const added = await registry.add(item);
  if (added && !metaRequested.has(details.tabId)) {
    metaRequested.add(details.tabId);
    void readPageMeta(details.tabId);
  }
}

/** Title and thumbnail, read from the page itself. */
async function readPageMeta(tabId: number): Promise<void> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || undefined;
        const abs = (u: string | undefined | null) => {
          try {
            return u ? new URL(u, location.href).href : undefined;
          } catch {
            return undefined;
          }
        };
        return {
          title: document.title.trim() || meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]'),
          thumbnail:
            abs(document.querySelector("video[poster]")?.getAttribute("poster")) ??
            abs(meta('meta[property="og:image"]')) ??
            abs(meta('meta[name="twitter:image"]')) ??
            abs(document.querySelector('link[rel="image_src"]')?.getAttribute("href")),
          pageUrl: location.href,
        };
      },
    });
    if (res?.result) await registry.update(tabId, res.result);
  } catch {
    // Restricted pages (chrome://, the Web Store) refuse scripts; keep going.
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  metaRequested.delete(d.tabId);
  registry.clear(d.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  metaRequested.delete(tabId);
  registry.clear(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.title) void registry.get(tabId).then((t) => t && registry.update(tabId, { title: change.title }));
});

chrome.runtime.onMessage.addListener((msg: Command | FromOffscreenEnvelope, _sender, respond) => {
  if ("target" in msg) {
    if (msg.target !== "service-worker") return;
    downloads.onWorkerMessage(msg.message).finally(() => respond(true));
    return true;
  }
  handle(msg).then(respond, (err) => respond({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // respond asynchronously
});

async function handle(cmd: Command): Promise<CommandResult> {
  switch (cmd.kind) {
    case "download": {
      const found = await registry.findMedia(cmd.payload.tabId, cmd.payload.mediaId);
      if (!found) return { ok: false, error: "That video is no longer on this page. Reload and try again." };
      const jobId = await downloads.start(found.tab, found.item, cmd.payload.filename, cmd.payload.variantId);
      return { ok: true, jobId };
    }
    case "cancel":
      await downloads.cancel(cmd.payload.jobId);
      return { ok: true };
    case "clear-tab":
      registry.clear(cmd.payload.tabId);
      return { ok: true };
  }
}

chrome.runtime.onStartup.addListener(() => void clearStaleRules());
chrome.runtime.onInstalled.addListener(() => void clearStaleRules());
