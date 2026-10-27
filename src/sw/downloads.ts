// Download jobs. The worker fetches the media (so header replay applies, which
// it does not for chrome.downloads' own requests), then chrome.downloads saves
// the finished file from a blob: URL. Job state is mirrored to
// chrome.storage.session for the UI and to survive service-worker restarts.

import { storageKeys } from "../shared/messages";
import { buildFilename, sanitizeFilename } from "../shared/naming";
import { loadSettings } from "../shared/settings";
import type { DownloadJob, MediaItem, TabMedia } from "../shared/types";
import type { FromWorker, ToOffscreenEnvelope, ToWorker } from "../shared/worker-protocol";
import { installReplay, removeReplay } from "./replay";

const OFFSCREEN_URL = "offscreen.html";

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

  async start(tab: TabMedia, item: MediaItem, filenameOverride?: string): Promise<string> {
    await this.loaded;
    if (item.hasDrm) throw new Error("This video is protected by DRM and can't be downloaded.");
    if (item.type !== "http") throw new Error("Stream downloads (HLS and DASH) arrive in the next version.");

    const settings = await loadSettings();
    const name = filenameOverride
      ? `${sanitizeFilename(filenameOverride.replace(/\.[a-z0-9]{1,5}$/i, ""), settings.maxLength)}.${item.ext}`
      : buildFilename({
          template: settings.template,
          maxLength: settings.maxLength,
          title: tab.title,
          pageUrl: tab.pageUrl,
          mediaUrl: item.url,
          serverFilename: item.serverFilename,
          ext: item.ext,
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
      totalBytes: item.sizeBytes,
      saveAs: settings.saveAs,
      ruleIds: await installReplay([item.url], item.sentHeaders),
      startedAt: Date.now(),
    };
    this.jobs.set(job.jobId, job);
    this.persist();
    try {
      await toWorker({
        type: "fetch-file",
        jobId: job.jobId,
        url: item.url,
        expectedBytes: item.sizeBytes,
        supportsRanges: item.supportsRanges,
      });
    } catch (err) {
      await this.fail(job, err instanceof Error ? err.message : String(err));
      throw err;
    }
    return job.jobId;
  }

  async cancel(jobId: string): Promise<void> {
    await this.loaded;
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "running") return;
    if (job.chromeDownloadId !== undefined) await chrome.downloads.cancel(job.chromeDownloadId).catch(() => {});
    else await toWorker({ type: "cancel", jobId });
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
        this.persist();
        break;
      case "error":
        await this.fail(job, msg.message);
        break;
      case "done":
        job.bytesReceived = msg.bytes;
        job.totalBytes = msg.bytes;
        job.phase = "saving";
        await removeReplay(job.ruleIds ?? []);
        job.ruleIds = [];
        try {
          job.chromeDownloadId = await chrome.downloads.download({
            url: msg.blobUrl,
            filename: job.filename,
            conflictAction: "uniquify",
            saveAs: job.saveAs,
          });
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
      void toWorker({ type: "cleanup", jobId: job.jobId });
    } else if (state === "interrupted") {
      await this.fail(job, delta.error?.current === "USER_CANCELED" ? "Cancelled" : (delta.error?.current ?? "Saving failed"));
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

  /** Debounced write of every job (finished ones stay listed for the UI). */
  private persist(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void chrome.storage.session.set({ [storageKeys.jobs]: Object.fromEntries(this.jobs) });
    }, 200);
  }
}
