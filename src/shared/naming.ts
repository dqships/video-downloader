// Filename templates and a sanitiser that is safe on Windows, macOS and Linux.

import type { MediaItem, StreamVariant } from "./types";

export interface NamingInput {
  template: string;
  maxLength: number;
  title?: string;
  pageUrl: string;
  mediaUrl: string;
  serverFilename?: string;
  ext: string;
  now?: Date;
}

/** The extension a download is saved with: sound-only streams as .m4a, Vorbis only fits in WebM. */
export function savedExt(item: Pick<MediaItem, "ext">, variant?: Pick<StreamVariant, "webm" | "audioOnly">): string {
  return variant?.webm ? "webm" : variant?.audioOnly ? "m4a" : item.ext;
}

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BYTES = 200;

/** "www.example.co.uk" -> "example", "youtube.com" -> "youtube". */
export function siteLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  // An address has no site name to pick out.
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return host;
  const parts = host.replace(/^www\d*\./, "").split(".");
  if (parts.length === 1) return parts[0] ?? "";
  // Treat "co.uk", "com.au" and similar as one suffix.
  const secondLevel = parts.at(-2) ?? "";
  const hasCompoundSuffix =
    parts.length >= 3 && (parts.at(-1) ?? "").length === 2 && /^(co|com|org|net|gov|ac|edu|ne|or)$/.test(secondLevel);
  return (hasCompoundSuffix ? parts.at(-3) : secondLevel) ?? "";
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, "");
}

/** Last path segment of a URL, decoded, without its extension. */
export function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    return stripExt(decodeURIComponent(last));
  } catch {
    return "";
  }
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Expands %variables. An empty variable is removed together with the
 * separator (space, dash, underscore) written right before it.
 */
export function expandTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template
    .replace(/([\s_-]*)%([a-z]+)/gi, (whole, sep: string, key: string) => {
      const value = vars[key.toLowerCase()];
      if (value === undefined) return whole; // unknown variable: leave as typed
      return value === "" ? "" : sep + value;
    })
    .replace(/^[\s_-]+|[\s_-]+$/g, "");
}

function truncateBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    if (enc.encode(out + ch).length > maxBytes) break;
    out += ch;
  }
  return out;
}

export function sanitizeFilename(raw: string, maxLength = 80): string {
  let s = raw.normalize("NFC");
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s.replace(/[<>:"/\\|?*]/g, " ");
  s = s.replace(/\s+/g, " ").replace(/-{2,}/g, "-");
  s = s.replace(/^[\s.]+/, "");
  s = Array.from(s).slice(0, maxLength).join("");
  s = truncateBytes(s, MAX_BYTES);
  s = s.replace(/[\s.]+$/, "");
  if (RESERVED_WINDOWS.test(s)) s += "_";
  return s || "untitled";
}

export function buildFilename(input: NamingInput): string {
  const title =
    input.title?.trim() ||
    (input.serverFilename ? stripExt(input.serverFilename) : "") ||
    nameFromUrl(input.mediaUrl);
  const base = expandTemplate(input.template, {
    title,
    hostname: siteLabel(input.pageUrl),
    date: isoDate(input.now ?? new Date()),
  });
  return `${sanitizeFilename(base, input.maxLength)}.${input.ext}`;
}

/** "Café/Tromsø – Nordlys.mp4" -> "Cafe/Troms - Nordlys.mp4". */
export function asciiFilename(path: string): string {
  return path
    .split("/")
    .map((part) => {
      const dot = part.lastIndexOf(".");
      const [base, ext] = dot > 0 ? [part.slice(0, dot), part.slice(dot)] : [part, ""];
      const plain = base
        .normalize("NFKD")
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/[^\x20-\x7e]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return (plain || "video") + ext;
    })
    .join("/");
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
  mpg: "video/mpeg", mpeg: "video/mpeg", ogv: "video/ogg", flv: "video/x-flv", "3gp": "video/3gpp", avi: "video/x-msvideo",
  ts: "video/mp2t", m4a: "audio/mp4", mp3: "audio/mpeg", weba: "audio/webm", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
};

/**
 * The type to give a saved file's blob. Chrome sniffs a blob with no type as
 * text/plain and swaps the name's extension for .txt.
 */
export function mimeForFilename(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}
