import { describe, expect, it } from "vitest";
import { mergeMedia } from "../../src/sw/registry";
import type { MediaItem } from "../../src/shared/types";

const MB = 1024 * 1024;
let n = 0;
const item = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: over.id ?? `m${n++}`,
  type: "http",
  url: "https://cdn.x/a.mp4",
  tabId: 1,
  pageUrl: "https://x/",
  mime: "video/mp4",
  ext: "mp4",
  supportsRanges: false,
  sentHeaders: {},
  hasDrm: false,
  detectedAt: n,
  sourceKind: "sniffer",
  ...over,
});

describe("mergeMedia", () => {
  it("adds new items and ignores exact repeats", () => {
    const a = item({ id: "a" });
    const first = mergeMedia([], a);
    expect(first).toMatchObject({ changed: true });
    expect(mergeMedia(first.list, { ...a, detectedAt: 999 })).toMatchObject({ changed: false });
  });

  it("fills in details learned later", () => {
    const a = item({ id: "a" });
    const { list } = mergeMedia([a], { ...a, sizeBytes: 5 * MB, supportsRanges: true });
    expect(list[0]).toMatchObject({ sizeBytes: 5 * MB, supportsRanges: true, detectedAt: a.detectedAt });
  });

  it("keeps at most 10 per type, dropping the oldest", () => {
    let list: MediaItem[] = [];
    for (let i = 0; i < 12; i++) list = mergeMedia(list, item({ id: `h${i}`, sizeBytes: 50 * MB })).list;
    expect(list.map((m) => m.id)).toEqual(["h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10", "h11"]);
  });

  it("treats small files as DASH segments once a manifest is known", () => {
    let list = mergeMedia([], item({ id: "small", sizeBytes: 2 * MB })).list;
    list = mergeMedia(list, item({ id: "big", sizeBytes: 300 * MB })).list;
    list = mergeMedia(list, item({ id: "mpd", type: "dash" })).list;
    expect(list.map((m) => m.id)).toEqual(["big", "mpd"]);
    expect(mergeMedia(list, item({ id: "small2", sizeBytes: MB })).changed).toBe(false);
  });
});

describe("mergeMedia with HLS masters", () => {
  const master = () =>
    item({ id: "master", type: "hls", url: "https://cdn.x/master.m3u8", childUrls: ["https://cdn.x/360p.m3u8", "https://cdn.x/audio.m3u8"] });
  const child = () => item({ id: "child", type: "hls", url: "https://cdn.x/360p.m3u8" });

  it("hides a quality playlist that arrives after its master", () => {
    const { list } = mergeMedia([master()], child());
    expect(list.map((m) => m.id)).toEqual(["master"]);
  });

  it("removes a quality playlist that arrived before its master", () => {
    const { list } = mergeMedia([child()], master());
    expect(list.map((m) => m.id)).toEqual(["master"]);
  });

  it("keeps an unrelated media playlist", () => {
    const other = item({ id: "other", type: "hls", url: "https://cdn.y/index.m3u8" });
    const { list } = mergeMedia([master()], other);
    expect(list.map((m) => m.id)).toEqual(["master", "other"]);
  });
});

describe("mergeMedia with page-declared media", () => {
  it("takes the player's headers when it requests a URL the page declared", () => {
    const declared = item({ id: "p", sourceKind: "page", title: "Storm", sentHeaders: { referer: "https://x/" } });
    const sniffed = item({ id: "p", sentHeaders: { referer: "https://x/", cookie: "s=1" }, sizeBytes: 9 * MB });
    const { list } = mergeMedia([declared], sniffed);
    expect(list[0]).toMatchObject({ sourceKind: "sniffer", title: "Storm", sizeBytes: 9 * MB, sentHeaders: { cookie: "s=1" } });
  });
});

describe("mergeMedia with player recordings", () => {
  it("lists a player recording only while no stream is found, and drops it when one is", () => {
    const player = item({ id: "p", type: "mse" });
    const hls = item({ id: "h", type: "hls", url: "https://cdn.x/master.m3u8" });
    expect(mergeMedia([hls], player).changed).toBe(false);
    const { list } = mergeMedia([player], hls);
    expect(list.map((m) => m.type)).toEqual(["hls"]);
  });

  it("keeps the player next to a stream none of whose qualities can be saved (WebM-only DASH)", () => {
    const player = item({ id: "p", type: "mse" });
    const webm = item({ id: "d", type: "dash", url: "https://cdn.x/manifest.mpd", variants: [] });
    expect(mergeMedia([webm], player).list.map((m) => m.type)).toEqual(["dash", "mse"]);
    expect(mergeMedia([player], webm).list.map((m) => m.type)).toEqual(["mse", "dash"]);
  });

  it("keeps a player that is being recorded when a stream shows up", () => {
    const player = item({ id: "p", type: "mse", recording: true });
    const hls = item({ id: "h", type: "hls", url: "https://cdn.x/master.m3u8" });
    expect(mergeMedia([player], hls).list.map((m) => m.type)).toEqual(["mse", "hls"]);
    expect(mergeMedia([hls], player).list.map((m) => m.type)).toEqual(["hls", "mse"]);
  });

  it("lists a manifest once when a player fails over to another CDN with the same path", () => {
    const a = item({ id: "a", type: "dash", url: "https://vod-dash-ww-live.akamaized.net/usp/auth/vod/piff_abr_full_hd/p0pj5lg2/pc_hd_abr_v2.mpd?s=1" });
    const b = item({ id: "b", type: "dash", url: "https://vod-dash-ww.live.cf.md.bbci.co.uk/usp/auth/vod/piff_abr_full_hd/p0pj5lg2/pc_hd_abr_v2.mpd?s=2" });
    expect(mergeMedia([a], b).changed).toBe(false);
    const other = item({ id: "c", type: "dash", url: "https://cdn.other.net/manifest.mpd" });
    expect(mergeMedia([item({ id: "d", type: "dash", url: "https://cdn.x.net/manifest.mpd" })], other).changed).toBe(true);
  });
});

describe("mergeMedia when the page plays another video", () => {
  const at = (s: number) => 1_000_000 + s * 1000;
  const dash = (id: string, s: number, over: Partial<MediaItem> = {}) =>
    item({ id, type: "dash", url: `https://cdn.x/${id}/manifest.mpd`, detectedAt: at(s), ...over });

  it("lists only the video playing now when the next one autoplays", () => {
    let list = mergeMedia([], dash("first", 0)).list;
    list = mergeMedia(list, dash("first-audio", 2)).list;
    list = mergeMedia(list, dash("second", 95)).list;
    expect(list.map((m) => m.id)).toEqual(["second"]);
    list = mergeMedia(list, dash("third", 200)).list;
    expect(list.map((m) => m.id)).toEqual(["third"]);
  });

  it("keeps what a player loads together in its first seconds", () => {
    let list = mergeMedia([], dash("video", 0)).list;
    list = mergeMedia(list, item({ id: "file", sizeBytes: 300 * MB, detectedAt: at(4) })).list;
    expect(list.map((m) => m.id)).toEqual(["video", "file"]);
  });

  it("keeps the files a page declares until a second video plays", () => {
    const declared = item({ id: "declared", sourceKind: "page", url: "https://cdn.x/1080.mp4", sizeBytes: 300 * MB, detectedAt: at(0) });
    let list = mergeMedia([declared], dash("first", 60)).list;
    expect(list.map((m) => m.id)).toEqual(["declared", "first"]);
    list = mergeMedia(list, dash("second", 160)).list;
    expect(list.map((m) => m.id)).toEqual(["second"]);
  });

  it("keeps a video that is downloading or being recorded", () => {
    const player = item({ id: "player", type: "mse", recording: true, detectedAt: at(0) });
    let list = mergeMedia([player], dash("first", 1)).list;
    list = mergeMedia(list, dash("second", 90), new Set(["first"])).list;
    expect(list.map((m) => m.id)).toEqual(["player", "first", "second"]);
  });
});
