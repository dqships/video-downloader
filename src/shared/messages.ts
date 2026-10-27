// One envelope for every runtime message. The UI only sends commands; it reads
// state from chrome.storage and never waits on the service worker for data.

export type Command =
  | { kind: "download"; payload: { tabId: number; mediaId: string; filename?: string; variantId?: string; subtitleId?: string } }
  | { kind: "cancel"; payload: { jobId: string } }
  /** Ends a live recording and saves it. */
  | { kind: "stop"; payload: { jobId: string } }
  | { kind: "clear-tab"; payload: { tabId: number } }
  /** From the content script: the page gave a media element DRM keys. */
  | { kind: "page-drm"; payload: { keySystem: string } };

export type CommandResult = { ok: true; jobId?: string } | { ok: false; error: string };

export const storageKeys = {
  tab: (tabId: number) => `tab:${tabId}`,
  jobs: "jobs",
  settings: "settings",
  history: "history",
} as const;

export function sendCommand(cmd: Command): Promise<CommandResult> {
  return chrome.runtime.sendMessage(cmd);
}
