// Downloads an HLS stream and remuxes it to one MP4, without re-encoding.
// Mediabunny reads the playlists and segments (AES-128, fMP4 and separate
// audio included); we only point it at the playlist and give it a file.

import { ALL_FORMATS, Conversion, Input, Mp4OutputFormat, Output, StreamTarget, UrlSource, type StreamTargetChunk } from "mediabunny";
import { backoffMs, MAX_ATTEMPTS } from "./fetch-file";

export interface RemuxHlsOptions {
  url: string;
  file: FileSystemFileHandle;
  signal: AbortSignal;
  onProgress: (bytes: number, fraction: number) => void;
}

const PROGRESS_EVERY_MS = 500;
/** Segments fetched at once; enough to fill a fast line, polite to CDNs. */
const PARALLEL_SEGMENTS = 4;

/** Returns the size of the finished MP4. */
export async function remuxHls({ url, file, signal, onProgress }: RemuxHlsOptions): Promise<number> {
  signal.throwIfAborted();
  const handle = await file.createSyncAccessHandle();
  handle.truncate(0);
  let size = 0;
  const target = new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      write(chunk) {
        handle.write(chunk.data, { at: chunk.position });
        size = Math.max(size, chunk.position + chunk.data.byteLength);
      },
    }),
  );
  const input = new Input({
    source: new UrlSource(url, {
      parallelism: PARALLEL_SEGMENTS,
      // Mediabunny wants seconds; stop after as many tries as direct files get.
      getRetryDelay: (attempts) => (attempts >= MAX_ATTEMPTS ? null : backoffMs(attempts) / 1000),
    }),
    formats: ALL_FORMATS,
  });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });

  let conversion: Conversion | undefined;
  const abort = () => void conversion?.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    conversion = await Conversion.init({ input, output, showWarnings: false });
    if (!conversion.isValid) {
      const reasons = [...new Set(conversion.discardedTracks.map((t) => t.reason))].join(", ");
      throw new Error(`This stream can't be saved as MP4 (${reasons || "no usable tracks"})`);
    }
    let last = 0;
    conversion.onProgress = (fraction) => {
      const now = Date.now();
      if (now - last < PROGRESS_EVERY_MS) return;
      last = now;
      onProgress(size, fraction);
    };
    signal.throwIfAborted();
    await conversion.execute();
    signal.throwIfAborted();
    handle.flush();
    onProgress(size, 1);
    return size;
  } finally {
    signal.removeEventListener("abort", abort);
    input.dispose();
    handle.close();
  }
}
