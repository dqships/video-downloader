// Captures the popup in light and dark mode, narrow and wide, for visual
// review. Usage: pnpm build && node scripts/screenshots.mjs [outDir]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../tests/e2e/server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const out = resolve(process.argv[2] ?? "screenshots");
mkdirSync(out, { recursive: true });

const site = await startServer();
const profile = mkdtempSync(join(tmpdir(), "vd-shots-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;

  const page = await context.newPage();
  await page.goto(`${site.origin}/mixed.html`);
  let tab;
  for (let i = 0; i < 75 && !(tab?.media.length >= 2 && tab.title); i++) {
    await page.waitForTimeout(200);
    tab = await sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t && (await chrome.storage.session.get(`tab:${t.id}`))[`tab:${t.id}`];
    }, `${site.origin}/mixed.html`);
  }
  if (!tab) throw new Error("media not detected");

  // A fake in-progress job so the progress state is visible.
  const mp4 = tab.media.find((m) => m.type === "http");
  await sw.evaluate(
    ({ tabId, mediaId }) =>
      chrome.storage.session.set({
        jobs: {
          demo: {
            jobId: "demo", mediaId, tabId, filename: "demo.mp4", state: "running", phase: "fetching",
            bytesReceived: 1_100_000, totalBytes: 1_754_114, saveAs: false, startedAt: Date.now(),
          },
        },
      }),
    { tabId: tab.tabId, mediaId: mp4.id },
  );

  const shoot = async (name, url, scheme, width) => {
    const p = await context.newPage();
    await p.emulateMedia({ colorScheme: scheme });
    await p.setViewportSize({ width, height: 600 });
    await p.goto(url);
    await p.waitForTimeout(400);
    const body = await p.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.body.scrollHeight }));
    if (body.w > width) console.warn(`${name}: content overflows (${body.w}px > ${width}px)`);
    await p.setViewportSize({ width, height: Math.ceil(body.h) + 2 });
    await p.screenshot({ path: join(out, `${name}.png`) });
    await p.close();
  };

  for (const scheme of ["light", "dark"]) {
    // Narrow: the real popup width. Wide: the popup opened as a tab.
    await shoot(`popup-${scheme}-narrow`, `chrome-extension://${id}/popup.html?tabId=${tab.tabId}&narrow=1`, scheme, 380);
    await shoot(`popup-${scheme}-wide`, `chrome-extension://${id}/popup.html?tabId=${tab.tabId}`, scheme, 760);
    await shoot(`popup-${scheme}-empty`, `chrome-extension://${id}/popup.html?tabId=999999&narrow=1`, scheme, 380);
  }
  console.log(`screenshots in ${out}`);
} finally {
  await context.close();
  site.server.close();
  rmSync(profile, { recursive: true, force: true });
}
