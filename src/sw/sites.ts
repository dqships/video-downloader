// Site extractors: small, site-specific additions to what the network shows.
// Each one looks at a just-detected item and may return more to know about it
// (other qualities, its own title, where it sits on the page). They never
// replace detection, so a site redesign degrades to the generic listing.

import { formatBytes } from "../shared/format";
import type { MediaItem, StreamVariant } from "../shared/types";
import { findXPost } from "./x-post";

type Extra = Partial<Pick<MediaItem, "variants" | "title" | "thumbnail" | "rank">>;

const CHECK_TIMEOUT_MS = 8_000;

/** Size of a file from a one-byte request, or undefined when it isn't there. */
async function fileSize(url: string): Promise<number | undefined> {
  try {
    const res = await fetch(url, { headers: { range: "bytes=0-0" }, cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    void res.body?.cancel();
    if (res.status !== 206 && res.status !== 200) return undefined;
    const total = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? res.headers.get("content-length");
    return total ? Number(total) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Twitch clips: the player loads one height (`.../h264/360/index.mp4?token=…&sig=…`).
 * The signature covers the token, not the path, so the other heights of the
 * same clip answer with the same query.
 */
export const TWITCH_CLIP = /^(https:\/\/[^/]+\.cloudfront\.net\/nauth\/[^?]+\/)(\d{3,4})(\/index\.mp4\?.*)$/;
const TWITCH_HEIGHTS = [1080, 720, 480, 360];

async function twitchClip(item: MediaItem): Promise<Extra | undefined> {
  const m = item.type === "http" ? TWITCH_CLIP.exec(item.url) : null;
  if (!m) return undefined;
  const [, head, , tail] = m;
  const sizes = await Promise.all(TWITCH_HEIGHTS.map((h) => fileSize(`${head}${h}${tail}`)));
  const variants: StreamVariant[] = TWITCH_HEIGHTS.flatMap((height, i) =>
    sizes[i] ? [{ id: String(height), label: `${height}p · ${formatBytes(sizes[i])}`, height, url: `${head}${height}${tail}`, sizeBytes: sizes[i] }] : [],
  );
  return variants.length > 1 ? { variants } : undefined;
}

/** amplify_video/<id>/, ext_tw_video/<id>/ or tweet_video/<name>.mp4 (GIFs). */
export function xMediaKey(url: string): string | undefined {
  return /video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\//.exec(url)?.[1] ?? /video\.twimg\.com\/tweet_video\/([\w-]+)\.mp4/.exec(url)?.[1];
}

async function xPost(item: MediaItem): Promise<Extra | undefined> {
  const key = xMediaKey(item.url);
  if (!key) return undefined;
  const statusId = /\/status\/(\d+)/.exec(item.pageUrl)?.[1] ?? null;
  const [res] = await chrome.scripting.executeScript({ target: { tabId: item.tabId }, func: findXPost, args: [key, statusId] });
  return res?.result ?? undefined;
}

const EXTRACTORS: ((item: MediaItem) => Promise<Extra | undefined>)[] = [twitchClip, xPost];

/** What the site extractors add to an item; {} when none applies or they fail. */
export async function enrich(item: MediaItem): Promise<Extra> {
  for (const extract of EXTRACTORS) {
    try {
      const extra = await extract(item);
      if (extra) return extra;
    } catch {
      // A site changed; the generic listing still stands.
    }
  }
  return {};
}
