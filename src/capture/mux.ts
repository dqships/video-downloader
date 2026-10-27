// Joins what a page fed its player, or the tracks of a WebM DASH stream, into a single file. Each SourceBuffer gives
// one or more runs: an init segment followed by media segments, with a new run
// whenever the player switches quality. Runs of one track are joined into one
// track where the codec allows it; packets are copied as they are, shifted so
// the file starts at zero.

import {
  ALL_FORMATS,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type InputAudioTrack,
  type InputTrack,
  type InputVideoTrack,
  type StreamTargetChunk,
} from "mediabunny";

export interface MuxResult {
  blob: Blob;
  ext: "mp4" | "webm" | "m4a";
  durationSec: number;
}

/** Codecs MP4 can't carry; anything else goes in MP4. */
const WEBM_ONLY = new Set(["vorbis"]);

interface Run {
  track: InputTrack;
  codec: string;
  config: VideoDecoderConfig | AudioDecoderConfig;
  /** Runs with the same key can be joined into one track. */
  key: string;
  bytes: number;
  /** Where its first packet plays, timestampOffset included. */
  start: number;
  /** The SourceBuffer's timestampOffset while this run was appended. */
  offset: number;
  /** H.264 parameter sets to repeat before each keyframe, when runs differ in them. */
  inband?: Uint8Array;
}

const hex = (b?: AllowSharedBufferSource) =>
  b ? [...(b instanceof ArrayBuffer || b instanceof SharedArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength))].map((x) => x.toString(16).padStart(2, "0")).join("") : "";

function bytesOf(b: AllowSharedBufferSource): Uint8Array {
  return b instanceof ArrayBuffer || b instanceof SharedArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * The SPS and PPS of an AVCDecoderConfigurationRecord, as length-prefixed NAL
 * units ready to put in front of a sample, and the length size samples use.
 */
export function avcParameterSets(description: AllowSharedBufferSource): { lengthSize: number; nals: Uint8Array } | undefined {
  const d = bytesOf(description);
  if (d.length < 7 || d[0] !== 1) return undefined;
  const lengthSize = (d[4]! & 3) + 1;
  const units: Uint8Array[] = [];
  let at = 5;
  for (const count of [d[at]! & 31, -1]) {
    let n = count;
    if (n === -1) n = d[at++]!;
    else at++;
    for (let i = 0; i < n; i++) {
      if (at + 2 > d.length) return undefined;
      const len = (d[at]! << 8) | d[at + 1]!;
      at += 2;
      if (at + len > d.length) return undefined;
      units.push(d.subarray(at, at + len));
      at += len;
    }
  }
  const out = new Uint8Array(units.reduce((s, u) => s + lengthSize + u.length, 0));
  let pos = 0;
  for (const u of units) {
    for (let i = lengthSize - 1; i >= 0; i--) out[pos++] = (u.length >>> (8 * i)) & 0xff;
    out.set(u, pos);
    pos += u.length;
  }
  return { lengthSize, nals: out };
}

/** One run as the capture page kept it. */
export interface CapturedRun {
  blob: Blob;
  offset: number;
}

const EBML_MAGIC = 0x1a45dfa3;
const WEBM_INDEXES = new Set([0x114d9b74 /* SeekHead */, 0x1c53bb6b /* Cues */]);
const WEBM_CLUSTER = 0x1f43b675;

function ebmlId(b: Uint8Array, at: number): [number, number] | undefined {
  const first = b[at];
  if (!first) return undefined;
  const len = Math.clz32(first) - 23;
  if (len < 1 || len > 4 || at + len > b.length) return undefined;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[at + i]!;
  return [id, len];
}

function ebmlSize(b: Uint8Array, at: number): [number, number] | undefined {
  const first = b[at];
  if (!first) return undefined;
  const len = Math.clz32(first) - 23;
  if (len < 1 || len > 8 || at + len > b.length) return undefined;
  let size = first & (0xff >> len);
  let unknown = size === 0xff >> len;
  for (let i = 1; i < len; i++) {
    size = size * 256 + b[at + i]!;
    unknown &&= b[at + i] === 0xff;
  }
  return [unknown ? -1 : size, len];
}

/**
 * A WebM init segment carries the index of the file it came from (SeekHead,
 * Cues), whose byte positions mean nothing in the joined capture. They're
 * blanked to Void elements of the same length, so nothing else moves.
 */
export function blankWebmIndexes(head: Uint8Array): void {
  const top = ebmlId(head, 0);
  if (!top || top[0] !== EBML_MAGIC) return;
  const headerSize = ebmlSize(head, top[1]);
  if (!headerSize || headerSize[0] < 0) return;
  let at = top[1] + headerSize[1] + headerSize[0];
  const segment = ebmlId(head, at);
  if (!segment) return;
  const segmentSize = ebmlSize(head, at + segment[1]);
  if (!segmentSize) return;
  at += segment[1] + segmentSize[1];
  while (at < head.length) {
    const id = ebmlId(head, at);
    const size = id && ebmlSize(head, at + id[1]);
    if (!id || !size || size[0] < 0 || id[0] === WEBM_CLUSTER) return;
    const length = id[1] + size[1] + size[0];
    if (at + length > head.length) return;
    if (WEBM_INDEXES.has(id[0]) && length >= 9) {
      // Void (0xEC) with an 8-byte size covering the rest.
      head[at] = 0xec;
      head[at + 1] = 0x01;
      let rest = length - 9;
      for (let i = 8; i >= 2; i--) {
        head[at + i] = rest & 0xff;
        rest = Math.floor(rest / 256);
      }
    }
    at += length;
  }
}

const WEBM_HEAD_BYTES = 1 << 20;

async function withoutWebmIndexes(blob: Blob): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, WEBM_HEAD_BYTES)).arrayBuffer());
  if (head[0] !== 0x1a || head[1] !== 0x45 || head[2] !== 0xdf || head[3] !== 0xa3) return blob;
  blankWebmIndexes(head);
  return new Blob([head, blob.slice(head.length)]);
}

async function readRun({ blob: raw, offset }: CapturedRun, inputs: Input[]): Promise<Run | undefined> {
  const blob = await withoutWebmIndexes(raw);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  inputs.push(input);
  const track: InputTrack | null = (await input.getPrimaryVideoTrack().catch(() => null)) ?? (await input.getPrimaryAudioTrack().catch(() => null));
  if (!track) return undefined;
  const codec = await track.getCodec();
  const config = track.isVideoTrack() ? await (track as InputVideoTrack).getDecoderConfig() : await (track as InputAudioTrack).getDecoderConfig();
  const first = await new EncodedPacketSink(track).getFirstPacket();
  if (!codec || !config || !first) return undefined;
  let key: string;
  if (codec === "avc") key = `avc:${config.description ? avcParameterSets(config.description)?.lengthSize : "annexb"}`;
  // VP8, VP9 and AV1 decoders follow a size change at a keyframe on their own.
  else if (codec === "vp8" || codec === "vp9" || codec === "av1") key = codec;
  else if (track.isAudioTrack()) {
    const audio = track as InputAudioTrack;
    // AAC LC and HE-AAC differ in the codec string, not in the codec name.
    key = `${config.codec}:${audio.sampleRate}:${audio.numberOfChannels}`;
  } else key = `${codec}:${hex(config.description)}`;
  return { track, codec, config, key, bytes: blob.size, start: first.timestamp + offset, offset };
}

/**
 * The runs of one track that can be joined with each other: the group that
 * holds the most. H.264 runs whose parameter sets differ carry them in each
 * keyframe (an avc3 track) so a decoder can follow the switch.
 */
function joinable(runs: Run[]): Run[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) groups.set(run.key, [...(groups.get(run.key) ?? []), run]);
  const best = [...groups.values()].sort((a, b) => b.reduce((s, r) => s + r.bytes, 0) - a.reduce((s, r) => s + r.bytes, 0))[0] ?? [];
  if (best[0]?.codec === "avc" && new Set(best.map((r) => hex(r.config.description))).size > 1) {
    for (const run of best) run.inband = run.config.description ? avcParameterSets(run.config.description)?.nals : undefined;
  }
  return best;
}

/** The decoder config to describe a joined track with: its largest picture, or its first. */
function trackConfig(runs: Run[]): Run["config"] {
  const video = runs.filter((r) => "codedWidth" in r.config) as (Run & { config: VideoDecoderConfig })[];
  const top = video.sort((a, b) => (b.config.codedWidth ?? 0) * (b.config.codedHeight ?? 0) - (a.config.codedWidth ?? 0) * (a.config.codedHeight ?? 0))[0];
  const config = { ...(top ?? runs[0]!).config };
  if (runs[0]!.inband) config.codec = config.codec.replace(/^avc1/, "avc3");
  return config;
}

/** A keyframe and the packets that depend on it, in decode order. */
interface Gop {
  start: number;
  end: number;
  packets: EncodedPacket[];
}

/** Time ranges already taken, kept sorted and merged. */
class Taken {
  private ranges: [number, number][] = [];
  /** Where [start, end) first runs into a taken range: start itself, a later point, or Infinity. */
  firstOverlap(start: number, end: number): number {
    let first = Infinity;
    for (const [a, b] of this.ranges) {
      if (a >= end - EPSILON) break;
      if (b > start + EPSILON) first = Math.min(first, Math.max(a, start));
    }
    return first;
  }
  add(start: number, end: number): void {
    const next: [number, number][] = [];
    let [s, e] = [start, end];
    for (const [a, b] of this.ranges) {
      if (b < s - EPSILON || a > e + EPSILON) next.push([a, b]);
      else [s, e] = [Math.min(s, a), Math.max(e, b)];
    }
    next.push([s, e]);
    this.ranges = next.sort((x, y) => x[0] - y[0]);
  }
}
const EPSILON = 1e-3;

/** A run's frame groups in order, each handed out once the next one begins. */
async function* readGops(run: Run): AsyncGenerator<Gop> {
  let gop: Gop | undefined;
  /** The packet before the newest one, for the length of a last block that has none. */
  let previous: EncodedPacket | undefined;
  let newest: EncodedPacket | undefined;
  for await (const raw of new EncodedPacketSink(run.track).packets()) {
    let packet = run.offset ? raw.clone({ timestamp: raw.timestamp + run.offset }) : raw;
    if (packet.type === "key" && run.inband) {
      const data = new Uint8Array(run.inband.length + packet.data.length);
      data.set(run.inband);
      data.set(packet.data, run.inband.length);
      packet = packet.clone({ data });
    }
    // WebM leaves the last block of a cluster without a duration: it lasts until the next one.
    if (gop && gop.packets.at(-1)!.duration === 0) settleDuration(gop, packet.timestamp);
    if (packet.type === "key" || !gop) {
      if (gop) yield gop;
      gop = { start: packet.timestamp, end: packet.timestamp, packets: [] };
    }
    previous = newest;
    newest = packet;
    gop.packets.push(packet);
    gop.end = Math.max(gop.end, packet.timestamp + packet.duration);
  }
  if (!gop) return;
  const last = gop.packets.at(-1)!;
  if (last.duration === 0 && previous) settleDuration(gop, last.timestamp + previous.duration);
  yield gop;
}

async function gopsOf(run: Run): Promise<Gop[]> {
  const gops: Gop[] = [];
  for await (const gop of readGops(run)) gops.push(gop);
  return gops;
}

function settleDuration(gop: Gop, next: number): void {
  const prev = gop.packets.at(-1)!;
  const duration = Math.max(0, next - prev.timestamp);
  if (duration === 0) return;
  gop.packets[gop.packets.length - 1] = prev.clone({ duration });
  gop.end = Math.max(gop.end, prev.timestamp + duration);
}

/**
 * What the player ended up with, by Media Source's own rule: a later append
 * replaces whatever it overlaps (players re-append, switch quality mid-way and
 * go back over time they already have); what it doesn't cover stays. A frame
 * group that loses its start loses the rest with it.
 */
async function timeline(runs: Run[]): Promise<Gop[]> {
  const appended = (await Promise.all(runs.map(gopsOf))).flat();
  const taken = new Taken();
  const kept: Gop[] = [];
  for (let i = appended.length - 1; i >= 0; i--) {
    const gop = appended[i]!;
    const cut = taken.firstOverlap(gop.start, gop.end);
    if (cut <= gop.start + EPSILON) continue;
    // A packet that would mostly play over the later append goes too.
    const packets = cut === Infinity ? gop.packets : gop.packets.filter((p) => p.timestamp + p.duration / 2 < cut);
    if (packets.length === 0) continue;
    const end = Math.min(gop.end, cut);
    kept.push({ start: gop.start, end, packets });
    taken.add(gop.start, end);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** A track's frame groups in the order to write them, and the time they span. */
interface Planned {
  gops: AsyncIterable<Gop> | Gop[];
  start: number;
  end: number;
}

/**
 * Silent frames that need no encoder: AAC-LC (from hls.js, by channel count)
 * and a 20 ms Opus packet, which any Opus decoder plays in mono or stereo.
 */
const SILENCE: Record<string, (channels: number, sampleRate: number) => { data: Uint8Array; duration: number } | undefined> = {
  aac: (channels, sampleRate) => {
    const frame = { 1: [0x00, 0xc8, 0x00, 0x80, 0x23, 0x80], 2: [0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80] }[channels];
    return frame && { data: new Uint8Array(frame), duration: 1024 / sampleRate };
  },
  opus: () => ({ data: new Uint8Array([0xf8, 0xff, 0xfe]), duration: 0.02 }),
};

/** A late start this short is left as it is. */
const MIN_PAD_SEC = 0.1;

/**
 * Sound that begins after the picture (a player that loaded audio late) gets
 * silence in front, so the file's audio starts with its video in every player,
 * also ones that ignore an MP4 edit list.
 */
function padAudio(run: Run, planned: Planned, from: number): Planned {
  const config = run.config as AudioDecoderConfig;
  if (run.track.isVideoTrack() || planned.start - from < MIN_PAD_SEC || !config.codec.match(/^(mp4a\.40\.2|opus)$/)) return planned;
  const frame = SILENCE[run.codec]?.(config.numberOfChannels, config.sampleRate);
  if (!frame) return planned;
  const count = Math.floor((planned.start - from) / frame.duration);
  const first = planned.start - count * frame.duration;
  const packets = Array.from({ length: count }, (_, i) => new EncodedPacket(frame.data, "key", first + i * frame.duration, frame.duration));
  const rest = planned.gops;
  async function* gops() {
    yield { start: first, end: planned.start, packets };
    yield* rest;
  }
  return { gops: gops(), start: first, end: planned.end };
}

async function plan(runs: Run[]): Promise<Planned> {
  if (runs.length === 1) {
    // One run (a downloaded track) is written as it is read, without holding it.
    const run = runs[0]!;
    return { gops: readGops(run), start: run.start, end: (await run.track.computeDuration()) + run.offset };
  }
  const gops = await timeline(runs);
  if (gops.length === 0) throw new Error("The player hadn't loaded any audio or video yet");
  return { gops, start: gops[0]!.start, end: Math.max(...gops.map((g) => g.end)) };
}

export interface JoinResult {
  ext: "mp4" | "webm" | "m4a";
  durationSec: number;
}

/**
 * Joins tracks into one file written to `target`. `tracks`: per track (a
 * SourceBuffer, or a downloaded DASH representation), its runs in the order
 * they were appended. With several video or audio tracks, the biggest of
 * each is kept.
 */
export async function joinTracks(tracks: CapturedRun[][], target: StreamTarget, onProgress?: (fraction: number) => void): Promise<JoinResult> {
  const inputs: Input[] = [];
  try {
    const chosen: Run[][] = [];
    for (const runs of tracks) {
      const read = (await Promise.all(runs.map((run) => readRun(run, inputs)))).flatMap((r) => (r ? [r] : []));
      const joined = joinable(read);
      if (joined.length) chosen.push(joined);
    }
    const isVideo = (runs: Run[]) => runs[0]!.track.isVideoTrack();
    const byBytes = (a: Run[], b: Run[]) => b.reduce((s, r) => s + r.bytes, 0) - a.reduce((s, r) => s + r.bytes, 0);
    const picked = [chosen.filter(isVideo).sort(byBytes)[0], chosen.filter((r) => !isVideo(r)).sort(byBytes)[0]].flatMap((r) => (r ? [r] : []));
    if (picked.length === 0) throw new Error("The player hadn't loaded any audio or video yet");
    const webm = picked.some((runs) => WEBM_ONLY.has(runs[0]!.codec));
    const hasVideo = picked.some(isVideo);
    const planned = await Promise.all(picked.map(plan));
    const videoStart = planned.find((_, i) => isVideo(picked[i]!))?.start;
    const plans = videoStart === undefined ? planned : planned.map((p, i) => padAudio(picked[i]![0]!, p, videoStart));

    const output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: false }), target });
    const base = Math.min(...plans.map((p) => p.start));
    const end = Math.max(...plans.map((p) => p.end)) - base;

    const writers = picked.map((runs) => {
      const codec = runs[0]!.codec;
      const config = trackConfig(runs);
      if (isVideo(runs)) {
        const source = new EncodedVideoPacketSource(codec as never);
        output.addVideoTrack(source);
        return (p: EncodedPacket, first: boolean) => source.add(p, first ? { decoderConfig: config as VideoDecoderConfig } : undefined);
      }
      const source = new EncodedAudioPacketSource(codec as never);
      output.addAudioTrack(source);
      return (p: EncodedPacket, first: boolean) => source.add(p, first ? { decoderConfig: config as AudioDecoderConfig } : undefined);
    });
    await output.start();

    let done = 0;
    await Promise.all(
      plans.map(async ({ gops }, i) => {
        let first = true;
        for await (const gop of gops) {
          for (const packet of gop.packets) {
            const timestamp = Math.max(0, packet.timestamp - base);
            await writers[i]!(packet.clone({ timestamp }), first);
            first = false;
          }
          if (end > 0 && i === 0) {
            done = Math.max(done, (gop.end - base) / end);
            onProgress?.(Math.min(1, done));
          }
        }
        if (first) throw new Error("The player hadn't loaded any audio or video yet");
      }),
    );
    await output.finalize();
    return { ext: webm ? "webm" : hasVideo ? "mp4" : "m4a", durationSec: Math.max(0, end) };
  } finally {
    for (const input of inputs) input.dispose();
  }
}

/** A player recording, joined in memory (the capture page saves it as a blob). */
export async function muxCaptured(tracks: CapturedRun[][], onProgress?: (fraction: number) => void): Promise<MuxResult> {
  const chunks: StreamTargetChunk[] = [];
  const target = new StreamTarget(new WritableStream<StreamTargetChunk>({ write: (c) => void chunks.push({ ...c, data: c.data.slice() }) }));
  const { ext, durationSec } = await joinTracks(tracks, target, onProgress);
  return { blob: assemble(chunks), ext, durationSec };
}

/** Positioned writes to one Blob (the MP4 writer goes back to fill in sizes). */
function assemble(chunks: StreamTargetChunk[]): Blob {
  let size = 0;
  let sequential = true;
  for (const c of chunks) {
    if (c.position !== size) sequential = false;
    size = Math.max(size, c.position + c.data.byteLength);
  }
  if (sequential) return new Blob(chunks.map((c) => c.data as BlobPart));
  const bytes = new Uint8Array(size);
  for (const c of chunks) bytes.set(c.data, c.position);
  return new Blob([bytes]);
}
