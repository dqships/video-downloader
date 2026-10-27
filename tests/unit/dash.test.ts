import { describe, expect, it } from "vitest";
import { dashChildUrls, expandTemplate, hlsMediaPlaylist, listDashVariants, parseIsoDuration, parseMpd, parseSidx, resolveSegments } from "../../src/shared/dash";
import { parseM3u8, type HlsMedia } from "../../src/shared/hls";
import { parseXml } from "../../src/shared/xml";

const URL_ = "https://cdn.example/v/manifest.mpd";

describe("parseXml", () => {
  it("reads elements, namespaced attributes, entities, comments and CDATA", () => {
    const root = parseXml(`<?xml version="1.0"?><!-- c --><a:MPD xmlns:a="x" a:type='static' t="&lt;&amp;&#65;"><B/><C>text<![CDATA[<raw>]]></C></a:MPD>`);
    expect(root.name).toBe("MPD");
    expect(root.attrs).toMatchObject({ type: "static", t: "<&A" });
    expect(root.children.map((c) => c.name)).toEqual(["B", "C"]);
    expect(root.children[1]!.text).toBe("text<raw>");
  });

  it("rejects broken markup", () => {
    expect(() => parseXml("<a><b></a>")).toThrow();
    expect(() => parseXml("<a>")).toThrow();
  });
});

describe("helpers", () => {
  it("parses ISO 8601 durations", () => {
    expect(parseIsoDuration("PT6.0S")).toBe(6);
    expect(parseIsoDuration("PT1H2M3.5S")).toBe(3723.5);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("nope")).toBeUndefined();
  });

  it("expands segment templates", () => {
    expect(expandTemplate("c-$RepresentationID$-$Number%05d$-$Time$-$Bandwidth$-$$.m4s", { RepresentationID: "v1", Number: 7, Time: 900, Bandwidth: 5 })).toBe(
      "c-v1-00007-900-5-$.m4s",
    );
  });
});

describe("parseMpd", () => {
  it("lists numbered template segments with the period length", () => {
    const mpd = `<MPD type="static" mediaPresentationDuration="PT5S"><BaseURL>media/</BaseURL><Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate timescale="10" duration="20" startNumber="3" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s"/>
        <Representation id="hd" bandwidth="4000000" width="1920" height="1080" codecs="avc1.640028"/>
      </AdaptationSet></Period></MPD>`;
    const m = parseMpd(mpd, URL_);
    expect(m.duration).toBe(5);
    const seg = m.representations[0]!.segments;
    expect(seg.kind).toBe("list");
    if (seg.kind !== "list") return;
    expect(seg.init?.url).toBe("https://cdn.example/v/media/hd/init.mp4");
    expect(seg.segments.map((s) => [s.url.split("/").pop(), s.duration])).toEqual([
      ["3.m4s", 2],
      ["4.m4s", 2],
      ["5.m4s", 1],
    ]);
  });

  it("follows a SegmentTimeline, including r=-1", () => {
    const mpd = `<MPD type="static" mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="audio/mp4" lang="en">
      <Representation id="a" bandwidth="1"><SegmentTemplate timescale="1000" media="a-$Time$.m4s">
        <SegmentTimeline><S t="0" d="2000" r="1"/><S d="1000" r="-1"/></SegmentTimeline>
      </SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;
    const seg = parseMpd(mpd, URL_).representations[0]!.segments;
    if (seg.kind !== "list") throw new Error("expected a list");
    expect(seg.segments.map((s) => s.url.split("/").pop())).toEqual(["a-0.m4s", "a-2000.m4s", "a-4000.m4s", "a-5000.m4s", "a-6000.m4s", "a-7000.m4s"]);
  });

  it("marks DRM, live and trick-play", () => {
    const mpd = `<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v" bandwidth="1"/></AdaptationSet>
      <AdaptationSet mimeType="video/mp4"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="1"/><Representation id="t"/></AdaptationSet></Period></MPD>`;
    const m = parseMpd(mpd, URL_);
    expect(m.isLive).toBe(true);
    expect(m.hasDrm).toBe(true);
    expect(m.representations.map((r) => r.key)).toEqual(["0:v"]);
  });

  it("reads the longest period of a multi-period manifest", () => {
    const mpd = `<MPD type="static" mediaPresentationDuration="PT100S">
      <Period id="ad" start="PT0S"><AdaptationSet mimeType="video/mp4"><Representation id="ad"/></AdaptationSet></Period>
      <Period id="main" start="PT10S"><AdaptationSet mimeType="video/mp4"><Representation id="main"/></AdaptationSet></Period></MPD>`;
    const m = parseMpd(mpd, URL_);
    expect(m.duration).toBe(90);
    expect(m.representations.map((r) => r.key)).toEqual(["0:main"]);
  });
});

describe("listDashVariants", () => {
  // As ffmpeg writes it: two video qualities in one set, audio in another.
  const mpd = `<MPD type="static" mediaPresentationDuration="PT6.0S"><Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" mimeType="video/mp4" codecs="avc1.64001e" bandwidth="1500000" width="640" height="360">
        <SegmentTemplate timescale="1000000" duration="2000000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
      </Representation>
      <Representation id="1" mimeType="video/mp4" codecs="avc1.64000d" bandwidth="400000" width="320" height="180">
        <SegmentTemplate timescale="1000000" duration="2000000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" lang="und">
      <Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="126759">
        <SegmentTemplate timescale="1000000" duration="2000000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet></Period></MPD>`;

  it("offers each video quality with the best audio, then audio only", () => {
    const m = parseMpd(mpd, URL_);
    const variants = listDashVariants(m, URL_);
    expect(variants.map((v) => v.label)).toEqual(["360p", "180p", "Audio only"]);
    expect(variants[0]).toMatchObject({ videoRep: "0:0", audioRep: "1:2", codecs: "avc1.64001e,mp4a.40.2" });
    expect(variants[2]).toMatchObject({ audioOnly: true, audioRep: "1:2" });
    expect(variants[2]!.videoRep).toBeUndefined();
  });

  it("offers WebM qualities, preferring MP4-family ones where a height has both", () => {
    const mpd = `<MPD type="static" mediaPresentationDuration="PT1S"><Period>
      <AdaptationSet mimeType="video/webm"><Representation id="w1080" codecs="vp9" height="1080"/><Representation id="w720" codecs="vp9" height="720"/></AdaptationSet>
      <AdaptationSet mimeType="video/mp4"><Representation id="m720" codecs="avc1.64001f" height="720"/></AdaptationSet>
      <AdaptationSet mimeType="audio/webm"><Representation id="o" codecs="opus" bandwidth="160000"/></AdaptationSet>
      <AdaptationSet mimeType="audio/webm"><Representation id="v" codecs="vorbis" bandwidth="190000"/></AdaptationSet>
    </Period></MPD>`;
    const variants = listDashVariants(parseMpd(mpd, URL_), URL_);
    expect(variants.map((v) => [v.label, v.videoRep?.split(":")[1], v.audioRep?.split(":")[1], !!v.webm])).toEqual([
      ["1080p", "w1080", "o", false],
      ["720p", "m720", "o", false],
      ["Audio only", undefined, "o", false],
    ]);
  });

  it("saves as WebM when the only audio is Vorbis", () => {
    const mpd = `<MPD type="static" mediaPresentationDuration="PT1S"><Period>
      <AdaptationSet mimeType="video/webm"><Representation id="w" codecs="vp8" height="360"/></AdaptationSet>
      <AdaptationSet mimeType="audio/webm"><Representation id="v" codecs="vorbis"/></AdaptationSet>
    </Period></MPD>`;
    expect(listDashVariants(parseMpd(mpd, URL_), URL_).every((v) => v.webm)).toBe(true);
  });
});

/** A version-0 sidx box with the given (size, duration) references. */
function sidx(refs: [number, number][], timescale = 1000, firstOffset = 0): Uint8Array {
  const size = 32 + refs.length * 12;
  const view = new DataView(new ArrayBuffer(size));
  view.setUint32(0, size);
  [..."sidx"].forEach((c, i) => view.setUint8(4 + i, c.charCodeAt(0)));
  view.setUint32(16, timescale);
  view.setUint32(24, firstOffset);
  view.setUint16(30, refs.length);
  refs.forEach(([bytes, duration], i) => {
    view.setUint32(32 + i * 12, bytes);
    view.setUint32(36 + i * 12, duration);
  });
  return new Uint8Array(view.buffer);
}

describe("SegmentBase", () => {
  const mpd = `<MPD type="static" mediaPresentationDuration="PT6S"><Period><AdaptationSet mimeType="video/mp4">
    <Representation id="v" height="360"><BaseURL>video.mp4</BaseURL><SegmentBase indexRange="800-867"><Initialization range="0-799"/></SegmentBase></Representation>
    </AdaptationSet></Period></MPD>`;
  const m = parseMpd(mpd, "https://x/dash-base/manifest.mpd");

  it("reads the sidx into absolute byte ranges that follow the index", async () => {
    const rep = m.representations[0]!;
    const index = sidx([[1000, 2000], [1500, 2000], [700, 2000]]);
    const { init, segments } = await resolveSegments(rep, m.duration, async (url, r) => {
      expect([url, r.start, r.end]).toEqual(["https://x/dash-base/video.mp4", 800, 867]);
      return index;
    });
    expect(init).toEqual({ url: "https://x/dash-base/video.mp4", range: { start: 0, end: 799 } });
    expect(segments.map((s) => [s.range!.start, s.range!.end, s.duration])).toEqual([
      [868, 1867, 2],
      [1868, 3367, 2],
      [3368, 4067, 2],
    ]);
    expect(dashChildUrls(m)).toEqual(["https://x/dash-base/video.mp4"]);
  });

  it("rejects a range that isn't a sidx", () => {
    expect(() => parseSidx(new Uint8Array(32), 0, "u")).toThrow();
  });
});

describe("hlsMediaPlaylist", () => {
  it("writes byte ranges and the init map so the HLS reader accepts it", () => {
    const text = hlsMediaPlaylist({ url: "https://x/v.mp4", range: { start: 0, end: 99 } }, [
      { url: "https://x/v.mp4", range: { start: 100, end: 199 }, duration: 2 },
      { url: "https://x/v.mp4", range: { start: 200, end: 299 }, duration: 1.5 },
    ]);
    expect(text).toContain('#EXT-X-MAP:URI="https://x/v.mp4",BYTERANGE="100@0"');
    expect(text).toContain("#EXT-X-BYTERANGE:100@200");
    const pl = parseM3u8(text, "data:") as HlsMedia;
    expect(pl.duration).toBeCloseTo(3.5);
    expect(pl.endList).toBe(true);
  });
});
