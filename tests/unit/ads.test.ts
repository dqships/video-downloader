import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adBeforeDownload, adClosed, adWatched, countSave, defaultSchedule, emptyAdState, parseFeed, type AdFeed, type AdState } from "../../src/shared/ads";

const ad = (id: string) => ({ id, name: id.toUpperCase(), line: `What ${id} does.`, cta: `Get ${id}`, url: `https://example.com/${id}` });
const feed: AdFeed = { schedule: defaultSchedule, upgradeUrl: "", ads: [ad("one"), ad("two")] };
const HOUR = 3_600_000;
/** A real clock time: shownAt 0 means "never shown". */
const T0 = 1_700_000_000_000;

/** Downloads `n` times, watching any ad that comes up first in full. Returns which downloads had one. */
function downloads(n: number, start: AdState = emptyAdState, now = 0): { state: AdState; adsAt: number[] } {
  let state = start;
  const adsAt: number[] = [];
  for (let i = 1; i <= n; i++) {
    const t = T0 + now + i * 24 * HOUR;
    state = adBeforeDownload(state, feed, t);
    if (state.due) {
      adsAt.push(state.saved + 1);
      state = adClosed(adWatched(state, 15_000), t);
    }
    state = countSave(state);
  }
  return { state, adsAt };
}

describe("parseFeed", () => {
  it("keeps valid ads and drops broken, inactive, duplicate or non-https ones", () => {
    const parsed = parseFeed({
      upgradeUrl: "https://example.com/upgrade",
      ads: [
        ad("ok"),
        { ...ad("off"), active: false },
        { ...ad("http"), url: "http://example.com" },
        { ...ad("script"), url: "javascript:alert(1)" },
        { ...ad("noline"), line: "" },
        { ...ad("long"), name: "x".repeat(41) },
        ad("ok"),
        { ...ad("img"), image: "https://example.com/i.png" },
        { ...ad("badimg"), image: "data:image/png;base64,AAAA" },
        "nope",
      ],
    });
    expect(parsed.ads.map((a) => a.id)).toEqual(["ok", "img", "badimg"]);
    expect(parsed.ads[1]!.image).toBe("https://example.com/i.png");
    expect(parsed.ads[2]!.image).toBeUndefined();
    expect(parsed.upgradeUrl).toBe("https://example.com/upgrade");
  });

  it("clamps the schedule so a typo can't make ads constant or longer than 15 s", () => {
    const { schedule } = parseFeed({ schedule: { firstAfter: 0, every: 1, minHours: -5, seconds: 90 } });
    expect(schedule).toEqual({ firstAfter: 1, every: 2, minHours: 0, seconds: 15 });
    expect(parseFeed(null).schedule).toEqual(defaultSchedule);
  });

  it("reads the site's ads.json without dropping an active ad", () => {
    const raw = JSON.parse(readFileSync(new URL("../../site/ads.json", import.meta.url), "utf8"));
    const active = raw.ads.filter((a: { active?: boolean }) => a.active !== false).map((a: { id: string }) => a.id);
    expect(parseFeed(raw).ads.map((a) => a.id)).toEqual(active);
    expect(active.length).toBeGreaterThan(0);
  });
});

describe("ad schedule", () => {
  it("shows the first ad before the 6th download (after 5 saves), then before every 4th", () => {
    expect(downloads(18).adsAt).toEqual([6, 10, 14, 18]);
  });

  it("rotates through the ads", () => {
    let state = adBeforeDownload({ ...emptyAdState, saved: 5 }, feed, T0);
    expect(state.due?.ad.id).toBe("one");
    state = adClosed(adWatched(state, 15_000), T0);
    state = { ...state, sinceAd: 4 };
    state = adBeforeDownload(state, feed, T0 + 10 * HOUR);
    expect(state.due?.ad.id).toBe("two");
  });

  it("waits at least minHours between ads", () => {
    let state = adClosed(adWatched(adBeforeDownload({ ...emptyAdState, saved: 5 }, feed, T0), 15_000), T0);
    for (let i = 0; i < 10; i++) state = countSave(adBeforeDownload(state, feed, T0 + HOUR));
    expect(state.due).toBeUndefined();
    state = adBeforeDownload(state, feed, T0 + 6 * HOUR);
    expect(state.due).toBeDefined();
  });

  it("marks the save an ad came before, so no ask follows it", () => {
    let state = adClosed(adWatched(adBeforeDownload({ ...emptyAdState, saved: 5 }, feed, T0), 15_000), T0);
    expect(state.adThisSave).toBe(true);
    state = countSave(state);
    expect(state.adThisSave).toBe(false);
    expect(state.sinceAd).toBe(1);
  });

  it("keeps an unfinished ad, with the time it has left, for the next download", () => {
    let state = adBeforeDownload({ ...emptyAdState, saved: 5 }, feed, 0);
    state = adWatched(state, 6_000);
    expect(adClosed(state, 0)).toBe(state); // can't move on early
    state = adBeforeDownload(state, feed, HOUR);
    expect(state.due?.remainingMs).toBe(9_000);
    state = adClosed(adWatched(state, 9_000), HOUR);
    expect(state.due).toBeUndefined();
    expect(state.sinceAd).toBe(0);
  });

  it("shows nothing once ads are removed, or with an empty list", () => {
    expect(downloads(20, { ...emptyAdState, adFree: true }).adsAt).toEqual([]);
    expect(adBeforeDownload({ ...emptyAdState, saved: 9 }, { ...feed, ads: [] }, 0).due).toBeUndefined();
    const waiting = adBeforeDownload({ ...emptyAdState, saved: 5 }, feed, 0);
    expect(adBeforeDownload({ ...waiting, adFree: true }, feed, 0).due).toBeUndefined();
  });
});
