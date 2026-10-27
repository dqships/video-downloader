// Messages between the service worker and the download worker. The worker
// cannot use chrome.* APIs, so the offscreen document relays both ways:
// service worker <-runtime messages-> offscreen document <-postMessage-> worker.

/** One file, or a byte range of one, of a downloaded track. */
export interface TrackPart {
  url: string;
  range?: { start: number; end: number };
}

export type ToWorker =
  | { type: "fetch-file"; jobId: string; url: string; expectedBytes?: number; supportsRanges: boolean }
  /** `url` is a playlist, often a data: URL master built for the chosen quality. */
  | { type: "fetch-hls"; jobId: string; url: string; audioOnly?: boolean }
  /** A stream the HLS reader can't take (WebM DASH): each track's parts, in order, joined into one file. */
  | { type: "fetch-tracks"; jobId: string; tracks: TrackPart[][] }
  /** Records a live DASH stream's representations until it ends or a `stop` arrives. */
  | { type: "record-live-dash"; jobId: string; manifestUrl: string; reps: string[] }
  /** Records a live HLS stream until it ends or a `stop` arrives. */
  | { type: "record-live"; jobId: string; url: string; audioOnly?: boolean }
  /** Ends a recording and keeps what was recorded. */
  | { type: "stop"; jobId: string }
  | { type: "cancel"; jobId: string }
  | { type: "cleanup"; jobId: string };

export type FromWorker =
  | { type: "progress"; jobId: string; bytes: number; totalBytes?: number; fraction?: number; seconds?: number }
  | { type: "done"; jobId: string; blobUrl: string; bytes: number }
  | { type: "error"; jobId: string; message: string }
  /** The capture page saved a player recording itself (it has the blob). */
  | { type: "saved"; jobId: string; downloadId: number; filename: string; bytes: number };

/** Runtime-message envelopes, so pages can tell relay traffic from commands. */
export interface ToOffscreenEnvelope {
  target: "offscreen";
  message: ToWorker;
}

export interface FromOffscreenEnvelope {
  target: "service-worker";
  message: FromWorker;
}
