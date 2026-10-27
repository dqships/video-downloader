// Saves a subtitle track as .srt next to the video. Subtitles are small text,
// so the service worker fetches and converts them itself and hands
// chrome.downloads a data: URL.

import { parseM3u8 } from "../shared/hls";
import { mergeCues, parseSubtitles, toSrt } from "../shared/subtitles";
import type { SubtitleTrack } from "../shared/types";
import { fetchPlaylistText } from "./hls-probe";
import { installReplay, removeReplay, replayScopes } from "./replay";

const SEGMENT_TIMEOUT_MS = 15_000;
const MAX_SEGMENTS = 2000;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`The server answered ${res.status} for the subtitles`);
  return res.text();
}

/** The URLs holding the track's text, reading its playlist first for HLS. */
async function textUrls(track: SubtitleTrack): Promise<string[]> {
  const { source } = track;
  if (source.kind === "file") return [source.url];
  if (source.kind === "segments") return source.urls;
  const pl = parseM3u8(await fetchPlaylistText(source.url), source.url);
  if (pl.kind !== "media") throw new Error("The subtitle playlist has no segments");
  return pl.segments;
}

/** `Clip.mp4` + `en` -> `Clip.en.srt`, in the same folder. */
export function subtitleFilename(videoFilename: string, track: SubtitleTrack): string {
  const base = videoFilename.replace(/\.[a-z0-9]{1,5}$/i, "");
  const tag = (track.lang || track.label || "subtitles").replace(/[^\p{L}\p{N}-]+/gu, "_").slice(0, 24);
  return `${base}.${tag}.srt`;
}

/** Downloads, converts and saves the track; returns the file name used. */
export async function saveSubtitles(track: SubtitleTrack, sent: Record<string, string>, videoFilename: string): Promise<string> {
  const playlistUrl = track.source.kind === "hls" ? [track.source.url] : [];
  let rules = await installReplay(replayScopes([...playlistUrl, ...(track.source.kind === "file" ? [track.source.url] : [])]), sent);
  try {
    const urls = (await textUrls(track)).slice(0, MAX_SEGMENTS);
    await removeReplay(rules);
    rules = await installReplay(replayScopes(urls), sent);
    const texts: string[] = [];
    for (const url of urls) texts.push(await fetchText(url));
    const cues = mergeCues(texts.map(parseSubtitles));
    if (!cues.length) throw new Error("The subtitles were empty");
    const filename = subtitleFilename(videoFilename, track);
    await chrome.downloads.download({
      url: `data:application/x-subrip;charset=utf-8,${encodeURIComponent(toSrt(cues))}`,
      filename,
      conflictAction: "uniquify",
    });
    return filename;
  } finally {
    await removeReplay(rules);
  }
}
