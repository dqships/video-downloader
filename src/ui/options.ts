// Options page: saving settings and the list of saved files. Settings save as
// they change; the history list follows storage, so downloads that finish
// while the page is open appear on their own.

import { formatBytes } from "../shared/format";
import { loadHistory, removeHistory } from "../shared/history";
import { storageKeys } from "../shared/messages";
import { buildFilename } from "../shared/naming";
import { defaultSettings, loadSettings, type Settings } from "../shared/settings";
import type { HistoryEntry } from "../shared/types";
import { icons } from "./icons";

const form = document.querySelector<HTMLFormElement>("#settings")!;
const example = document.querySelector<HTMLOutputElement>("#example")!;
const saved = document.querySelector<HTMLElement>("#saved")!;
const list = document.querySelector<HTMLOListElement>("#history")!;
const empty = document.querySelector<HTMLElement>("#history-empty")!;
const rowTemplate = document.querySelector<HTMLTemplateElement>("#history-row")!;

const field = <T extends HTMLInputElement>(name: keyof Settings) => form.elements.namedItem(name) as T;
let savedTimer: ReturnType<typeof setTimeout> | undefined;

function readForm(): Settings {
  const maxLength = Math.round(Number(field("maxLength").value));
  return {
    template: field("template").value.trim() || defaultSettings.template,
    maxLength: Number.isFinite(maxLength) ? Math.min(200, Math.max(20, maxLength)) : defaultSettings.maxLength,
    subfolder: field("subfolder").value.trim(),
    saveAs: field("saveAs").checked,
  };
}

function showExample(s: Settings): void {
  const name = buildFilename({
    template: s.template,
    maxLength: s.maxLength,
    title: "Northern Lights Over Tromsø",
    pageUrl: "https://www.example.com/watch",
    mediaUrl: "https://cdn.example.com/v/clip.mp4",
    ext: "mp4",
  });
  example.value = s.subfolder ? `${s.subfolder.replace(/[\\/]+$/, "")}/${name}` : name;
}

async function save(): Promise<void> {
  const s = readForm();
  showExample(s);
  await chrome.storage.local.set({ [storageKeys.settings]: s });
  saved.textContent = "Saved";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.textContent = ""), 1500);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderHistory(entries: HistoryEntry[], missing: Set<number>): void {
  empty.hidden = entries.length > 0;
  document.querySelector<HTMLButtonElement>("#clear")!.hidden = entries.length === 0;
  list.replaceChildren(
    ...entries.map((e) => {
      const row = rowTemplate.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
      const thumb = row.querySelector<HTMLElement>(".vz-thumb")!;
      if (e.thumbnail) thumb.style.backgroundImage = `url(${JSON.stringify(e.thumbnail)})`;
      else thumb.innerHTML = /\.(m4a|mp3|ogg|opus|flac|wav|aac|weba)$/i.test(e.filename) ? icons.waveform : icons.film;
      const file = row.querySelector<HTMLElement>(".vz-history-file")!;
      file.textContent = e.filename;
      file.title = e.savedPath ?? e.filename;
      row.querySelector(".vz-history-title")!.textContent = e.title || (e.filename.split("/").at(-1) ?? e.filename);
      const date = new Date(e.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      row.querySelector(".vz-history-meta")!.textContent = [hostOf(e.pageUrl), e.quality, e.bytes ? formatBytes(e.bytes) : "", date]
        .filter(Boolean)
        .join(" · ");
      const gone = e.chromeDownloadId !== undefined && missing.has(e.chromeDownloadId);
      row.classList.toggle("is-missing", gone);
      const show = row.querySelector<HTMLButtonElement>(".show")!;
      show.innerHTML = icons.folder;
      show.setAttribute("aria-label", show.title);
      show.disabled = gone || e.chromeDownloadId === undefined;
      if (gone) show.title = "The file was moved or deleted";
      show.addEventListener("click", () => e.chromeDownloadId !== undefined && chrome.downloads.show(e.chromeDownloadId));
      const page = row.querySelector<HTMLAnchorElement>(".page")!;
      page.innerHTML = icons.external;
      page.setAttribute("aria-label", page.title);
      if (/^https?:/.test(e.pageUrl)) page.href = e.pageUrl;
      else page.hidden = true;
      const remove = row.querySelector<HTMLButtonElement>(".remove")!;
      remove.innerHTML = icons.close;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => void removeHistory(e.id));
      return row;
    }),
  );
}

/** Downloads Chrome no longer has a file for (moved, deleted, or cleared from its list). */
async function missingFiles(entries: HistoryEntry[]): Promise<Set<number>> {
  const ids = entries.flatMap((e) => (e.chromeDownloadId === undefined ? [] : [e.chromeDownloadId]));
  const found = await Promise.all(ids.map((id) => chrome.downloads.search({ id }).then(([d]) => [id, d] as const)));
  return new Set(found.filter(([, d]) => !d || d.exists === false).map(([id]) => id));
}

async function refreshHistory(): Promise<void> {
  const entries = await loadHistory();
  renderHistory(entries, await missingFiles(entries));
}

async function init(): Promise<void> {
  const s = await loadSettings();
  field("template").value = s.template;
  field("maxLength").value = String(s.maxLength);
  field("subfolder").value = s.subfolder;
  field("saveAs").checked = s.saveAs;
  showExample(s);
  form.addEventListener("input", () => showExample(readForm()));
  form.addEventListener("change", () => void save());
  form.addEventListener("submit", (e) => e.preventDefault());
  const clear = document.querySelector<HTMLButtonElement>("#clear")!;
  clear.innerHTML = `${icons.trash}<span>Clear history</span>`;
  clear.addEventListener("click", () => void removeHistory());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[storageKeys.history]) void refreshHistory();
  });
  await refreshHistory();
}

void init();
