// Decides whether a network response is media we should list. Pure: it takes
// plain data so it can be unit-tested without Chrome.

import type { MediaType } from "../shared/types";

export interface ResponseInfo {
  url: string;
  /** chrome.webRequest resource type: "media", "xmlhttprequest", ... */
  type: string;
  statusCode: number;
  responseHeaders: { name: string; value?: string }[];
  initiator?: string;
}

export interface Classified {
  type: MediaType;
  mime: string;
  ext: string;
  sizeBytes?: number;
  supportsRanges: boolean;
  serverFilename?: string;
}

/** Direct files smaller than this are usually previews, ads or segments. */
export const MIN_DIRECT_BYTES = 500 * 1024;

const MIME_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/x-m4v": "m4v",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/mpeg": "mpg",
  "video/ogg": "ogv",
  "video/x-flv": "flv",
  "video/3gpp": "3gp",
  "video/x-msvideo": "avi",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/webm": "weba",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
};

const MEDIA_EXTS = new Set([
  "mp4", "m4v", "webm", "mkv", "mov", "mpg", "mpeg", "ogv", "flv", "3gp", "avi",
  "m4a", "mp3", "weba", "ogg", "oga", "opus", "flac", "wav", "aac",
]);

/** Pieces of a stream, never whole files. */
const SEGMENT_PATH = /\.(ts|m4s|m2ts|cmfv|cmfa)$/i;

function header(info: ResponseInfo, name: string): string | undefined {
  const lower = name.toLowerCase();
  return info.responseHeaders.find((h) => h.name.toLowerCase() === lower)?.value;
}

function pathExt(pathname: string): string | undefined {
  const m = /\.([a-z0-9]{1,5})$/i.exec(pathname);
  return m?.[1]?.toLowerCase();
}

/** Filename from a Content-Disposition header, RFC 5987 form preferred. */
export function dispositionFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const star = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(value);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(value);
  const name = plain?.[2] ?? plain?.[1];
  return name?.trim() || undefined;
}

/** Total size from Content-Range ("bytes 0-1/12345") or Content-Length. */
function totalSize(info: ResponseInfo): number | undefined {
  const range = header(info, "content-range");
  const total = range && /\/(\d+)\s*$/.exec(range)?.[1];
  if (total) return Number(total);
  if (info.statusCode === 200) {
    const len = Number(header(info, "content-length"));
    if (Number.isFinite(len) && len > 0) return len;
  }
  return undefined;
}

export function classify(info: ResponseInfo): Classified | null {
  if (info.statusCode < 200 || info.statusCode >= 300) return null;
  if (info.initiator?.startsWith("chrome-extension://")) return null;

  let url: URL;
  try {
    url = new URL(info.url);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const mime = (header(info, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = pathExt(url.pathname);
  const href = url.pathname + url.search;

  if (mime.includes("mpegurl") || ext === "m3u8") {
    return { type: "hls", mime, ext: "mp4", supportsRanges: false };
  }
  if (mime.includes("dash+xml") || ext === "mpd") {
    return { type: "dash", mime, ext: "mp4", supportsRanges: false };
  }

  if (SEGMENT_PATH.test(url.pathname) || mime === "video/mp2t" || mime === "video/iso.segment") return null;
  if (mime.startsWith("image/") || mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript")) {
    return null;
  }

  const serverFilename = dispositionFilename(header(info, "content-disposition"));
  const dispositionExt = serverFilename ? pathExt(serverFilename) : undefined;
  const looksLikeMedia =
    info.type === "media" ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    (ext !== undefined && MEDIA_EXTS.has(ext)) ||
    (dispositionExt !== undefined && MEDIA_EXTS.has(dispositionExt));
  if (!looksLikeMedia) return null;
  // Range requests with a byte range in the query string are segments too.
  if (/[?&](range|bytestart)=/i.test(href)) return null;

  const sizeBytes = totalSize(info);
  if (sizeBytes !== undefined && sizeBytes < MIN_DIRECT_BYTES) return null;

  const chosenExt =
    (ext && MEDIA_EXTS.has(ext) ? ext : undefined) ??
    (dispositionExt && MEDIA_EXTS.has(dispositionExt) ? dispositionExt : undefined) ??
    MIME_EXT[mime] ??
    "mp4";

  const acceptRanges = header(info, "accept-ranges")?.toLowerCase();
  return {
    type: "http",
    mime,
    ext: chosenExt,
    sizeBytes,
    supportsRanges: acceptRanges === "bytes" || header(info, "content-range") !== undefined,
    serverFilename,
  };
}
