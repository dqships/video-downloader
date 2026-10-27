import { describe, expect, it } from "vitest";
import { dailymotionId, pageCandidates, type PageScan } from "../../src/shared/page-media";

const scan = (over: Partial<PageScan>): PageScan => ({ pageUrl: "https://news.example/story/1", jsonLd: [], metas: [], videoSrcs: [], ...over });

describe("pageCandidates", () => {
  it("reads VideoObjects from JSON-LD, nested in @graph and articles", () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "NewsArticle", video: { "@type": "VideoObject", name: " Storm coverage ", contentUrl: "/media/storm.mp4", thumbnailUrl: ["https://img.example/s.jpg"], duration: "PT1M30S" } },
        { "@type": ["VideoObject"], name: "Embed only", embedUrl: "https://player.example/e/1" },
      ],
    });
    expect(pageCandidates(scan({ jsonLd: [ld, "{ broken"] }))).toEqual([
      { url: "https://news.example/media/storm.mp4", title: "Storm coverage", thumbnail: "https://img.example/s.jpg", durationSec: 90, mime: undefined },
    ]);
  });

  it("reads og:video with its type and skips player pages", () => {
    const metas = [
      { key: "og:title", value: "Clip" },
      { key: "og:image", value: "/poster.jpg" },
      { key: "og:video", value: "https://player.example/embed/9" },
      { key: "og:video:type", value: "text/html" },
      { key: "og:video:secure_url", value: "https://cdn.example/9/master.m3u8" },
      { key: "og:video:type", value: "application/x-mpegURL" },
      { key: "twitter:player:stream", value: "https://cdn.example/9.mp4" },
    ];
    expect(pageCandidates(scan({ metas }))).toEqual([
      { url: "https://cdn.example/9/master.m3u8", mime: "application/x-mpegurl" },
      { url: "https://cdn.example/9.mp4", mime: undefined },
    ]);
  });

  it("keeps the richest first description and fills gaps from later ones", () => {
    const ld = JSON.stringify({ "@type": "VideoObject", contentUrl: "https://cdn.example/a.mp4", duration: 12 });
    const out = pageCandidates(
      scan({ jsonLd: [ld], metas: [{ key: "og:title", value: "Page title" }], videoSrcs: [{ url: "https://cdn.example/a.mp4", type: "video/mp4" }, { url: "javascript:x" }] }),
    );
    expect(out).toEqual([{ url: "https://cdn.example/a.mp4", durationSec: 12, title: undefined, thumbnail: undefined, mime: "video/mp4" }]);
  });
});

describe("dailymotionId", () => {
  it("reads the video from watch pages, embeds and the player", () => {
    expect(dailymotionId("https://www.dailymotion.com/video/xbrjsa2")).toBe("xbrjsa2");
    expect(dailymotionId("https://www.dailymotion.com/embed/video/x8abc12?autoplay=1")).toBe("x8abc12");
    expect(dailymotionId("https://geo.dailymotion.com/player/xtv3w.html?video=x7tgad0")).toBe("x7tgad0");
  });

  it("ignores other pages and other sites", () => {
    expect(dailymotionId("https://www.dailymotion.com/")).toBeUndefined();
    expect(dailymotionId("https://geo.dailymotion.com/player/xtv3w.html?")).toBeUndefined();
    expect(dailymotionId("https://notdailymotion.com/video/xbrjsa2")).toBeUndefined();
    expect(dailymotionId("https://example.com/video/xbrjsa2")).toBeUndefined();
  });
});
