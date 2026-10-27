// Shared data shapes. Every detector produces a MediaItem; the downloader and
// the UI only ever consume MediaItems, so new detectors never touch them.

export type MediaType = "http" | "hls" | "dash";

export interface MediaItem {
  /** Stable id: a hash of the URL (http) or of the manifest (hls/dash). */
  id: string;
  type: MediaType;
  url: string;
  tabId: number;
  pageUrl: string;
  /** MIME type as served, lowercased, without parameters. */
  mime: string;
  /** File extension to save with, without the dot. */
  ext: string;
  /** Total size in bytes when the server told us. */
  sizeBytes?: number;
  supportsRanges: boolean;
  /** Name from Content-Disposition, when the server sent one. */
  serverFilename?: string;
  /** Request headers the page sent for this URL, replayed on download. */
  sentHeaders: Record<string, string>;
  hasDrm: boolean;
  detectedAt: number;
  sourceKind: "sniffer";
  /** Streams only: the qualities on offer, best first. */
  variants?: StreamVariant[];
  /** Streams only: child playlists of this master, hidden from the list. */
  childUrls?: string[];
  /** Streams only: length in seconds, when known. */
  durationSec?: number;
  /** Streams only: still being broadcast (no end marker yet). */
  isLive?: boolean;
}

/** One downloadable quality of a stream: a video playlist plus its audio. */
export interface StreamVariant {
  id: string;
  /** "1080p", "720p · 2.4 Mbps", "Audio only"... */
  label: string;
  height?: number;
  width?: number;
  bandwidth?: number;
  codecs?: string;
  /** The media playlist to download. */
  url: string;
  /** A separate audio playlist, when the stream keeps audio apart. */
  audioUrl?: string;
  audioCodecs?: string;
  audioLanguage?: string;
}

export interface TabMedia {
  tabId: number;
  pageUrl: string;
  title?: string;
  thumbnail?: string;
  media: MediaItem[];
}

export type DownloadState = "running" | "complete" | "failed";

export interface DownloadJob {
  jobId: string;
  mediaId: string;
  tabId: number;
  /** Path relative to Chrome's download folder. */
  filename: string;
  state: DownloadState;
  /** Fetching into the worker, then saving through chrome.downloads. */
  phase: "fetching" | "saving";
  bytesReceived: number;
  totalBytes?: number;
  /** Streams: fraction done, 0..1, since the final size isn't known up front. */
  progress?: number;
  /** Streams: the quality being downloaded. */
  variantLabel?: string;
  error?: string;
  saveAs: boolean;
  /** Header-replay rules to remove when the job ends. */
  ruleIds?: number[];
  chromeDownloadId?: number;
  /** Absolute path of the saved file, once complete. */
  savedPath?: string;
  startedAt: number;
}
