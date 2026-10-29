// House ads: short ads for the maker's other apps, shown before some downloads
// start: the download waits until the ad has run, then goes ahead.
// The list is data published on the website (site/ads.json), so new ads go
// live without an extension release. It holds text, links and an optional
// image address, never code: everything is checked here and rendered with
// textContent. Rules are pure functions so they can be tested; the service
// worker (src/sw/ads.ts) and the popup (src/ui/ads-view.ts) apply them.

export const ADS_FEED_URL = "https://vidzilla.followusai.com/ads.json";

export interface Ad {
  id: string;
  /** The app's name, shown large. */
  name: string;
  /** One line under the name: what the app does. */
  line: string;
  /** The button label, such as "Get WebToMarkdown". */
  cta: string;
  /** Where the button goes: the app's store page or site. */
  url: string;
  /** Optional square icon (https). */
  image?: string;
}

export interface AdSchedule {
  /** Saves before the first ad ever shows (it comes before the next download). */
  firstAfter: number;
  /** Saves between one ad and the next. */
  every: number;
  /** Hours that must pass between two ads, however many saves. */
  minHours: number;
  /** How long an ad stays up before it can be closed. */
  seconds: number;
}

export interface AdFeed {
  schedule: AdSchedule;
  /** The page that sells the ad-free upgrade; empty hides "Remove ads". */
  upgradeUrl: string;
  ads: Ad[];
}

export interface AdState {
  /** Completed saves counted so far. */
  saved: number;
  /** Saves since the last ad was closed. */
  sinceAd: number;
  /** When the last ad was closed (ms). */
  shownAt: number;
  /** Which ad in the feed is next, round robin. */
  next: number;
  /** The ad waiting to be watched, with the time it still has to run. */
  due?: { ad: Ad; remainingMs: number };
  /** An ad ran before the download now under way (so no ask comes after it). */
  adThisSave?: boolean;
  /** Paid to remove ads. */
  adFree: boolean;
}

export const defaultSchedule: AdSchedule = { firstAfter: 5, every: 4, minHours: 6, seconds: 15 };

export const emptyAdState: AdState = { saved: 0, sinceAd: 0, shownAt: 0, next: 0, adFree: false };

const LIMITS = { id: 40, name: 40, line: 120, cta: 32, url: 500 } as const;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean && clean.length <= max ? clean : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const raw = text(value, LIMITS.url);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function count(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/**
 * Reads ads.json. Anything malformed is dropped rather than shown: an ad
 * without a name, line, button or https link is skipped, and so is one marked
 * "active": false. The schedule is clamped so a typo can't make ads constant
 * or endless (never more often than every 2 saves, never longer than 15 s).
 */
export function parseFeed(json: unknown): AdFeed {
  const root = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const s = (root.schedule && typeof root.schedule === "object" ? root.schedule : {}) as Record<string, unknown>;
  const schedule: AdSchedule = {
    firstAfter: count(s.firstAfter, defaultSchedule.firstAfter, 1, 100),
    every: count(s.every, defaultSchedule.every, 2, 100),
    minHours: count(s.minHours, defaultSchedule.minHours, 0, 24 * 30),
    seconds: count(s.seconds, defaultSchedule.seconds, 0, 15),
  };
  const seen = new Set<string>();
  const ads: Ad[] = [];
  for (const entry of Array.isArray(root.ads) ? root.ads : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.active === false) continue;
    const ad = {
      id: text(e.id, LIMITS.id),
      name: text(e.name, LIMITS.name),
      line: text(e.line, LIMITS.line),
      cta: text(e.cta, LIMITS.cta),
      url: httpsUrl(e.url),
      image: httpsUrl(e.image),
    };
    if (!ad.id || !ad.name || !ad.line || !ad.cta || !ad.url || seen.has(ad.id)) continue;
    seen.add(ad.id);
    ads.push(ad.image ? (ad as Ad) : { id: ad.id, name: ad.name, line: ad.line, cta: ad.cta, url: ad.url });
  }
  return { schedule, upgradeUrl: httpsUrl(root.upgradeUrl) ?? "", ads };
}

/**
 * A download is about to start: queues an ad first when the schedule says
 * one is due (enough saves since the last ad, and enough hours). An ad left
 * unfinished, its popup closed early, comes back with the time it had left.
 */
export function adBeforeDownload(state: AdState, feed: AdFeed, now: number): AdState {
  if (state.adFree) return state.due ? { ...state, due: undefined } : state;
  if (state.due) return state;
  const { schedule, ads } = feed;
  if (ads.length === 0) return state;
  const firstAd = state.shownAt === 0;
  const enough = firstAd ? state.saved >= schedule.firstAfter : state.sinceAd >= schedule.every;
  const rested = firstAd || now - state.shownAt >= schedule.minHours * 3_600_000;
  if (!enough || !rested) return state;
  const ad = ads[state.next % ads.length]!;
  return { ...state, due: { ad, remainingMs: schedule.seconds * 1000 } };
}

/** A download finished: one more save toward the next ad. */
export function countSave(state: AdState): AdState {
  return { ...state, saved: state.saved + 1, sinceAd: state.sinceAd + 1, adThisSave: false };
}

/** Time spent looking at the ad counts down; closing the popup pauses it. */
export function adWatched(state: AdState, elapsedMs: number): AdState {
  if (!state.due) return state;
  return { ...state, due: { ...state.due, remainingMs: Math.max(0, state.due.remainingMs - elapsedMs) } };
}

/** Moving on (to the download) is only possible once the countdown has run out. */
export function adClosed(state: AdState, now: number): AdState {
  if (!state.due || state.due.remainingMs > 0) return state;
  return { ...state, due: undefined, shownAt: now, sinceAd: 0, next: state.next + 1, adThisSave: true };
}
