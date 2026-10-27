// Subtitles are saved as SubRip (.srt), which every player reads. Streams
// carry WebVTT (often cut into segments) or TTML; both convert here.

import type { XmlElement } from "./xml";
import { parseXml } from "./xml";

export interface Cue {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
}

/** "01:02:03.500", "02:03.5" or "02:03,500" to seconds. */
function clock(value: string): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/.exec(value.trim());
  if (!m) return undefined;
  const [, h = "0", min, s, frac = "0"] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(`0.${frac}`);
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

/** Cues of one WebVTT file or segment. Styling tags are dropped. */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue; // header, NOTE, STYLE or REGION blocks
    const [from, rest = ""] = lines[at]!.split("-->");
    const start = clock(from ?? "");
    const end = clock(rest.trim().split(/\s+/)[0] ?? "");
    const body = lines.slice(at + 1).map(stripTags).join("\n").trim();
    if (start === undefined || end === undefined || !body) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

/** TTML time expressions: clock times, "1.5s", "200ms", "90f" or ticks ("1000t"). */
function ttmlTime(value: string | undefined, tickRate: number, frameRate: number): number | undefined {
  if (!value) return undefined;
  const offset = /^([\d.]+)(h|m|s|ms|f|t)$/.exec(value.trim());
  if (offset) {
    const n = Number(offset[1]);
    const unit = offset[2];
    return unit === "h" ? n * 3600 : unit === "m" ? n * 60 : unit === "s" ? n : unit === "ms" ? n / 1000 : unit === "f" ? n / frameRate : n / tickRate;
  }
  // hh:mm:ss:frames is TTML's frame-clock form.
  const frames = /^(\d+):(\d{2}):(\d{2}):(\d+)$/.exec(value.trim());
  if (frames) return Number(frames[1]) * 3600 + Number(frames[2]) * 60 + Number(frames[3]) + Number(frames[4]) / frameRate;
  return clock(value);
}

function ttmlText(el: XmlElement): string {
  return el.content.map((c) => (typeof c === "string" ? c.replace(/\s+/g, " ") : c.name === "br" ? "\n" : ttmlText(c))).join("");
}

/** Cues of a TTML (or DFXP) document. */
export function parseTtml(text: string): Cue[] {
  const root = parseXml(text);
  const tickRate = Number(root.attrs.tickRate) || 10_000_000;
  const frameRate = Number(root.attrs.frameRate) || 30;
  const cues: Cue[] = [];
  const walk = (el: XmlElement) => {
    if (el.name === "p") {
      const start = ttmlTime(el.attrs.begin, tickRate, frameRate);
      const end = ttmlTime(el.attrs.end, tickRate, frameRate) ?? (start !== undefined ? start + (ttmlTime(el.attrs.dur, tickRate, frameRate) ?? 0) : undefined);
      const body = ttmlText(el)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
      if (start !== undefined && end !== undefined && body) cues.push({ start, end, text: body });
      return;
    }
    el.children.forEach(walk);
  };
  walk(root);
  return cues;
}

/** Joins cues from several segments: sorted, with repeats across segment edges dropped. */
export function mergeCues(lists: Cue[][]): Cue[] {
  const seen = new Set<string>();
  const out: Cue[] = [];
  for (const cue of lists.flat().sort((a, b) => a.start - b.start || a.end - b.end)) {
    const key = `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|${cue.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cue);
  }
  return out;
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

/** Reads WebVTT or TTML, whichever the text is. */
export function parseSubtitles(text: string): Cue[] {
  const head = text.trimStart().slice(0, 64);
  if (head.startsWith("WEBVTT")) return parseVtt(text);
  if (head.startsWith("<")) return parseTtml(text);
  return parseVtt(text); // SRT reads the same way, once commas are allowed in times
}
