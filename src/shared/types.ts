// Shared data shapes. Every detector produces a MediaItem; the downloader and
// the UI only ever consume MediaItems, so new detectors never touch them.

/** "mse": no URL to fetch; what the page's player is fed is recorded instead. */
export type MediaType = "http" | "hls" | "dash" | "mse";

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
  /** "sniffer": seen on the network; "page": declared in the page's markup. */
  sourceKind: "sniffer" | "page";
  /** The page's own name for this video, when it has several (JSON-LD). */
  title?: string;
  thumbnail?: string;
  /** MSE recordings: the frame whose player is recorded. */
  frameId?: number;
  /** Listing order a site extractor chose (0 first); unset items follow. */
  rank?: number;
  /** Streams only: the qualities on offer, best first. */
  variants?: StreamVariant[];
  /** Streams only: child playlists of this master, hidden from the list. */
  childUrls?: string[];
  /** Streams only: length in seconds, when known. */
  durationSec?: number;
  /** Streams only: still being broadcast (no end marker yet). */
  isLive?: boolean;
  /** Subtitle tracks this stream carries. */
  subtitles?: SubtitleTrack[];
}

/** A subtitle track a page or stream offers; saved as .srt next to the video. */
export interface SubtitleTrack {
  id: string;
  /** "English", "Deutsch (CC)"... */
  label: string;
  lang?: string;
  /**
   * Where the text is: one WebVTT/TTML/SRT file, an HLS subtitle playlist of
   * WebVTT segments, or a list of segment URLs (DASH).
   */
  source: { kind: "file"; url: string } | { kind: "hls"; url: string } | { kind: "segments"; urls: string[] };
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
  /** The media playlist to download (for a direct file, the file itself). */
  url: string;
  /** Direct files only: the file's size. */
  sizeBytes?: number;
  /** A separate audio playlist, when the stream keeps audio apart. */
  audioUrl?: string;
  audioCodecs?: string;
  audioLanguage?: string;
  /** Save the sound only (an .m4a); the picture is dropped. */
  audioOnly?: boolean;
  /** DASH: representations to download, as `adaptationSet:representation`. */
  videoRep?: string;
  audioRep?: string;
}

export interface TabMedia {
  tabId: number;
  pageUrl: string;
  title?: string;
  thumbnail?: string;
  /** Set when the page plays DRM-protected media (EME): the key system. */
  drmKeySystem?: string;
  /** Subtitle tracks the page itself attaches (<track> elements). */
  subtitles?: SubtitleTrack[];
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
  /** Live recordings: seconds recorded so far. */
  recordedSec?: number;
  /** A live recording: runs until the stream ends or the user stops it. */
  recording?: boolean;
  /** Subtitles saved alongside: the file name, or why it failed. */
  subtitleFile?: string;
  subtitleError?: string;
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
  /** For history: where it came from and what it was called there. */
  pageUrl?: string;
  title?: string;
  thumbnail?: string;
  /** Player recordings: the frame recorded, and whether its capture frame has claimed the job. */
  player?: { frameId: number; claimed?: boolean };
}

/** One saved file, kept in chrome.storage.local for the history list. */
export interface HistoryEntry {
  id: string;
  filename: string;
  /** Absolute path, as Chrome saved it. */
  savedPath?: string;
  chromeDownloadId?: number;
  pageUrl: string;
  title?: string;
  thumbnail?: string;
  bytes?: number;
  /** "1080p", "Audio only"... */
  quality?: string;
  recorded?: boolean;
  savedAt: number;
}
