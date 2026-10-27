import { afterEach, describe, expect, it, vi } from "vitest";
import { enrich, xMediaKey } from "../../src/sw/sites";
import type { MediaItem } from "../../src/shared/types";

const clip = (height: number) =>
  `https://d1ndex63qxojbr.cloudfront.net/nauth/abc-123/landscape/h264/${height}/index.mp4?token=%7B%22clip_uri%22%3A1%7D&sig=ff`;

const item = (url: string): MediaItem => ({
  id: "1", type: "http", url, tabId: 1, pageUrl: "https://clips.twitch.tv/Slug", mime: "binary/octet-stream", ext: "mp4",
  supportsRanges: true, sentHeaders: {}, hasDrm: false, detectedAt: 0, sourceKind: "sniffer",
});

afterEach(() => vi.unstubAllGlobals());

describe("Twitch clips", () => {
  it("offers every height the CDN has for the clip, best first", async () => {
    const sizes: Record<string, number> = { "1080": 19_974_271, "720": 8_475_809, "360": 2_582_883 };
    vi.stubGlobal("fetch", async (url: string) => {
      const h = /h264\/(\d+)\//.exec(url)![1]!;
      return sizes[h]
        ? new Response("x", { status: 206, headers: { "content-range": `bytes 0-0/${sizes[h]}` } })
        : new Response("", { status: 404 });
    });
    const { variants } = await enrich(item(clip(360)));
    expect(variants?.map((v) => [v.id, v.url, v.sizeBytes])).toEqual([
      ["1080", clip(1080), 19_974_271],
      ["720", clip(720), 8_475_809],
      ["360", clip(360), 2_582_883],
    ]);
    expect(variants?.[0]?.label).toMatch(/^1080p · /);
  });

  it("leaves other files alone", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("no requests expected");
    });
    expect(await enrich(item("https://cdn.example/360/index.mp4"))).toEqual({});
  });
});

describe("xMediaKey", () => {
  it.each([
    ["https://video.twimg.com/amplify_video/1849/pl/avc1/720x1280/a.m3u8", "1849"],
    ["https://video.twimg.com/ext_tw_video/1850/pu/pl/b.m3u8?tag=12", "1850"],
    ["https://video.twimg.com/tweet_video/GaBc-1.mp4", "GaBc-1"],
    ["https://video.example/amplify_video/1/pl.m3u8", undefined],
  ])("%s", (url, key) => expect(xMediaKey(url)).toBe(key));
});
