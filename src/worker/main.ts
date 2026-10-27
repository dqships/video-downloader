// Download worker. Started by the offscreen document; does the network and
// file work for every job and hands finished files back as blob: URLs.

/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "../shared/worker-protocol";
import { fetchFile } from "./fetch-file";
import { fetchTracks } from "./fetch-tracks";
import { recordLive } from "./record-live";
import { remuxHls } from "./remux-hls";

declare const self: DedicatedWorkerGlobalScope;

const running = new Map<string, AbortController>();
/** Live recordings: aborting one ends it and keeps the file. */
const stops = new Map<string, AbortController>();
const blobUrls = new Map<string, string>();

const post = (msg: FromWorker) => self.postMessage(msg);
const opfs = () => navigator.storage.getDirectory();
const partName = (jobId: string) => `${jobId}.part`;

async function purgeOpfs(): Promise<void> {
  const root = await opfs();
  // `keys()` is missing from TypeScript's DOM lib for directory handles.
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
    await root.removeEntry(name, { recursive: true }).catch(() => {});
  }
}

type JobMessage = Extract<ToWorker, { type: "fetch-file" | "fetch-hls" | "fetch-tracks" | "record-live" }>;

async function runJob(msg: JobMessage): Promise<void> {
  const ctrl = new AbortController();
  running.set(msg.jobId, ctrl);
  try {
    const root = await opfs();
    const file = await root.getFileHandle(partName(msg.jobId), { create: true });
    const stop = new AbortController();
    stops.set(msg.jobId, stop);
    const bytes =
      msg.type === "record-live"
        ? await recordLive({
            url: msg.url,
            file,
            signal: ctrl.signal,
            stop: stop.signal,
            audioOnly: msg.audioOnly,
            onProgress: (b, seconds) => post({ type: "progress", jobId: msg.jobId, bytes: b, seconds }),
          })
        : msg.type === "fetch-tracks"
        ? await fetchTracks({
            jobId: msg.jobId,
            tracks: msg.tracks,
            dir: root,
            file,
            signal: ctrl.signal,
            onProgress: (b, fraction) => post({ type: "progress", jobId: msg.jobId, bytes: b, fraction }),
          })
        : msg.type === "fetch-hls"
        ? await remuxHls({
            url: msg.url,
            file,
            signal: ctrl.signal,
            audioOnly: msg.audioOnly,
            onProgress: (b, fraction) => post({ type: "progress", jobId: msg.jobId, bytes: b, fraction }),
          })
        : await fetchFile({
            url: msg.url,
            file,
            expectedBytes: msg.expectedBytes,
            supportsRanges: msg.supportsRanges,
            signal: ctrl.signal,
            onProgress: (b, total) => post({ type: "progress", jobId: msg.jobId, bytes: b, totalBytes: total }),
          });
    if (bytes < 1024) throw new Error("The server sent an empty file");
    const blobUrl = URL.createObjectURL(await file.getFile());
    blobUrls.set(msg.jobId, blobUrl);
    post({ type: "done", jobId: msg.jobId, blobUrl, bytes });
  } catch (err) {
    const message = ctrl.signal.aborted ? "Cancelled" : err instanceof Error ? err.message : String(err);
    post({ type: "error", jobId: msg.jobId, message });
    await cleanup(msg.jobId);
  } finally {
    running.delete(msg.jobId);
    stops.delete(msg.jobId);
  }
}

async function cleanup(jobId: string): Promise<void> {
  const url = blobUrls.get(jobId);
  if (url) URL.revokeObjectURL(url);
  blobUrls.delete(jobId);
  await (await opfs()).removeEntry(partName(jobId)).catch(() => {});
}

const ready = purgeOpfs().catch(() => {});

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  await ready;
  const msg = e.data;
  switch (msg.type) {
    case "fetch-file":
    case "fetch-hls":
    case "fetch-tracks":
    case "record-live":
      void runJob(msg);
      break;
    case "stop":
      stops.get(msg.jobId)?.abort();
      break;
    case "cancel":
      running.get(msg.jobId)?.abort(new Error("Cancelled"));
      break;
    case "cleanup":
      await cleanup(msg.jobId);
      break;
  }
};
