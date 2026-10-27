// Download worker. Started by the offscreen document; does the network and
// file work for every job and hands finished files back as blob: URLs.

/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "../shared/worker-protocol";
import { fetchFile } from "./fetch-file";

declare const self: DedicatedWorkerGlobalScope;

const running = new Map<string, AbortController>();
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

async function fetchJob(msg: Extract<ToWorker, { type: "fetch-file" }>): Promise<void> {
  const ctrl = new AbortController();
  running.set(msg.jobId, ctrl);
  try {
    const root = await opfs();
    const file = await root.getFileHandle(partName(msg.jobId), { create: true });
    const bytes = await fetchFile({
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
      void fetchJob(msg);
      break;
    case "cancel":
      running.get(msg.jobId)?.abort(new Error("Cancelled"));
      break;
    case "cleanup":
      await cleanup(msg.jobId);
      break;
  }
};
