// Media a page declares in its markup, found before anything plays. News sites
// and many CMSs describe their videos with schema.org VideoObject (JSON-LD),
// Open Graph or Twitter player tags; plain pages put the file in <video src>.
// The page only gathers the raw text; this module reads it, so it can be tested.

export interface PageScan {
  pageUrl: string;
  /** Text of each <script type="application/ld+json">. */
  jsonLd: string[];
  /** <meta property|name="…" content="…">, in document order. */
  metas: { key: string; value: string }[];
  /** src of <video> and <video><source>, when not a blob: or MediaSource URL. */
  videoSrcs: { url: string; type?: string }[];
}

export interface PageCandidate {
  url: string;
  title?: string;
  thumbnail?: string;
  durationSec?: number;
  /** A declared MIME type, when the page gave one. */
  mime?: string;
}

const MAX_CANDIDATES = 10;
/** Player pages (iframes), not media files. */
const NOT_MEDIA_TYPES = /^(text\/html|application\/x-shockwave-flash)/i;

function absolute(url: unknown, base: string): string | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  try {
    const u = new URL(url.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** ISO 8601 durations ("PT1M30S"), or plain seconds. */
function seconds(value: unknown): number | undefined {
  if (typeof value === "number" && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
  if (m && m[0] !== "P" && m[0].toUpperCase() !== "PT") {
    const [, d = "0", h = "0", min = "0", s = "0"] = m;
    return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s) || undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** thumbnailUrl / image may be a string, an ImageObject or a list of either. */
function imageUrl(value: unknown, base: string): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (first && typeof first === "object") return absolute((first as Record<string, unknown>).url ?? (first as Record<string, unknown>).contentUrl, base);
  return absolute(first, base);
}

const isType = (node: Record<string, unknown>, name: string) =>
  [node["@type"]].flat().some((t) => typeof t === "string" && t.replace(/^.*[/:]/, "") === name);

/** Every VideoObject or AudioObject anywhere in a JSON-LD document (@graph, nested, lists). */
function mediaObjects(doc: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 8) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    const obj = node as Record<string, unknown>;
    if (isType(obj, "VideoObject") || isType(obj, "AudioObject")) out.push(obj);
    for (const value of Object.values(obj)) walk(value, depth + 1);
  };
  walk(doc, 0);
  return out;
}

export function pageCandidates(scan: PageScan): PageCandidate[] {
  const base = scan.pageUrl;
  const found = new Map<string, PageCandidate>();
  const add = (c: PageCandidate | undefined) => {
    if (!c || found.size >= MAX_CANDIDATES) return;
    // The first description of a URL wins; later ones only fill gaps.
    const prev = Object.entries(found.get(c.url) ?? {}).filter(([, v]) => v !== undefined);
    found.set(c.url, { ...c, ...Object.fromEntries(prev) });
  };

  for (const text of scan.jsonLd) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      continue; // sites ship broken JSON-LD often enough
    }
    for (const obj of mediaObjects(doc)) {
      // contentUrl is the file; embedUrl is a player page, which we can't save.
      const url = absolute(obj.contentUrl, base);
      if (!url) continue;
      add({
        url,
        title: typeof obj.name === "string" ? obj.name.trim() || undefined : undefined,
        thumbnail: imageUrl(obj.thumbnailUrl ?? obj.thumbnail ?? obj.image, base),
        durationSec: seconds(obj.duration),
        mime: typeof obj.encodingFormat === "string" && obj.encodingFormat.includes("/") ? obj.encodingFormat.toLowerCase() : undefined,
      });
    }
  }

  // Open Graph: og:video (or :url / :secure_url) followed by its own og:video:type.
  // Only JSON-LD names a video itself; page-wide tags (og:title) describe the
  // page, may still be a placeholder while a single-page app loads, and are
  // read for the tab anyway.
  const meta = scan.metas.map((m) => ({ key: m.key.toLowerCase(), value: m.value }));
  for (let i = 0; i < meta.length; i++) {
    const { key, value } = meta[i]!;
    if (key !== "og:video" && key !== "og:video:url" && key !== "og:video:secure_url" && key !== "twitter:player:stream") continue;
    const typeKey = key === "twitter:player:stream" ? "twitter:player:stream:content_type" : "og:video:type";
    let mime: string | undefined;
    for (let j = i + 1; j < meta.length && j < i + 8; j++) {
      if (meta[j]!.key === typeKey) {
        mime = meta[j]!.value.toLowerCase();
        break;
      }
      if (meta[j]!.key === key) break;
    }
    if (mime && NOT_MEDIA_TYPES.test(mime)) continue;
    const url = absolute(value, base);
    if (url) add({ url, mime });
  }

  for (const src of scan.videoSrcs) {
    const url = absolute(src.url, base);
    if (url) add({ url, mime: src.type?.toLowerCase() || undefined });
  }
  return [...found.values()];
}

/** Dailymotion video pages and embeds: /video/x8abc, /embed/video/x8abc, or ?video=x8abc on the player. */
export function dailymotionId(pageUrl: string): string | undefined {
  try {
    const u = new URL(pageUrl);
    if (u.hostname !== "dailymotion.com" && !u.hostname.endsWith(".dailymotion.com")) return undefined;
    const id = /^\/(?:embed\/)?video\/(x[a-z0-9]+)/i.exec(u.pathname)?.[1] ?? u.searchParams.get("video") ?? undefined;
    return id && /^x[a-z0-9]+$/i.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
