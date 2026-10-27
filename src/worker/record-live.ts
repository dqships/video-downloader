// Records a live HLS stream to MP4 until it ends or the user stops it. Packets
// are copied as they arrive (no re-encoding); stopping finalizes the file, so
// what was recorded so far is kept. Cancelling throws it away.

import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  type EncodedPacket,
  type InputTrack,
  type StreamTargetChunk,
} from "mediabunny";
import { backoffMs, MAX_ATTEMPTS } from "./fetch-file";

export interface RecordLiveOptions {
  url: string;
  file: FileSystemFileHandle;
  /** Aborting throws the recording away. */
  signal: AbortSignal;
  /** Aborting ends the recording and keeps it. */
  stop: AbortSignal;
  audioOnly?: boolean;
  onProgress: (bytes: number, seconds: number) => void;
}

const PROGRESS_EVERY_MS = 500;

/** Resolves when `signal` aborts; never rejects. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));

/** Returns the size of the finished MP4. */
export async function recordLive({ url, file, signal, stop, audioOnly, onProgress }: RecordLiveOptions): Promise<number> {
  signal.throwIfAborted();
  const handle = await file.createSyncAccessHandle();
  handle.truncate(0);
  let size = 0;
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(
      new WritableStream<StreamTargetChunk>({
        write(chunk) {
          handle.write(chunk.data, { at: chunk.position });
          size = Math.max(size, chunk.position + chunk.data.byteLength);
        },
      }),
    ),
  });
  const input = new Input({
    source: new UrlSource(url, {
      getRetryDelay: (attempts) => (attempts >= MAX_ATTEMPTS ? null : backoffMs(attempts) / 1000),
    }),
    formats: ALL_FORMATS,
  });

  let ended = false;
  try {
    const video = audioOnly ? null : await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) throw new Error("This stream has no audio or video we can record");

    /** Each track with a function that writes one packet (the first carries the decoder config). */
    const tracks: { track: InputTrack; add: (packet: EncodedPacket, first: boolean) => Promise<void> }[] = [];
    if (video) {
      const codec = await video.getCodec();
      if (!codec) throw new Error("This stream's video codec can't be saved as MP4");
      const source = new EncodedVideoPacketSource(codec);
      output.addVideoTrack(source);
      const config = await video.getDecoderConfig();
      tracks.push({ track: video, add: (p, first) => source.add(p, first && config ? { decoderConfig: config } : undefined) });
    }
    if (audio) {
      const codec = await audio.getCodec();
      if (!codec) throw new Error("This stream's audio codec can't be saved as MP4");
      const source = new EncodedAudioPacketSource(codec);
      output.addAudioTrack(source);
      const config = await audio.getDecoderConfig();
      tracks.push({ track: audio, add: (p, first) => source.add(p, first && config ? { decoderConfig: config } : undefined) });
    }
    await output.start();

    // The window a live playlist offers starts mid-broadcast: shift every
    // track by the earliest first timestamp so the file starts at zero.
    const firsts = await Promise.all(tracks.map((t) => new EncodedPacketSink(t.track).getFirstPacket()));
    const base = Math.min(...firsts.filter((p) => p).map((p) => p!.timestamp));
    let recorded = 0;
    let last = 0;

    const copy = async ({ track, add }: (typeof tracks)[number]) => {
      let first = true;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        if (ended || signal.aborted) return;
        const shifted = packet.clone({ timestamp: Math.max(0, packet.timestamp - base) });
        await add(shifted, first);
        first = false;
        recorded = Math.max(recorded, shifted.timestamp + shifted.duration);
        const now = Date.now();
        if (now - last >= PROGRESS_EVERY_MS) {
          last = now;
          onProgress(size, recorded);
        }
      }
    };

    // Run until every track ends (the broadcast finished), or stop/cancel.
    // A stopped copy may still be waiting for the next live segment; it exits
    // on its own once that arrives (or the input is disposed), so it's not awaited.
    const copies = Promise.all(tracks.map(copy));
    copies.catch(() => {});
    await Promise.race([copies, aborted(stop), aborted(signal)]);
    ended = true;
    signal.throwIfAborted();
    if (recorded === 0) throw new Error("Nothing was recorded yet");
    await output.finalize();
    handle.flush();
    onProgress(size, recorded);
    return size;
  } catch (err) {
    ended = true;
    if (output.state === "started") await output.cancel().catch(() => {});
    throw err;
  } finally {
    input.dispose();
    handle.close();
  }
}
