// Runs in the page's own JavaScript world at document start. Some players
// fetch their video in ways the network can't show us (custom transports,
// obfuscated manifests) and hand the bytes straight to Media Source
// Extensions. This notes which players use MSE and, only while the user
// records one, passes on a copy of every buffer the page appends.
//
// Messages go to the isolated bridge script by window.postMessage; the page
// can see them too, but they only carry the page's own data.

interface Track {
  id: number;
  mime: string;
  /** The latest init segment, replayed when recording starts mid-stream. */
  init?: ArrayBuffer;
  source: MediaSource;
}

/**
 * Pages may open a MediaSource only to probe the browser (BBC: one tiny
 * append, then endOfStream) or play an ad in one before the video; the
 * recording ends once every MediaSource that got media has ended, and none
 * starts within a few seconds.
 */
const sources = new WeakMap<MediaSource, { media: boolean; ended: boolean }>();
const fed: WeakRef<MediaSource>[] = [];
const END_SETTLE_MS = 4000;
let endTimer: ReturnType<typeof setTimeout> | undefined;

function allEnded(): boolean {
  const live = fed.flatMap((r) => {
    const ms = r.deref();
    return ms ? [sources.get(ms)!] : [];
  });
  return live.length > 0 && live.every((s) => s.ended);
}

function checkEnded(): void {
  clearTimeout(endTimer);
  if (!allEnded()) return;
  endTimer = setTimeout(() => {
    if (!allEnded()) return;
    if (recording()) post({ type: "mse-ended" });
    else if (state === "undecided") endedEarly = true;
  }, END_SETTLE_MS);
}

const TAG = "__vidzilla_mse";
const tracks = new WeakMap<SourceBuffer, Track>();
/** SourceBuffers can't be enumerated from a WeakMap; keep a weak list as well. */
const buffers: WeakRef<SourceBuffer>[] = [];
let nextId = 1;
/**
 * "undecided" until the extension answers whether a recording is armed for
 * this page (Record reloads the page so the whole video is caught); appends
 * wait in a small queue meanwhile. Then "recording" or "idle".
 */
let state: "undecided" | "idle" | "recording" = "undecided";
let queue: { track: number; mime: string; init: boolean; bytes: ArrayBuffer }[] = [];
let queued = 0;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const DECIDE_WITHIN_MS = 5000;
const recording = () => state === "recording";

function idle(): void {
  state = "idle";
  queue = [];
  queued = 0;
}
let announced = false;
/** The whole video loaded before the extension answered. */
let endedEarly = false;

const post = (msg: Record<string, unknown>, transfer: Transferable[] = []) => window.postMessage({ [TAG]: true, ...msg }, "*", transfer);

/** fMP4 init segments start with ftyp or moov; WebM ones with the EBML header. */
function isInit(bytes: Uint8Array): boolean {
  if (bytes.length >= 8) {
    const box = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
    if (box === "ftyp" || box === "moov") return true;
  }
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

function copy(data: BufferSource): ArrayBuffer {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return view.slice().buffer;
}

const ms = window.MediaSource ?? (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
if (ms) {
  // Players that can run Media Source in a worker (Facebook) do, where this
  // script can't see them. Saying it isn't supported keeps them on this page.
  try {
    Object.defineProperty(ms, "canConstructInDedicatedWorker", { value: false, configurable: true });
  } catch {
    // Never break the page's player.
  }
  const addSourceBuffer = ms.prototype.addSourceBuffer;
  ms.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
    const sb = addSourceBuffer.call(this, mime);
    try {
      buffers.push(new WeakRef(sb));
      if (!announced) {
        announced = true;
        post({ type: "mse-used", mime });
        setTimeout(() => state === "undecided" && idle(), DECIDE_WITHIN_MS);
      }
      tracks.set(sb, { id: nextId++, mime, source: this });
      if (!sources.has(this)) {
        sources.set(this, { media: false, ended: false });
        this.addEventListener("sourceended", () => {
          sources.get(this)!.ended = true;
          checkEnded();
        });
        // A player that reopens its stream (a seek, an error) isn't done yet.
        this.addEventListener("sourceopen", () => (sources.get(this)!.ended = false));
      }
    } catch {
      // Never break the page's player.
    }
    return sb;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
    try {
      const track = tracks.get(this);
      if (track) {
        const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const init = isInit(view);
        if (init) track.init = copy(data);
        else if (track.init) {
          const src = sources.get(track.source);
          if (src && !src.media) {
            src.media = true;
            fed.push(new WeakRef(track.source));
          }
        }
        if (state === "recording") {
          const bytes = copy(data);
          post({ type: "mse-data", track: track.id, mime: track.mime, init, bytes }, [bytes]);
        } else if (state === "undecided") {
          const bytes = copy(data);
          queue.push({ track: track.id, mime: track.mime, init, bytes });
          queued += bytes.byteLength;
          if (queued > MAX_QUEUED_BYTES) idle();
        }
      }
    } catch {
      // Never break the page's player.
    }
    return appendBuffer.call(this, data);
  };
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || e.data?.[TAG] !== "control") return;
  if (e.data.type === "start" && state !== "recording") {
    if (state === "undecided") {
      // Armed before the page loaded: everything the player appended so far.
      for (const m of queue) post({ type: "mse-data", ...m }, [m.bytes]);
      if (endedEarly && allEnded()) setTimeout(() => post({ type: "mse-ended" }));
    } else {
      // Started mid-stream: what's appended from now needs the init segments seen before.
      replayInits();
    }
    queue = [];
    queued = 0;
    state = "recording";
  } else if (e.data.type === "stop" || e.data.type === "idle") {
    idle();
  }
});

/** Sends each known track's latest init segment, so recording can start mid-stream. */
function replayInits(): void {
  for (const sb of knownBuffers()) {
    const track = tracks.get(sb);
    if (!track?.init) continue;
    const bytes = track.init.slice(0);
    post({ type: "mse-data", track: track.id, mime: track.mime, init: true, bytes }, [bytes]);
  }
}

function knownBuffers(): SourceBuffer[] {
  return buffers.flatMap((r) => {
    const sb = r.deref();
    return sb ? [sb] : [];
  });
}

export {};
