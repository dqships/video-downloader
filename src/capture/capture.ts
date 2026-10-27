// The capture page: an invisible extension frame inside the page being
// recorded. It receives each buffer the player appends (through a port from
// the content script), keeps them per track, and when the recording stops or
// the video ends, joins them into one file and saves it.
//
// A track that changes quality mid-way starts a new run (a new init segment);
// the runs are joined where the codec allows it (mux.ts).

import type { FromOffscreenEnvelope, FromWorker } from "../shared/worker-protocol";
import { muxCaptured } from "./mux";

interface Run {
  parts: ArrayBuffer[];
  bytes: number;
  media: number;
}

// Any page could load this frame, so the job id arrives privately from the
// content script, and the job (with the name it saves under) comes from the
// service worker, which hands each recording out once.
type Claim = { ok: true; filename: string; saveAs: boolean } | { ok: false; error: string };
let jobId = "";
let job: Promise<Claim> = Promise.resolve({ ok: false, error: "No recording was started" });
const tracks = new Map<number, Run[]>();
let total = 0;
let lastProgress = 0;
let finishing = false;
let port: MessagePort | undefined;

const toSw = (message: FromWorker | { type: "saved"; jobId: string; downloadId: number; filename: string; bytes: number }) =>
  chrome.runtime.sendMessage({ target: "service-worker", message } as FromOffscreenEnvelope).catch(() => {});

function add(track: number, init: boolean, bytes: ArrayBuffer): void {
  const runs = tracks.get(track) ?? [];
  tracks.set(track, runs);
  let run = runs.at(-1);
  if (init) {
    // A new init segment opens a new run, unless the open one has no media yet.
    if (!run || run.media > 0) runs.push((run = { parts: [], bytes: 0, media: 0 }));
    else {
      total -= run.bytes;
      run.parts = [];
      run.bytes = 0;
    }
  } else if (!run) {
    return; // media before any init segment can't be read
  } else {
    run.media++;
  }
  run!.parts.push(bytes);
  run!.bytes += bytes.byteLength;
  total += bytes.byteLength;
  const now = Date.now();
  if (now - lastProgress > 500) {
    lastProgress = now;
    void toSw({ type: "progress", jobId, bytes: total });
  }
}

async function finish(): Promise<void> {
  if (finishing) return;
  finishing = true;
  try {
    const streams = [...tracks.values()].map((runs) => runs.filter((r) => r.media > 0).map((r) => new Blob(r.parts))).filter((runs) => runs.length > 0);
    if (streams.length === 0) throw new Error("Nothing was recorded. Play the video while recording.");
    const claim = await job;
    if (!claim.ok) throw new Error(claim.error);
    const { filename, saveAs } = claim;
    const { blob, ext } = await muxCaptured(streams);
    tracks.clear();
    const name = filename.replace(/\.[a-z0-9]{1,5}$/i, "") + `.${ext}`;
    const url = URL.createObjectURL(blob);
    const downloadId = await chrome.downloads.download({ url, filename: name, saveAs, conflictAction: "uniquify" });
    await toSw({ type: "saved", jobId, downloadId, filename: name, bytes: blob.size });
    // Keep the blob alive until Chrome has the file.
    chrome.downloads.onChanged.addListener((d) => {
      if (d.id === downloadId && (d.state?.current === "complete" || d.state?.current === "interrupted")) {
        URL.revokeObjectURL(url);
        port?.postMessage({ type: "close" });
      }
    });
  } catch (err) {
    await toSw({ type: "error", jobId, message: err instanceof Error ? err.message : String(err) });
    port?.postMessage({ type: "close" });
  }
}

window.addEventListener("message", async (e: MessageEvent) => {
  if (port || jobId || typeof e.data?.vidzillaCapture !== "string" || !e.ports[0]) return;
  jobId = e.data.vidzillaCapture;
  job = chrome.runtime.sendMessage({ kind: "capture-job", payload: { jobId } }) as Promise<Claim>;
  if (!(await job).ok) return;
  port = e.ports[0];
  port.onmessage = (m) => {
    const msg = m.data as { type: string; track?: number; init?: boolean; bytes?: ArrayBuffer };
    if (msg.type === "data" && !finishing && typeof msg.track === "number" && msg.bytes instanceof ArrayBuffer) add(msg.track, !!msg.init, msg.bytes);
    else if (msg.type === "stop" || msg.type === "ended") void finish();
    else if (msg.type === "cancel") tracks.clear();
  };
});
