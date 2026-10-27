import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { muxCaptured } from "../../src/capture/mux";

const dash = join(__dirname, "../fixtures/media/dash");
const stream = (rep: number, count: number) =>
  new Blob([readFileSync(join(dash, `init-${rep}.m4s`)), ...Array.from({ length: count }, (_, i) => readFileSync(join(dash, `chunk-${rep}-0000${i + 1}.m4s`)))]);

describe.skipIf(!existsSync(dash))("muxCaptured", () => {
  it("joins a player's separate video and audio streams into one MP4", async () => {
    const { blob, ext, durationSec } = await muxCaptured([stream(0, 3), stream(2, 4)]);
    expect(ext).toBe("mp4");
    expect(durationSec).toBeGreaterThan(5);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    expect(await input.getPrimaryVideoTrack()).toBeTruthy();
    expect(await input.getPrimaryAudioTrack()).toBeTruthy();
    expect(await input.computeDuration()).toBeGreaterThan(5);
  });

  it("saves sound alone as .m4a", async () => {
    const { ext } = await muxCaptured([stream(2, 4)]);
    expect(ext).toBe("m4a");
  });
});
