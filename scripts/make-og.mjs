// Makes the website's social preview image (Open Graph / Twitter card):
// brand/og-image.png, 1200×630. Drawn in code from the design tokens and the
// logo, then screenshotted with Playwright's Chromium.
// Usage: node scripts/make-og.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = new URL("../", import.meta.url);
const out = fileURLToPath(new URL("brand/og-image.png", root));

const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="design/tokens.css" />
<style>
  body {
    margin: 0;
    width: 1200px;
    height: 630px;
    display: grid;
    grid-template-rows: 1fr auto;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--font-family);
  }
  .card {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--space-5);
    text-align: center;
  }
  .lockup {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    color: var(--color-text);
  }
  .mark {
    width: calc(var(--space-8) * 1.155);
    height: var(--space-8);
    color: var(--color-primary);
  }
  .word {
    width: calc(var(--space-7) * 5.37);
    height: var(--space-7);
  }
  h1 {
    margin: 0;
    max-width: 18ch;
    font-size: calc(var(--space-9) * 0.84);
    line-height: 0.92;
    font-weight: var(--weight-heavy);
    font-stretch: var(--stretch-wide);
    letter-spacing: var(--tracking-tight);
  }
  .film {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    background: var(--color-film);
  }
  .holes {
    height: var(--space-4);
    margin: 0 calc(-1 * var(--space-2));
    background: repeating-linear-gradient(90deg, var(--color-bg) 0 var(--space-5), transparent var(--space-5) var(--space-7));
    mask: linear-gradient(#000, #000);
    border-radius: var(--radius-sm);
  }
  .edge {
    display: flex;
    justify-content: space-between;
    padding: 0 var(--space-6);
    color: var(--color-film-edge);
    font-size: var(--text-md);
    line-height: var(--text-md-lh);
    font-weight: var(--weight-bold);
    font-stretch: var(--stretch-condensed);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="lockup">
      <svg class="mark" aria-hidden="true"><use href="brand/symbols.svg#vz-mark" /></svg>
      <svg class="word" aria-hidden="true"><use href="brand/symbols.svg#vz-wordmark" /></svg>
    </div>
    <h1>Save the video you're watching.</h1>
  </div>
  <div class="film">
    <div class="holes"></div>
    <div class="edge"><span>VZ 01 · Chrome extension</span><span>MP4 · HLS · DASH · Live</span><span>Free</span></div>
    <div class="holes"></div>
  </div>
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
// Load from the repo root so the stylesheet, font and logo symbols resolve.
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
  return route.fulfill({ path: fileURLToPath(new URL(url.pathname.slice(1), root)) });
});
await page.goto("http://og.local/");
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
