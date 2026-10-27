// Popup: reads the current tab's media and download jobs from
// chrome.storage.session and renders them as frames on a film strip.
// It never holds state of its own beyond what the user is typing.

import { formatBytes, formatDuration } from "../shared/format";
import { sendCommand, storageKeys } from "../shared/messages";
import { buildFilename, savedExt } from "../shared/naming";
import { defaultSettings, loadSettings, type Settings } from "../shared/settings";
import type { DownloadJob, MediaItem, StreamVariant, TabMedia } from "../shared/types";
import { setOpenMode } from "../shared/open-mode";
import { bindAd } from "./ads-view";
import { bindAsk, bindAskButtons } from "./asks-view";
import { bindHistory } from "./history-view";
import { icons } from "./icons";
import { bindSettingsForm } from "./settings-form";

const strip = document.getElementById("strip")!;
const pageHost = document.getElementById("page-host")!;
const template = document.getElementById("frame-template") as HTMLTemplateElement;
/** The side panel stays open across tabs, so it follows the active one. */
const isPanel = document.body.classList.contains("vz-popup--panel");

let settings: Settings = defaultSettings;
let tabId = -1;
let tab: TabMedia | undefined;
let jobs: Record<string, DownloadJob> = {};
const frames = new Map<string, HTMLElement>();
/** Names the user typed, by media id; they win over the template. */
const edited = new Map<string, string>();
const pendingErrors = new Map<string, string>();
/** Quality picked per stream, by media id; the best one otherwise. */
const chosenVariant = new Map<string, string>();
/** Subtitle track picked per item, by media id; none by default. */
const chosenSubtitle = new Map<string, string>();

const TYPE_ORDER: Record<MediaItem["type"], number> = { dash: 0, hls: 1, http: 2, mse: 3 };

async function resolveTabId(): Promise<number> {
  // ?tabId= opens the popup as a full page for a given tab (tests, debugging).
  const params = new URLSearchParams(location.search);
  const param = params.get("tabId");
  if (param) {
    if (!params.has("narrow")) document.body.classList.add("wide");
    return Number(param);
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active?.id ?? -1;
}

function sorted(media: MediaItem[]): MediaItem[] {
  return [...media].sort(
    (a, b) =>
      (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || b.detectedAt - a.detectedAt,
  );
}

/** The stream quality that Download will save: the one picked, or the best. */
function chosenStream(item: MediaItem): StreamVariant | undefined {
  if (item.type !== "hls" && item.type !== "dash") return undefined;
  return item.variants?.find((v) => v.id === chosenVariant.get(item.id)) ?? item.variants?.[0];
}

function defaultName(item: MediaItem): string {
  return buildFilename({
    template: settings.template,
    maxLength: settings.maxLength,
    title: item.title ?? tab?.title,
    pageUrl: tab?.pageUrl ?? item.pageUrl,
    mediaUrl: item.url,
    serverFilename: item.serverFilename,
    ext: savedExt(item, chosenStream(item)),
  });
}

function latestJob(mediaId: string): DownloadJob | undefined {
  return Object.values(jobs)
    .filter((j) => j.mediaId === mediaId && j.tabId === tabId)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

/** The format of the file Download saves; HLS and DASH streams are joined into one MP4 (or M4A, or WebM). */
function typeLabel(item: MediaItem): string {
  if (item.type === "mse") return "PLAYER";
  return savedExt(item, chosenStream(item)).toUpperCase();
}

function renderEmpty(): void {
  strip.replaceChildren();
  frames.clear();
  const empty = document.createElement("div");
  empty.className = "vz-empty";
  empty.innerHTML = `${icons.film}<p class="vz-empty-title">No videos found yet</p><p>Start playing the video on this page, then open this again.</p>`;
  strip.append(empty);
}

function createFrame(item: MediaItem): HTMLElement {
  const frame = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  frame.dataset.id = item.id;
  frame.querySelector(".copy")!.innerHTML = icons.copy;
  frame.querySelector(".download")!.innerHTML = icons.download;

  const name = frame.querySelector<HTMLInputElement>(".vz-frame-name")!;
  name.addEventListener("input", () => edited.set(item.id, name.value));

  for (const wrap of frame.querySelectorAll(".vz-select")) wrap.insertAdjacentHTML("beforeend", icons.chevronDown);
  const quality = frame.querySelector<HTMLSelectElement>(".quality select")!;
  quality.addEventListener("change", () => {
    chosenVariant.set(item.id, quality.value);
    render(); // the badge and file name follow the quality (Audio only saves an .m4a)
  });
  const subtitles = frame.querySelector<HTMLSelectElement>(".subtitles select")!;
  subtitles.addEventListener("change", () => chosenSubtitle.set(item.id, subtitles.value));

  frame.querySelector(".copy")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(item.url).catch(() => {});
    btn.innerHTML = icons.check;
    setTimeout(() => (btn.innerHTML = icons.copy), 1200);
  });

  frame.querySelector(".download")!.addEventListener("click", async () => {
    pendingErrors.delete(item.id);
    const job = latestJob(item.id);
    if (job?.state === "running") {
      // A live recording stops and saves; anything else is cancelled.
      await sendCommand({ kind: job.recording ? "stop" : "cancel", payload: { jobId: job.jobId } });
      return;
    }
    const res = await sendCommand({
      kind: "download",
      payload: { tabId, mediaId: item.id, filename: edited.get(item.id), variantId: chosenVariant.get(item.id), subtitleId: chosenSubtitle.get(item.id) || undefined },
    });
    if (!res.ok) pendingErrors.set(item.id, res.error);
    render();
  });
  return frame;
}

function updateFrame(frame: HTMLElement, item: MediaItem): void {
  const thumb = frame.querySelector<HTMLElement>(".vz-thumb")!;
  const poster = item.thumbnail ?? tab?.thumbnail;
  const look = poster ?? (item.mime.startsWith("audio/") ? "waveform" : "film");
  if (thumb.dataset.look !== look) {
    thumb.dataset.look = look;
    thumb.style.backgroundImage = poster ? `url(${JSON.stringify(poster)})` : "";
    thumb.innerHTML = poster ? "" : item.mime.startsWith("audio/") ? icons.waveform : icons.film;
  }

  const name = frame.querySelector<HTMLInputElement>(".vz-frame-name")!;
  if (!edited.has(item.id) && document.activeElement !== name) name.value = defaultName(item);
  name.title = name.value;

  setText(frame.querySelector(".vz-badge")!, typeLabel(item));
  const details = [
    item.isLive ? "Live" : formatDuration(item.durationSec),
    formatBytes(item.sizeBytes),
    new URL(item.url).hostname,
  ].filter(Boolean);
  setText(frame.querySelector(".meta-text")!, details.join(" · "));
  updateQuality(frame, item);
  updateSubtitles(frame, item);

  // The note is drawn on a scratch copy and only then put in place when it
  // changed, so progress updates don't keep rebuilding the frame.
  const note = document.createElement("p");
  const download = frame.querySelector<HTMLButtonElement>(".download")!;
  const progress = frame.querySelector<HTMLElement>(".vz-perf")!;
  const job = latestJob(item.id);
  const isRunning = job?.state === "running";
  const mode = isRunning ? (job.recording ? "stop" : "cancel") : item.isLive || item.type === "mse" ? "record" : "download";
  if (download.dataset.mode !== mode) {
    download.dataset.mode = mode;
    const look = {
      download: [icons.download, "Download"],
      record: [icons.record, "Record"],
      cancel: [icons.close, "Cancel"],
      stop: [icons.stop, "Stop and save"],
    } as const;
    [download.innerHTML, download.title] = look[mode];
    download.setAttribute("aria-label", download.title);
    // Vermilion marks an action; cancel is the only one that isn't.
    download.classList.toggle("vz-icon-btn--primary", mode !== "cancel");
  }
  frame.classList.toggle("is-fogged", item.hasDrm);
  note.className = "vz-frame-note";
  let showProgress = false;
  let disabled = false;

  if (item.hasDrm) {
    disabled = true;
    note.innerHTML = `${icons.lock}<span>Protected by DRM. Not supported.</span>`;
  } else if (item.variants?.length === 0) {
    disabled = true;
    note.textContent = "No quality in this stream can be saved.";
  } else if (pendingErrors.has(item.id)) {
    note.classList.add("is-error");
    note.textContent = pendingErrors.get(item.id)!;
  } else if (job?.state === "running" && job.recording) {
    note.textContent =
      job.phase === "saving"
        ? "Saving the recording to your Downloads folder"
        : job.player?.armed
          ? "Reloading the page to record the video from the start"
          : item.type === "mse"
          ? `Recording what the player plays${job.bytesReceived ? ` · ${formatBytes(job.bytesReceived)}` : ""}. Stops when the video ends.`
          : `Recording ${formatDuration(job.recordedSec) || "0:00"}${job.bytesReceived ? ` · ${formatBytes(job.bytesReceived)}` : ""}`;
  } else if (job?.state === "running") {
    showProgress = true;
    const fraction = job.progress ?? (job.totalBytes ? job.bytesReceived / job.totalBytes : 0);
    progress.style.setProperty("--vz-perf-value", `${Math.min(100, fraction * 100)}%`);
    const quality = job.variantLabel ? ` ${job.variantLabel}` : "";
    if (job.phase === "saving") note.textContent = "Saving to your Downloads folder";
    else if (job.progress !== undefined)
      note.textContent = `Downloading${quality}, ${Math.floor(job.progress * 100)}%${job.bytesReceived ? ` · ${formatBytes(job.bytesReceived)}` : ""}`;
    else
      note.textContent = job.totalBytes
        ? `Downloading ${formatBytes(job.bytesReceived)} of ${formatBytes(job.totalBytes)}`
        : `Downloading ${formatBytes(job.bytesReceived)}`;
  } else if (job?.state === "complete") {
    note.classList.add(job.subtitleError ? "is-error" : "is-done");
    note.textContent = job.subtitleError
      ? `Saved as ${job.filename}, but the subtitles failed: ${job.subtitleError}. `
      : `Saved as ${job.filename}${job.subtitleFile ? " with subtitles" : ""}. `;
    note.title = job.savedPath ?? job.filename;
    if (job.chromeDownloadId !== undefined) {
      note.classList.add("has-action");
      note.append(showInFolder(job.chromeDownloadId));
    }
  } else if (job?.state === "failed") {
    note.classList.add("is-error");
    note.textContent = `Download failed: ${job.error ?? "unknown error"}`;
  } else if (tab?.drmKeySystem && item.type !== "http") {
    // EME on the page: the stream may be encrypted even if its manifest didn't say so.
    note.innerHTML = `${icons.warning}<span></span>`;
    note.querySelector("span")!.textContent = `This page plays ${drmName(tab.drmKeySystem)}-protected video. If this is that stream, the saved file won't play.`;
  } else if (item.isLive) {
    note.textContent = "Live. Records until the stream ends or you press stop.";
  } else if (item.type === "mse") {
    note.textContent = "No file to fetch here. Record reloads the page and keeps what the player loads, from the start. Let the video play to the end.";
  } else {
    note.hidden = true;
  }
  download.disabled = disabled;
  progress.hidden = !showProgress;
  frame.classList.toggle("has-progress", showProgress);
  placeNote(frame.querySelector<HTMLElement>(".vz-frame-note")!, note);
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Moves a freshly drawn note into the frame, touching only what differs. */
function placeNote(current: HTMLElement, next: HTMLElement): void {
  if (current.className !== next.className) current.className = next.className;
  current.hidden = next.hidden;
  current.title = next.title;
  if (current.innerHTML !== next.innerHTML) current.replaceChildren(...next.childNodes);
}

function showInFolder(downloadId: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "vz-text-btn";
  button.textContent = "Show in folder";
  button.dataset.download = String(downloadId); // a new download of the same video gets a new button
  button.addEventListener("click", () => chrome.downloads.show(downloadId));
  return button;
}

function drmName(keySystem: string): string {
  if (keySystem.includes("widevine")) return "Widevine";
  if (keySystem.includes("playready")) return "PlayReady";
  if (keySystem.includes("fps") || keySystem.includes("fairplay")) return "FairPlay";
  return "DRM";
}

/** The subtitle picker, shown when the stream or the page has captions. */
function updateSubtitles(frame: HTMLElement, item: MediaItem): void {
  const wrap = frame.querySelector<HTMLElement>(".subtitles")!;
  const select = wrap.querySelector("select")!;
  // Players often list a language twice (two caption groups, a <track> echoing
  // the stream); offer each language once.
  const seen = new Set<string>();
  const tracks = [...(item.subtitles ?? []), ...(tab?.subtitles ?? [])].filter((t) => {
    const key = (t.lang || t.label).toLowerCase();
    return !seen.has(key) && seen.add(key);
  });
  wrap.hidden = tracks.length === 0;
  if (wrap.hidden) return;
  const signature = tracks.map((t) => `${t.id}:${t.label}`).join("|");
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(new Option("No subtitles", ""), ...tracks.map((t) => new Option(`CC ${t.label}`, t.id)));
  }
  select.value = chosenSubtitle.get(item.id) ?? "";
  select.disabled = latestJob(item.id)?.state === "running" || item.hasDrm;
}

/** The quality picker, shown when a stream offers more than one. */
function updateQuality(frame: HTMLElement, item: MediaItem): void {
  const wrap = frame.querySelector<HTMLElement>(".quality")!;
  const select = wrap.querySelector("select")!;
  const variants = item.variants ?? [];
  wrap.hidden = variants.length < 2;
  if (wrap.hidden) return;
  const signature = variants.map((v) => `${v.id}:${v.label}`).join("|");
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(...variants.map((v) => new Option(v.label, v.id)));
  }
  select.value = chosenVariant.get(item.id) ?? variants[0]!.id;
  select.disabled = latestJob(item.id)?.state === "running" || item.hasDrm;
}

function render(): void {
  pageHost.textContent = tab?.pageUrl ? new URL(tab.pageUrl).hostname : "";
  const media = sorted(tab?.media ?? []);
  if (media.length === 0) {
    renderEmpty();
    return;
  }
  strip.querySelector(".vz-empty")?.remove();
  const keep = new Set(media.map((m) => m.id));
  for (const [id, el] of frames) {
    if (!keep.has(id)) {
      el.remove();
      frames.delete(id);
    }
  }
  let previous: HTMLElement | undefined;
  for (const item of media) {
    let frame = frames.get(item.id);
    if (!frame) {
      frame = createFrame(item);
      frames.set(item.id, frame);
    }
    updateFrame(frame, item);
    // Keep DOM order equal to sort order, but move a frame only when it's out
    // of place: inserting it again replays its arrival animation (a flash on
    // every progress update).
    const expected = previous ? previous.nextElementSibling : strip.firstElementChild;
    if (expected !== frame) {
      if (previous) previous.after(frame);
      else strip.prepend(frame);
    }
    previous = frame;
  }
}

async function load(): Promise<void> {
  const tabKey = storageKeys.tab(tabId);
  const data = await chrome.storage.session.get([tabKey, storageKeys.jobs]);
  tab = data[tabKey] as TabMedia | undefined;
  jobs = (data[storageKeys.jobs] as Record<string, DownloadJob> | undefined) ?? {};
  render();
}

/** Forgets what the user typed or picked; those belong to the previous tab. */
async function switchTab(next: number): Promise<void> {
  if (next === tabId) return;
  tabId = next;
  for (const map of [edited, pendingErrors, chosenVariant, chosenSubtitle]) map.clear();
  strip.replaceChildren();
  frames.clear();
  await load();
}

let windowId: number | undefined;

type View = "videos" | "settings" | "saved";
let view: View = "videos";

/** Swaps the strip for the settings form or the saved files, in place. */
function showView(next: View): void {
  view = next;
  const open = next !== "videos";
  const button = document.querySelector<HTMLButtonElement>("#toggle-settings")!;
  document.querySelector<HTMLElement>("#settings-view")!.hidden = next !== "settings";
  document.querySelector<HTMLElement>("#saved-view")!.hidden = next !== "saved";
  strip.hidden = open;
  document.querySelector<HTMLElement>(".vz-popup-foot")!.hidden = open;
  document.body.classList.toggle("has-view", open);
  button.innerHTML = open ? icons.close : icons.gear;
  button.title = open ? "Back to the videos" : "Settings";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-controls", next === "saved" ? "saved-view" : "settings-view");
  button.setAttribute("aria-expanded", String(open));
  document.querySelector("#open-history")!.setAttribute("aria-expanded", String(next === "saved"));
}

/** Popup to side panel and back. The choice is saved, so the toolbar button keeps opening it. */
async function switchMode(): Promise<void> {
  if (isPanel) {
    await setOpenMode(false);
    await chrome.action.openPopup().catch(() => {});
    if (windowId !== undefined && typeof chrome.sidePanel.close === "function") await chrome.sidePanel.close({ windowId });
    else window.close();
    return;
  }
  // Open first: Chrome only allows it straight from the click.
  if (windowId !== undefined) await chrome.sidePanel.open({ windowId });
  await setOpenMode(true);
  window.close();
}

function setupControls(): void {
  const settingsButton = document.querySelector<HTMLButtonElement>("#toggle-settings")!;
  settingsButton.addEventListener("click", () => showView(view === "videos" ? "settings" : "videos"));
  showView("videos");
  bindSettingsForm(document);
  bindHistory(document);
  bindAskButtons(document);
  bindAsk(document);
  bindAd(document);

  const mode = document.querySelector<HTMLButtonElement>("#switch-mode")!;
  [mode.innerHTML, mode.title] = isPanel ? [icons.popup, "Switch to the popup"] : [icons.sidePanel, "Switch to the side panel"];
  mode.setAttribute("aria-label", mode.title);
  mode.hidden = document.body.classList.contains("wide");
  mode.addEventListener("click", () => void switchMode());

  const folder = document.querySelector<HTMLButtonElement>("#open-folder")!;
  folder.innerHTML = `${icons.folder}<span>Downloads</span>`;
  folder.title = "Open your Downloads folder";
  folder.addEventListener("click", () => chrome.downloads.showDefaultFolder());

  const history = document.querySelector<HTMLButtonElement>("#open-history")!;
  history.innerHTML = `${icons.clock}<span>Saved files</span>`;
  history.title = "Files Vidzilla saved, with Show in folder";
  history.addEventListener("click", () => showView("saved"));

  const clear = document.querySelector<HTMLButtonElement>("#clear-list")!;
  clear.innerHTML = icons.trash;
  clear.addEventListener("click", () => void sendCommand({ kind: "clear-tab", payload: { tabId } }));
}

async function main(): Promise<void> {
  setupControls();
  [tabId, settings, windowId] = await Promise.all([resolveTabId(), loadSettings(), chrome.windows.getCurrent().then((w) => w.id)]);
  if (isPanel) {
    // An open side panel stands in for the popup until the user switches back.
    if (!document.body.classList.contains("wide")) void setOpenMode(true);
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === windowId) void switchTab(info.tabId);
    });
  }
  chrome.storage.local.onChanged.addListener(async (changes) => {
    if (!(storageKeys.settings in changes)) return;
    settings = await loadSettings();
    render(); // file names follow the template
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    const tabKey = storageKeys.tab(tabId);
    if (tabKey in changes) tab = changes[tabKey]!.newValue as TabMedia | undefined;
    if (storageKeys.jobs in changes) jobs = (changes[storageKeys.jobs]!.newValue as Record<string, DownloadJob>) ?? {};
    if (tabKey in changes || storageKeys.jobs in changes) render();
  });
  await load();
}

void main();
