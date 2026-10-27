// The toolbar button opens either the popup or the side panel, as set in
// settings. Chrome only opens the panel on click when the action has no popup.

import { storageKeys } from "../shared/messages";
import { loadSettings } from "../shared/settings";

async function apply(): Promise<void> {
  const { sidePanel } = await loadSettings();
  await chrome.action.setPopup({ popup: sidePanel ? "" : "popup.html" });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidePanel }).catch(() => {});
}

export function watchSidePanelSetting(): void {
  void apply();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && storageKeys.settings in changes) void apply();
  });
}
