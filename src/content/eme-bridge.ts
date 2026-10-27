// Isolated-world half of DRM detection: passes the page script's notice on to
// the service worker. Reports once per page, plus once more if a named key
// system follows a bare "encrypted" notice.

let reported: string | undefined;
window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || e.data?.__vidzilla !== "eme") return;
  const keySystem = String(e.data.keySystem ?? "unknown").slice(0, 100);
  if (keySystem === "org.w3.clearkey") return; // Clear Key isn't DRM.
  if (reported && (reported !== "encrypted" || keySystem === "encrypted")) return;
  reported = keySystem;
  chrome.runtime.sendMessage({ kind: "page-drm", payload: { keySystem } }).catch(() => {});
});
