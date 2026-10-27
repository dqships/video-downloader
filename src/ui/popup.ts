// Popup: reads the current tab's media and download jobs from
// chrome.storage.session and renders them as frames on a film strip.
// It never holds state of its own beyond what the user is typing.

import { formatBytes, formatDuration } from "../shared/format";
import { sendCommand, storageKeys } from "../shared/messages";
import { buildFilename } from "../shared/naming";
import { defaultSettings, loadSettings, type Settings } from "../shared/settings";
import type { DownloadJob, MediaItem, TabMedia } from "../shared/types";
import { icons } from "./icons";

const strip = document.getElementById("strip")!;
const pageHost = document.getElementById("page-host")!;
const template = document.getElementById("frame-template") as HTMLTemplateElement;

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

const TYPE_ORDER: Record<MediaItem["type"], number> = { dash: 0, hls: 1, http: 2 };

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
    (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || b.detectedAt - a.detectedAt,
  );
}

function defaultName(item: MediaItem): string {
  return buildFilename({
    template: settings.template,
    maxLength: settings.maxLength,
    title: item.title ?? tab?.title,
    pageUrl: tab?.pageUrl ?? item.pageUrl,
    mediaUrl: item.url,
    serverFilename: item.serverFilename,
    ext: item.ext,
  });
}

function latestJob(mediaId: string): DownloadJob | undefined {
  return Object.values(jobs)
    .filter((j) => j.mediaId === mediaId && j.tabId === tabId)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

function typeLabel(item: MediaItem): string {
  if (item.type === "hls") return "HLS";
  if (item.type === "dash") return "DASH";
  return item.ext.toUpperCase();
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
  quality.addEventListener("change", () => chosenVariant.set(item.id, quality.value));
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
  if (poster) {
    thumb.style.backgroundImage = `url(${JSON.stringify(poster)})`;
    thumb.innerHTML = "";
  } else {
    thumb.style.backgroundImage = "";
    thumb.innerHTML = item.mime.startsWith("audio/") ? icons.waveform : icons.film;
  }

  const name = frame.querySelector<HTMLInputElement>(".vz-frame-name")!;
  if (!edited.has(item.id) && document.activeElement !== name) name.value = defaultName(item);
  name.title = name.value;

  frame.querySelector(".vz-badge")!.textContent = typeLabel(item);
  const details = [
    item.isLive ? "Live" : formatDuration(item.durationSec),
    formatBytes(item.sizeBytes),
    new URL(item.url).hostname,
  ].filter(Boolean);
  frame.querySelector(".meta-text")!.textContent = details.join(" · ");
  updateQuality(frame, item);
  updateSubtitles(frame, item);

  const note = frame.querySelector<HTMLElement>(".vz-frame-note")!;
  const download = frame.querySelector<HTMLButtonElement>(".download")!;
  const progress = frame.querySelector<HTMLElement>(".vz-perf")!;
  const job = latestJob(item.id);
  const isRunning = job?.state === "running";
  const mode = isRunning ? (job.recording ? "stop" : "cancel") : item.isLive ? "record" : "download";
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
  note.hidden = false;
  progress.hidden = true;
  frame.classList.remove("has-progress");
  download.disabled = false;

  if (item.hasDrm) {
    download.disabled = true;
    note.innerHTML = `${icons.lock}<span>Protected by DRM. Not supported.</span>`;
  } else if (item.variants?.length === 0) {
    download.disabled = true;
    note.textContent = "No quality in this stream can be saved yet (WebM streams arrive later).";
  } else if (item.isLive && item.type === "dash") {
    download.disabled = true;
    note.textContent = "Recording live DASH streams arrives in a later update.";
  } else if (pendingErrors.has(item.id)) {
    note.classList.add("is-error");
    note.textContent = pendingErrors.get(item.id)!;
  } else if (job?.state === "running" && job.recording) {
    note.textContent =
      job.phase === "saving"
        ? "Saving the recording to your Downloads folder"
        : `Recording ${formatDuration(job.recordedSec) || "0:00"}${job.bytesReceived ? ` · ${formatBytes(job.bytesReceived)}` : ""}`;
  } else if (job?.state === "running") {
    progress.hidden = false;
    frame.classList.add("has-progress");
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
      ? `Saved as ${job.filename}, but the subtitles failed: ${job.subtitleError}`
      : `Saved as ${job.filename}${job.subtitleFile ? " with subtitles" : ""}`;
    note.title = job.savedPath ?? job.filename;
  } else if (job?.state === "failed") {
    note.classList.add("is-error");
    note.textContent = `Download failed: ${job.error ?? "unknown error"}`;
  } else if (tab?.drmKeySystem && item.type !== "http") {
    // EME on the page: the stream may be encrypted even if its manifest didn't say so.
    note.innerHTML = `${icons.warning}<span></span>`;
    note.querySelector("span")!.textContent = `This page plays ${drmName(tab.drmKeySystem)}-protected video. If this is that stream, the saved file won't play.`;
  } else if (item.isLive) {
    note.textContent = "Live. Records until the stream ends or you press stop.";
  } else {
    note.hidden = true;
  }
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
  const tracks = [...(item.subtitles ?? []), ...(tab?.subtitles ?? [])];
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
  for (const item of media) {
    let frame = frames.get(item.id);
    if (!frame) {
      frame = createFrame(item);
      frames.set(item.id, frame);
    }
    updateFrame(frame, item);
    strip.append(frame); // re-append keeps DOM order equal to sort order
  }
}

async function load(): Promise<void> {
  const tabKey = storageKeys.tab(tabId);
  const data = await chrome.storage.session.get([tabKey, storageKeys.jobs]);
  tab = data[tabKey] as TabMedia | undefined;
  jobs = (data[storageKeys.jobs] as Record<string, DownloadJob> | undefined) ?? {};
  render();
}

async function main(): Promise<void> {
  [tabId, settings] = await Promise.all([resolveTabId(), loadSettings()]);
  chrome.storage.session.onChanged.addListener((changes) => {
    const tabKey = storageKeys.tab(tabId);
    if (tabKey in changes) tab = changes[tabKey]!.newValue as TabMedia | undefined;
    if (storageKeys.jobs in changes) jobs = (changes[storageKeys.jobs]!.newValue as Record<string, DownloadJob>) ?? {};
    if (tabKey in changes || storageKeys.jobs in changes) render();
  });
  await load();
}

void main();
