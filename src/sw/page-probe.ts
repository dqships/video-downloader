// Lists media a page declares (JSON-LD, Open Graph, <video src>) without
// waiting for it to play. Each declared URL is checked with a one-byte request
// so only real media files and streams are listed.

import { pageCandidates, type PageCandidate, type PageScan } from "../shared/page-media";
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

/** Candidates from every frame of the tab; [] where scripts can't run. */
export async function scanTab(tabId: number): Promise<{ candidate: PageCandidate; pageUrl: string }[]> {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanFrame });
    return results.flatMap((r) => (r.result ? pageCandidates(r.result).map((candidate) => ({ candidate, pageUrl: r.result!.pageUrl })) : []));
  } catch {
    return [];
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
