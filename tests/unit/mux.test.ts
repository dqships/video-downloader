import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { avcParameterSets, blankWebmIndexes, muxCaptured } from "../../src/capture/mux";

const dash = join(__dirname, "../fixtures/media/dash");
const run = (blob: Blob, offset = 0) => ({ blob, offset });
const chunk = (rep: number, n: number) => readFileSync(join(dash, `chunk-${rep}-0000${n}.m4s`));
const stream = (rep: number, count: number) => new Blob([readFileSync(join(dash, `init-${rep}.m4s`)), ...Array.from({ length: count }, (_, i) => chunk(rep, i + 1))]);

describe.skipIf(!existsSync(dash))("muxCaptured", () => {
  it("joins a player's separate video and audio streams into one MP4", async () => {
    const { blob, ext, durationSec } = await muxCaptured([[run(stream(0, 3))], [run(stream(2, 4))]]);
    expect(ext).toBe("mp4");
    expect(durationSec).toBeGreaterThan(5);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    expect(await input.getPrimaryVideoTrack()).toBeTruthy();
    expect(await input.getPrimaryAudioTrack()).toBeTruthy();
    expect(await input.computeDuration()).toBeGreaterThan(5);
  });

  it("saves sound alone as .m4a", async () => {
    const { ext } = await muxCaptured([[run(stream(2, 4))]]);
    expect(ext).toBe("m4a");
  });

  it("joins a quality switch into one video track that starts at the beginning", async () => {
    // 180p for the first segment, then 360p: H.264 with different parameter sets.
    const low = new Blob([readFileSync(join(dash, "init-1.m4s")), chunk(1, 1)]);
    const high = new Blob([readFileSync(join(dash, "init-0.m4s")), chunk(0, 2), chunk(0, 3)]);
    const { blob } = await muxCaptured([[run(low), run(high)], [run(stream(2, 4))]]);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const video = (await input.getPrimaryVideoTrack())!;
    expect(await video.getCodec()).toBe("avc");
    expect((await video.getDecoderConfig())!.codec).toMatch(/^avc3\./);
    expect(await video.getFirstTimestamp()).toBeLessThan(0.1);
    expect(await video.computeDuration()).toBeGreaterThan(5);
  });

  it("reads the parameter sets out of an avcC record", () => {
    // version 1, profile, compat, level, lengthSize 4, one SPS [0x67, 0x01], one PPS [0x68]
    const record = new Uint8Array([1, 0x64, 0, 0x1e, 0xff, 0xe1, 0, 2, 0x67, 1, 1, 0, 1, 0x68]);
    expect(avcParameterSets(record)).toEqual({ lengthSize: 4, nals: new Uint8Array([0, 0, 0, 2, 0x67, 1, 0, 0, 0, 1, 0x68]) });
  });

  it("places a run where the player's timestampOffset put it", async () => {
    // The same first segment, shifted 2 s later by the page.
    const { blob } = await muxCaptured([[run(stream(2, 1)), run(new Blob([readFileSync(join(dash, "init-2.m4s")), chunk(2, 1)]), 2)]]);
    const audio = (await new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }).getPrimaryAudioTrack())!;
    expect(await audio.computeDuration()).toBeGreaterThan(3.9);
  });
});

describe("blankWebmIndexes", () => {
  it("turns SeekHead and Cues into Void elements of the same length, up to the first Cluster", () => {
    const head = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00, // EBML header, 1 byte of payload
      0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // Segment, unknown size
      0x11, 0x4d, 0x9b, 0x74, 0x86, 1, 2, 3, 4, 5, 6, // SeekHead, 11 bytes in all
      0x15, 0x49, 0xa9, 0x66, 0x81, 9, // Info
      0x1c, 0x53, 0xbb, 0x6b, 0x85, 1, 2, 3, 4, 5, // Cues, 10 bytes
      0x1f, 0x43, 0xb6, 0x75, 0x81, 7, // Cluster
    ]);
    blankWebmIndexes(head);
    expect([...head.subarray(18, 29)]).toEqual([0xec, 0x01, 0, 0, 0, 0, 0, 0, 2, 5, 6]);
    expect([...head.subarray(29, 35)]).toEqual([0x15, 0x49, 0xa9, 0x66, 0x81, 9]);
    expect([...head.subarray(35, 44)]).toEqual([0xec, 0x01, 0, 0, 0, 0, 0, 0, 1]);
    expect([...head.subarray(45)]).toEqual([0x1f, 0x43, 0xb6, 0x75, 0x81, 7]);
  });
});
