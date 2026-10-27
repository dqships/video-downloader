// The house ad in the popup and side panel. When the service worker has
// queued one (shared/ads.ts), it takes the place of the strip and foot and
// counts down; Close appears when the time is up. The countdown only runs
// while the ad is on screen: closing the popup or opening settings pauses
// it, and the time left is kept in storage so it picks up where it stopped.
// Everything shown comes from the ad list as text, never as HTML.

import { adClosed, adWatched, emptyAdState, type AdFeed, type AdState } from "../shared/ads";
import { upgradeLink } from "../shared/license";
import { storageKeys } from "../shared/messages";

const TICK_MS = 250;
/** How often the time watched is written back to storage. */
const SAVE_MS = 1000;

export function bindAd(doc: Document): void {
  const section = doc.querySelector<HTMLElement>("#ad")!;
  const views = [...doc.querySelectorAll<HTMLElement>("#settings-view, #saved-view")];
  const icon = section.querySelector<HTMLElement>(".vz-ad-icon")!;
  const name = section.querySelector<HTMLElement>(".vz-ad-name")!;
  const line = section.querySelector<HTMLElement>(".vz-ad-line")!;
  const cta = section.querySelector<HTMLAnchorElement>(".vz-ad-cta")!;
  const count = section.querySelector<HTMLElement>(".vz-ad-count")!;
  const perf = section.querySelector<HTMLElement>(".vz-ad-perf")!;
  const remove = section.querySelector<HTMLAnchorElement>(".vz-ad-remove")!;
  const close = section.querySelector<HTMLButtonElement>(".vz-ad-close")!;

  let state: AdState = emptyAdState;
  let total = 15_000;
  let upgradeUrl = "";
  /** Watched since the last write to storage. */
  let unsaved = 0;
  let lastTick = 0;
  let sinceSave = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const visible = () => Boolean(state.due) && !state.adFree && views.every((v) => v.hidden);
  const remaining = () => Math.max(0, (state.due?.remainingMs ?? 0) - unsaved);

  async function save(): Promise<void> {
    if (!unsaved) return;
    const elapsed = unsaved;
    unsaved = 0;
    state = adWatched(state, elapsed);
    const stored = await read();
    await chrome.storage.local.set({ [storageKeys.ads]: adWatched(stored, elapsed) });
  }

  async function read(): Promise<AdState> {
    const data = await chrome.storage.local.get([storageKeys.ads, storageKeys.adFeed]);
    const feed = (data[storageKeys.adFeed] as { feed: AdFeed } | undefined)?.feed;
    total = (feed?.schedule.seconds ?? 15) * 1000;
    upgradeUrl = feed?.upgradeUrl ?? "";
    return { ...emptyAdState, ...(data[storageKeys.ads] as Partial<AdState> | undefined) };
  }

  function paint(): void {
    const left = remaining();
    const seconds = Math.ceil(left / 1000);
    count.textContent = String(seconds).padStart(2, "0");
    const done = total ? Math.min(1, 1 - left / total) : 1;
    perf.style.setProperty("--vz-perf-value", `${done * 100}%`);
    perf.setAttribute("aria-valuenow", String(Math.round(done * 100)));
    close.disabled = left > 0;
    close.textContent = left > 0 ? `Close in ${seconds}` : "Close";
  }

  function tick(): void {
    const now = performance.now();
    const elapsed = now - lastTick;
    lastTick = now;
    if (!visible() || doc.visibilityState !== "visible") return;
    unsaved = Math.min(unsaved + elapsed, state.due?.remainingMs ?? 0);
    sinceSave += elapsed;
    paint();
    if (sinceSave >= SAVE_MS || remaining() === 0) {
      sinceSave = 0;
      void save();
    }
  }

  function render(): void {
    const show = visible();
    section.hidden = !show;
    doc.body.classList.toggle("has-ad", show);
    if (!show || !state.due) {
      clearInterval(timer);
      timer = undefined;
      return;
    }
    const { ad } = state.due;
    if (section.dataset.id !== ad.id) {
      section.dataset.id = ad.id;
      name.textContent = ad.name;
      line.textContent = ad.line;
      cta.textContent = ad.cta;
      cta.href = ad.url;
      if (ad.image) {
        icon.textContent = "";
        icon.style.backgroundImage = `url(${JSON.stringify(ad.image)})`;
      } else {
        icon.style.backgroundImage = "";
        icon.textContent = ad.name.slice(0, 1).toUpperCase();
      }
    }
    remove.hidden = !upgradeUrl;
    if (upgradeUrl) void upgradeLink(upgradeUrl).then((href) => (remove.href = href));
    paint();
    if (!timer) {
      lastTick = performance.now();
      timer = setInterval(tick, TICK_MS);
    }
  }

  close.addEventListener("click", async () => {
    await save();
    const stored = await read();
    await chrome.storage.local.set({ [storageKeys.ads]: adClosed(stored, Date.now()) });
  });

  // Settings and saved files swap the strip out; the ad steps aside with it and comes back after.
  const observer = new MutationObserver(render);
  for (const v of views) observer.observe(v, { attributes: true, attributeFilter: ["hidden"] });
  doc.addEventListener("visibilitychange", () => {
    lastTick = performance.now();
    if (doc.visibilityState === "hidden") void save();
  });
  chrome.storage.local.onChanged.addListener(async (changes) => {
    if (!(storageKeys.ads in changes) && !(storageKeys.adFeed in changes)) return;
    state = await read();
    render();
  });

  void read().then((s) => {
    state = s;
    render();
  });
}
