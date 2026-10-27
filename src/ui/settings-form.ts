// The settings form, shared by the options page and the settings view inside
// the popup and side panel. Settings save as they change, and the form follows
// changes made from the other surfaces.

import { storageKeys } from "../shared/messages";
import { buildFilename } from "../shared/naming";
import { defaultSettings, loadSettings, type Settings } from "../shared/settings";

export function bindSettingsForm(root: ParentNode): void {
  const form = root.querySelector<HTMLFormElement>(".vz-settings-form")!;
  const example = root.querySelector<HTMLOutputElement>(".vz-settings-example")!;
  const saved = root.querySelector<HTMLElement>(".vz-settings-saved")!;
  const field = <T extends HTMLInputElement>(name: keyof Settings) => form.elements.namedItem(name) as T;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

  const readForm = (): Settings => {
    const maxLength = Math.round(Number(field("maxLength").value));
    return {
      template: field("template").value.trim() || defaultSettings.template,
      maxLength: Number.isFinite(maxLength) ? Math.min(200, Math.max(20, maxLength)) : defaultSettings.maxLength,
      subfolder: field("subfolder").value.trim(),
      saveAs: field("saveAs").checked,
      sidePanel: field("sidePanel").checked,
    };
  };

  const showExample = (s: Settings): void => {
    const name = buildFilename({
      template: s.template,
      maxLength: s.maxLength,
      title: "Northern Lights Over Tromsø",
      pageUrl: "https://www.example.com/watch",
      mediaUrl: "https://cdn.example.com/v/clip.mp4",
      ext: "mp4",
    });
    example.value = s.subfolder ? `${s.subfolder.replace(/[\\/]+$/, "")}/${name}` : name;
  };

  const fill = (s: Settings): void => {
    // Leave the field being typed in alone.
    const set = (name: keyof Settings, value: string) => {
      const input = field(name);
      if (document.activeElement !== input) input.value = value;
    };
    set("template", s.template);
    set("maxLength", String(s.maxLength));
    set("subfolder", s.subfolder);
    field("saveAs").checked = s.saveAs;
    field("sidePanel").checked = s.sidePanel;
    showExample(s);
  };

  form.addEventListener("input", () => showExample(readForm()));
  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("change", async () => {
    const s = readForm();
    showExample(s);
    await chrome.storage.local.set({ [storageKeys.settings]: s });
    saved.textContent = "Saved";
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved.textContent = ""), 1500);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && storageKeys.settings in changes) void loadSettings().then(fill);
  });
  void loadSettings().then(fill);
}
