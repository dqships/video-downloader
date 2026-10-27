// Renders assets/icons/icon.svg to the PNG sizes the manifest needs.
// Needs Playwright with Chromium: `node scripts/make-icons.cjs`.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("playwright");

const dir = join(__dirname, "../assets/icons");
const svg = readFileSync(join(dir, "icon.svg"), "utf8");

(async () => {
  const browser = await chromium.launch();
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
    await page.screenshot({ path: join(dir, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
  await browser.close();
})();
