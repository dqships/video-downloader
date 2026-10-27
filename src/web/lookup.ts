// Works out what a link pasted on the website points at: a video file, an HLS
// stream, or something only the extension can save. A web page may read another
// site's response only when that site allows it (CORS), so a refused fetch is
// an answer too: the extension, which works inside the tab, can still save it.

import { isDrmKey, listVariants, parseM3u8, type HlsMedia } from "../shared/hls";
import type { StreamVariant } from "../shared/types";
import { classify, MIME_EXT } from "../sw/classify";

export type Lookup =
  | {
      kind: "file";
      url: string;
      mime: string;
      ext: string;
      sizeBytes?: number;
      supportsRanges: boolean;
      serverFilename?: string;
    }
  | { kind: "hls"; url: string; variants: StreamVariant[]; durationSec?: number; isLive: boolean; hasDrm: boolean }
  /** HTML, or anything else that isn't media: the video is somewhere on that page. */
  | { kind: "page"; url: string }
  /** The site doesn't share its files with other websites, or can't be reached. */
  | { kind: "blocked"; url: string }
  | { kind: "http-error"; url: string; status: number }
  | { kind: "dash"; url: string }
  | { kind: "youtube" }
  | { kind: "invalid" };

const TIMEOUT_MS = 15_000;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
const YOUTUBE_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"];

/** "example.com/clip.mp4" -> "https://example.com/clip.mp4"; null if it isn't a web link. */
export function parseLink(text: string): URL | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
  return url;
}

export function isYouTube(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return YOUTUBE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

async function readText(res: Response): Promise<string> {
  const text = await res.text();
  if (text.length > MAX_PLAYLIST_BYTES) throw new Error("The playlist is too large");
  return text;
}

function mediaFacts(pl: HlsMedia) {
  return {
    durationSec: pl.duration > 0 ? Math.round(pl.duration * 10) / 10 : undefined,
    isLive: !pl.endList && pl.playlistType !== "VOD",
    hasDrm: pl.keys.some(isDrmKey),
  };
}

async function readHls(url: string, res: Response, signal: AbortSignal): Promise<Lookup> {
  const pl = parseM3u8(await readText(res), url);
  if (pl.kind === "media") {
    return { kind: "hls", url, variants: [{ id: "0", label: "Original", url }], ...mediaFacts(pl) };
  }
  const variants = listVariants(pl);
  const sessionDrm = pl.sessionKeys.some(isDrmKey);
  const best = variants[0];
  let facts = { durationSec: undefined as number | undefined, isLive: false, hasDrm: false };
  if (best) {
    // The best quality's playlist tells us the length, liveness and keys.
    try {
      const media = parseM3u8(await readText(await fetch(best.url, { signal })), best.url);
      if (media.kind === "media") facts = mediaFacts(media);
    } catch {
      /* list it without details; the download will report a real failure */
    }
  }
  return { kind: "hls", url, variants, ...facts, hasDrm: sessionDrm || facts.hasDrm };
}

export async function lookup(text: string, outer?: AbortSignal): Promise<Lookup> {
  const link = parseLink(text);
  if (!link) return { kind: "invalid" };
  if (isYouTube(link)) return { kind: "youtube" };

  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(outer ? [outer] : [])]);
  let res: Response;
  try {
    res = await fetch(link.href, { signal, cache: "no-store" });
  } catch (err) {
    if (outer?.aborted) throw err;
    return { kind: "blocked", url: link.href };
  }

  const url = res.url || link.href;
  const responseHeaders = [...res.headers].map(([name, value]) => ({ name, value }));
  const classified = classify({ url, type: "xmlhttprequest", statusCode: res.status, responseHeaders });

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { kind: "http-error", url, status: res.status };
  }
  if (classified?.type === "hls") return readHls(url, res, signal);
  // Only the headers matter from here: stop the body.
  await res.body?.cancel().catch(() => {});
  if (classified?.type === "dash") return { kind: "dash", url };
  if (classified?.type === "http") {
    const { mime, ext, sizeBytes, supportsRanges, serverFilename } = classified;
    return { kind: "file", url, mime, ext, sizeBytes, supportsRanges, serverFilename };
  }
  // classify() skips small files as previews; a pasted link was chosen on purpose.
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (/^(video|audio)\//.test(mime) && mime !== "video/mp2t") {
    const length = Number(res.headers.get("content-length"));
    return {
      kind: "file",
      url,
      mime,
      ext: MIME_EXT[mime] ?? (mime.startsWith("audio/") ? "m4a" : "mp4"),
      sizeBytes: Number.isFinite(length) && length > 0 ? length : undefined,
      supportsRanges: false,
    };
  }
  return { kind: "page", url };
}
