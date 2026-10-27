import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adAfterSave, adClosed, adWatched, defaultSchedule, emptyAdState, parseFeed, type AdFeed, type AdState } from "../../src/shared/ads";

const ad = (id: string) => ({ id, name: id.toUpperCase(), line: `What ${id} does.`, cta: `Get ${id}`, url: `https://example.com/${id}` });
const feed: AdFeed = { schedule: defaultSchedule, upgradeUrl: "", ads: [ad("one"), ad("two")] };
const HOUR = 3_600_000;
/** A real clock time: shownAt 0 means "never shown". */
const T0 = 1_700_000_000_000;

/** Saves `n` times, closing any ad that comes up after watching it in full. */
function saves(n: number, start: AdState = emptyAdState, now = 0): { state: AdState; adsAt: number[] } {
  let state = start;
  const adsAt: number[] = [];
  for (let i = 1; i <= n; i++) {
    const t = T0 + now + i * 24 * HOUR;
    state = adAfterSave(state, feed, t, false);
    if (state.due) {
      adsAt.push(state.saved);
      state = adClosed(adWatched(state, 15_000), t);
    }
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
  it("shows the first ad on the 5th save, then every 4th", () => {
    expect(saves(18).adsAt).toEqual([5, 9, 13, 17]);
  });

  it("rotates through the ads", () => {
    let state = adAfterSave({ ...emptyAdState, saved: 4 }, feed, T0, false);
    expect(state.due?.ad.id).toBe("one");
    state = adClosed(adWatched(state, 15_000), T0);
    state = { ...state, sinceAd: 3 };
    state = adAfterSave(state, feed, T0 + 10 * HOUR, false);
    expect(state.due?.ad.id).toBe("two");
  });

  it("waits at least minHours between ads", () => {
    let state = adClosed(adWatched(adAfterSave({ ...emptyAdState, saved: 4 }, feed, T0, false), 15_000), T0);
    for (let i = 0; i < 10; i++) state = adAfterSave(state, feed, T0 + HOUR, false);
    expect(state.due).toBeUndefined();
    state = adAfterSave(state, feed, T0 + 6 * HOUR, false);
    expect(state.due).toBeDefined();
  });

  it("never queues an ad on a save that brings up the review or share prompt, and drops a waiting one", () => {
    const waiting = adAfterSave({ ...emptyAdState, saved: 4 }, feed, 0, false);
    expect(waiting.due).toBeDefined();
    const withAsk = adAfterSave(waiting, feed, HOUR, true);
    expect(withAsk.due).toBeUndefined();
    expect(adAfterSave({ ...emptyAdState, saved: 4 }, feed, 0, true).due).toBeUndefined();
  });

  it("keeps an unwatched ad waiting across saves, with the time it has left", () => {
    let state = adAfterSave({ ...emptyAdState, saved: 4 }, feed, 0, false);
    state = adWatched(state, 6_000);
    expect(adClosed(state, 0)).toBe(state); // can't close early
    state = adAfterSave(state, feed, HOUR, false);
    expect(state.due?.remainingMs).toBe(9_000);
    state = adClosed(adWatched(state, 9_000), HOUR);
    expect(state.due).toBeUndefined();
    expect(state.sinceAd).toBe(0);
  });

  it("shows nothing once ads are removed, or with an empty list", () => {
    expect(saves(20, { ...emptyAdState, adFree: true }).adsAt).toEqual([]);
    expect(adAfterSave({ ...emptyAdState, saved: 9 }, { ...feed, ads: [] }, 0, false).due).toBeUndefined();
  });
});
