// DASH (MPD) support. A manifest is read into representations with resolved
// segment URLs; a download then describes the chosen video and audio as HLS
// media playlists (fMP4 with EXT-X-MAP and byte ranges), so the same
// Mediabunny HLS reader that handles HLS remuxes DASH too.

import { labelVariants } from "./hls";
import type { StreamVariant, SubtitleTrack } from "./types";
import { child, childrenNamed, parseXml, type XmlElement } from "./xml";

/** Inclusive byte range, as DASH writes them ("0-833"). */
export interface ByteRange {
  start: number;
  end: number;
}

export interface SegmentRef {
  url: string;
  range?: ByteRange;
  /** Seconds. */
  duration?: number;
}

export type DashSegments =
  /** Every segment is known (SegmentTemplate or SegmentList). */
  | { kind: "list"; init?: SegmentRef; segments: SegmentRef[] }
  /** One file whose segment index (sidx) has to be read first (SegmentBase). */
  | { kind: "indexed"; url: string; init?: ByteRange; index: ByteRange }
  /** One plain file, nothing else known. */
  | { kind: "file"; url: string };

export interface DashRepresentation {
  /** Unique within the manifest: `adaptationSet:representation`. */
  key: string;
  kind: "video" | "audio" | "text" | "other";
  mime: string;
  codecs?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  lang?: string;
  /** The adaptation set is marked as the main one (Role main). */
  isMain: boolean;
  /** A <Label> the manifest gives the track, if any. */
  label?: string;
  hasDrm: boolean;
  segments: DashSegments;
}

export interface DashManifest {
  isLive: boolean;
  /** Seconds, of the period we read. */
  duration?: number;
  hasDrm: boolean;
  representations: DashRepresentation[];
}

/** "PT1H2M3.5S" (and "P1DT...") to seconds. */
export function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

function parseRange(value: string | undefined): ByteRange | undefined {
  const m = value && /^(\d+)-(\d+)$/.exec(value.trim());
  return m ? { start: Number(m[1]), end: Number(m[2]) } : undefined;
}

const num = (v: string | undefined) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

/** Applies the first BaseURL child of `el`, if any, to `base`. */
function withBase(base: string, el: XmlElement | undefined): string {
  const b = child(el, "BaseURL")?.text.trim();
  return b ? resolve(b, base) : base;
}

/** "$RepresentationID$", "$Number%05d$", "$Time$", "$Bandwidth$" and "$$". */
export function expandTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (whole, name: string, width?: string) => {
    if (name === "") return "$";
    const value = vars[name];
    if (value === undefined) return whole;
    return width ? String(value).padStart(Number(width), "0") : String(value);
  });
}

/** Merged view of the same segment element at Period, AdaptationSet and Representation level. */
function inherited(name: string, levels: (XmlElement | undefined)[]): { attrs: Record<string, string>; children: XmlElement[] } | undefined {
  const found = levels.map((l) => child(l, name)).filter((e): e is XmlElement => !!e);
  if (!found.length) return undefined;
  const attrs: Record<string, string> = {};
  let children: XmlElement[] = [];
  for (const el of found) {
    Object.assign(attrs, el.attrs);
    if (el.children.length) children = el.children; // the closest level's timeline/list wins
  }
  return { attrs, children };
}

function templateSegments(
  t: { attrs: Record<string, string>; children: XmlElement[] },
  base: string,
  rep: { id: string; bandwidth?: number },
  periodDuration: number | undefined,
): DashSegments {
  const timescale = num(t.attrs.timescale) ?? 1;
  const startNumber = num(t.attrs.startNumber) ?? 1;
  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const init = t.attrs.initialization ? { url: resolve(expandTemplate(t.attrs.initialization, vars), base) } : undefined;
  const media = t.attrs.media;
  if (!media) return { kind: "list", init, segments: [] };
  const segments: SegmentRef[] = [];
  const timeline = t.children.find((c) => c.name === "SegmentTimeline");
  if (timeline) {
    const pto = num(t.attrs.presentationTimeOffset) ?? 0;
    const end = periodDuration !== undefined ? pto + periodDuration * timescale : undefined;
    let time = 0;
    let number = startNumber;
    const entries = childrenNamed(timeline, "S");
    entries.forEach((s, i) => {
      const d = num(s.attrs.d) ?? 0;
      if (s.attrs.t !== undefined) time = num(s.attrs.t) ?? time;
      let repeat = num(s.attrs.r) ?? 0;
      if (repeat < 0) {
        // Repeat until the next entry's start, or the end of the period.
        const next = num(entries[i + 1]?.attrs.t) ?? end;
        repeat = next !== undefined && d > 0 ? Math.ceil((next - time) / d) - 1 : 0;
      }
      for (let k = 0; k <= repeat && d > 0; k++) {
        segments.push({ url: resolve(expandTemplate(media, { ...vars, Number: number, Time: time }), base), duration: d / timescale });
        time += d;
        number++;
      }
    });
  } else {
    const duration = num(t.attrs.duration);
    if (duration && periodDuration !== undefined) {
      const count = Math.ceil((periodDuration * timescale) / duration - 1e-6);
      for (let k = 0; k < count; k++) {
        const left = periodDuration - (k * duration) / timescale;
        segments.push({
          url: resolve(expandTemplate(media, { ...vars, Number: startNumber + k, Time: k * duration }), base),
          duration: Math.min(duration / timescale, left),
        });
      }
    }
  }
  return { kind: "list", init, segments };
}

function listSegments(l: { attrs: Record<string, string>; children: XmlElement[] }, base: string, periodDuration: number | undefined): DashSegments {
  const timescale = num(l.attrs.timescale) ?? 1;
  const duration = num(l.attrs.duration);
  const initEl = l.children.find((c) => c.name === "Initialization");
  const init = initEl
    ? { url: initEl.attrs.sourceURL ? resolve(initEl.attrs.sourceURL, base) : base, range: parseRange(initEl.attrs.range) }
    : undefined;
  const urls = l.children.filter((c) => c.name === "SegmentURL");
  const segments = urls.map((s, k) => {
    const each = duration ? duration / timescale : periodDuration !== undefined ? periodDuration / urls.length : undefined;
    const left = periodDuration !== undefined && duration ? periodDuration - (k * duration) / timescale : undefined;
    return {
      url: s.attrs.media ? resolve(s.attrs.media, base) : base,
      range: parseRange(s.attrs.mediaRange),
      duration: each !== undefined && left !== undefined ? Math.min(each, left) : each,
    };
  });
  return { kind: "list", init, segments };
}

function kindOf(mime: string, contentType: string | undefined, codecs: string | undefined): DashRepresentation["kind"] {
  const type = contentType ?? mime.split("/")[0];
  if (type === "video" || type === "audio" || type === "text") return type;
  if (mime === "application/ttml+xml" || codecs === "wvtt" || codecs === "stpp") return "text";
  return "other";
}

/** Period lengths: @duration, else up to the next period's start or the end. */
function periodDurations(periods: XmlElement[], total: number | undefined): (number | undefined)[] {
  return periods.map((p, i) => {
    const own = parseIsoDuration(p.attrs.duration);
    if (own !== undefined) return own;
    const start = parseIsoDuration(p.attrs.start) ?? 0;
    const nextStart = parseIsoDuration(periods[i + 1]?.attrs.start);
    if (nextStart !== undefined) return nextStart - start;
    return total !== undefined ? total - start : undefined;
  });
}

export function parseMpd(text: string, mpdUrl: string): DashManifest {
  const mpd = parseXml(text);
  if (mpd.name !== "MPD") throw new Error("Not a DASH manifest");
  const isLive = mpd.attrs.type === "dynamic";
  const total = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const periods = childrenNamed(mpd, "Period");
  // Multi-period manifests are usually ads around the programme: read the longest period.
  const durations = periodDurations(periods, total);
  let index = 0;
  durations.forEach((d, i) => {
    if ((d ?? 0) > (durations[index] ?? 0)) index = i;
  });
  const period = periods[index];
  const duration = durations[index] ?? total;
  const representations: DashRepresentation[] = [];
  const mpdBase = withBase(mpdUrl, mpd);
  const periodBase = withBase(mpdBase, period);

  childrenNamed(period, "AdaptationSet").forEach((set, setIndex) => {
    const trickPlay = [...childrenNamed(set, "EssentialProperty"), ...childrenNamed(set, "SupplementalProperty")].some((p) =>
      /trickmode/i.test(p.attrs.schemeIdUri ?? ""),
    );
    if (trickPlay) return;
    const setBase = withBase(periodBase, set);
    const setDrm = childrenNamed(set, "ContentProtection").length > 0;
    const isMain = childrenNamed(set, "Role").some((r) => r.attrs.value === "main");
    childrenNamed(set, "Representation").forEach((rep, repIndex) => {
      const id = rep.attrs.id ?? String(repIndex);
      const mime = (rep.attrs.mimeType ?? set.attrs.mimeType ?? "").toLowerCase();
      const codecs = rep.attrs.codecs ?? set.attrs.codecs;
      const bandwidth = num(rep.attrs.bandwidth);
      const base = withBase(setBase, rep);
      const levels = [period, set, rep];
      const template = inherited("SegmentTemplate", levels);
      const list = inherited("SegmentList", levels);
      const segBase = inherited("SegmentBase", levels);
      let segments: DashSegments;
      if (template) segments = templateSegments(template, base, { id, bandwidth }, duration);
      else if (list) segments = listSegments(list, base, duration);
      else if (segBase?.attrs.indexRange) {
        const initEl = segBase.children.find((c) => c.name === "Initialization");
        segments = { kind: "indexed", url: base, index: parseRange(segBase.attrs.indexRange)!, init: parseRange(initEl?.attrs.range) };
      } else segments = { kind: "file", url: base };
      representations.push({
        key: `${setIndex}:${id}`,
        kind: kindOf(mime, set.attrs.contentType, codecs),
        mime,
        codecs,
        bandwidth,
        width: num(rep.attrs.width ?? set.attrs.width),
        height: num(rep.attrs.height ?? set.attrs.height),
        lang: rep.attrs.lang ?? set.attrs.lang,
        isMain,
        label: (child(rep, "Label") ?? child(set, "Label"))?.text.trim() || undefined,
        hasDrm: setDrm || childrenNamed(rep, "ContentProtection").length > 0,
        segments,
      });
    });
  });

  const media = representations.filter((r) => r.kind === "video" || r.kind === "audio");
  return {
    isLive,
    duration,
    hasDrm: media.length > 0 && media.every((r) => r.hasDrm),
    representations,
  };
}

/** MP4-family tracks; WebM DASH can't go through the HLS reader. */
function isMp4Family(rep: DashRepresentation): boolean {
  if (rep.mime.endsWith("/webm")) return false;
  return !/^(vp8|vp9|vp09|vorbis)/i.test(rep.codecs ?? "");
}

/** The audio a player would start with: main role, then highest bitrate. */
export function bestAudio(m: DashManifest): DashRepresentation | undefined {
  return m.representations
    .filter((r) => r.kind === "audio" && !r.hasDrm && isMp4Family(r))
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
}

/** Qualities on offer, best first, each with the best audio, plus audio only. */
export function listDashVariants(m: DashManifest, mpdUrl: string): StreamVariant[] {
  const audio = bestAudio(m);
  const videos = m.representations
    .filter((r) => r.kind === "video" && !r.hasDrm && isMp4Family(r))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  const out: StreamVariant[] = videos.map((v) => ({
    id: "",
    label: "",
    height: v.height,
    width: v.width,
    bandwidth: v.bandwidth,
    codecs: [v.codecs, audio?.codecs].filter(Boolean).join(",") || undefined,
    url: mpdUrl,
    videoRep: v.key,
    audioRep: audio?.key,
    audioLanguage: audio?.lang,
    audioCodecs: audio?.codecs,
  }));
  if (audio) {
    out.push({
      id: "",
      label: "Audio only",
      audioOnly: true,
      bandwidth: audio.bandwidth,
      url: mpdUrl,
      audioRep: audio.key,
      audioLanguage: audio.lang,
      audioCodecs: audio.codecs,
    });
  }
  return labelVariants(out);
}

/** Files a page's player fetches for this manifest; hidden from the list. */
export function dashChildUrls(m: DashManifest): string[] {
  const urls = new Set<string>();
  for (const r of m.representations) {
    if (r.segments.kind !== "list") urls.add(r.segments.url);
    else {
      if (r.segments.init) urls.add(r.segments.init.url);
      for (const s of r.segments.segments) if (s.range) urls.add(s.url);
    }
  }
  return [...urls];
}

/**
 * Reads a segment index box (sidx). `offset` is where the box starts in the
 * file; returned ranges are absolute.
 */
export function parseSidx(bytes: Uint8Array, offset: number, url: string): SegmentRef[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(0);
  const type = String.fromCharCode(...bytes.subarray(4, 8));
  if (type !== "sidx") throw new Error("No segment index (sidx) where the manifest said");
  let p = 8;
  if (size === 1) {
    size = Number(view.getBigUint64(8));
    p = 16;
  }
  const version = view.getUint8(p);
  p += 4; // version + flags
  p += 4; // reference_ID
  const timescale = view.getUint32(p);
  p += 4;
  let firstOffset: number;
  if (version === 0) {
    p += 4; // earliest_presentation_time
    firstOffset = view.getUint32(p);
    p += 4;
  } else {
    p += 8;
    firstOffset = Number(view.getBigUint64(p));
    p += 8;
  }
  p += 2; // reserved
  const count = view.getUint16(p);
  p += 2;
  let start = offset + size + firstOffset;
  const refs: SegmentRef[] = [];
  for (let i = 0; i < count; i++) {
    const word = view.getUint32(p);
    if (word >>> 31) throw new Error("Nested segment indexes aren't supported yet");
    const length = word & 0x7fffffff;
    const duration = view.getUint32(p + 4) / timescale;
    refs.push({ url, range: { start, end: start + length - 1 }, duration });
    start += length;
    p += 12;
  }
  return refs;
}

export type RangeFetcher = (url: string, range: ByteRange) => Promise<Uint8Array>;

/** Every segment of a representation, reading its sidx when the manifest only points at one. */
export async function resolveSegments(
  rep: DashRepresentation,
  duration: number | undefined,
  fetchRange: RangeFetcher,
): Promise<{ init?: SegmentRef; segments: SegmentRef[] }> {
  const seg = rep.segments;
  if (seg.kind === "list") return { init: seg.init, segments: seg.segments };
  if (seg.kind === "file") return { segments: [{ url: seg.url, duration }] };
  const index = await fetchRange(seg.url, seg.index);
  const segments = parseSidx(index, seg.index.start, seg.url);
  // The init segment runs from the start of the file up to the index, unless stated.
  const init = { url: seg.url, range: seg.init ?? { start: 0, end: seg.index.start - 1 } };
  return { init, segments };
}

const byteRange = (r: ByteRange) => `${r.end - r.start + 1}@${r.start}`;

/** An HLS media playlist for one representation's resolved segments. */
export function hlsMediaPlaylist(init: SegmentRef | undefined, segments: SegmentRef[]): string {
  const target = Math.max(1, ...segments.map((s) => Math.ceil(s.duration ?? 1)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS"];
  if (init) lines.push(`#EXT-X-MAP:URI="${init.url}"${init.range ? `,BYTERANGE="${byteRange(init.range)}"` : ""}`);
  for (const s of segments) {
    lines.push(`#EXTINF:${(s.duration ?? 1).toFixed(6)},`);
    if (s.range) lines.push(`#EXT-X-BYTERANGE:${byteRange(s.range)}`);
    lines.push(s.url);
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

/** Text tracks saved as plain WebVTT or TTML (not wrapped in MP4 segments). */
export function listDashSubtitles(m: DashManifest): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  for (const r of m.representations) {
    if (r.kind !== "text" || !/^(text\/vtt|application\/ttml\+xml)$/.test(r.mime)) continue;
    const seg = r.segments;
    const source: SubtitleTrack["source"] | undefined =
      seg.kind === "file"
        ? { kind: "file", url: seg.url }
        : seg.kind === "list" && seg.segments.length && seg.segments.every((s) => !s.range)
          ? { kind: "segments", urls: seg.segments.map((s) => s.url) }
          : undefined;
    if (source) out.push({ id: `dash-${r.key}`, label: r.label ?? r.lang ?? `Subtitles ${out.length + 1}`, lang: r.lang, source });
  }
  return out;
}
