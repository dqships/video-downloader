import { describe, expect, it } from "vitest";
import { codecFamily, dataUrl, isDrmKey, listVariants, parseAttributes, parseM3u8, singleVariantMaster, type HlsMaster, type HlsMedia } from "../../src/shared/hls";

const BASE = "https://cdn.example/v/master.m3u8?token=1";

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Deutsch",LANGUAGE="de",URI="audio/de.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=29.970,AUDIO="aud"
https://other.example/1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
720p-low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
720p-high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"
audio-only.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1",IV=0x00
#EXTINF:6.0,
seg0.m4s
#EXTINF:5.5,title
seg1.m4s
#EXT-X-ENDLIST
`;

describe("parseAttributes", () => {
  it("handles quoted values with commas and bare values", () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=640x360')).toEqual({
      BANDWIDTH: "1",
      CODECS: "avc1.4d401f,mp4a.40.2",
      RESOLUTION: "640x360",
    });
  });
});

describe("parseM3u8", () => {
  it("reads a master playlist, resolving URIs against the playlist URL", () => {
    const pl = parseM3u8(MASTER, BASE) as HlsMaster;
    expect(pl.kind).toBe("master");
    expect(pl.variants).toHaveLength(5);
    expect(pl.variants[0]).toMatchObject({ uri: "https://cdn.example/v/360p.m3u8", width: 640, height: 360, bandwidth: 800000, audioGroup: "aud" });
    expect(pl.variants[1]).toMatchObject({ uri: "https://other.example/1080p.m3u8", averageBandwidth: 4500000, frameRate: 29.97 });
    expect(pl.renditions.map((r) => [r.language, r.isDefault, r.uri])).toEqual([
      ["en", true, "https://cdn.example/v/audio/en.m3u8"],
      ["de", false, "https://cdn.example/v/audio/de.m3u8"],
    ]);
  });

  it("reads a media playlist: segments, init, keys, duration, end marker", () => {
    const pl = parseM3u8(MEDIA, "https://cdn.example/v/720p.m3u8") as HlsMedia;
    expect(pl.kind).toBe("media");
    expect(pl.segments).toEqual(["https://cdn.example/v/seg0.m4s", "https://cdn.example/v/seg1.m4s"]);
    expect(pl.otherUris).toEqual(["https://cdn.example/v/init.mp4", "https://keys.example/k1"]);
    expect(pl.keys).toEqual([{ method: "AES-128", keyFormat: undefined, uri: "https://keys.example/k1" }]);
    expect(pl.duration).toBeCloseTo(11.5);
    expect(pl.endList).toBe(true);
    expect(pl.playlistType).toBe("VOD");
  });

  it("treats a playlist without an end marker as live", () => {
    const pl = parseM3u8("#EXTM3U\n#EXTINF:4,\na.ts\n", BASE) as HlsMedia;
    expect(pl.endList).toBe(false);
  });

  it("copes with CRLF line endings", () => {
    const pl = parseM3u8(MEDIA.replace(/\n/g, "\r\n"), BASE) as HlsMedia;
    expect(pl.segments).toHaveLength(2);
  });

  it("rejects text that isn't a playlist", () => {
    expect(() => parseM3u8("<html>", BASE)).toThrow();
  });
});

describe("isDrmKey", () => {
  it("allows plain AES-128 and no encryption", () => {
    expect(isDrmKey({ method: "NONE" })).toBe(false);
    expect(isDrmKey({ method: "AES-128", uri: "https://k" })).toBe(false);
    expect(isDrmKey({ method: "AES-128", keyFormat: "identity", uri: "https://k" })).toBe(false);
  });

  it("flags SAMPLE-AES, CENC and DRM key systems", () => {
    expect(isDrmKey({ method: "SAMPLE-AES", uri: "skd://abc" })).toBe(true);
    expect(isDrmKey({ method: "SAMPLE-AES-CTR" })).toBe(true);
    expect(isDrmKey({ method: "AES-128", uri: "skd://abc" })).toBe(true);
    expect(isDrmKey({ method: "SAMPLE-AES", keyFormat: "com.apple.streamingkeydelivery" })).toBe(true);
    expect(isDrmKey({ method: "SAMPLE-AES-CTR", keyFormat: "urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED" })).toBe(true);
  });
});

describe("codecFamily", () => {
  it("groups codecs by container", () => {
    expect(codecFamily("avc1.64001f,mp4a.40.2")).toBe("mp4");
    expect(codecFamily("vp09.00.10.08")).toBe("webm");
    expect(codecFamily(undefined)).toBe("unknown");
  });
});

describe("listVariants", () => {
  const variants = listVariants(parseM3u8(MASTER, BASE) as HlsMaster);

  it("orders best first and pairs the default audio", () => {
    expect(variants.map((v) => v.label)).toEqual(["1080p", "720p · 4.0 Mbps", "720p · 3.0 Mbps", "360p", "Audio only"]);
    expect(variants[0]).toMatchObject({ url: "https://other.example/1080p.m3u8", audioUrl: "https://cdn.example/v/audio/en.m3u8", audioLanguage: "en" });
    expect(variants[4]!.audioUrl).toBeUndefined();
    expect(new Set(variants.map((v) => v.id)).size).toBe(variants.length);
  });

  it("marks HDR variants", () => {
    const hdr = parseM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=3840x2160,VIDEO-RANGE=PQ\nuhd.m3u8\n', BASE) as HlsMaster;
    expect(listVariants(hdr)[0]!.label).toBe("2160p PQ");
  });
});

describe("singleVariantMaster", () => {
  it("round-trips through the parser with only the chosen variant and audio", () => {
    const [best] = listVariants(parseM3u8(MASTER, BASE) as HlsMaster);
    const text = singleVariantMaster(best!);
    const back = parseM3u8(text, "data:") as HlsMaster;
    expect(back.variants).toHaveLength(1);
    expect(back.variants[0]).toMatchObject({ uri: "https://other.example/1080p.m3u8", height: 1080, codecs: "avc1.640028,mp4a.40.2" });
    expect(back.renditions.map((r) => r.uri)).toEqual(["https://cdn.example/v/audio/en.m3u8"]);
  });

  it("encodes as a data: URL", () => {
    const url = dataUrl("#EXTM3U\n# é\n");
    expect(url.startsWith("data:application/vnd.apple.mpegurl;base64,")).toBe(true);
    expect(Buffer.from(url.split(",")[1]!, "base64").toString("utf8")).toBe("#EXTM3U\n# é\n");
  });
});
