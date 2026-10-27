// Page titles carry the site's name ("Storm hits coast | CNN", "Clip - Twitch",
// "Episode 4 - video Dailymotion"); a saved file only needs the video's name.

export interface TitleSources {
  docTitle?: string;
  ogTitle?: string;
  /** og:site_name. */
  siteName?: string;
  host: string;
}

const SEPARATOR = /\s+[|\-–—/·]\s+(?=[^|\-–—/·]*$)/;
/** A trailing segment this long or shorter can be a site name. */
const MAX_SITE_WORDS = 3;

/** "edition.cnn.com" -> ["edition", "cnn"]: labels a site name may echo. */
function hostLabels(host: string): string[] {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  return labels.slice(0, -1).filter((l) => l.length > 1);
}

function isSiteName(segment: string, src: TitleSources): boolean {
  const s = segment.trim().toLowerCase();
  if (!s || s.split(/\s+/).length > MAX_SITE_WORDS) return false;
  if (src.siteName && s === src.siteName.trim().toLowerCase()) return true;
  const words = s.split(/[\s.]+/);
  return hostLabels(src.host).some((l) => words.includes(l)) || (s.length === 1 && hostLabels(src.host).includes("x"));
}

function strip(title: string, src: TitleSources): string {
  let t = title.replace(/^\(\d+\+?\)\s+/, "").trim(); // "(3) " unread counts
  // X: 'SpaceX on X: "Liftoff!" / X' -> 'SpaceX: Liftoff!'
  const x = /^(.+?) on X: [“"](.*)[”"](?:\s*\/\s*X)?$/s.exec(t);
  if (x) return `${x[1]}: ${x[2]!.replace(/\s+/g, " ").trim()}`;
  for (let i = 0; i < 2; i++) {
    const m = SEPARATOR.exec(t);
    if (!m || !isSiteName(t.slice(m.index + m[0].length), src)) break;
    t = t.slice(0, m.index).trim();
  }
  return t;
}

export function cleanTitle(src: TitleSources): string | undefined {
  const doc = src.docTitle?.trim() ? strip(src.docTitle, src) : "";
  // A tab titled just "Dailymotion" names the site, not the video.
  if (doc && !isSiteName(doc, src)) return doc;
  const og = src.ogTitle?.trim() ? strip(src.ogTitle, src) : "";
  return og || src.docTitle?.trim() || undefined;
}
