// A small M3U8 reader: just what listing, choosing and DRM checks need.
// Segment-level work (decryption, demuxing) is left to Mediabunny.

import type { StreamVariant } from "./types";

export type Attributes = Record<string, string>;

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audioGroup?: string;
  videoRange?: string;
}

export interface HlsRendition {
  type: "AUDIO" | "SUBTITLES" | "CLOSED-CAPTIONS" | "VIDEO";
  groupId: string;
  name: string;
  language?: string;
  isDefault: boolean;
  autoselect: boolean;
  uri?: string;
}

export interface HlsKey {
  method: string;
  keyFormat?: string;
  uri?: string;
}

export interface HlsMaster {
  kind: "master";
  variants: HlsVariant[];
  renditions: HlsRendition[];
  sessionKeys: HlsKey[];
}

export interface HlsMedia {
  kind: "media";
  segments: string[];
  /** Init segments (EXT-X-MAP) and key URIs, for header-replay scoping. */
  otherUris: string[];
  keys: HlsKey[];
  duration: number;
  endList: boolean;
  playlistType?: string;
}

export type HlsPlaylist = HlsMaster | HlsMedia;

/** Parses an attribute list: KEY=value,KEY="quoted, with commas". */
export function parseAttributes(s: string): Attributes {
  const out: Attributes = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const raw = m[2]!;
    out[m[1]!] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

const num = (v: string | undefined) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

export function parseM3u8(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0]?.startsWith("#EXTM3U")) throw new Error("Not an M3U8 playlist");

  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  const sessionKeys: HlsKey[] = [];
  const segments: string[] = [];
  const otherUris: string[] = [];
  const keys: HlsKey[] = [];
  let duration = 0;
  let endList = false;
  let playlistType: string | undefined;
  let pendingVariant: HlsVariant | undefined;

  for (const line of lines) {
    if (!line.startsWith("#")) {
      if (pendingVariant) {
        variants.push({ ...pendingVariant, uri: resolve(line, baseUrl) });
        pendingVariant = undefined;
      } else {
        segments.push(resolve(line, baseUrl));
      }
      continue;
    }
    const colon = line.indexOf(":");
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1);
    switch (tag) {
      case "#EXT-X-STREAM-INF": {
        const a = parseAttributes(value);
        const [w, h] = (a.RESOLUTION ?? "").split("x").map(Number);
        pendingVariant = {
          uri: "",
          bandwidth: num(a.BANDWIDTH),
          averageBandwidth: num(a["AVERAGE-BANDWIDTH"]),
          width: w || undefined,
          height: h || undefined,
          codecs: a.CODECS,
          frameRate: num(a["FRAME-RATE"]),
          audioGroup: a.AUDIO,
          videoRange: a["VIDEO-RANGE"],
        };
        break;
      }
      case "#EXT-X-MEDIA": {
        const a = parseAttributes(value);
        renditions.push({
          type: a.TYPE as HlsRendition["type"],
          groupId: a["GROUP-ID"] ?? "",
          name: a.NAME ?? "",
          language: a.LANGUAGE,
          isDefault: a.DEFAULT === "YES",
          autoselect: a.AUTOSELECT === "YES",
          uri: a.URI ? resolve(a.URI, baseUrl) : undefined,
        });
        break;
      }
      case "#EXT-X-SESSION-KEY":
      case "#EXT-X-KEY": {
        const a = parseAttributes(value);
        const key: HlsKey = { method: a.METHOD ?? "NONE", keyFormat: a.KEYFORMAT, uri: a.URI ? resolve(a.URI, baseUrl) : undefined };
        if (tag === "#EXT-X-SESSION-KEY") sessionKeys.push(key);
        else {
          keys.push(key);
          if (key.uri && !key.uri.startsWith("skd:") && !key.uri.startsWith("data:")) otherUris.push(key.uri);
        }
        break;
      }
      case "#EXT-X-MAP": {
        const uri = parseAttributes(value).URI;
        if (uri) otherUris.push(resolve(uri, baseUrl));
        break;
      }
      case "#EXTINF":
        duration += Number.parseFloat(value) || 0;
        break;
      case "#EXT-X-ENDLIST":
        endList = true;
        break;
      case "#EXT-X-PLAYLIST-TYPE":
        playlistType = value;
        break;
    }
  }

  if (variants.length || (renditions.length && !segments.length)) {
    return { kind: "master", variants, renditions, sessionKeys };
  }
  return { kind: "media", segments, otherUris, keys, duration, endList, playlistType };
}

const DRM_KEY_FORMATS = [
  "com.apple.streamingkeydelivery", // FairPlay
  "com.microsoft.playready",
  "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", // Widevine
  "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", // PlayReady
];

/**
 * DRM, as opposed to plain AES-128 transport encryption (which we support):
 * SAMPLE-AES or CENC methods, or a DRM system's key format.
 */
export function isDrmKey(key: HlsKey): boolean {
  const method = key.method.toUpperCase();
  if (method === "NONE") return false;
  const format = key.keyFormat?.toLowerCase();
  if (format && DRM_KEY_FORMATS.includes(format)) return true;
  if (key.uri?.startsWith("skd:")) return true;
  return method !== "AES-128";
}

/** Family of a CODECS string, for pairing audio and picking a container. */
export function codecFamily(codecs: string | undefined): "mp4" | "webm" | "unknown" {
  if (!codecs) return "unknown";
  const video = codecs.split(",").map((c) => c.trim().toLowerCase().split(".")[0]);
  if (video.some((c) => ["av01", "vp08", "vp8", "vp09", "vp9"].includes(c!))) return "webm";
  if (video.some((c) => ["avc1", "avc3", "hvc1", "hev1", "mp4v", "mp4a", "ac-3", "ec-3"].includes(c!))) return "mp4";
  return "unknown";
}

/** The audio rendition a player would pick for a variant's AUDIO group. */
export function audioFor(master: HlsMaster, variant: HlsVariant): HlsRendition | undefined {
  if (!variant.audioGroup) return undefined;
  const group = master.renditions.filter((r) => r.type === "AUDIO" && r.groupId === variant.audioGroup && r.uri);
  return group.find((r) => r.isDefault) ?? group.find((r) => r.autoselect) ?? group[0];
}

export function mbps(bandwidth: number): string {
  return bandwidth >= 1e6 ? `${(bandwidth / 1e6).toFixed(1)} Mbps` : `${Math.round(bandwidth / 1e3)} kbps`;
}

/** Split CODECS into its video and audio halves. */
function splitCodecs(codecs: string | undefined): { video?: string; audio?: string } {
  const parts = (codecs ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const isAudio = (c: string) => /^(mp4a|ac-3|ec-3|opus|flac|vorbis)/i.test(c);
  const video = parts.filter((c) => !isAudio(c)).join(",");
  const audio = parts.filter(isAudio).join(",");
  return { video: video || undefined, audio: audio || undefined };
}

/**
 * The qualities a master offers, best first, one per resolution and bitrate.
 * Variants that differ only in a non-SDR VIDEO-RANGE or an unknown codec family
 * still show up; the picker labels make the difference visible.
 */
export function listVariants(master: HlsMaster): StreamVariant[] {
  const seen = new Set<string>();
  const out: StreamVariant[] = [];
  const ranked = [...master.variants].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
  );
  for (const v of ranked) {
    const audio = audioFor(master, v);
    const key = `${v.uri}|${audio?.uri ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { video } = splitCodecs(v.codecs);
    out.push({
      id: "",
      label: "",
      height: v.height,
      width: v.width,
      bandwidth: v.bandwidth,
      codecs: v.codecs,
      url: v.uri,
      audioUrl: audio?.uri,
      audioLanguage: audio?.language,
      audioCodecs: splitCodecs(v.codecs).audio,
      ...(video === undefined && v.codecs && !v.height ? { label: "Audio only" } : {}),
    });
  }
  // A sound-only download: the separate audio playlist when there is one,
  // otherwise the lightest variant with its picture dropped.
  const lightest = [...out].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0))[0];
  const hasAudioOnly = out.some((v) => v.label === "Audio only");
  if (lightest && !hasAudioOnly && (lightest.audioUrl || codecHasAudio(lightest.codecs))) {
    out.push({
      id: "",
      label: "Audio only",
      audioOnly: true,
      url: lightest.audioUrl ?? lightest.url,
      audioLanguage: lightest.audioLanguage,
      audioCodecs: lightest.audioCodecs,
    });
  }
  const ranges = new Map(master.variants.map((m) => [m.uri, m.videoRange]));
  return labelVariants(out, (v) => {
    const range = ranges.get(v.url);
    return range && range !== "SDR" ? ` ${range}` : "";
  });
}

/** True when CODECS names an audio codec, or says nothing (assume muxed audio). */
function codecHasAudio(codecs: string | undefined): boolean {
  return !codecs || splitCodecs(codecs).audio !== undefined;
}

/**
 * Numbers the variants and labels the unlabelled ones: "720p", with the
 * bitrate added when two share a height, plus an optional suffix ("PQ").
 */
export function labelVariants(list: StreamVariant[], suffix: (v: StreamVariant) => string = () => ""): StreamVariant[] {
  const heights = new Map<number, number>();
  for (const v of list) if (v.height) heights.set(v.height, (heights.get(v.height) ?? 0) + 1);
  list.forEach((v, i) => {
    v.id = String(i);
    if (v.label) return;
    if (v.height) {
      const shared = (heights.get(v.height) ?? 0) > 1;
      v.label = `${v.height}p${suffix(v)}${shared && v.bandwidth ? ` · ${mbps(v.bandwidth)}` : ""}`;
    } else if (v.bandwidth) {
      v.label = mbps(v.bandwidth);
    } else {
      v.label = `Quality ${i + 1}`;
    }
  });
  return list;
}

const quote = (s: string) => `"${s.replace(/"/g, "%22")}"`;

/**
 * A one-variant master for the quality the user picked, with absolute URIs, so
 * the remuxer reads exactly that video playlist and its audio and nothing else.
 */
export function singleVariantMaster(variant: StreamVariant): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  const attrs = [`BANDWIDTH=${variant.bandwidth ?? 1}`];
  if (variant.width && variant.height) attrs.push(`RESOLUTION=${variant.width}x${variant.height}`);
  if (variant.codecs) attrs.push(`CODECS=${quote(variant.codecs)}`);
  if (variant.audioUrl) {
    const lang = variant.audioLanguage ? `,LANGUAGE=${quote(variant.audioLanguage)}` : "";
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio"${lang},DEFAULT=YES,AUTOSELECT=YES,URI=${quote(variant.audioUrl)}`);
    attrs.push(`AUDIO="aud"`);
  }
  lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`, variant.url, "");
  return lines.join("\n");
}

export function dataUrl(playlist: string): string {
  const bytes = new TextEncoder().encode(playlist);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:application/vnd.apple.mpegurl;base64,${btoa(bin)}`;
}
