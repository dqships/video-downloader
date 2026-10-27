// One envelope for every runtime message. The UI only sends commands; it reads
// state from chrome.storage and never waits on the service worker for data.

export type Command =
  | { kind: "download"; payload: { tabId: number; mediaId: string; filename?: string; variantId?: string; subtitleId?: string } }
  | { kind: "cancel"; payload: { jobId: string } }
  /** Ends a live recording and saves it. */
  | { kind: "stop"; payload: { jobId: string } }
  | { kind: "clear-tab"; payload: { tabId: number } }
  /** From the content script: the page gave a media element DRM keys. */
  | { kind: "page-drm"; payload: { keySystem: string } }
  /** From the content script: the page's player is fed through Media Source Extensions. */
  | { kind: "page-mse"; payload: { mime: string } }
  /** From the capture page: claim a player recording (once) and learn where to save it. */
  | { kind: "capture-job"; payload: { jobId: string } };

export type CommandResult = { ok: true; jobId?: string; filename?: string; saveAs?: boolean } | { ok: false; error: string };

export const storageKeys = {
  tab: (tabId: number) => `tab:${tabId}`,
  jobs: "jobs",
  settings: "settings",
  history: "history",
  asks: "asks",
} as const;

export function sendCommand(cmd: Command): Promise<CommandResult> {
  return chrome.runtime.sendMessage(cmd);
}
