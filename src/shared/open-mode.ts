// Whether the toolbar button opens the popup or the side panel. Chrome only
// opens the panel on click when the action has no popup, so both are set.

import { storageKeys } from "./messages";
import { loadSettings } from "./settings";

export async function applyOpenMode(sidePanel: boolean): Promise<void> {
  await chrome.action.setPopup({ popup: sidePanel ? "" : "popup.html" });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidePanel }).catch(() => {});
}

/** Saves the choice so it lasts, and applies it now. */
export async function setOpenMode(sidePanel: boolean): Promise<void> {
  await applyOpenMode(sidePanel);
  const settings = await loadSettings();
  if (settings.sidePanel !== sidePanel) await chrome.storage.local.set({ [storageKeys.settings]: { ...settings, sidePanel } });
}
