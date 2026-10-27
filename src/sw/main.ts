// Service worker entry. Listeners are registered synchronously at top level so
// Chrome wakes the worker for network traffic and messages.

import { hash53 } from "../shared/hash";
import { cleanTitle } from "../shared/titles";
import type { Command, CommandResult } from "../shared/messages";
import type { MediaItem, SubtitleTrack, TabMedia } from "../shared/types";
import type { FromOffscreenEnvelope } from "../shared/worker-protocol";
import { classify } from "./classify";
import { Downloads } from "./downloads";
import { HeaderCache, replayableHeaders } from "./headers";
import { probeDash } from "./dash-probe";
import { probeHls, type FrameRef } from "./hls-probe";
import { checkCandidate, scanTab } from "./page-probe";
import { enrich } from "./sites";
import { Registry } from "./registry";
import { clearStaleRules } from "./replay";
import { refreshLicense, refreshLicenseIfStale, watchThanksPage } from "./license";
import { watchSidePanelSetting } from "./side-panel";

/** Single-page apps swap videos without a page load; look again once they settle. */
const RESCAN_DELAY_MS = 1500;
const PLAYER_GRACE_MS = 3000;
const SNIFF_TYPES = ["xmlhttprequest", "media", "sub_frame", "other"] as chrome.webRequest.ResourceType[];
const BADGE_COLOR = "#C8781E";

const headerCache = new HeaderCache();
const registry = new Registry(updateBadge);
const downloads = new Downloads();
const metaRequested = new Set<number>();
/** DRM seen on a tab before any media was listed there. */
const pendingDrm = new Map<number, string>();
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
  await list({
    tabId: details.tabId,
    url: details.url,
    found,
    sentHeaders: headerCache.get(details.requestId) ?? {},
    pageUrl: tab.url ?? details.initiator ?? "",
    frame: { tabId: details.tabId, frameId: details.frameId },
    earlier,
    extra: { sourceKind: "sniffer" },
  });
}

/** Probes a stream's manifest if needed, then lists it after the media seen before it. */
async function list(input: {
  tabId: number;
  url: string;
  found: NonNullable<ReturnType<typeof classify>>;
  sentHeaders: Record<string, string>;
  pageUrl: string;
  /** The frame that loaded the URL, when a request showed us. */
  frame?: FrameRef;
  earlier: Promise<unknown>[];
  extra: Pick<MediaItem, "sourceKind"> & Partial<Pick<MediaItem, "title" | "thumbnail" | "durationSec">>;
}): Promise<void> {
  const { tabId, url, found, sentHeaders } = input;
  const known = await registry.get(tabId);
  // Quality playlists of a listed master, and repeat sightings, need no probe.
  const isStream = found.type !== "http";
  if (known?.media.some((m) => m.childUrls?.includes(url) || (isStream && m.url === url))) return;
  const streamDetails =
    found.type === "hls"
      ? await probeHls(url, sentHeaders, input.frame)
      : found.type === "dash"
        ? await probeDash(url, sentHeaders, input.frame)
        : {};
  // The URL looked like a stream but the server sent something else.
  if (streamDetails === null) return;
  await Promise.allSettled(input.earlier);
  const now = await registry.get(tabId);
  if (now?.media.some((m) => m.childUrls?.includes(url))) return;
  const item: MediaItem = {
    id: hash53(url),
    type: found.type,
    url,
    tabId,
    pageUrl: input.pageUrl,
    mime: found.mime,
    ext: found.ext,
    sizeBytes: found.sizeBytes,
    supportsRanges: found.supportsRanges,
    serverFilename: found.serverFilename,
    sentHeaders,
    hasDrm: false,
    detectedAt: Date.now(),
    ...input.extra,
    ...streamDetails,
  };
  if (item.durationSec === undefined) delete item.durationSec;
  for (const [key, value] of Object.entries(await enrich(item))) if (value !== undefined) Object.assign(item, { [key]: value });
  const added = await registry.add(item, await downloads.busyMedia(tabId));
  const drm = pendingDrm.get(tabId);
  if (added && drm) {
    pendingDrm.delete(tabId);
    await registry.update(tabId, { drmKeySystem: drm });
  }
  if (added && !metaRequested.has(tabId)) {
    metaRequested.add(tabId);
    void readPageMeta(tabId);
  }
}

/** Lists what the page declares in its markup, before anything plays. */
async function scanPage(tabId: number): Promise<void> {
  const candidates = await scanTab(tabId);
  const checked = await Promise.all(candidates.map((c) => checkCandidate(c.candidate, c.pageUrl)));
  for (const hit of checked) {
    if (!hit) continue;
    const { candidate, found, pageUrl } = hit;
    const earlier = [...(handling.get(tabId) ?? [])];
    track(
      tabId,
      list({
        tabId,
        url: candidate.url,
        found,
        sentHeaders: { referer: pageUrl },
        pageUrl,
        earlier,
        extra: { sourceKind: "page", title: candidate.title, thumbnail: candidate.thumbnail, durationSec: candidate.durationSec },
      }),
    );
  }
}

chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId === 0) void scanPage(d.tabId);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId === 0) setTimeout(() => void scanPage(d.tabId), RESCAN_DELAY_MS);
});

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
          docTitle: document.title.trim(),
          ogTitle: meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]'),
          siteName: meta('meta[property="og:site_name"]'),
          thumbnail:
            abs(document.querySelector("video[poster]")?.getAttribute("poster")) ??
            abs(meta('meta[property="og:image"]')) ??
            abs(meta('meta[name="twitter:image"]')) ??
            abs(document.querySelector('link[rel="image_src"]')?.getAttribute("href")),
          pageUrl: location.href,
          // Captions the page attaches to its videos with <track>.
          tracks: [...document.querySelectorAll<HTMLTrackElement>("video track[src]")]
            .filter((t) => !t.kind || t.kind === "subtitles" || t.kind === "captions")
            .map((t) => ({ url: abs(t.getAttribute("src"))!, label: t.label, lang: t.srclang }))
            .filter((t) => t.url),
        };
      },
    });
    if (res?.result) {
      const { tracks, docTitle, ogTitle, siteName, ...meta } = res.result;
      const title = cleanTitle({ docTitle, ogTitle, siteName, host: new URL(meta.pageUrl).hostname });
      const subtitles: SubtitleTrack[] = tracks.map((t, i) => ({
        id: `page-${i}`,
        label: t.label || t.lang || `Subtitles ${i + 1}`,
        lang: t.lang || undefined,
        source: { kind: "file", url: t.url },
      }));
      await registry.update(tabId, { ...meta, title, ...(subtitles.length ? { subtitles } : {}) });
    }
  } catch {
    // Restricted pages (chrome://, the Web Store) refuse scripts; keep going.
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  metaRequested.delete(d.tabId);
  pendingDrm.delete(d.tabId);
  registry.clear(d.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  metaRequested.delete(tabId);
  pendingDrm.delete(tabId);
  registry.clear(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Read the page again rather than trust the raw tab title, which carries the site's name.
  if (change.title) void registry.get(tabId).then((t) => t && readPageMeta(tabId));
});

chrome.runtime.onMessage.addListener((msg: Command | FromOffscreenEnvelope, sender, respond) => {
  if ("target" in msg) {
    if (msg.target !== "service-worker") return;
    downloads.onWorkerMessage(msg.message).finally(() => respond(true));
    return true;
  }
  handle(msg, sender).then(respond, (err) => respond({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // respond asynchronously
});

async function handle(cmd: Command, sender: chrome.runtime.MessageSender): Promise<CommandResult> {
  switch (cmd.kind) {
    case "download": {
      const found = await registry.findMedia(cmd.payload.tabId, cmd.payload.mediaId);
      if (!found) return { ok: false, error: "That video is no longer on this page. Reload and try again." };
      const jobId = await downloads.start(found.tab, found.item, cmd.payload.filename, cmd.payload.variantId, cmd.payload.subtitleId);
      return { ok: true, jobId };
    }
    case "cancel":
      await downloads.cancel(cmd.payload.jobId);
      return { ok: true };
    case "stop":
      await downloads.stop(cmd.payload.jobId);
      return { ok: true };
    case "page-drm": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false, error: "Not from a tab" };
      // The list may not exist yet; keep the flag so media found later sees it.
      const tab = await registry.get(tabId);
      if (tab) await registry.update(tabId, { drmKeySystem: cmd.payload.keySystem });
      else pendingDrm.set(tabId, cmd.payload.keySystem);
      return { ok: true };
    }
    case "page-mse": {
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId === undefined) return { ok: false, error: "Not from a tab" };
      const frameUrl = sender.url ?? sender.tab?.url ?? "";
      const id = playerId(tabId, sender.frameId, frameUrl);
      // Record reloaded this page: answer at once, the player is waiting to start.
      const armed = await downloads.claimArmed(tabId, sender.frameId, id, sender.tab?.url ?? frameUrl);
      void listPlayer(tabId, sender.frameId, frameUrl, cmd.payload.mime, !armed);
      return armed ? { ok: true, jobId: armed.jobId } : { ok: true };
    }
    case "capture-job": {
      // Our own page (its host may be the dynamic id web-accessible pages get), not a content script.
      const from = sender.url ? new URL(sender.url) : undefined;
      if (sender.id !== chrome.runtime.id || from?.protocol !== "chrome-extension:" || from.pathname !== "/capture.html")
        return { ok: false, error: "Not the capture page" };
      const job = await downloads.claimCapture(cmd.payload.jobId);
      return job ? { ok: true, filename: job.filename, saveAs: job.saveAs } : { ok: false, error: "No such recording" };
    }
    case "clear-tab":
      registry.clear(cmd.payload.tabId);
      return { ok: true };
    case "check-license":
      await refreshLicense();
      return { ok: true };
  }
}

/**
 * A player fed through Media Source Extensions. Listed only as a last resort:
 * most such players load an HLS or DASH manifest we can download directly,
 * and the registry drops this entry once one shows up.
 */
const playerId = (tabId: number, frameId: number, frameUrl: string) => hash53(`mse:${tabId}:${frameId}:${frameUrl}`);

/** `grace` false: the player is being recorded, so it's listed at once and stays. */
async function listPlayer(tabId: number, frameId: number, frameUrl: string, mime: string, grace: boolean): Promise<void> {
  // Give the player's manifest a moment to be seen first (not when it's being recorded).
  if (grace) await new Promise((r) => setTimeout(r, PLAYER_GRACE_MS));
  await Promise.allSettled([...(handling.get(tabId) ?? [])]);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return;
  const audioOnly = mime.startsWith("audio/");
  const added = await registry.add({
    id: playerId(tabId, frameId, frameUrl),
    type: "mse",
    url: frameUrl,
    tabId,
    pageUrl: tab.url ?? frameUrl,
    mime: audioOnly ? "audio/mp4" : "video/mp4",
    ext: audioOnly ? "m4a" : "mp4",
    supportsRanges: false,
    sentHeaders: {},
    hasDrm: false,
    detectedAt: Date.now(),
    sourceKind: "sniffer",
    frameId,
    recording: !grace || undefined,
  });
  if (added && !metaRequested.has(tabId)) {
    metaRequested.add(tabId);
    void readPageMeta(tabId);
  }
}

watchSidePanelSetting();
watchThanksPage();
chrome.runtime.onStartup.addListener(() => {
  void clearStaleRules();
  void refreshLicenseIfStale();
});
chrome.runtime.onInstalled.addListener(() => void clearStaleRules());
