// Isolated-world half of DRM detection: passes the page script's notice on to
// the service worker, once per page.

let reported = false;
window.addEventListener("message", (e: MessageEvent) => {
  if (reported || e.source !== window || e.data?.__vidzilla !== "eme") return;
  const keySystem = String(e.data.keySystem ?? "unknown").slice(0, 100);
  if (keySystem === "org.w3.clearkey") return; // Clear Key isn't DRM.
  reported = true;
  chrome.runtime.sendMessage({ kind: "page-drm", payload: { keySystem } }).catch(() => {});
});
