// Offscreen document. MV3 service workers cannot start Web Workers, so this
// page exists only to host the download worker and relay its messages.

import type { FromOffscreenEnvelope, FromWorker, ToOffscreenEnvelope } from "../shared/worker-protocol";

const worker = new Worker("worker.js", { type: "module" });

async function relay(message: FromWorker, attempt = 0): Promise<void> {
  const envelope: FromOffscreenEnvelope = { target: "service-worker", message };
  try {
    await chrome.runtime.sendMessage(envelope);
  } catch {
    // Progress can be dropped; a lost "done" or "error" would hang the job.
    if (message.type !== "progress" && attempt < 10) {
      setTimeout(() => void relay(message, attempt + 1), 1000);
    }
  }
}

worker.onmessage = (e: MessageEvent<FromWorker>) => void relay(e.data);

chrome.runtime.onMessage.addListener((msg: ToOffscreenEnvelope, _sender, respond) => {
  if (msg?.target !== "offscreen") return;
  worker.postMessage(msg.message);
  respond(true);
});
