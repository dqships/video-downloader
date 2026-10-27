// Reads a DASH manifest the page loaded (qualities, length, live, DRM) and,
// for a download, turns the chosen representations into HLS playlists for
// the download worker. Fetches replay the page's headers.

import { dashChildUrls, hlsMediaPlaylist, isMp4Family, liveSegments, listDashSubtitles, listDashVariants, parseMpd, resolveSegments, type ByteRange, type DashManifest, type SegmentRef } from "../shared/dash";
import { dataUrl, singleVariantMaster } from "../shared/hls";
import type { StreamVariant } from "../shared/types";
import type { TrackPart } from "../shared/worker-protocol";
import type { FrameRef, HlsDetails } from "./hls-probe";
import { fetchForProbe, fetchWithReplay } from "./hls-probe";
import { installReplay, removeReplay } from "./replay";

const INDEX_TIMEOUT_MS = 15_000;

async function readManifest(url: string, sent: Record<string, string>): Promise<DashManifest> {
  return parseMpd(await fetchWithReplay(url, sent), url);
}

/** Never throws: an unreadable manifest just lists without details; null when it isn't a manifest. */
export async function probeDash(url: string, sent: Record<string, string>, frame?: FrameRef): Promise<HlsDetails | null> {
  let text: string;
  try {
    text = await fetchForProbe(url, sent, frame);
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
 * A segment count worked out from the length can end in a sliver the
 * packager folded into the segment before (BBC's servers do this), so a
 * short last segment is checked and dropped when the server doesn't have it.
 */
async function dropMissingTail(segments: SegmentRef[], sent: Record<string, string>): Promise<SegmentRef[]> {
  const last = segments.at(-1);
  const before = segments.at(-2);
  if (!last || !before || last.range || (last.duration ?? 0) >= (before.duration ?? 0) / 2) return segments;
  const rules = await installReplay([last.url], sent);
  try {
    const res = await fetch(last.url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) });
    void res.body?.cancel();
    return res.status === 404 || res.status === 410 ? segments.slice(0, -1) : segments;
  } catch {
    return segments;
  } finally {
    await removeReplay(rules);
  }
}

export type DashPlan =
  /** A data: URL playlist (a one-quality master, or the audio playlist alone) for the HLS reader. */
  | { kind: "hls"; url: string; urls: string[] }
  /** WebM tracks: each one's files, fetched and joined by the worker. */
  | { kind: "tracks"; tracks: TrackPart[][]; urls: string[] }
  /** A live stream: the worker reads the manifest itself as it updates. */
  | { kind: "live"; reps: string[]; urls: string[] };

/**
 * What the worker should read for this variant, and every URL it will fetch,
 * for header-replay scoping.
 */
export async function planDash(manifestUrl: string, variant: StreamVariant, sent: Record<string, string>): Promise<DashPlan> {
  const m = await readManifest(manifestUrl, sent);
  const urls: string[] = [manifestUrl];
  const rep = (key: string | undefined) => {
    if (!key) return undefined;
    const found = m.representations.find((r) => r.key === key);
    if (!found) throw new Error("This quality is no longer in the stream's manifest. Reload the page and try again.");
    if (found.hasDrm) throw new Error("This video is protected by DRM and can't be downloaded.");
    return found;
  };
  const audioRep = rep(variant.audioRep);
  const videoRep = variant.audioOnly ? undefined : rep(variant.videoRep);
  if (variant.audioOnly && !audioRep) throw new Error("This stream has no separate audio track.");
  if (!variant.audioOnly && !videoRep) throw new Error("This quality is no longer in the stream's manifest. Reload the page and try again.");
  const reps = [videoRep, audioRep].filter((r) => r !== undefined);

  if (m.isLive) {
    // Where its files live, for the header replay; the worker follows the manifest from here.
    for (const r of reps) {
      const { init, segments } = liveSegments(m, r, Date.now());
      urls.push(...(init ? [init.url] : []), ...segments.slice(-1).map((s) => s.url));
    }
    return { kind: "live", reps: reps.map((r) => r.key), urls };
  }

  if (reps.some((r) => !isMp4Family(r))) {
    const tracks: TrackPart[][] = [];
    for (const r of reps) {
      // A single-file representation is a whole WebM file: no index needed.
      if (r.segments.kind === "file" || r.segments.kind === "indexed") {
        urls.push(r.segments.url);
        tracks.push([{ url: r.segments.url }]);
        continue;
      }
      if (r.segments.kind !== "list") throw new Error("This stream's manifest lists no segments.");
      const segments = await dropMissingTail(r.segments.segments, sent);
      if (!segments.length) throw new Error("This stream's manifest lists no segments.");
      const parts = [...(r.segments.init ? [r.segments.init] : []), ...segments].map((s) => ({ url: s.url, range: s.range }));
      urls.push(...parts.map((p) => p.url));
      tracks.push(parts);
    }
    return { kind: "tracks", tracks, urls };
  }

  const playlist = async (r: typeof audioRep) => {
    if (!r) return undefined;
    const resolved = await resolveSegments(r, m.duration, (u, range) => fetchRange(u, range, sent));
    const init = resolved.init;
    const segments = await dropMissingTail(resolved.segments, sent);
    if (!segments.length) throw new Error("This stream's manifest lists no segments.");
    if (init) urls.push(init.url);
    urls.push(...segments.map((s) => s.url));
    return dataUrl(hlsMediaPlaylist(init, segments));
  };
  const audio = await playlist(audioRep);
  if (variant.audioOnly) return { kind: "hls", url: audio!, urls };
  const video = (await playlist(videoRep))!;
  return { kind: "hls", url: dataUrl(singleVariantMaster({ ...variant, url: video, audioUrl: audio })), urls };
}
