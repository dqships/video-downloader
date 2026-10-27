import { describe, expect, it } from "vitest";
import { classify, dispositionFilename, type ResponseInfo } from "../../src/sw/classify";

const MB = 1024 * 1024;
const res = (over: Partial<ResponseInfo> & { headers?: Record<string, string> }): ResponseInfo => ({
  url: over.url ?? "https://cdn.example.com/v/clip.mp4",
  type: over.type ?? "media",
  statusCode: over.statusCode ?? 200,
  initiator: over.initiator ?? "https://example.com",
  responseHeaders: Object.entries(over.headers ?? { "Content-Type": "video/mp4", "Content-Length": String(5 * MB) }).map(
    ([name, value]) => ({ name, value }),
  ),
});

describe("classify", () => {
  it("lists a direct mp4 with its size", () => {
    expect(classify(res({}))).toMatchObject({ type: "http", ext: "mp4", sizeBytes: 5 * MB });
  });

  it("reads the total size from a 206 range response", () => {
    const r = classify(res({ statusCode: 206, headers: { "Content-Type": "video/webm", "Content-Range": "bytes 0-1023/9000000" } }));
    expect(r).toMatchObject({ type: "http", sizeBytes: 9000000, supportsRanges: true });
  });

  it("detects HLS by content type and by URL", () => {
    expect(classify(res({ url: "https://x.com/a", type: "xmlhttprequest", headers: { "Content-Type": "application/vnd.apple.mpegURL" } }))?.type).toBe("hls");
    expect(classify(res({ url: "https://x.com/master.m3u8?t=1", type: "xmlhttprequest", headers: { "Content-Type": "text/plain" } }))?.type).toBe("hls");
  });

  it("detects DASH by content type and by URL", () => {
    expect(classify(res({ url: "https://x.com/m", type: "xmlhttprequest", headers: { "Content-Type": "application/dash+xml" } }))?.type).toBe("dash");
    expect(classify(res({ url: "https://x.com/stream.mpd", type: "xmlhttprequest", headers: {} }))?.type).toBe("dash");
  });

  it("ignores segments, small files, errors and our own requests", () => {
    expect(classify(res({ url: "https://x.com/seg-12.ts", headers: { "Content-Type": "video/mp2t", "Content-Length": String(2 * MB) } }))).toBeNull();
    expect(classify(res({ url: "https://x.com/chunk.m4s" }))).toBeNull();
    expect(classify(res({ headers: { "Content-Type": "video/mp4", "Content-Length": "1000" } }))).toBeNull();
    expect(classify(res({ statusCode: 404 }))).toBeNull();
    expect(classify(res({ initiator: "chrome-extension://abc" }))).toBeNull();
    expect(classify(res({ url: "https://x.com/v.mp4?range=0-5000" }))).toBeNull();
  });

  it("ignores non-media XHR", () => {
    expect(classify(res({ url: "https://x.com/api", type: "xmlhttprequest", headers: { "Content-Type": "application/json" } }))).toBeNull();
    expect(classify(res({ url: "https://x.com/page", type: "xmlhttprequest", headers: { "Content-Type": "application/octet-stream" } }))).toBeNull();
  });

  it("picks the extension from URL, then Content-Disposition, then MIME", () => {
    expect(classify(res({ url: "https://x.com/get?id=1", type: "xmlhttprequest", headers: { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="Talk.webm"', "Content-Length": String(MB) } }))).toMatchObject({ ext: "webm", serverFilename: "Talk.webm" });
    expect(classify(res({ url: "https://x.com/get?id=1", headers: { "Content-Type": "audio/mpeg", "Content-Length": String(MB) } }))?.ext).toBe("mp3");
    expect(classify(res({ url: "https://x.com/get?id=1", headers: { "Content-Type": "", "Content-Length": String(MB) } }))?.ext).toBe("mp4");
  });
});

describe("dispositionFilename", () => {
  it("prefers the RFC 5987 form", () => {
    expect(dispositionFilename(`attachment; filename="a.mp4"; filename*=UTF-8''caf%C3%A9.mp4`)).toBe("café.mp4");
    expect(dispositionFilename("inline; filename=plain.mp4")).toBe("plain.mp4");
    expect(dispositionFilename(undefined)).toBeUndefined();
  });
});
