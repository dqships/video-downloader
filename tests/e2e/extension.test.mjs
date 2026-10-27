// End-to-end: loads the built extension into Chromium, visits the fixture
// site, and checks detection, the popup and real downloads.
// Run with `pnpm test:e2e` (needs Playwright with Chromium, and ffprobe).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

async function downloadFromPopup(tabId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.locator(".frame .download").first().click();
  const job = await waitFor(
    () =>
      sw.evaluate(async () => {
        const jobs = Object.values((await chrome.storage.session.get("jobs")).jobs ?? {});
        return jobs.find((j) => j.state !== "running");
      }),
    "download to finish",
    30000,
  );
  const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), job.chromeDownloadId);
  await popup.close();
  await sw.evaluate(() => chrome.storage.session.remove("jobs"));
  return { job, item, popup };
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
  await popup.locator(".frame").first().waitFor();
  assert.equal(await popup.locator(".frame .name").first().inputValue(), "Test Clip Fixture Site.mp4");
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

test("lists an HLS manifest as a stream", async () => {
  const { tab, page } = await visit("/hls.html");
  assert.equal(tab.media[0].type, "hls");
  assert.match(tab.media[0].url, /master\.m3u8$/);
  await page.close();
});
