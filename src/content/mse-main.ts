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
}

const TAG = "__vidzilla_mse";
const tracks = new WeakMap<SourceBuffer, Track>();
/** SourceBuffers can't be enumerated from a WeakMap; keep a weak list as well. */
const buffers: WeakRef<SourceBuffer>[] = [];
let nextId = 1;
let recording = false;
let announced = false;

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
      tracks.set(sb, { id: nextId++, mime });
      buffers.push(new WeakRef(sb));
      if (!announced) {
        announced = true;
        post({ type: "mse-used", mime });
      }
      this.addEventListener("sourceended", () => recording && post({ type: "mse-ended" }));
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
        if (recording) {
          const bytes = copy(data);
          post({ type: "mse-data", track: track.id, mime: track.mime, init, bytes }, [bytes]);
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
  if (e.data.type === "start" && !recording) {
    recording = true;
    // Media appended from here on needs the init segments seen before.
    replayInits();
  } else if (e.data.type === "stop") {
    recording = false;
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
