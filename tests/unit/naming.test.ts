import { describe, expect, it } from "vitest";
import { asciiFilename, buildFilename, expandTemplate, mimeForFilename, nameFromUrl, sanitizeFilename, siteLabel } from "../../src/shared/naming";

describe("siteLabel", () => {
  it("takes the registrable label", () => {
    expect(siteLabel("https://www.youtube.com/watch")).toBe("youtube");
    expect(siteLabel("https://news.bbc.co.uk/x")).toBe("bbc");
    expect(siteLabel("https://player.vimeo.com/")).toBe("vimeo");
    expect(siteLabel("http://localhost:8080/")).toBe("localhost");
  });
});

describe("expandTemplate", () => {
  it("drops an empty variable with its separator", () => {
    expect(expandTemplate("%hostname - %title", { hostname: "", title: "Clip" })).toBe("Clip");
    expect(expandTemplate("%title_%date", { title: "Clip", date: "" })).toBe("Clip");
    expect(expandTemplate("%title (%hostname)", { title: "Clip", hostname: "vimeo" })).toBe("Clip (vimeo)");
  });
  it("leaves unknown variables alone", () => {
    expect(expandTemplate("%title %nope", { title: "A" })).toBe("A %nope");
  });
});

describe("sanitizeFilename", () => {
  it("removes reserved characters and trims dots", () => {
    expect(sanitizeFilename('..My: "Video" / Part 1?.')).toBe("My Video Part 1");
  });
  it("guards Windows reserved names and empty names", () => {
    expect(sanitizeFilename("CON")).toBe("CON_");
    expect(sanitizeFilename("???")).toBe("untitled");
  });
  it("cuts to the character limit and 200 UTF-8 bytes", () => {
    expect(sanitizeFilename("a".repeat(300), 80)).toHaveLength(80);
    const long = sanitizeFilename("é".repeat(150), 500);
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(200);
  });
  it("keeps Unicode titles", () => {
    expect(sanitizeFilename("東京 タワー — night")).toBe("東京 タワー — night");
  });
});

describe("buildFilename", () => {
  const base = { template: "%title", maxLength: 80, pageUrl: "https://example.com/p", mediaUrl: "https://cdn.example.com/v/my%20clip.mp4", ext: "mp4" };
  it("uses the page title first", () => {
    expect(buildFilename({ ...base, title: "Cats | Example" })).toBe("Cats Example.mp4");
  });
  it("falls back to the server name, then the URL", () => {
    expect(buildFilename({ ...base, serverFilename: "talk.webm" })).toBe("talk.mp4");
    expect(buildFilename(base)).toBe("my clip.mp4");
    expect(nameFromUrl("https://x.com/")).toBe("");
  });
});

describe("asciiFilename", () => {
  it("drops accents and other non-ASCII characters but keeps folders and the extension", () => {
    expect(asciiFilename("Vidzilla/Northern Lights Over Tromsø – Café.mp4")).toBe("Vidzilla/Northern Lights Over Troms - Cafe.mp4");
    expect(asciiFilename("東京.mp4")).toBe("video.mp4");
  });
});

describe("siteLabel for addresses", () => {
  it("keeps an IP address whole", () => {
    expect(siteLabel("http://127.0.0.1:8080/page.html")).toBe("127.0.0.1");
  });
});

describe("mimeForFilename", () => {
  it("types saved files by extension so Chrome keeps it", () => {
    expect(mimeForFilename("Clip.mp4")).toBe("video/mp4");
    expect(mimeForFilename("folder/Song.M4A")).toBe("audio/mp4");
    expect(mimeForFilename("Talk.webm")).toBe("video/webm");
  });
  it("never leaves a blob untyped", () => {
    expect(mimeForFilename("no-extension")).toBe("application/octet-stream");
    expect(mimeForFilename("odd.xyz")).toBe("application/octet-stream");
  });
});
