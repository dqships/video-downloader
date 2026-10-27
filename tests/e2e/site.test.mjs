// End-to-end: the website's paste-a-link downloader. Serves the built site on
// one origin and the fixture media on others (one that shares its files with
// CORS, one that doesn't), pastes links and checks the files it saves.
// Run with `pnpm test:e2e` (needs Playwright with Chromium, and ffprobe).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { serveSite } from "../../scripts/serve-site.mjs";
import { startServer } from "./server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const clip = fileURLToPath(new URL("../fixtures/media/clip.mp4", import.meta.url));

let site, shared, closed, browser, page;

function probe(file) {
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,height", "-of", "json", file]).toString());
  return { video: out.streams.find((s) => s.codec_type === "video"), audio: out.streams.find((s) => s.codec_type === "audio") };
}

async function paste(link) {
  await page.fill("#paste-url", link);
  await page.click(".paste-form button");
}

before(async () => {
  execFileSync("node", [fileURLToPath(new URL("../../scripts/build-site.mjs", import.meta.url))]);
  [site, shared, closed] = await Promise.all([serveSite(), startServer(0, { cors: true }), startServer(0)]);
  browser = await chromium.launch();
  page = await browser.newPage({ acceptDownloads: true });
  await page.goto(site.origin);
});

after(async () => {
  await browser?.close();
  for (const s of [site, shared, closed]) s?.server.close();
});

test("saves a pasted video file", async () => {
  await paste(`${shared.origin}/media/clip.mp4`);
  const frame = page.locator(".paste-strip .vz-frame").first();
  await frame.locator(".vz-badge", { hasText: "MP4" }).waitFor();
  assert.equal(await frame.locator(".vz-frame-name").inputValue(), "clip.mp4");
  const [download] = await Promise.all([page.waitForEvent("download"), frame.locator(".download").click()]);
  assert.equal(download.suggestedFilename(), "clip.mp4");
  assert.equal(statSync(await download.path()).size, statSync(clip).size);
  await frame.locator(".vz-frame-note.is-done").waitFor();
});

test("saves a pasted HLS stream at the chosen quality, audio included", async () => {
  await paste(`${shared.origin}/media/hls-multi/master.m3u8`);
  const frame = page.locator(".paste-strip .vz-frame").first();
  await frame.locator(".vz-badge", { hasText: "HLS" }).waitFor();
  assert.equal(await frame.locator(".vz-frame-name").inputValue(), "hls-multi.mp4");
  const select = frame.locator(".vz-select select");
  assert.deepEqual(await select.locator("option").allTextContents(), ["360p", "180p", "Audio only"]);
  await select.selectOption({ label: "180p" });
  await frame.locator(".vz-frame-name").fill("Two qualities");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), frame.locator(".download").click()]);
  assert.equal(download.suggestedFilename(), "Two qualities.mp4");
  const { video, audio } = probe(await download.path());
  assert.equal(video?.height, 180);
  assert.ok(audio, "audio track kept");
});

test("lists a DRM stream as fogged and won't download it", async () => {
  await paste(`${shared.origin}/drm/index.m3u8`);
  const frame = page.locator(".paste-strip .vz-frame").first();
  await frame.locator(".vz-frame-note", { hasText: "DRM" }).waitFor();
  assert.ok(await frame.evaluate((el) => el.classList.contains("is-fogged")));
  assert.ok(await frame.locator(".download").isDisabled());
});

test("explains links it can't save", async () => {
  const note = page.locator("[data-paste-note]");
  await paste(`${shared.origin}/page.html`);
  await note.filter({ hasText: "web page, not a video file" }).waitFor();
  await paste(`${closed.origin}/media/clip.mp4`);
  await note.filter({ hasText: "couldn't reach that link" }).waitFor();
  await paste("https://www.youtube.com/watch?v=abc");
  await note.filter({ hasText: "doesn't save YouTube" }).waitFor();
  await paste("not a link");
  await note.filter({ hasText: "doesn't look like a web link" }).waitFor();
});
