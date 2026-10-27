import { describe, expect, it } from "vitest";
import { listDashSubtitles, parseMpd } from "../../src/shared/dash";
import { listHlsSubtitles, parseM3u8, type HlsMaster } from "../../src/shared/hls";
import { mergeCues, parseSubtitles, parseTtml, parseVtt, toSrt } from "../../src/shared/subtitles";

describe("parseVtt", () => {
  it("reads cues, drops styling and header blocks", () => {
    const cues = parseVtt("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\nNOTE hi\n\n1\n00:00:00.500 --> 00:00:02.000 align:start\nHello <b>there</b> &amp; you\n\n01:02.250 --> 01:03.000\nshort clock\n");
    expect(cues).toEqual([
      { start: 0.5, end: 2, text: "Hello there & you" },
      { start: 62.25, end: 63, text: "short clock" },
    ]);
  });
});

describe("parseTtml", () => {
  it("reads ticks, clock times, <br/> and spans in order", () => {
    const cues = parseTtml(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="p" ttp:tickRate="10000000"><body><div>
      <p begin="5000000t" end="20000000t">Hallo<br/>zusammen</p>
      <p begin="00:00:04.000" dur="1.5s"><span>Zweite</span> Zeile</p></div></body></tt>`);
    expect(cues).toEqual([
      { start: 0.5, end: 2, text: "Hallo\nzusammen" },
      { start: 4, end: 5.5, text: "Zweite Zeile" },
    ]);
  });
});

describe("mergeCues and toSrt", () => {
  it("drops cues repeated across segments and writes SubRip", () => {
    const a = parseSubtitles("WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nAcross\n");
    const b = parseSubtitles("WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nAcross\n\n00:00:04.000 --> 00:01:05.5\nNext\n");
    expect(toSrt(mergeCues([b, a]))).toBe("1\n00:00:01,500 --> 00:00:03,000\nAcross\n\n2\n00:00:04,000 --> 00:01:05,500\nNext\n");
  });
});

describe("subtitle tracks in manifests", () => {
  it("lists HLS subtitle renditions", () => {
    const master = parseM3u8(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="s"\nv.m3u8\n',
      "https://x/master.m3u8",
    ) as HlsMaster;
    expect(listHlsSubtitles(master)).toEqual([{ id: "hls-0", label: "English", lang: "en", source: { kind: "hls", url: "https://x/subs/en.m3u8" } }]);
  });

  it("lists DASH text tracks given as files or plain segments, skipping MP4-wrapped ones", () => {
    const m = parseMpd(
      `<MPD type="static" mediaPresentationDuration="PT4S"><Period>
        <AdaptationSet contentType="text" mimeType="text/vtt" lang="en"><Representation id="vtt"><BaseURL>en.vtt</BaseURL></Representation></AdaptationSet>
        <AdaptationSet contentType="text" mimeType="application/ttml+xml" lang="de"><Label>Deutsch</Label><Representation id="t">
          <SegmentTemplate media="de-$Number$.ttml" duration="2" startNumber="1"/></Representation></AdaptationSet>
        <AdaptationSet contentType="text" mimeType="application/mp4" codecs="stpp"><Representation id="mp4"><BaseURL>s.mp4</BaseURL></Representation></AdaptationSet>
      </Period></MPD>`,
      "https://x/m.mpd",
    );
    expect(listDashSubtitles(m)).toEqual([
      { id: "dash-0:vtt", label: "en", lang: "en", source: { kind: "file", url: "https://x/en.vtt" } },
      { id: "dash-1:t", label: "Deutsch", lang: "de", source: { kind: "segments", urls: ["https://x/de-1.ttml", "https://x/de-2.ttml"] } },
    ]);
  });
});
