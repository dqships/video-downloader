// Isolated-world half of player recording. Tells the service worker that the
// page plays through Media Source Extensions, and while a recording runs,
// passes each buffer the page appends to Vidzilla's capture page (an
// extension iframe), which builds the file and saves it.

const TAG = "__vidzilla_mse";
let used = false;
let port: MessagePort | undefined;
let frame: HTMLIFrameElement | undefined;

const control = (type: "start" | "stop" | "idle") => window.postMessage({ [TAG]: "control", type }, "*");

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || e.data?.[TAG] !== true) return;
  const msg = e.data as { type: string; track?: number; mime?: string; init?: boolean; offset?: number; bytes?: ArrayBuffer };
  if (msg.type === "mse-used" && !used) {
    used = true;
    // The answer says whether Record armed this page before it loaded.
    chrome.runtime
      .sendMessage({ kind: "page-mse", payload: { mime: String(msg.mime ?? "").slice(0, 200) } })
      .then((res: { ok: boolean; jobId?: string } | undefined) => (res?.jobId ? startCapture(res.jobId) : control("idle")))
      .catch(() => control("idle"));
  } else if (msg.type === "mse-data" && port && msg.bytes instanceof ArrayBuffer) {
    port.postMessage({ type: "data", track: msg.track, mime: msg.mime, init: !!msg.init, offset: Number(msg.offset) || 0, bytes: msg.bytes }, [msg.bytes]);
  } else if (msg.type === "mse-ended" && port) {
    port.postMessage({ type: "ended" });
  }
});

function finish(): void {
  control("stop");
  port?.close();
  port = undefined;
  frame?.remove();
  frame = undefined;
}

/** Adds the capture frame, hands it the job privately, then tells the page to send buffers. */
function startCapture(jobId: string): void {
  if (frame) return;
  const src = chrome.runtime.getURL("capture.html");
  frame = document.createElement("iframe");
  frame.src = src;
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.addEventListener("load", () => {
    const channel = new MessageChannel();
    port = channel.port1;
    // The capture page says when it has saved (or given up), so the frame can go.
    port.onmessage = (e) => e.data?.type === "close" && finish();
    // Only our own frame can read the job id: the target origin is the extension's.
    frame!.contentWindow!.postMessage({ vidzillaCapture: jobId }, `chrome-extension://${chrome.runtime.id}`, [channel.port2]);
    control("start");
  }, { once: true });
  (document.body ?? document.documentElement).append(frame);
}

chrome.runtime.onMessage.addListener((msg: { kind?: string }) => {
  if (!used) return;
  if (msg.kind === "mse-stop") {
    control("stop");
    port?.postMessage({ type: "stop" });
  } else if (msg.kind === "mse-cancel") {
    port?.postMessage({ type: "cancel" });
    finish();
  }
});

export {};
