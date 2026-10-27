// Records a live DASH stream until it ends or the user stops it. The worker
// follows the manifest itself: each update lists (or, for numbered segments,
// implies) the segments that exist now, and every one not seen yet is appended
// to its track's file. Stopping, or the stream ending, joins the tracks into
// one file without re-encoding; cancelling throws it away.

import { StreamTarget, type StreamTargetChunk } from "mediabunny";
import { joinTracks } from "../capture/mux";
import { liveSegments, parseMpd, type DashManifest, type SegmentRef } from "../shared/dash";
import { backoffMs, HttpError, MAX_ATTEMPTS } from "./fetch-file";

export interface RecordLiveDashOptions {
  jobId: string;
  manifestUrl: string;
  /** Representation keys to record, as `adaptationSet:representation`. */
  reps: string[];
  dir: FileSystemDirectoryHandle;
  file: FileSystemFileHandle;
  /** Aborting throws the recording away. */
  signal: AbortSignal;
  /** Aborting ends the recording and keeps it. */
  stop: AbortSignal;
  onProgress: (bytes: number, seconds: number) => void;
  /** For tests: the clock. */
  now?: () => number;
}

/** Segments a recording starts with: the live edge, as a player would join. */
const START_SEGMENTS = 3;
const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 10_000;
/** The manifest stopped growing for this many updates: the broadcast is over. */
const STALE_UPDATES = 6;
const RESPONSE_TIMEOUT_MS = 20_000;

async function get(url: string, signal: AbortSignal, range?: SegmentRef["range"]): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(RESPONSE_TIMEOUT_MS)]),
      });
      if (!res.ok) throw new HttpError(res.status);
      return res;
    } catch (err) {
      signal.throwIfAborted();
      if ((err instanceof HttpError && !err.retryable) || attempt + 1 >= MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
}

async function bytesOf(ref: SegmentRef, signal: AbortSignal): Promise<Uint8Array> {
  const data = new Uint8Array(await (await get(ref.url, signal, ref.range)).arrayBuffer());
  return ref.range && data.byteLength > ref.range.end - ref.range.start + 1 ? data.subarray(ref.range.start, ref.range.end + 1) : data;
}

const keyOf = (s: SegmentRef) => `${s.url}#${s.range?.start ?? ""}`;

const sleep = (ms: number, ...signals: AbortSignal[]) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    for (const s of signals) s.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Returns the size of the finished file. */
export async function recordLiveDash({ jobId, manifestUrl, reps, dir, file, signal, stop, onProgress, now = Date.now }: RecordLiveDashOptions): Promise<number> {
  const tracks = await Promise.all(
    reps.map(async (key, i) => {
      const handleFile = await dir.getFileHandle(`${jobId}.live${i}`, { create: true });
      const handle = await handleFile.createSyncAccessHandle();
      handle.truncate(0);
      return { key, handleFile, handle, at: 0, seen: new Set<string>(), hasInit: false, seconds: 0 };
    }),
  );
  let bytes = 0;
  let started = false;
  let stale = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const m: DashManifest = parseMpd(await (await get(manifestUrl, signal)).text(), manifestUrl);
      let added = 0;
      let segmentSeconds: number | undefined;
      for (const track of tracks) {
        const rep = m.representations.find((r) => r.key === track.key);
        if (!rep) throw new Error("The stream changed its qualities mid-broadcast");
        const { init, segments } = liveSegments(m, rep, now());
        segmentSeconds ??= segments.at(-1)?.duration;
        let fresh = segments.filter((s) => !track.seen.has(keyOf(s)));
        if (!started) fresh = fresh.slice(-START_SEGMENTS);
        if (!track.hasInit && init) {
          const data = await bytesOf(init, signal);
          track.handle.write(data, { at: track.at });
          track.at += data.byteLength;
          bytes += data.byteLength;
          track.hasInit = true;
        }
        for (const s of segments) if (!started) track.seen.add(keyOf(s));
        for (const s of fresh) {
          if (stop.aborted) break;
          track.seen.add(keyOf(s));
          let data: Uint8Array;
          try {
            data = await bytesOf(s, signal);
          } catch (err) {
            // A segment the clock says exists but the server hasn't published yet: try it next round.
            if (err instanceof HttpError && err.status === 404) {
              track.seen.delete(keyOf(s));
              break;
            }
            throw err;
          }
          track.handle.write(data, { at: track.at });
          track.at += data.byteLength;
          bytes += data.byteLength;
          track.seconds += s.duration ?? 0;
          added++;
        }
      }
      started = true;
      onProgress(bytes, Math.max(...tracks.map((t) => t.seconds)));
      // The broadcast ended (the manifest turned static) or the user stopped.
      if (!m.isLive || stop.aborted) break;
      stale = added ? 0 : stale + 1;
      if (stale >= STALE_UPDATES) break;
      const wait = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, (m.updatePeriod ?? segmentSeconds ?? 2) * 1000));
      await sleep(wait, stop, signal);
      if (stop.aborted) break;
    }
    signal.throwIfAborted();
    for (const t of tracks) {
      t.handle.flush();
      t.handle.close();
    }
    if (!tracks.some((t) => t.at > 0)) throw new Error("Nothing was recorded");

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
      const runs = await Promise.all(tracks.map(async (t) => [{ blob: await t.handleFile.getFile(), offset: 0 }]));
      await joinTracks(runs, target);
      out.flush();
    } finally {
      out.close();
    }
    return size;
  } finally {
    for (const t of tracks) {
      try {
        t.handle.close();
      } catch {
        // already closed
      }
      await dir.removeEntry(t.handleFile.name).catch(() => {});
    }
  }
}
