// Joins what a page fed its player (one byte stream per SourceBuffer, each an
// init segment followed by media segments) into a single file. Packets are
// copied as they are, shifted so the file starts at zero.

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
  type InputAudioTrack,
  type InputTrack,
  type StreamTargetChunk,
} from "mediabunny";

export interface MuxResult {
  blob: Blob;
  ext: "mp4" | "webm" | "m4a";
  durationSec: number;
}

/** Codecs MP4 can't carry; anything else goes in MP4. */
const WEBM_ONLY = new Set(["vorbis"]);

export async function muxCaptured(streams: Blob[], onProgress?: (fraction: number) => void): Promise<MuxResult> {
  const inputs = streams.map((blob) => new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }));
  try {
    const tracks: InputTrack[] = [];
    for (const input of inputs) {
      const video = await input.getPrimaryVideoTrack().catch(() => null);
      const audio = await input.getPrimaryAudioTrack().catch(() => null);
      if (video && !tracks.some((t) => t.isVideoTrack())) tracks.push(video);
      if (audio && !tracks.some((t) => t.isAudioTrack())) tracks.push(audio);
    }
    if (tracks.length === 0) throw new Error("The player hadn't loaded any audio or video yet");
    const codecs = await Promise.all(tracks.map((t) => t.getCodec()));
    const webm = codecs.some((c) => c && WEBM_ONLY.has(c));
    const hasVideo = tracks.some((t) => t.isVideoTrack());

    const chunks: StreamTargetChunk[] = [];
    const output = new Output({
      format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(new WritableStream<StreamTargetChunk>({ write: (c) => void chunks.push({ ...c, data: c.data.slice() }) })),
    });

    const sinks = tracks.map((t) => new EncodedPacketSink(t));
    const firsts = await Promise.all(sinks.map((s) => s.getFirstPacket()));
    const base = Math.min(...firsts.flatMap((p) => (p ? [p.timestamp] : [])));
    const durations = await Promise.all(tracks.map((t) => t.computeDuration()));
    const end = Math.max(...durations) - base;

    const writers = await Promise.all(
      tracks.map(async (track, i) => {
        const codec = codecs[i];
        if (!codec) throw new Error("The player's stream uses a format we can't save");
        if (track.isVideoTrack()) {
          const config = await track.getDecoderConfig();
          const source = new EncodedVideoPacketSource(codec as never);
          output.addVideoTrack(source);
          return (p: Parameters<typeof source.add>[0], first: boolean) => source.add(p, first && config ? { decoderConfig: config as VideoDecoderConfig } : undefined);
        }
        const config = await (track as InputAudioTrack).getDecoderConfig();
        const source = new EncodedAudioPacketSource(codec as never);
        output.addAudioTrack(source);
        return (p: Parameters<typeof source.add>[0], first: boolean) => source.add(p, first && config ? { decoderConfig: config as AudioDecoderConfig } : undefined);
      }),
    );
    await output.start();

    let done = 0;
    await Promise.all(
      sinks.map(async (sink, i) => {
        let first = true;
        for await (const packet of sink.packets()) {
          await writers[i]!(packet.clone({ timestamp: Math.max(0, packet.timestamp - base) }), first);
          first = false;
          if (end > 0 && i === 0) {
            done = Math.max(done, (packet.timestamp - base) / end);
            onProgress?.(Math.min(1, done));
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
