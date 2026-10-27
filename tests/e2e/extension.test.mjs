// End-to-end: loads the built extension into Chromium, visits the fixture
// site, and checks detection, the popup and real downloads.
// Run with `pnpm test:e2e` (needs Playwright with Chromium, and ffprobe).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const dist = fileURLToPath(new URL("../../dist", import.meta.url));
let site, context, sw, extensionId, profile;

async function waitFor(fn, what, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Opens a fixture page and returns its tab id and the media the extension found. */
async function visit(path, minMedia = 1) {
  const page = await context.newPage();
  await page.goto(`${site.origin}${path}`);
  const tabId = await waitFor(
    () => sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${site.origin}${path}`),
    "tab id",
  );
  const tab = await waitFor(
    () =>
      sw.evaluate(async (key) => {
        const t = (await chrome.storage.session.get(key))[key];
        return t?.title && t.media.length ? t : undefined;
      }, `tab:${tabId}`),
    `media on ${path}`,
  );
  assert.ok(tab.media.length >= minMedia);
  return { page, tabId, tab };
}

async function downloadFromPopup(tabId, prepare = async () => {}) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.locator(".vz-frame").first().waitFor();
  await prepare(popup);
  await popup.locator(".vz-frame .download").first().click();
  const job = await waitFor(
    () =>
      sw.evaluate(async (tabId) => {
        const jobs = Object.values((await chrome.storage.session.get("jobs")).jobs ?? {});
        return jobs.find((j) => j.tabId === tabId && j.state !== "running");
      }, tabId),
    "download to finish",
    60000,
  );
  const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), job.chromeDownloadId);
  await popup.close();
  return { job, item, popup };
}

/** Duration and streams of a saved file, from ffprobe. */
function probe(file) {
  const out = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height", "-of", "json", file]).toString(),
  );
  const video = out.streams.find((s) => s.codec_type === "video");
  const audio = out.streams.find((s) => s.codec_type === "audio");
  return { duration: Number(out.format.duration), format: out.format.format_name, video, audio };
}

/** Downloads the page's first stream and checks it is a ~6 s MP4 with sound. */
async function downloadStream(path, prepare, { audioOnly = false } = {}) {
  const { tabId, page, tab } = await visit(path);
  const { job, item } = await downloadFromPopup(tabId, prepare);
  assert.equal(job.state, "complete", job.error);
  assert.match(job.filename, audioOnly ? /\.m4a$/ : /\.mp4$/, JSON.stringify({ job, variants: tab.media[0].variants }));
  const file = probe(item.filename);
  assert.match(file.format, /mp4/);
  assert.ok(Math.abs(file.duration - 6) < 0.5, `duration ${file.duration}`);
  if (audioOnly) assert.equal(file.video, undefined, "no picture in an audio-only file");
  else assert.equal(file.video?.codec_name, "h264");
  assert.equal(file.audio?.codec_name, "aac");
  const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules.length, 0, `replay rules are removed after the job: ${JSON.stringify(rules)}`);
  await page.close();
  return { tab, file, job };
}

before(async () => {
  assert.ok(existsSync(join(dist, "manifest.json")), "run `pnpm build` first");
  site = await startServer();
  profile = mkdtempSync(join(tmpdir(), "vd-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(sw.url()).host;
});

after(async () => {
  await context?.close();
  site?.server.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

test("detects a direct mp4 with the page title and size", async () => {
  const { tab, page } = await visit("/page.html");
  const mp4 = tab.media.find((m) => m.type === "http");
  assert.equal(mp4.ext, "mp4");
  assert.ok(mp4.sizeBytes > 1_000_000);
  assert.equal(tab.title, "Test Clip | Fixture Site");
  assert.match(tab.thumbnail, /\/poster\.png$/);
  await page.close();
});

test("popup lists the media and the download saves a playable file", async () => {
  const { tabId, page } = await visit("/page.html");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.locator(".vz-frame").first().waitFor();
  assert.equal(await popup.locator(".vz-frame .vz-frame-name").first().inputValue(), "Test Clip Fixture Site.mp4");
  await popup.close();

  const { job, item } = await downloadFromPopup(tabId);
  assert.equal(job.state, "complete", job.error);
  // Playwright reroutes browser downloads into its own folder under a random
  // name, so check the name we asked for and probe the file where it landed.
  assert.equal(job.filename, "Test Clip Fixture Site.mp4");
  const duration = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", item.filename]).toString(),
  );
  assert.ok(Math.abs(duration - 6) < 0.2, `duration ${duration}`);
  await page.close();
});

test("replays the page's Referer so a protected file downloads", async () => {
  const { tabId, page } = await visit("/protected.html");
  site.protectedLog.length = 0;
  const { job } = await downloadFromPopup(tabId);
  assert.equal(job.state, "complete", job.error);
  assert.ok(site.protectedLog.length > 0, "download reached the server");
  assert.ok(site.protectedLog.every((r) => r.referer.endsWith("/protected.html")), JSON.stringify(site.protectedLog));
  const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules.length, 0, "replay rules are removed after the job");
  await page.close();
});

test("lists an HLS master as one stream with its length", async () => {
  const { tab, page } = await visit("/hls.html");
  assert.equal(tab.media.length, 1);
  assert.equal(tab.media[0].type, "hls");
  assert.match(tab.media[0].url, /master\.m3u8$/);
  assert.equal(tab.media[0].durationSec, 6);
  assert.equal(tab.media[0].isLive, false);
  await page.close();
});

test("downloads a plain HLS stream as MP4", async () => {
  await downloadStream("/hls.html");
});

test("downloads an AES-128 encrypted stream", async () => {
  await downloadStream("/hls-aes.html");
});

test("downloads a fragmented MP4 (fMP4) stream", async () => {
  await downloadStream("/hls-fmp4.html");
});

test("offers each quality once and saves the one picked", async () => {
  const { tab } = await downloadStream("/hls-multi.html", async (popup) => {
    const select = popup.locator(".vz-frame .vz-select select").first();
    assert.deepEqual(await select.locator("option").allTextContents(), ["360p", "180p", "Audio only"]);
    await select.selectOption({ label: "180p" });
  });
  // The quality and audio playlists the player loaded are not listed apart.
  assert.equal(tab.media.length, 1);
  assert.equal(tab.media[0].variants.length, 3);
});

test("saves the picked quality's picture size", async () => {
  const { file } = await downloadStream("/hls-multi.html", (popup) =>
    popup.locator(".vz-frame .vz-select select").first().selectOption({ label: "180p" }),
  );
  assert.equal(file.video.height, 180);
});

const pick = (label) => (popup) => popup.locator(".vz-frame .vz-select select").first().selectOption({ label });

test("saves only the sound of an HLS stream as .m4a", async () => {
  await downloadStream("/hls-multi.html", pick("Audio only"), { audioOnly: true });
});

test("downloads DASH and saves the picked quality", async () => {
  const { tab, file } = await downloadStream("/dash.html", async (popup) => {
    const select = popup.locator(".vz-frame .vz-select select").first();
    assert.deepEqual(await select.locator("option").allTextContents(), ["360p", "180p", "Audio only"]);
    await select.selectOption({ label: "180p" });
  });
  assert.equal(tab.media.length, 1);
  assert.equal(tab.media[0].type, "dash");
  assert.equal(tab.media[0].durationSec, 6);
  assert.equal(file.video.height, 180);
});

test("downloads DASH with a segment timeline", async () => {
  await downloadStream("/dash-timeline.html");
});

test("downloads DASH segments given as byte ranges", async () => {
  await downloadStream("/dash-single.html");
});

test("downloads DASH served as one indexed file per track", async () => {
  const { tab } = await downloadStream("/dash-base.html");
  // The player's byte-range reads of the track file are not listed as a video of their own.
  assert.deepEqual(tab.media.map((m) => m.type), ["dash"]);
});

test("saves only the sound of a DASH stream as .m4a", async () => {
  await downloadStream("/dash.html", pick("Audio only"), { audioOnly: true });
});

test("replays the page's Referer for every file of a stream", async () => {
  site.protectedLog.length = 0;
  await downloadStream("/hls-protected.html");
  const segments = site.protectedLog.filter((r) => r.path.endsWith(".ts"));
  assert.ok(segments.length >= 3, JSON.stringify(site.protectedLog));
  assert.ok(site.protectedLog.every((r) => r.referer.endsWith("/hls-protected.html")), JSON.stringify(site.protectedLog));
});

/** Downloads the page's first item with the given subtitle track; returns the job and the .srt text. */
async function downloadWithSubtitles(path, label) {
  const { tabId, page } = await visit(path);
  const { job } = await downloadFromPopup(tabId, async (popup) => {
    const select = popup.locator(".vz-frame .subtitles select").first();
    await select.waitFor();
    await select.selectOption({ label });
  });
  assert.equal(job.state, "complete", job.error);
  const saved = await waitFor(
    () =>
      sw.evaluate(async (tabId) => {
        const jobs = Object.values((await chrome.storage.session.get("jobs")).jobs ?? {});
        const j = jobs.find((j) => j.tabId === tabId);
        if (!j?.subtitleFile && !j?.subtitleError) return undefined;
        const [item] = await chrome.downloads.search({ urlRegex: "^data:application/x-subrip", orderBy: ["-startTime"], state: "complete" });
        return { job: j, path: item?.filename };
      }, tabId),
    "subtitles to be saved",
  );
  assert.equal(saved.job.subtitleError, undefined);
  await page.close();
  return { job: saved.job, srt: readFileSync(saved.path, "utf8") };
}

test("saves an HLS stream's WebVTT subtitles as .srt next to the video", async () => {
  const { job, srt } = await downloadWithSubtitles("/subs-hls.html", "CC English");
  assert.equal(job.subtitleFile, job.filename.replace(/\.mp4$/, ".en.srt"));
  assert.equal(
    srt,
    "1\n00:00:00,500 --> 00:00:02,000\nHello there\n\n2\n00:00:01,500 --> 00:00:03,000\nAcross the cut\n\n3\n00:00:04,000 --> 00:00:05,500\nSecond line\n",
  );
});

test("saves a DASH stream's TTML subtitles as .srt", async () => {
  const { job, srt } = await downloadWithSubtitles("/subs-dash.html", "CC Deutsch");
  assert.match(job.subtitleFile, /\.de\.srt$/);
  assert.match(srt, /^1\n00:00:00,500 --> 00:00:02,000\nHallo\nzusammen\n/);
});

test("saves a page's <track> captions with a direct file", async () => {
  const { job, srt } = await downloadWithSubtitles("/track.html", "CC Français");
  assert.match(job.subtitleFile, /\.fr\.srt$/);
  assert.equal(srt, "1\n00:00:01,000 --> 00:00:02,500\nBonjour\n");
});

test("keeps DRM streams unavailable", async () => {
  const { tabId, tab, page } = await visit("/drm.html");
  assert.equal(tab.media[0].hasDrm, true);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  assert.equal(await popup.locator(".vz-frame .download").first().isDisabled(), true);
  const res = await popup.evaluate(
    ([tabId, mediaId]) => chrome.runtime.sendMessage({ kind: "download", payload: { tabId, mediaId } }),
    [tabId, tab.media[0].id],
  );
  assert.equal(res.ok, false);
  await popup.close();
  await page.close();
});

test("warns when the page plays DRM-protected video (EME)", async () => {
  const { tabId, page } = await visit("/eme.html");
  const tab = await waitFor(
    () => sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key]?.drmKeySystem && (await chrome.storage.session.get(key))[key], `tab:${tabId}`),
    "DRM to be noticed",
  );
  assert.equal(tab.drmKeySystem, "com.widevine.alpha");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  assert.match(await popup.locator(".vz-frame-note").first().textContent(), /Widevine-protected/);
  await popup.close();
  await page.close();
});

/** Starts recording a live page from the popup; returns what's needed to stop and check it. */
test("lists media a page declares before anything plays", async () => {
  const { page, tabId } = await visit("/declared.html");
  const tab = await waitFor(
    () => sw.evaluate(async (key) => {
      const t = (await chrome.storage.session.get(key))[key];
      return t?.media.length >= 2 ? t : undefined;
    }, `tab:${tabId}`),
    "both declared media",
  );
  assert.equal(tab.media.length, 2, JSON.stringify(tab.media.map((m) => m.url)));
  const mp4 = tab.media.find((m) => m.type === "http");
  assert.equal(mp4.sourceKind, "page");
  assert.equal(mp4.title, "Harbour at Dawn");
  assert.equal(mp4.sentHeaders.referer, `${site.origin}/declared.html`);
  const hls = tab.media.find((m) => m.type === "hls");
  assert.equal(hls.durationSec, 6, "the declared stream was probed");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.locator(".vz-frame").nth(1).waitFor();
  const names = await popup.locator(".vz-frame .vz-frame-name").evaluateAll((els) => els.map((e) => e.value));
  assert.ok(names.includes("Harbour at Dawn.mp4"), names.join(", "));
  await popup.close();
  await page.close();
});

test("looks again when a single-page app swaps the video", async () => {
  const page = await context.newPage();
  await page.goto(`${site.origin}/spa.html`);
  const tab = await waitFor(
    () => sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      if (!t) return undefined;
      const stored = (await chrome.storage.session.get(`tab:${t.id}`))[`tab:${t.id}`];
      return stored?.media.length ? stored : undefined;
    }, `${site.origin}/spa/clip-2`),
    "media after pushState",
  );
  assert.match(tab.media[0].url, /clip\.mp4$/);
  await page.close();
});

async function startRecording(run) {
  const { tabId, tab, page } = await visit(`/live-page/${run}.html`);
  assert.equal(tab.media[0].isLive, true);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  const button = popup.locator(".vz-frame .download").first();
  assert.equal(await button.getAttribute("title"), "Record");
  await button.click();
  await waitFor(async () => (await button.getAttribute("title")) === "Stop and save", "recording to start");
  return { tabId, page, popup, button };
}

async function finishedJob(tabId, timeout) {
  return waitFor(
    () =>
      sw.evaluate(async (tabId) => {
        const jobs = Object.values((await chrome.storage.session.get("jobs")).jobs ?? {});
        return jobs.find((j) => j.tabId === tabId && j.state !== "running");
      }, tabId),
    "recording to be saved",
    timeout,
  );
}

test("records a live stream until stopped and keeps what was recorded", async () => {
  const { tabId, page, popup, button } = await startRecording("stopped");
  await waitFor(async () => /Recording 0:0[4-9]/.test(await popup.locator(".vz-frame-note").first().textContent()), "4 s recorded", 20000);
  await button.click();
  const job = await finishedJob(tabId, 30000);
  assert.equal(job.state, "complete", job.error);
  const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), job.chromeDownloadId);
  const file = probe(item.filename);
  assert.ok(file.duration >= 4 && file.duration < 20, `duration ${file.duration}`);
  assert.equal(file.video?.codec_name, "h264");
  assert.equal(file.audio?.codec_name, "aac");
  await popup.close();
  await page.close();
});

test("records a live stream to its end on its own", async () => {
  const { tabId, page, popup } = await startRecording("to-end");
  const job = await finishedJob(tabId, 60000);
  assert.equal(job.state, "complete", job.error);
  const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), job.chromeDownloadId);
  const file = probe(item.filename);
  // The broadcast runs 20 s; the recording starts at the window offered when it began.
  assert.ok(file.duration >= 12 && file.duration <= 20.5, `duration ${file.duration}`);
  await popup.close();
  await page.close();
});
