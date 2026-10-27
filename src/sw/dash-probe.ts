// Reads a DASH manifest the page loaded (qualities, length, live, DRM) and,
// for a download, turns the chosen representations into HLS playlists for
// the download worker. Fetches replay the page's headers.

import { dashChildUrls, hlsMediaPlaylist, listDashSubtitles, listDashVariants, parseMpd, resolveSegments, type ByteRange, type DashManifest } from "../shared/dash";
import { dataUrl, singleVariantMaster } from "../shared/hls";
import type { StreamVariant } from "../shared/types";
import type { HlsDetails } from "./hls-probe";
import { fetchWithReplay } from "./hls-probe";
import { installReplay, removeReplay } from "./replay";

const INDEX_TIMEOUT_MS = 15_000;

async function readManifest(url: string, sent: Record<string, string>): Promise<DashManifest> {
  return parseMpd(await fetchWithReplay(url, sent), url);
}

/** Never throws: an unreadable manifest just lists without details; null when it isn't a manifest. */
export async function probeDash(url: string, sent: Record<string, string>): Promise<HlsDetails | null> {
  let text: string;
  try {
    text = await fetchWithReplay(url, sent);
  } catch {
    return {};
  }
  if (!/<(\w+:)?MPD[\s>]/.test(text)) return null;
  try {
    const m = parseMpd(text, url);
    return {
      variants: listDashVariants(m, url),
      childUrls: dashChildUrls(m),
      durationSec: m.duration !== undefined ? Math.round(m.duration * 10) / 10 : undefined,
      isLive: m.isLive,
      hasDrm: m.hasDrm,
      subtitles: listDashSubtitles(m),
    };
  } catch {
    return {};
  }
}

async function fetchRange(url: string, range: ByteRange, sent: Record<string, string>): Promise<Uint8Array> {
  const rules = await installReplay([url], sent);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${range.start}-${range.end}` },
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`The server answered ${res.status} for the segment index`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A server that ignores Range sends the whole file; cut out the index.
    return res.status === 206 ? bytes : bytes.subarray(range.start, range.end + 1);
  } finally {
    await removeReplay(rules);
  }
}

/**
 * What the worker should read for this variant: a data: URL playlist (a
 * one-quality master, or the audio playlist alone), and every URL it will
 * fetch, for header-replay scoping.
 */
export async function planDash(
  manifestUrl: string,
  variant: StreamVariant,
  sent: Record<string, string>,
): Promise<{ url: string; urls: string[] }> {
  const m = await readManifest(manifestUrl, sent);
  if (m.isLive) throw new Error("Recording live streams arrives in a later version.");
  const urls: string[] = [manifestUrl];
  const playlist = async (key: string | undefined) => {
    if (!key) return undefined;
    const rep = m.representations.find((r) => r.key === key);
    if (!rep) throw new Error("This quality is no longer in the stream's manifest. Reload the page and try again.");
    if (rep.hasDrm) throw new Error("This video is protected by DRM and can't be downloaded.");
    const { init, segments } = await resolveSegments(rep, m.duration, (u, r) => fetchRange(u, r, sent));
    if (!segments.length) throw new Error("This stream's manifest lists no segments.");
    if (init) urls.push(init.url);
    urls.push(...segments.map((s) => s.url));
    return dataUrl(hlsMediaPlaylist(init, segments));
  };
  const audio = await playlist(variant.audioRep);
  if (variant.audioOnly) {
    if (!audio) throw new Error("This stream has no separate audio track.");
    return { url: audio, urls };
  }
  const video = await playlist(variant.videoRep);
  if (!video) throw new Error("This quality is no longer in the stream's manifest. Reload the page and try again.");
  return { url: dataUrl(singleVariantMaster({ ...variant, url: video, audioUrl: audio })), urls };
}
