// Popup: reads the current tab's media and download jobs from
// chrome.storage.session and renders them as frames on a film strip.
// It never holds state of its own beyond what the user is typing.

import { formatBytes } from "../shared/format";
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
    title: tab?.title,
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
  empty.className = "empty";
  empty.innerHTML = `${icons.film}<p class="empty-title">No videos found yet</p><p>Start playing the video on this page, then open this again.</p>`;
  strip.append(empty);
}

function createFrame(item: MediaItem): HTMLElement {
  const frame = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  frame.dataset.id = item.id;
  frame.querySelector(".copy")!.innerHTML = icons.copy;
  frame.querySelector(".download")!.innerHTML = icons.download;

  const name = frame.querySelector<HTMLInputElement>(".name")!;
  name.addEventListener("input", () => edited.set(item.id, name.value));

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
      await sendCommand({ kind: "cancel", payload: { jobId: job.jobId } });
      return;
    }
    const res = await sendCommand({
      kind: "download",
      payload: { tabId, mediaId: item.id, filename: edited.get(item.id) },
    });
    if (!res.ok) pendingErrors.set(item.id, res.error);
    render();
  });
  return frame;
}

function updateFrame(frame: HTMLElement, item: MediaItem): void {
  const thumb = frame.querySelector<HTMLElement>(".thumb")!;
  if (tab?.thumbnail) {
    thumb.style.backgroundImage = `url(${JSON.stringify(tab.thumbnail)})`;
    thumb.innerHTML = "";
  } else {
    thumb.style.backgroundImage = "";
    thumb.innerHTML = item.mime.startsWith("audio/") ? icons.waveform : icons.film;
  }

  const name = frame.querySelector<HTMLInputElement>(".name")!;
  if (!edited.has(item.id) && document.activeElement !== name) name.value = defaultName(item);
  name.title = name.value;

  const meta = frame.querySelector(".meta")!;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = typeLabel(item);
  const details = [formatBytes(item.sizeBytes), new URL(item.url).hostname].filter(Boolean).join(" · ");
  meta.replaceChildren(badge, details);

  const note = frame.querySelector<HTMLElement>(".note")!;
  const download = frame.querySelector<HTMLButtonElement>(".download")!;
  const progress = frame.querySelector<HTMLElement>(".progress")!;
  const bar = progress.querySelector<HTMLElement>("span")!;
  const job = latestJob(item.id);
  const isRunning = job?.state === "running";
  if (download.dataset.mode !== (isRunning ? "cancel" : "download")) {
    download.dataset.mode = isRunning ? "cancel" : "download";
    download.innerHTML = isRunning ? icons.close : icons.download;
    download.title = isRunning ? "Cancel" : "Download";
    download.classList.toggle("primary", !isRunning);
  }
  frame.classList.toggle("fogged", item.hasDrm);
  note.className = "note";
  note.hidden = false;
  progress.hidden = true;
  download.disabled = false;

  if (item.hasDrm) {
    download.disabled = true;
    note.innerHTML = `${icons.lock}<span>Protected by DRM. Not supported.</span>`;
  } else if (item.type !== "http") {
    download.disabled = true;
    note.textContent = "Stream downloads arrive in the next update.";
  } else if (pendingErrors.has(item.id)) {
    note.classList.add("error");
    note.textContent = pendingErrors.get(item.id)!;
  } else if (job?.state === "running") {
    progress.hidden = false;
    const pct = job.totalBytes ? Math.min(100, (job.bytesReceived / job.totalBytes) * 100) : 0;
    bar.style.width = `${pct}%`;
    if (job.phase === "saving") note.textContent = "Saving to your Downloads folder";
    else
      note.textContent = job.totalBytes
        ? `Downloading ${formatBytes(job.bytesReceived)} of ${formatBytes(job.totalBytes)}`
        : `Downloading ${formatBytes(job.bytesReceived)}`;
  } else if (job?.state === "complete") {
    note.classList.add("done");
    note.textContent = `Saved as ${job.filename}`;
    note.title = job.savedPath ?? job.filename;
  } else if (job?.state === "failed") {
    note.classList.add("error");
    note.textContent = `Download failed: ${job.error ?? "unknown error"}`;
  } else {
    note.hidden = true;
  }
}

function render(): void {
  pageHost.textContent = tab?.pageUrl ? new URL(tab.pageUrl).hostname : "";
  const media = sorted(tab?.media ?? []);
  if (media.length === 0) {
    renderEmpty();
    return;
  }
  strip.querySelector(".empty")?.remove();
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
