// Download jobs. The worker fetches the media (so header replay applies, which
// it does not for chrome.downloads' own requests), then chrome.downloads saves
// the finished file from a blob: URL. Job state is mirrored to
// chrome.storage.session for the UI and to survive service-worker restarts.

import { storageKeys } from "../shared/messages";
import { asciiFilename, buildFilename, mimeForFilename, sanitizeFilename } from "../shared/naming";
import { addHistory } from "../shared/history";
import { loadSettings } from "../shared/settings";
import { dataUrl, singleVariantMaster } from "../shared/hls";
import type { DownloadJob, MediaItem, StreamVariant, TabMedia } from "../shared/types";
import type { FromWorker, ToOffscreenEnvelope, ToWorker } from "../shared/worker-protocol";
import { planDash } from "./dash-probe";
import { variantUrls } from "./hls-probe";
import { installReplay, removeReplay, replayScopes } from "./replay";
import { saveSubtitles } from "./subtitles";

const OFFSCREEN_URL = "offscreen.html";
const KEEP_FINISHED_JOBS = 50;
/** How long a reloaded page has to start its player before an armed recording gives up. */
const ARM_TIMEOUT_MS = 30_000;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

let creatingOffscreen: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (existing.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification: "Runs downloads and remuxing in a Web Worker.",
    })
    .finally(() => (creatingOffscreen = undefined));
  await creatingOffscreen;
}

async function toWorker(message: ToWorker): Promise<void> {
  await ensureOffscreen();
  const envelope: ToOffscreenEnvelope = { target: "offscreen", message };
  // The offscreen page may still be registering its listener right after creation.
  for (let attempt = 0; ; attempt++) {
    try {
      await chrome.runtime.sendMessage(envelope);
      return;
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export class Downloads {
  private jobs = new Map<string, DownloadJob>();
  private loaded: Promise<void>;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.loaded = chrome.storage.session.get(storageKeys.jobs).then((data) => {
      const stored = (data[storageKeys.jobs] ?? {}) as Record<string, DownloadJob>;
      for (const job of Object.values(stored)) if (!this.jobs.has(job.jobId)) this.jobs.set(job.jobId, job);
    });
    chrome.downloads.onChanged.addListener((delta) => void this.onSaveChanged(delta));
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      // Re-assert our name so another extension cannot rename our files.
      const job = [...this.jobs.values()].find((j) => j.chromeDownloadId === item.id);
      if (job) suggest({ filename: job.filename, conflictAction: "uniquify" });
      else suggest();
    });
  }

  async start(tab: TabMedia, item: MediaItem, filenameOverride?: string, variantId?: string, subtitleId?: string): Promise<string> {
    await this.loaded;
    if (item.hasDrm) throw new Error("This video is protected by DRM and can't be downloaded.");
    if (item.type === "mse") return this.recordPlayer(tab, item, filenameOverride);
    let variant: StreamVariant | undefined;
    // A direct file may come in several sizes (a site extractor found them).
    const file = item.type === "http" ? (item.variants?.find((v) => v.id === variantId) ?? item.variants?.[0]) : undefined;
    const fileUrl = file?.url ?? item.url;
    const fileBytes = file ? file.sizeBytes : item.sizeBytes;
    if (item.type !== "http") {
      variant = item.variants?.find((v) => v.id === variantId) ?? item.variants?.[0];
      if (!variant) throw new Error("Couldn't read this stream's playlist. Reload the page and try again.");
    }

    // Sound-only stream downloads are saved as .m4a; Vorbis only fits in WebM.
    const ext = variant?.webm ? "webm" : variant?.audioOnly ? "m4a" : item.ext;
    const settings = await loadSettings();
    const name = filenameOverride
      ? `${sanitizeFilename(filenameOverride.replace(/\.[a-z0-9]{1,5}$/i, ""), settings.maxLength)}.${ext}`
      : buildFilename({
          template: settings.template,
          maxLength: settings.maxLength,
          title: item.title ?? tab.title,
          pageUrl: tab.pageUrl,
          mediaUrl: item.url,
          serverFilename: item.serverFilename,
          ext,
        });
    const folder = settings.subfolder
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((part) => sanitizeFilename(part, 64))
      .join("/");

    const job: DownloadJob = {
      jobId: crypto.randomUUID(),
      mediaId: item.id,
      tabId: tab.tabId,
      filename: folder ? `${folder}/${name}` : name,
      state: "running",
      phase: "fetching",
      bytesReceived: 0,
      totalBytes: variant ? undefined : fileBytes,
      progress: variant && !item.isLive ? 0 : undefined,
      recording: item.isLive || undefined,
      recordedSec: item.isLive ? 0 : undefined,
      variantLabel: (variant ?? file) && item.variants!.length > 1 ? (variant ?? file)!.label : undefined,
      saveAs: settings.saveAs,
      ruleIds: variant ? [] : await installReplay([fileUrl], item.sentHeaders),
      startedAt: Date.now(),
      pageUrl: tab.pageUrl,
      title: item.title ?? tab.title,
      thumbnail: item.thumbnail ?? tab.thumbnail,
    };
    this.jobs.set(job.jobId, job);
    this.persist();
    const mime = mimeForFilename(name);
    try {
      if (variant) {
        if (item.type === "dash") {
          // DASH is described to the worker as HLS playlists for the chosen
          // tracks, or (WebM) as the tracks' files to join.
          const plan = await planDash(item.url, variant, item.sentHeaders);
          job.ruleIds = await installReplay(replayScopes([item.url, ...plan.urls]), item.sentHeaders);
          if (plan.kind === "live") await toWorker({ type: "record-live-dash", jobId: job.jobId, mime, manifestUrl: item.url, reps: plan.reps });
          else if (plan.kind === "tracks") await toWorker({ type: "fetch-tracks", jobId: job.jobId, mime, tracks: plan.tracks });
          else await toWorker({ type: "fetch-hls", jobId: job.jobId, mime, url: plan.url, audioOnly: variant.audioOnly });
        } else {
          const urls = await variantUrls(variant, item.sentHeaders);
          // Media playlists are read as is; a master is narrowed to the chosen quality.
          const url = variant.url === item.url || variant.audioOnly ? variant.url : dataUrl(singleVariantMaster(variant));
          // Replay the page's headers on every directory the stream lives in.
          job.ruleIds = await installReplay(replayScopes([item.url, ...urls]), item.sentHeaders);
          await toWorker({ type: item.isLive ? "record-live" : "fetch-hls", jobId: job.jobId, mime, url, audioOnly: variant.audioOnly });
        }
      } else {
        await toWorker({
          type: "fetch-file",
          jobId: job.jobId,
          mime,
          url: fileUrl,
          expectedBytes: fileBytes,
          supportsRanges: item.supportsRanges,
        });
      }
    } catch (err) {
      await this.fail(job, err instanceof Error ? err.message : String(err));
      throw err;
    }
    const track = subtitleId ? [...(item.subtitles ?? []), ...(tab.subtitles ?? [])].find((t) => t.id === subtitleId) : undefined;
    if (track) {
      // Subtitles save on their own; a failure there doesn't stop the video.
      saveSubtitles(track, item.sentHeaders, job.filename).then(
        (file) => (job.subtitleFile = file),
        (err) => (job.subtitleError = err instanceof Error ? err.message : String(err)),
      ).finally(() => this.persist());
    }
    return job.jobId;
  }

  /** Player recording: the page's own buffers, collected by the capture frame. */
  private async recordPlayer(tab: TabMedia, item: MediaItem, filenameOverride?: string): Promise<string> {
    const settings = await loadSettings();
    const name = filenameOverride
      ? `${sanitizeFilename(filenameOverride.replace(/\.[a-z0-9]{1,5}$/i, ""), settings.maxLength)}.mp4`
      : buildFilename({ template: settings.template, maxLength: settings.maxLength, title: item.title ?? tab.title, pageUrl: tab.pageUrl, mediaUrl: item.url, ext: "mp4" });
    const folder = settings.subfolder.split(/[\\/]+/).filter(Boolean).map((part) => sanitizeFilename(part, 64)).join("/");
    const job: DownloadJob = {
      jobId: crypto.randomUUID(),
      mediaId: item.id,
      tabId: tab.tabId,
      filename: folder ? `${folder}/${name}` : name,
      state: "running",
      phase: "fetching",
      bytesReceived: 0,
      recording: true,
      saveAs: settings.saveAs,
      startedAt: Date.now(),
      pageUrl: tab.pageUrl,
      title: item.title ?? tab.title,
      thumbnail: item.thumbnail ?? tab.thumbnail,
      player: { frameId: -1, armed: true },
    };
    this.jobs.set(job.jobId, job);
    this.persist();
    // Reloading lets the player be recorded from its very first buffer; the
    // page's player asks for its job as soon as it starts (claimArmed).
    try {
      await chrome.tabs.reload(tab.tabId);
    } catch {
      await this.fail(job, "The page isn't reachable any more. Reload it and try again.");
      return job.jobId;
    }
    setTimeout(() => {
      if (job.state === "running" && job.player?.armed)
        void this.fail(job, "The player didn't start after the page reloaded. Play the video, then press Record again.");
    }, ARM_TIMEOUT_MS);
    return job.jobId;
  }

  /** A player in a just-reloaded tab: the armed recording, now bound to its frame. */
  async claimArmed(tabId: number, frameId: number, mediaId: string, pageUrl: string): Promise<DownloadJob | undefined> {
    await this.loaded;
    const job = [...this.jobs.values()].find((j) => j.tabId === tabId && j.state === "running" && j.player?.armed);
    // The tab may have gone to another site meanwhile.
    if (!job || !sameOrigin(job.pageUrl ?? "", pageUrl)) return undefined;
    job.player = { frameId };
    // Frame ids change across a reload, and the list entry with them.
    job.mediaId = mediaId;
    this.persist();
    return job;
  }

  /** The capture frame asks for its job; each recording is handed out once. */
  async claimCapture(jobId: string): Promise<DownloadJob | undefined> {
    await this.loaded;
    const job = this.jobs.get(jobId);
    if (!job?.player || job.player.claimed || job.state !== "running") return undefined;
    job.player.claimed = true;
    return job;
  }

  async cancel(jobId: string): Promise<void> {
    await this.loaded;
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "running") return;
    if (job.chromeDownloadId !== undefined) await chrome.downloads.cancel(job.chromeDownloadId).catch(() => {});
    else if (job.player) {
      if (!job.player.armed) await chrome.tabs.sendMessage(job.tabId, { kind: "mse-cancel", jobId }, { frameId: job.player.frameId }).catch(() => {});
      await this.fail(job, "Cancelled");
    } else await toWorker({ type: "cancel", jobId });
  }

  /** Ends a live recording; the worker then saves what it has. */
  async stop(jobId: string): Promise<void> {
    await this.loaded;
    const job = this.jobs.get(jobId);
    if (job?.state !== "running" || !job.recording || job.phase !== "fetching") return;
    if (job.player?.armed) await this.fail(job, "Cancelled");
    else if (job.player) await chrome.tabs.sendMessage(job.tabId, { kind: "mse-stop", jobId }, { frameId: job.player.frameId }).catch(() => {});
    else await toWorker({ type: "stop", jobId });
  }

  /** Messages relayed from the download worker. */
  async onWorkerMessage(msg: FromWorker): Promise<void> {
    await this.loaded;
    const job = this.jobs.get(msg.jobId);
    if (!job || job.state !== "running") return;
    switch (msg.type) {
      case "progress":
        job.bytesReceived = msg.bytes;
        if (msg.totalBytes) job.totalBytes = msg.totalBytes;
        if (msg.fraction !== undefined) job.progress = msg.fraction;
        if (msg.seconds !== undefined) job.recordedSec = msg.seconds;
        this.persist();
        break;
      case "error":
        await this.fail(job, msg.message);
        break;
      case "saved":
        job.chromeDownloadId = msg.downloadId;
        job.filename = msg.filename;
        job.bytesReceived = job.totalBytes = msg.bytes;
        job.phase = "saving";
        this.persist();
        break;
      case "done":
        job.bytesReceived = msg.bytes;
        job.totalBytes = msg.bytes;
        job.phase = "saving";
        await removeReplay(job.ruleIds ?? []);
        job.ruleIds = [];
        try {
          const save = () =>
            chrome.downloads.download({ url: msg.blobUrl, filename: job.filename, conflictAction: "uniquify", saveAs: job.saveAs });
          try {
            job.chromeDownloadId = await save();
          } catch (err) {
            // Some systems (no UTF-8 locale) refuse non-ASCII names; save under a plain one.
            const plain = asciiFilename(job.filename);
            if (!/invalid filename/i.test(String(err)) || plain === job.filename) throw err;
            job.filename = plain;
            job.chromeDownloadId = await save();
          }
          this.persist();
        } catch (err) {
          await this.fail(job, err instanceof Error ? err.message : String(err));
        }
        break;
    }
  }

  private async onSaveChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
    await this.loaded;
    const job = [...this.jobs.values()].find((j) => j.chromeDownloadId === delta.id);
    if (!job || job.state !== "running") return;
    const state = delta.state?.current;
    if (state === "complete") {
      const [item] = await chrome.downloads.search({ id: delta.id });
      job.state = "complete";
      job.savedPath = item?.filename;
      this.persist();
      const thumbnail = await this.latestThumbnail(job);
      void addHistory({
        id: job.jobId,
        filename: job.filename,
        savedPath: job.savedPath,
        chromeDownloadId: job.chromeDownloadId,
        pageUrl: job.pageUrl ?? "",
        title: job.title,
        thumbnail,
        bytes: item?.fileSize || item?.totalBytes || job.bytesReceived || undefined,
        // "720p · 2.5 MB": the size is listed on its own.
        quality: job.variantLabel?.split(" · ")[0],
        recorded: job.recording,
        savedAt: Date.now(),
      }).catch(() => {});
      void toWorker({ type: "cleanup", jobId: job.jobId });
    } else if (state === "interrupted") {
      await this.fail(job, delta.error?.current === "USER_CANCELED" ? "Cancelled" : (delta.error?.current ?? "Saving failed"));
    }
  }

  /**
   * Single-page apps often show a placeholder image (the site's logo) when a
   * download starts and the video's own one later; take the newest while the
   * tab still shows that page.
   */
  private async latestThumbnail(job: DownloadJob): Promise<string | undefined> {
    try {
      const key = storageKeys.tab(job.tabId);
      const tab = (await chrome.storage.session.get(key))[key] as TabMedia | undefined;
      if (!tab || tab.pageUrl !== job.pageUrl) return job.thumbnail;
      return tab.media.find((m) => m.id === job.mediaId)?.thumbnail ?? tab.thumbnail ?? job.thumbnail;
    } catch {
      return job.thumbnail;
    }
  }

  private async fail(job: DownloadJob, error: string): Promise<void> {
    job.state = "failed";
    job.error = error;
    await removeReplay(job.ruleIds ?? []);
    job.ruleIds = [];
    this.persist();
    void toWorker({ type: "cleanup", jobId: job.jobId }).catch(() => {});
  }

  /** Debounced write of every job (recent finished ones stay listed for the UI). */
  private persist(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      const finished = [...this.jobs.values()].filter((j) => j.state !== "running").sort((a, b) => b.startedAt - a.startedAt);
      for (const old of finished.slice(KEEP_FINISHED_JOBS)) this.jobs.delete(old.jobId);
      void chrome.storage.session.set({ [storageKeys.jobs]: Object.fromEntries(this.jobs) });
    }, 200);
  }
}

