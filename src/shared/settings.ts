import { storageKeys } from "./messages";

export interface Settings {
  /** Filename template; see naming.ts for variables. */
  template: string;
  maxLength: number;
  /** Subfolder inside Chrome's download folder; empty for none. */
  subfolder: string;
  saveAs: boolean;
  /** The toolbar button opens the side panel instead of the popup. */
  sidePanel: boolean;
}

export const defaultSettings: Settings = {
  template: "%title",
  maxLength: 80,
  subfolder: "",
  saveAs: false,
  sidePanel: false,
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(storageKeys.settings))[storageKeys.settings] as
    | Partial<Settings>
    | undefined;
  return { ...defaultSettings, ...stored };
}
