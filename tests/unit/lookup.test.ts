import { describe, expect, it } from "vitest";
import { isYouTube, parseLink } from "../../src/web/lookup";

describe("parseLink", () => {
  it("adds https to a bare host", () => {
    expect(parseLink(" example.com/clip.mp4 ")?.href).toBe("https://example.com/clip.mp4");
  });
  it("keeps http and https links", () => {
    expect(parseLink("http://cdn.example.com/a.m3u8?x=1")?.href).toBe("http://cdn.example.com/a.m3u8?x=1");
  });
  it("refuses text, other schemes and dotless hosts", () => {
    expect(parseLink("not a link")).toBeNull();
    expect(parseLink("javascript:alert(1)")).toBeNull();
    expect(parseLink("ftp://example.com/a.mp4")).toBeNull();
    expect(parseLink("clip")).toBeNull();
    expect(parseLink("")).toBeNull();
  });
});

describe("isYouTube", () => {
  it("matches YouTube hosts and subdomains only", () => {
    expect(isYouTube(new URL("https://www.youtube.com/watch?v=x"))).toBe(true);
    expect(isYouTube(new URL("https://youtu.be/x"))).toBe(true);
    expect(isYouTube(new URL("https://music.youtube.com/x"))).toBe(true);
    expect(isYouTube(new URL("https://notyoutube.com/x"))).toBe(false);
  });
});
