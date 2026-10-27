// Keeps the toolbar button opening what the user chose, popup or side panel,
// across restarts and changes made from settings.

import { storageKeys } from "../shared/messages";
import { applyOpenMode } from "../shared/open-mode";
import { loadSettings } from "../shared/settings";

export function watchSidePanelSetting(): void {
  void loadSettings().then((s) => applyOpenMode(s.sidePanel));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && storageKeys.settings in changes) void loadSettings().then((s) => applyOpenMode(s.sidePanel));
  });
}
