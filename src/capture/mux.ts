// Joins what a page fed its player into a single file. Each SourceBuffer gives
// one or more runs: an init segment followed by media segments, with a new run
// whenever the player switches quality. Runs of one track are joined into one
// track where the codec allows it; packets are copied as they are, shifted so
// the file starts at zero.

import {
  ALL_FORMATS,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type EncodedPacket,
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
 * The runs of one track that make the most of it: those that can be joined
 * with each other, in time order. H.264 runs whose parameter sets differ carry
 * them in each keyframe (an avc3 track) so a decoder can follow the switch.
 */
function joinable(runs: Run[]): Run[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) groups.set(run.key, [...(groups.get(run.key) ?? []), run]);
  const best = [...groups.values()].sort((a, b) => b.reduce((s, r) => s + r.bytes, 0) - a.reduce((s, r) => s + r.bytes, 0))[0] ?? [];
  best.sort((a, b) => a.start - b.start);
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

/** Packets of one run, up to where the next run takes over (a later append replaces what it overlaps). */
async function* runPackets(run: Run, until: number): AsyncGenerator<EncodedPacket> {
  for await (const raw of new EncodedPacketSink(run.track).packets()) {
    const packet = run.offset ? raw.clone({ timestamp: raw.timestamp + run.offset }) : raw;
    if (packet.timestamp >= until) {
      if (packet.type === "key") return;
      continue;
    }
    if (packet.type === "key" && run.inband) {
      const data = new Uint8Array(run.inband.length + packet.data.length);
      data.set(run.inband);
      data.set(packet.data, run.inband.length);
      yield packet.clone({ data });
    } else yield packet;
  }
}

/** `tracks`: per SourceBuffer, its runs in the order they were appended. */
export async function muxCaptured(tracks: CapturedRun[][], onProgress?: (fraction: number) => void): Promise<MuxResult> {
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

    const chunks: StreamTargetChunk[] = [];
    const output = new Output({
      format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(new WritableStream<StreamTargetChunk>({ write: (c) => void chunks.push({ ...c, data: c.data.slice() }) })),
    });

    const base = Math.min(...picked.map((runs) => runs[0]!.start));
    const ends = await Promise.all(picked.map(async (runs) => Math.max(...(await Promise.all(runs.map(async (r) => (await r.track.computeDuration()) + r.offset))))));
    const end = Math.max(...ends) - base;

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
      picked.map(async (runs, i) => {
        let first = true;
        for (let r = 0; r < runs.length; r++) {
          const until = runs[r + 1]?.start ?? Infinity;
          for await (const packet of runPackets(runs[r]!, until)) {
            const timestamp = Math.max(0, packet.timestamp - base);
            await writers[i]!(packet.clone({ timestamp }), first);
            first = false;
            if (end > 0 && i === 0) {
              done = Math.max(done, timestamp / end);
              onProgress?.(Math.min(1, done));
            }
          }
        }
      }),
    );
    await output.finalize();
    return { blob: assemble(chunks), ext: webm ? "webm" : hasVideo ? "mp4" : "m4a", durationSec: Math.max(0, end) };
  } finally {
    for (const input of inputs) input.dispose();
  }
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
