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
  if (item) assert.notEqual(item.mime, "text/plain", "saved file is typed, so Chrome keeps its extension");
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
  // House ads would take the strip's place mid-test; the ad test turns them on.
  await sw.evaluate(() => chrome.storage.local.set({ ads: { saved: 0, sinceAd: 0, shownAt: 0, next: 0, adFree: true } }));
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
  // An untyped blob is sniffed as text/plain and Chrome renames the file .txt.
  assert.equal(item.mime, "video/mp4");
  const duration = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", item.filename]).toString(),
  );
  assert.ok(Math.abs(duration - 6) < 0.2, `duration ${duration}`);
  await page.close();
});

test("popup keeps its width when Chrome opens it small, with head and foot controls in view", async () => {
  const { tabId, page } = await visit("/page.html");
  const popup = await context.newPage();
  // Chrome opens a popup tiny and grows it to fit the body; the body must not follow the viewport.
  await popup.setViewportSize({ width: 60, height: 60 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}&narrow`);
  await popup.locator(".vz-frame").first().waitFor();
  assert.equal(await popup.evaluate(() => document.body.getBoundingClientRect().width), 380);
  await popup.setViewportSize({ width: 380, height: 600 });
  for (const id of ["#switch-mode", "#toggle-settings", "#open-folder", "#open-history", "#clear-list", "#rate", "#share"]) {
    assert.ok(await popup.locator(id).isVisible(), `${id} visible`);
  }
  await popup.close();
  await page.close();
});

test("side panel shows the active tab's media and the same controls", async () => {
  const { tabId, page } = await visit("/page.html");
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 320, height: 700 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}&narrow`);
  await panel.locator(".vz-frame").first().waitFor();
  assert.ok(await panel.locator("#open-folder").isVisible());
  assert.ok(await panel.locator(".vz-frame .download").first().isVisible());
  assert.equal(await panel.locator("#switch-mode").getAttribute("title"), "Switch to the popup");
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // An open side panel stands in for the popup, and the choice is saved.
  await waitFor(() => sw.evaluate(async () => (await chrome.action.getPopup({})) === ""), "toolbar opens the panel");
  assert.equal((await sw.evaluate(() => chrome.storage.local.get("settings"))).settings.sidePanel, true);
  await panel.close();
  await page.close();
});

test("settings open inside the popup, and the side panel toggle there switches what the toolbar opens", async () => {
  const { tabId, page } = await visit("/page.html");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}&narrow`);
  await popup.locator(".vz-frame").first().waitFor();
  const pages = context.pages().length;
  await popup.click("#toggle-settings");
  assert.ok(await popup.locator("#settings-view").isVisible());
  assert.equal(await popup.locator("#strip").isVisible(), false);
  assert.equal(context.pages().length, pages, "no new tab");

  const toggle = popup.locator('#settings-view input[name="sidePanel"]');
  if (await toggle.isChecked()) await toggle.click();
  await waitFor(() => sw.evaluate(async () => (await chrome.action.getPopup({})).endsWith("popup.html")), "toolbar opens the popup");
  await toggle.click();
  await waitFor(() => sw.evaluate(async () => (await chrome.action.getPopup({})) === ""), "toolbar opens the panel");

  await popup.click("#toggle-settings");
  assert.ok(await popup.locator("#strip").isVisible());
  await toggle.evaluate((el) => el.click()); // back to the popup for the tests that follow
  await popup.close();
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

test("skips .m3u8 and .mpd URLs that answer with something else", async () => {
  const { tab, page } = await visit("/ad-manifest.html");
  // Give the probes of the two ad URLs time to finish before checking.
  await new Promise((r) => setTimeout(r, 1500));
  const media = await sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key].media, `tab:${tab.tabId}`);
  assert.deepEqual(media.map((m) => new URL(m.url).pathname), ["/media/hls/master.m3u8"]);
  await page.close();
});

test("reads a playlist from the page when the server refuses the extension", async () => {
  const { tab, page } = await visit("/page-only.html");
  assert.equal(tab.media[0].durationSec, 2);
  await page.close();
});

test("reads a playlist the server turned away twice", async () => {
  const { tab, page } = await visit("/flaky.html");
  assert.equal(tab.media[0].durationSec, 2);
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

test("labels a stream by the file it saves, and leaves frames in place while it downloads", async () => {
  const { tabId, page } = await visit("/hls-multi.html");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  const frame = popup.locator(".vz-frame").first();
  await frame.waitFor();
  assert.equal(await frame.locator(".vz-badge").textContent(), "MP4");
  await pick("Audio only")(popup);
  assert.equal(await frame.locator(".vz-badge").textContent(), "M4A");
  assert.match(await frame.locator(".vz-frame-name").inputValue(), /\.m4a$/);
  await pick("360p")(popup);
  assert.equal(await frame.locator(".vz-badge").textContent(), "MP4");

  // Count frames put back in the strip and arrival animations replayed: each one is a flash.
  await popup.evaluate(() => {
    window.__moves = 0;
    window.__animations = 0;
    new MutationObserver((records) => (window.__moves += records.length)).observe(document.getElementById("strip"), { childList: true });
    document.getElementById("strip").addEventListener("animationstart", () => window.__animations++);
  });
  await frame.locator(".download").click();
  await frame.locator(".vz-frame-note.is-done").waitFor({ timeout: 60000 });
  assert.deepEqual(await popup.evaluate(() => [window.__moves, window.__animations]), [0, 0]);
  await popup.close();
  await page.close();
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

test("downloads DASH whose length names one segment too many", async () => {
  const { file } = await downloadStream("/dash-tail.html");
  assert.equal(file.video.height, 360);
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

test("downloads WebM DASH (VP9 and Opus) into an MP4 without re-encoding", async () => {
  const { tabId, page, tab } = await visit("/dash-webm.html");
  assert.deepEqual(tab.media[0].variants.map((v) => v.label), ["360p", "Audio only"]);
  const { job, item } = await downloadFromPopup(tabId);
  assert.equal(job.state, "complete", job.error);
  assert.match(job.filename, /\.mp4$/);
  const file = probe(item.filename);
  assert.match(file.format, /mp4/);
  assert.equal(file.video?.codec_name, "vp9");
  assert.equal(file.audio?.codec_name, "opus");
  assert.ok(Math.abs(file.duration - 6) < 0.5, `duration ${file.duration}`);
  assert.equal(execFileSync("ffmpeg", ["-v", "error", "-i", item.filename, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), "");
  await page.close();
});

test("downloads one-file WebM DASH with Vorbis sound as a WebM", async () => {
  const { tabId, page, tab } = await visit("/dash-webm-base.html");
  assert.deepEqual(tab.media.map((m) => m.type), ["dash"]);
  const { job, item } = await downloadFromPopup(tabId);
  assert.equal(job.state, "complete", job.error);
  assert.match(job.filename, /\.webm$/);
  const file = probe(item.filename);
  assert.match(file.format, /webm|matroska/);
  assert.equal(file.video?.codec_name, "vp8");
  assert.equal(file.audio?.codec_name, "vorbis");
  assert.ok(Math.abs(file.duration - 6) < 0.5, `duration ${file.duration}`);
  await page.close();
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

test("warns on encrypted media even without a DRM module", async () => {
  const { tabId, page } = await visit("/encrypted.html");
  await waitFor(
    () => sw.evaluate(async (key) => (await chrome.storage.session.get(key))[key]?.drmKeySystem, `tab:${tabId}`),
    "encrypted media to be noticed",
  );
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  assert.match(await popup.locator(".vz-frame-note").first().textContent(), /DRM-protected/);
  await popup.close();
  await page.close();
});

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

/** Starts recording a live page from the popup; returns what's needed to stop and check it. */
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

test("records a live DASH stream until stopped and keeps what was recorded", async () => {
  const { tabId, page } = await visit("/live-dash-page/stopped.html");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  const button = popup.locator(".vz-frame .download").first();
  await button.click();
  await waitFor(async () => (await button.getAttribute("title")) === "Stop and save", "the stop button");
  await page.waitForTimeout(3000);
  await button.click();
  const job = await finishedJob(tabId, 30000);
  assert.equal(job.state, "complete", job.error);
  const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), job.chromeDownloadId);
  const file = probe(item.filename);
  assert.ok(file.duration >= 5 && file.duration < 16, `duration ${file.duration}`);
  await popup.close();
  await page.close();
});

test("records a live DASH stream to its end on its own", async () => {
  const { tabId, page, tab } = await visit("/live-dash-page/to-end.html");
  assert.equal(tab.media[0].type, "dash");
  assert.equal(tab.media[0].isLive, true);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  const button = popup.locator(".vz-frame .download").first();
  assert.equal(await button.getAttribute("title"), "Record");
  await button.click();
  const job = await finishedJob(tabId, 60000);
  assert.equal(job.state, "complete", job.error);
  const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), job.chromeDownloadId);
  const file = probe(item.filename);
  assert.equal(file.video?.codec_name, "h264");
  assert.equal(file.audio?.codec_name, "aac");
  // It joined three segments behind the live edge, 6 s in, and kept going to the end.
  assert.ok(file.duration > 17 && file.duration < 21, `duration ${file.duration}`);
  await popup.close();
  await page.close();
});

test("settings change the saved name, and saved files are listed in the popup's Saved files view", async () => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('input[name="template"]').fill("%hostname %title");
  await options.locator('input[name="subfolder"]').fill("Vidzilla");
  await options.locator('input[name="subfolder"]').press("Tab");
  await waitFor(
    () => sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.subfolder === "Vidzilla"),
    "settings to save",
  );
  assert.match(await options.locator(".vz-settings-example").textContent(), /^Vidzilla\/example Northern Lights Over Tromsø\.mp4$/);
  // The settings page is settings only; saved files live in the popup.
  assert.equal(await options.locator("#history").count(), 0);

  const { tabId, page } = await visit("/page.html");
  const { job } = await downloadFromPopup(tabId);
  assert.equal(job.state, "complete", job.error);
  assert.equal(job.filename, "Vidzilla/127.0.0.1 Test Clip Fixture Site.mp4");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}&narrow`);
  await popup.locator(".vz-frame").first().waitFor();
  const pages = context.pages().length;
  await popup.click("#open-history");
  assert.equal(context.pages().length, pages, "no new tab");
  assert.ok(await popup.locator("#saved-view").isVisible());
  assert.equal(await popup.locator("#strip").isVisible(), false);
  const row = popup.locator(".vz-history-row").first();
  await row.waitFor();
  assert.equal(await row.locator(".vz-history-file").textContent(), "Vidzilla/127.0.0.1 Test Clip Fixture Site.mp4");
  assert.match(await row.locator(".vz-history-meta").textContent(), /127\.0\.0\.1/);
  await popup.locator("#clear-history").click();
  await popup.locator("#history-empty").waitFor();
  // The head button leads back to the videos.
  assert.equal(await popup.locator("#toggle-settings").getAttribute("title"), "Back to the videos");
  await popup.click("#toggle-settings");
  assert.ok(await popup.locator("#strip").isVisible());
  assert.equal(await popup.locator("#saved-view").isVisible(), false);

  await sw.evaluate(() => chrome.storage.local.remove("settings"));
  await popup.close();
  await options.close();
  await page.close();
});

test("asks for a rating after a few saves, then to share, and the foot offers both again", async () => {
  const asks = () => sw.evaluate(async () => (await chrome.storage.local.get("asks")).asks);
  // Two files saved before this one; the third brings the first review ask.
  await sw.evaluate(() => chrome.storage.local.set({ asks: { saved: 2, reviewAsks: 0, reviewAt: 3, reviewDone: false, shareAt: 6, shareDone: false } }));
  const { tabId, page } = await visit("/page.html");
  const { job } = await downloadFromPopup(tabId);
  assert.equal(job.state, "complete", job.error);
  await waitFor(async () => (await asks())?.due === "review", "review ask due");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}&narrow`);
  const ask = popup.locator("#ask");
  await ask.waitFor();
  assert.equal(await popup.locator("#ask-title").textContent(), "Would you rate Vidzilla?");
  assert.match(await popup.locator("#ask-edge").textContent(), /^3 files saved$/);
  const labels = async () => (await popup.locator("#ask-actions button").allTextContents()).map((t) => t.trim());
  assert.deepEqual(await labels(), ["Rate Vidzilla", "Not now"], "no I already did the first time");
  assert.ok(await popup.locator("#open-folder").isVisible(), "the foot stays in view");
  assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Settings cover it; closing them brings it back.
  await popup.click("#toggle-settings");
  assert.equal(await ask.isVisible(), false);
  await popup.click("#toggle-settings");
  assert.ok(await ask.isVisible());

  // Not now: back a few saves later, now with I already did.
  await popup.locator("#ask-actions button", { hasText: "Not now" }).click();
  await ask.waitFor({ state: "hidden" });
  await sw.evaluate(() =>
    chrome.storage.local.get("asks").then(({ asks }) => chrome.storage.local.set({ asks: { ...asks, due: "review", reviewAsks: 2 } })),
  );
  await ask.waitFor();
  assert.deepEqual(await labels(), ["Rate Vidzilla", "Not now", "I already did"]);
  await popup.locator("#ask-actions button", { hasText: "I already did" }).click();
  await ask.waitFor({ state: "hidden" });
  assert.equal((await asks()).reviewDone, true);

  // The share ask, dismissed once and for good.
  await sw.evaluate(() =>
    chrome.storage.local.get("asks").then(({ asks }) => chrome.storage.local.set({ asks: { ...asks, due: "share" } })),
  );
  await ask.waitFor();
  assert.equal(await popup.locator("#ask-title").textContent(), "Know someone who saves videos?");
  assert.deepEqual(await labels(), ["Copy link", "Not now"]);
  await popup.locator("#ask-actions button", { hasText: "Not now" }).click();
  await ask.waitFor({ state: "hidden" });
  assert.equal((await asks()).shareDone, true);

  // The foot keeps both buttons; Rate opens the store's review page.
  assert.ok(await popup.locator("#share").isVisible());
  const opened = context.waitForEvent("page");
  await popup.click("#rate");
  const store = await opened;
  await waitFor(() => store.url() !== "about:blank" && store.url(), "review tab");
  // The store may add the listing's name to the address.
  assert.match(store.url(), new RegExp(`^https://chromewebstore\\.google\\.com/detail/(.+/)?${extensionId}/reviews$`));
  await store.close();
  await popup.close();
  await sw.evaluate(() => chrome.storage.local.remove("asks"));
  await page.close();
});

test("shows a house ad after a save, for a set time, never on the same save as an ask", async () => {
  const ads = () => sw.evaluate(async () => (await chrome.storage.local.get("ads")).ads);
  const feed = {
    schedule: { firstAfter: 5, every: 4, minHours: 6, seconds: 3 },
    upgradeUrl: "https://example.com/upgrade",
    ads: [{ id: "test", name: "<b>Bloomin</b>", line: "Grows things.", cta: "Get Bloomin", url: "https://example.com/bloomin" }],
  };
  // Four saves so far and no ask pending: the fifth brings the first ad.
  await sw.evaluate(
    (feed) =>
      chrome.storage.local.set({
        adFeed: { feed, fetchedAt: Date.now() },
        ads: { saved: 4, sinceAd: 4, shownAt: 0, next: 0, adFree: false },
        asks: { saved: 4, reviewAsks: 1, reviewAt: 99, reviewDone: true, shareAt: 99, shareDone: true },
      }),
    feed,
  );
  const { tabId, page } = await visit("/page.html");
  const { job } = await downloadFromPopup(tabId);
  assert.equal(job.state, "complete", job.error);
  await waitFor(async () => (await ads())?.due, "ad due");

  const open = async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}&narrow`);
    await popup.locator("#ad").waitFor();
    return popup;
  };
  let popup = await open();
  const close = popup.locator(".vz-ad-close");
  assert.equal(await popup.locator(".vz-ad-name").textContent(), "<b>Bloomin</b>", "ad text is shown as text");
  assert.match(await popup.locator(".vz-ad-edge").textContent(), /^Ad · From the maker of Vidzilla/);
  assert.equal(await popup.locator(".vz-ad-cta").getAttribute("href"), "https://example.com/bloomin");
  assert.equal(await popup.locator(".vz-ad-remove").getAttribute("href"), "https://example.com/upgrade");
  assert.equal(await popup.locator("#strip").isVisible(), false, "the ad takes the strip's place");
  assert.equal(await popup.locator(".vz-popup-foot").isVisible(), false);
  assert.ok(await close.isDisabled());
  assert.match(await close.textContent(), /^Close in [1-3]$/);
  assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  // Settings stay reachable; the countdown waits while they're open.
  await popup.click("#toggle-settings");
  assert.equal(await popup.locator("#ad").isVisible(), false);
  await new Promise((r) => setTimeout(r, 1300));
  const paused = (await ads()).due.remainingMs;
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal((await ads()).due.remainingMs, paused, "no countdown behind settings");
  await popup.click("#toggle-settings");
  await popup.locator("#ad").waitFor();

  // Closing the popup early keeps the time left for next time.
  await new Promise((r) => setTimeout(r, 1300));
  await popup.close();
  const left = (await ads()).due.remainingMs;
  assert.ok(left > 0 && left < 3000, `time left is kept (${left})`);
  popup = await open();
  await popup.locator(".vz-ad-close:enabled").waitFor({ timeout: 5000 });
  assert.equal(await popup.locator(".vz-ad-close").textContent(), "Close");
  await popup.click(".vz-ad-close");
  await popup.locator("#ad").waitFor({ state: "hidden" });
  assert.ok(await popup.locator("#strip").isVisible());
  const after = await ads();
  assert.equal(after.due, undefined);
  assert.equal(after.sinceAd, 0);
  await popup.close();

  // A save that brings up the review ask brings no ad, and drops one that was waiting.
  await sw.evaluate(() =>
    chrome.storage.local.set({
      ads: { saved: 9, sinceAd: 9, shownAt: 1, next: 1, adFree: false },
      asks: { saved: 2, reviewAsks: 0, reviewAt: 3, reviewDone: false, shareAt: 6, shareDone: false },
    }),
  );
  const second = await downloadFromPopup(tabId);
  assert.equal(second.job.state, "complete", second.job.error);
  await waitFor(async () => (await sw.evaluate(async () => (await chrome.storage.local.get("asks")).asks))?.due === "review", "review ask due");
  await waitFor(async () => (await ads()).saved === 10, "ad counter");
  assert.equal((await ads()).due, undefined, "no ad on the same save as the review ask");

  await sw.evaluate(() => chrome.storage.local.remove(["asks", "adFeed"]));
  await sw.evaluate(() => chrome.storage.local.set({ ads: { saved: 0, sinceAd: 0, shownAt: 0, next: 0, adFree: true } }));
  await page.close();
});

test("records a player that hides its stream (Media Source Extensions)", async () => {
  const { tabId, tab, page } = await visit("/mse.html");
  assert.deepEqual(tab.media.map((m) => m.type), ["mse"]);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  const button = popup.locator(".vz-frame .download").first();
  assert.equal(await button.getAttribute("title"), "Record");
  // The video has already played through; Record reloads the page to catch it all.
  const reloaded = page.waitForEvent("load");
  await button.click();
  await reloaded;
  const job = await finishedJob(tabId, 30000);
  assert.equal(job.state, "complete", job.error);
  assert.equal(job.filename, "Hidden Stream Player.mp4");
  const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), job.chromeDownloadId);
  const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", item.filename]).toString().trim().split("\n");
  assert.deepEqual(streams.sort(), ["audio", "video"]);
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", item.filename]).toString());
  assert.ok(duration > 5, `duration ${duration}`);
  await page.waitForSelector('iframe[src^="chrome-extension://"]', { state: "detached" });
  await popup.close();
  await page.close();
});

test("records a player through a probe player and a quality switch, from the start", async () => {
  const { tabId, tab, page } = await visit("/mse-switch.html");
  assert.deepEqual(tab.media.map((m) => m.type), ["mse"]);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  const reloaded = page.waitForEvent("load");
  await popup.locator(".vz-frame .download").first().click();
  await reloaded;
  const job = await finishedJob(tabId, 30000);
  assert.equal(job.state, "complete", job.error);
  const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), job.chromeDownloadId);
  const probe = (entries) => execFileSync("ffprobe", ["-v", "error", ...entries, "-of", "csv=p=0", item.filename]).toString().trim().split("\n");
  // Both tracks run the whole six seconds; the picture switches size at 2 s.
  for (const line of probe(["-show_entries", "stream=codec_type,start_time,duration"])) {
    const [type, start, duration] = line.split(",");
    assert.ok(Number(start) < 0.1 && Number(duration) > 5.5, `${type} ${start} ${duration}`);
  }
  const sizes = new Set(probe(["-select_streams", "v", "-show_entries", "frame=width"]).map((w) => w.replace(/,/g, "")));
  assert.deepEqual([...sizes].sort(), ["320", "640"]);
  assert.equal(execFileSync("ffmpeg", ["-v", "error", "-i", item.filename, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), "");
  await popup.close();
  await page.close();
});

test("a player that would run Media Source in a worker stays on the page and is listed", async () => {
  const { tab, page } = await visit("/mse-worker.html");
  assert.deepEqual(tab.media.map((m) => m.type), ["mse"]);
  assert.equal(await page.evaluate(() => document.querySelector("video").srcObject), null);
  await page.close();
});

test("a page can't start a recording through the capture frame", async () => {
  const before = new Date().toISOString();
  const page = await context.newPage();
  await page.goto(`${site.origin}/page.html`);
  const answer = await page.evaluate(async (src) => {
    const frame = document.createElement("iframe");
    frame.src = src;
    document.body.append(frame);
    await new Promise((r) => frame.addEventListener("load", r, { once: true }));
    const channel = new MessageChannel();
    const reply = new Promise((r) => {
      channel.port1.onmessage = (e) => r(e.data);
      setTimeout(() => r("no reply"), 1500);
    });
    frame.contentWindow.postMessage({ vidzillaCapture: "made-up-job" }, "*", [channel.port2]);
    channel.port1.postMessage({ type: "data", track: 1, init: true, bytes: new ArrayBuffer(8) });
    channel.port1.postMessage({ type: "stop" });
    return reply;
  }, `chrome-extension://${extensionId}/capture.html`);
  assert.equal(answer, "no reply");
  const recent = await sw.evaluate((startedAfter) => chrome.downloads.search({ startedAfter }), before);
  assert.equal(recent.length, 0);
  await page.close();
});

