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
