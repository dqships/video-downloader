// Website: paste a link to a video file or an HLS stream and save it right on
// the page. Downloads run in the extension's own download worker
// (src/worker/main.ts), so the site and the extension fetch and join streams
// the same way. Frames use the popup's markup and classes.

import { formatBytes, formatDuration } from "../shared/format";
import { dataUrl, singleVariantMaster } from "../shared/hls";
import { buildFilename, nameFromUrl, siteLabel } from "../shared/naming";
import { defaultSettings } from "../shared/settings";
import type { StreamVariant } from "../shared/types";
import type { FromWorker, ToWorker } from "../shared/worker-protocol";
import { icons } from "../ui/icons";
import { lookup, type Lookup } from "./lookup";

type Media = Extract<Lookup, { kind: "file" | "hls" }>;

interface Entry {
  media: Media;
  frame: HTMLElement;
  jobId?: string;
  state: "idle" | "running" | "done" | "failed";
  fraction?: number;
  bytes?: number;
  filename?: string;
  error?: string;
}

const form = document.querySelector<HTMLFormElement>("[data-paste]")!;
const input = form.querySelector<HTMLInputElement>("input")!;
const submit = form.querySelector<HTMLButtonElement>("button")!;
const note = document.querySelector<HTMLElement>("[data-paste-note]")!;
const strip = document.querySelector<HTMLElement>("[data-paste-strip]")!;
const template = document.getElementById("paste-frame") as HTMLTemplateElement;

const entries = new Map<string, Entry>();
let worker: Worker | undefined;

function toWorker(msg: ToWorker): void {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<FromWorker>) => onWorker(e.data);
  }
  worker.postMessage(msg);
}

/* Messages under the field, for links the page can't save. ------------- */

function storeLink(): string {
  const href = document.querySelector<HTMLAnchorElement>("[data-store-link]")?.href ?? "";
  return `<a href="${href}">Add Vidzilla to Chrome</a>`;
}

const NOTES: Record<Exclude<Lookup["kind"], "file" | "hls">, (r: Lookup) => string> = {
  invalid: () => "That doesn't look like a web link. Paste one that starts with https://.",
  youtube: () => "Vidzilla doesn't save YouTube videos.",
  page: () =>
    `That link is a web page, not a video file. The extension finds the video on any page you play it on. ${storeLink()}.`,
  blocked: () =>
    `This page couldn't reach that link. Either the site doesn't share its files with other websites, or the link is wrong. The extension works inside the tab you're watching, so it can save from those sites. ${storeLink()}.`,
  "http-error": (r) => `The site answered ${(r as { status: number }).status} for that link, so there's nothing to save.`,
  dash: () => "DASH streams (.mpd) can't be saved yet. They're coming to the extension first.",
};

function showNote(html: string, isError = false): void {
  note.innerHTML = `${isError ? icons.warning : ""}<span>${html}</span>`;
  note.classList.toggle("is-error", isError);
  note.hidden = false;
}

/* Frames ----------------------------------------------------------------- */

/** Stream playlists are often all called "master" or "index"; their folder says more. */
const GENERIC_NAME = /^(master|index|playlist|manifest|chunklist|main|video|stream)(_\w+)?$/i;

function titleFor(url: string): string | undefined {
  if (!GENERIC_NAME.test(nameFromUrl(url))) return undefined;
  const folders = new URL(url).pathname.split("/").filter(Boolean).slice(0, -1).reverse();
  return folders.find((f) => !GENERIC_NAME.test(f)) ?? siteLabel(url);
}

function defaultName(media: Media): string {
  return buildFilename({
    template: defaultSettings.template,
    maxLength: defaultSettings.maxLength,
    title: media.kind === "file" && media.serverFilename ? undefined : titleFor(media.url),
    pageUrl: media.url,
    mediaUrl: media.url,
    serverFilename: media.kind === "file" ? media.serverFilename : undefined,
    ext: media.kind === "file" ? media.ext : "mp4",
  });
}

function createFrame(media: Media): Entry {
  const frame = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  const entry: Entry = { media, frame, state: "idle" };
  const isAudio = media.kind === "file" && media.mime.startsWith("audio/");
  frame.querySelector(".vz-thumb")!.innerHTML = isAudio ? icons.waveform : icons.film;
  frame.querySelector(".copy")!.innerHTML = icons.copy;

  const name = frame.querySelector<HTMLInputElement>(".vz-frame-name")!;
  name.value = defaultName(media);
  name.title = name.value;

  frame.querySelector(".vz-badge")!.textContent = media.kind === "hls" ? "HLS" : media.ext.toUpperCase();
  const details =
    media.kind === "hls"
      ? [media.isLive ? "Live" : formatDuration(media.durationSec)]
      : [formatBytes(media.sizeBytes)];
  details.push(new URL(media.url).hostname);
  frame.querySelector(".meta-text")!.textContent = details.filter(Boolean).join(" · ");

  const wrap = frame.querySelector<HTMLElement>(".vz-select")!;
  if (media.kind === "hls" && media.variants.length > 1) {
    wrap.hidden = false;
    wrap.insertAdjacentHTML("beforeend", icons.chevronDown);
    wrap.querySelector("select")!.replaceChildren(...media.variants.map((v) => new Option(v.label, v.id)));
  }

  frame.querySelector(".copy")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(media.url).catch(() => {});
    btn.innerHTML = icons.check;
    setTimeout(() => (btn.innerHTML = icons.copy), 1200);
  });
  frame.querySelector(".download")!.addEventListener("click", () => {
    if (entry.state === "running") toWorker({ type: "cancel", jobId: entry.jobId! });
    else start(entry);
  });
  return entry;
}

/** The quality picked for a stream, the best one by default. */
function chosenVariant(entry: Entry): StreamVariant | undefined {
  if (entry.media.kind !== "hls") return undefined;
  const chosen = entry.frame.querySelector<HTMLSelectElement>(".vz-select select")!.value;
  return entry.media.variants.find((v) => v.id === chosen) ?? entry.media.variants[0];
}

function filenameFor(entry: Entry): string {
  // Sound-only stream downloads are saved as .m4a.
  const ext = entry.media.kind === "file" ? entry.media.ext : chosenVariant(entry)?.audioOnly ? "m4a" : "mp4";
  const typed = entry.frame.querySelector<HTMLInputElement>(".vz-frame-name")!.value.trim();
  const name = typed || defaultName(entry.media);
  // Swap a stream's .mp4/.m4a for the one this quality saves as.
  const base = entry.media.kind === "file" ? name.replace(new RegExp(`\\.${ext}$`, "i"), "") : name.replace(/\.(mp4|m4a)$/i, "");
  return `${base}.${ext}`;
}

function start(entry: Entry): void {
  if (entry.jobId) {
    toWorker({ type: "cleanup", jobId: entry.jobId });
    entries.delete(entry.jobId);
  }
  const jobId = crypto.randomUUID();
  Object.assign(entry, { jobId, state: "running", fraction: 0, bytes: 0, error: undefined, filename: filenameFor(entry) });
  entries.set(jobId, entry);
  const { media } = entry;
  if (media.kind === "hls") {
    const variant = chosenVariant(entry)!;
    // Media playlists are read as is; a master is narrowed to the chosen quality.
    const url = variant.url === media.url || variant.audioOnly ? variant.url : dataUrl(singleVariantMaster(variant));
    toWorker({ type: "fetch-hls", jobId, url, audioOnly: variant.audioOnly });
  } else {
    toWorker({ type: "fetch-file", jobId, url: media.url, expectedBytes: media.sizeBytes, supportsRanges: media.supportsRanges });
  }
  update(entry);
}

/** A fetch the site refused reads as "Failed to fetch"; say what it means. */
function friendly(message: string): string {
  return /failed to fetch|networkerror|load failed/i.test(message)
    ? "the site stopped sending the video to this page"
    : message.replace(/^\w/, (c) => c.toLowerCase());
}

function onWorker(msg: FromWorker): void {
  const entry = entries.get(msg.jobId);
  if (!entry) return;
  if (msg.type === "progress") {
    entry.bytes = msg.bytes;
    entry.fraction = msg.fraction ?? (msg.totalBytes ? msg.bytes / msg.totalBytes : undefined);
  } else if (msg.type === "done") {
    entry.state = "done";
    entry.bytes = msg.bytes;
    const a = document.createElement("a");
    a.href = msg.blobUrl;
    a.download = entry.filename!;
    a.click();
  } else {
    entry.state = msg.message === "Cancelled" ? "idle" : "failed";
    entry.error = friendly(msg.message);
  }
  update(entry);
}

function update(entry: Entry): void {
  const { frame, media } = entry;
  const download = frame.querySelector<HTMLButtonElement>(".download")!;
  const frameNote = frame.querySelector<HTMLElement>(".vz-frame-note")!;
  const progress = frame.querySelector<HTMLElement>(".vz-perf")!;
  const select = frame.querySelector<HTMLSelectElement>(".vz-select select")!;
  const running = entry.state === "running";
  const blocked = media.kind === "hls" && (media.hasDrm || media.isLive);

  download.innerHTML = running ? icons.close : icons.download;
  download.title = running ? "Cancel" : "Download";
  download.setAttribute("aria-label", download.title);
  download.classList.toggle("vz-icon-btn--primary", !running);
  download.disabled = blocked;
  select.disabled = running || blocked;
  frame.classList.toggle("is-fogged", media.kind === "hls" && media.hasDrm);
  progress.hidden = !running;
  frame.classList.toggle("has-progress", running);
  frameNote.className = "vz-frame-note";
  frameNote.hidden = false;

  if (media.kind === "hls" && media.hasDrm) {
    frameNote.innerHTML = `${icons.lock}<span>Protected by DRM. Vidzilla leaves it alone.</span>`;
  } else if (media.kind === "hls" && media.isLive) {
    frameNote.textContent = "This is a live stream. Recording live streams arrives in a later update.";
  } else if (running) {
    const fraction = entry.fraction ?? 0;
    progress.style.setProperty("--vz-perf-value", `${Math.min(100, fraction * 100)}%`);
    const size = media.kind === "file" && media.sizeBytes ? ` of ${formatBytes(media.sizeBytes)}` : "";
    frameNote.textContent =
      media.kind === "hls"
        ? `Downloading, ${Math.floor(fraction * 100)}%${entry.bytes ? ` · ${formatBytes(entry.bytes)}` : ""}`
        : `Downloading ${formatBytes(entry.bytes ?? 0)}${size}`;
  } else if (entry.state === "done") {
    frameNote.classList.add("is-done");
    frameNote.textContent = `Saved as ${entry.filename} · ${formatBytes(entry.bytes)}`;
  } else if (entry.state === "failed") {
    frameNote.classList.add("is-error");
    frameNote.textContent = `Download failed: ${entry.error}`;
  } else {
    frameNote.hidden = true;
  }
}

/* The form --------------------------------------------------------------- */

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  note.hidden = true;
  submit.disabled = true;
  form.setAttribute("aria-busy", "true");
  try {
    const result = await lookup(input.value);
    if (result.kind === "file" || result.kind === "hls") {
      const entry = createFrame(result);
      update(entry);
      strip.prepend(entry.frame);
      strip.hidden = false;
      input.value = "";
    } else {
      showNote(NOTES[result.kind](result), result.kind !== "page");
    }
  } catch (err) {
    showNote(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    submit.disabled = false;
    form.removeAttribute("aria-busy");
  }
});
