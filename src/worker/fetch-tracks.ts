// Downloads a DASH stream the HLS reader can't take (WebM: VP8, VP9, AV1,
// Opus, Vorbis) as one file per track, then joins the tracks into one file
// without re-encoding.

import { StreamTarget, type StreamTargetChunk } from "mediabunny";
import { joinTracks } from "../capture/mux";
import type { TrackPart } from "../shared/worker-protocol";
import { backoffMs, HttpError, MAX_ATTEMPTS } from "./fetch-file";

export interface FetchTracksOptions {
  jobId: string;
  tracks: TrackPart[][];
  dir: FileSystemDirectoryHandle;
  file: FileSystemFileHandle;
  signal: AbortSignal;
  onProgress: (bytes: number, fraction: number) => void;
}

const PROGRESS_EVERY_MS = 500;
/** Parts fetched at once per track; enough to fill a fast line, polite to CDNs. */
const PARALLEL_PARTS = 4;
const RESPONSE_TIMEOUT_MS = 30_000;
/** Downloading is most of the work; joining the tracks is the rest. */
const DOWNLOAD_SHARE = 0.9;

async function fetchPart(part: TrackPart, signal: AbortSignal): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const headers: HeadersInit = part.range ? { Range: `bytes=${part.range.start}-${part.range.end}` } : {};
      const res = await fetch(part.url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(RESPONSE_TIMEOUT_MS)]) });
      if (!res.ok) throw new HttpError(res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A server that ignores Range sends the whole file; cut out the part.
      return part.range && res.status === 200 ? bytes.subarray(part.range.start, part.range.end + 1) : bytes;
    } catch (err) {
      signal.throwIfAborted();
      if ((err instanceof HttpError && !err.retryable) || attempt + 1 >= MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
}

/** Returns the size of the joined file. */
export async function fetchTracks({ jobId, tracks, dir, file, signal, onProgress }: FetchTracksOptions): Promise<number> {
  const totalParts = tracks.reduce((n, t) => n + t.length, 0);
  let doneParts = 0;
  let bytes = 0;
  let last = 0;
  const progress = (fraction: number) => {
    const now = Date.now();
    if (now - last < PROGRESS_EVERY_MS) return;
    last = now;
    onProgress(bytes, fraction);
  };

  const trackFiles: FileSystemFileHandle[] = [];
  try {
    for (let t = 0; t < tracks.length; t++) {
      const handleFile = await dir.getFileHandle(`${jobId}.track${t}`, { create: true });
      trackFiles.push(handleFile);
      const handle = await handleFile.createSyncAccessHandle();
      try {
        handle.truncate(0);
        let at = 0;
        const parts = tracks[t]!;
        // Fetch ahead, write in order.
        const pending: Promise<Uint8Array>[] = [];
        let next = 0;
        const fill = () => {
          while (next < parts.length && pending.length < PARALLEL_PARTS) pending.push(fetchPart(parts[next++]!, signal));
        };
        fill();
        while (pending.length) {
          const data = await pending.shift()!;
          fill();
          handle.write(data, { at });
          at += data.byteLength;
          bytes += data.byteLength;
          doneParts++;
          progress((doneParts / totalParts) * DOWNLOAD_SHARE);
        }
        handle.flush();
      } finally {
        handle.close();
      }
    }

    signal.throwIfAborted();
    const out = await file.createSyncAccessHandle();
    let size = 0;
    try {
      out.truncate(0);
      const target = new StreamTarget(
        new WritableStream<StreamTargetChunk>({
          write(chunk) {
            out.write(chunk.data, { at: chunk.position });
            size = Math.max(size, chunk.position + chunk.data.byteLength);
          },
        }),
      );
      const runs = await Promise.all(trackFiles.map(async (f) => [{ blob: await f.getFile(), offset: 0 }]));
      await joinTracks(runs, target, (f) => progress(DOWNLOAD_SHARE + f * (1 - DOWNLOAD_SHARE)));
      out.flush();
    } finally {
      out.close();
    }
    onProgress(size, 1);
    return size;
  } finally {
    for (const f of trackFiles) await dir.removeEntry(f.name).catch(() => {});
  }
}
