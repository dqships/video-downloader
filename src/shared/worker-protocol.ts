// Messages between the service worker and the download worker. The worker
// cannot use chrome.* APIs, so the offscreen document relays both ways:
// service worker <-runtime messages-> offscreen document <-postMessage-> worker.

export type ToWorker =
  | { type: "fetch-file"; jobId: string; url: string; expectedBytes?: number; supportsRanges: boolean }
  | { type: "cancel"; jobId: string }
  | { type: "cleanup"; jobId: string };

export type FromWorker =
  | { type: "progress"; jobId: string; bytes: number; totalBytes?: number }
  | { type: "done"; jobId: string; blobUrl: string; bytes: number }
  | { type: "error"; jobId: string; message: string };

/** Runtime-message envelopes, so pages can tell relay traffic from commands. */
export interface ToOffscreenEnvelope {
  target: "offscreen";
  message: ToWorker;
}

export interface FromOffscreenEnvelope {
  target: "service-worker";
  message: FromWorker;
}
