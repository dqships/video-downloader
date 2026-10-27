// Reads an HLS playlist the page loaded, so the list can offer its qualities,
// show the length and spot DRM or live streams before anything downloads.
// Fetches replay the page's headers, like downloads do.

import { isDrmKey, listHlsSubtitles, listVariants, parseM3u8, type HlsMedia } from "../shared/hls";
import type { MediaItem, StreamVariant } from "../shared/types";
import { installReplay, removeReplay } from "./replay";

const PLAYLIST_TIMEOUT_MS = 15_000;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

export type HlsDetails = Partial<Pick<MediaItem, "variants" | "childUrls" | "durationSec" | "isLive" | "hasDrm" | "subtitles">>;

/** Fetches a playlist; the caller has installed header replay for its directory. */
export async function fetchPlaylistText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`The server answered ${res.status} for the playlist`);
  const text = await res.text();
  if (text.length > MAX_PLAYLIST_BYTES) throw new Error("The playlist is too large");
  return text;
}

/** Fetches a playlist with header replay scoped to it for the duration. */
export async function fetchWithReplay(url: string, sent: Record<string, string>): Promise<string> {
  const rules = await installReplay([url], sent);
  try {
    return await fetchPlaylistText(url);
  } finally {
    await removeReplay(rules);
  }
}

function mediaFacts(pl: HlsMedia): Pick<HlsDetails, "durationSec" | "isLive" | "hasDrm"> {
  return {
    durationSec: pl.duration > 0 ? Math.round(pl.duration * 10) / 10 : undefined,
    isLive: !pl.endList && pl.playlistType !== "VOD",
    hasDrm: pl.keys.some(isDrmKey),
  };
}

/** Never throws: an unreadable playlist just lists without details. */
export async function probeHls(url: string, sent: Record<string, string>): Promise<HlsDetails> {
  try {
    const pl = parseM3u8(await fetchWithReplay(url, sent), url);
    if (pl.kind === "media") {
      const variant: StreamVariant = { id: "0", label: "Original", url };
      return { variants: [variant], ...mediaFacts(pl) };
    }
    const variants = listVariants(pl);
    const childUrls = [
      ...new Set([...pl.variants.map((v) => v.uri), ...pl.renditions.flatMap((r) => (r.uri ? [r.uri] : []))]),
    ];
    const sessionDrm = pl.sessionKeys.some(isDrmKey);
    const subtitles = listHlsSubtitles(pl);
    const best = variants[0];
    if (!best) return { variants, childUrls, subtitles, hasDrm: sessionDrm };
    // The best quality's playlist tells us the length, liveness and keys.
    const media = parseM3u8(await fetchWithReplay(best.url, sent), best.url);
    const facts = media.kind === "media" ? mediaFacts(media) : { hasDrm: false };
    return { variants, childUrls, subtitles, ...facts, hasDrm: sessionDrm || facts.hasDrm };
  } catch {
    return {};
  }
}

/** Every URL a download of this variant will touch, for header-replay scoping. */
export async function variantUrls(variant: StreamVariant, sent: Record<string, string>): Promise<string[]> {
  const playlists = [variant.url, variant.audioUrl].filter((u): u is string => !!u);
  const lists = await Promise.all(
    playlists.map(async (u) => {
      const pl = parseM3u8(await fetchWithReplay(u, sent), u);
      return pl.kind === "media" ? [u, ...pl.segments, ...pl.otherUris] : [u];
    }),
  );
  return lists.flat();
}
