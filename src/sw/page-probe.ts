// Lists media a page declares (JSON-LD, Open Graph, <video src>, a few sites'
// public video-info feeds) without waiting for it to play. Each declared URL is checked with a one-byte request
// so only real media files and streams are listed.

import { dailymotionId, pageCandidates, type PageCandidate, type PageScan } from "../shared/page-media";
import { classify, type Classified } from "./classify";
import { installReplay, removeReplay } from "./replay";

const CHECK_TIMEOUT_MS = 10_000;

/** Gathers the raw markup in every frame; runs in the page. */
function scanFrame(): PageScan {
  const abs = (u: string | null) => (u && !u.startsWith("blob:") && !u.startsWith("data:") ? u : undefined);
  const videoSrcs: PageScan["videoSrcs"] = [];
  for (const v of document.querySelectorAll("video, audio")) {
    const own = abs(v.getAttribute("src"));
    if (own) videoSrcs.push({ url: own });
    for (const s of v.querySelectorAll("source")) {
      const url = abs(s.getAttribute("src"));
      if (url) videoSrcs.push({ url, type: s.getAttribute("type") ?? undefined });
    }
  }
  return {
    pageUrl: location.href,
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? "").slice(0, 20),
    metas: [...document.querySelectorAll("meta[content]")]
      .map((m) => ({ key: m.getAttribute("property") ?? m.getAttribute("name") ?? "", value: m.getAttribute("content") ?? "" }))
      .filter((m) => /^(og:|twitter:)/i.test(m.key)),
    videoSrcs: videoSrcs.slice(0, 20),
  };
}

export interface FoundOnPage {
  candidate: PageCandidate;
  found: Classified;
  /** The frame that declared it, sent as Referer. */
  pageUrl: string;
}

type FrameCandidate = { candidate: PageCandidate; pageUrl: string; frameId: number };

/**
 * Candidates from every frame of the tab; [] where scripts can't run. `seen`
 * holds what earlier scans of this page already looked at, and is updated,
 * so scanning again only checks what is new.
 */
export async function scanTab(tabId: number, seen: Set<string>): Promise<FrameCandidate[]> {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanFrame });
    const out: FrameCandidate[] = [];
    for (const r of results) {
      if (!r.result) continue;
      for (const candidate of pageCandidates(r.result)) {
        if (seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        out.push({ candidate, pageUrl: r.result.pageUrl, frameId: r.frameId });
      }
      // The feed hands out a fresh token each time, so it's keyed by video.
      const id = dailymotionId(r.result.pageUrl);
      if (id && !seen.has(`dailymotion:${id}`)) {
        seen.add(`dailymotion:${id}`);
        const candidate = await dailymotionStream(id);
        if (candidate) out.push({ candidate, pageUrl: r.result.pageUrl, frameId: r.frameId });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Dailymotion's player asks for its stream only once play is pressed, but the
 * page's public video-info feed already names it.
 */
async function dailymotionStream(id: string): Promise<PageCandidate | undefined> {
  try {
    const res = await fetch(`https://www.dailymotion.com/player/metadata/video/${id}`, { cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const info = (await res.json()) as {
      title?: unknown;
      duration?: unknown;
      thumbnails?: Record<string, unknown>;
      qualities?: { auto?: { type?: unknown; url?: unknown }[] };
    };
    const stream = info.qualities?.auto?.find((q) => typeof q.url === "string" && /mpegurl/i.test(String(q.type)));
    if (!stream) return undefined;
    const thumbs = info.thumbnails ?? {};
    const thumbnail = ["720", "480", "360"].map((k) => thumbs[k]).find((t): t is string => typeof t === "string");
    return {
      url: stream.url as string,
      title: typeof info.title === "string" ? info.title.trim() || undefined : undefined,
      thumbnail,
      durationSec: typeof info.duration === "number" && info.duration > 0 ? info.duration : undefined,
      mime: "application/x-mpegurl",
    };
  } catch {
    return undefined;
  }
}

/** Asks the server what the URL is. Undefined when it isn't media we list. */
export async function checkCandidate(candidate: PageCandidate, pageUrl: string): Promise<FoundOnPage | undefined> {
  const sent = { referer: pageUrl };
  const rules = await installReplay([candidate.url], sent);
  try {
    const res = await fetch(candidate.url, {
      headers: { range: "bytes=0-0" },
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    void res.body?.cancel();
    const responseHeaders = [...res.headers].map(([name, value]) => ({ name, value }));
    // Judge by where it led (redirects to a CDN are common), list by what the page said.
    const found = classify({ url: res.url || candidate.url, type: "media", statusCode: res.status, responseHeaders });
    return found ? { candidate, found, pageUrl } : undefined;
  } catch {
    return undefined;
  } finally {
    await removeReplay(rules);
  }
}
