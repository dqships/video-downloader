// Builds the Vidzilla logo files in brand/ from the geometry in DESIGN.md.
// The mark is constructed, not drawn: a play triangle turned to point down
// (download), cut by a chevron into a V and a rhombus (the piece you take).
// Usage: node scripts/make-brand.mjs   (PNG export needs Playwright)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const INK = "#1b1713";
const PAPER = "#f3eee4";
const VERMILION_LIGHT = "#c43716";
const VERMILION_DARK = "#ff6633";
const FILM = "#17130f";

const r = (n) => +n.toFixed(2);

/**
 * Mark geometry on a 96-unit grid. The triangle is equilateral (sides at 60°).
 * a: half-width of the rhombus; g: gap between V and rhombus, measured square
 * to the cut. Returns path data for the V and the rhombus.
 */
export function markPaths({ a = 12, g = 5 } = {}) {
  const t = Math.sqrt(3);
  const x0 = 4, x1 = 92, y0 = 14, cx = 48;
  const apex = y0 + (cx - x0) * t;
  const left = [cx - a, apex - a * t];
  const right = [cx + a, apex - a * t];
  const top = apex - 2 * a * t;
  const peak = top - 2 * g; // a perpendicular offset g along a 60° edge is 2g vertically
  const xi = (peak - y0 + (cx + x0) * t) / (2 * t);
  const yi = y0 + (xi - x0) * t;
  return {
    v: `M${x0} ${y0}H${x1}L${r(2 * cx - xi)} ${r(yi)}L${cx} ${r(peak)}L${r(xi)} ${r(yi)}Z`,
    drop: `M${cx} ${r(top)}L${r(right[0])} ${r(right[1])}L${cx} ${r(apex)}L${r(left[0])} ${r(left[1])}Z`,
    box: { x: x0, y: y0, w: x1 - x0, h: r(apex - y0) },
  };
}

const word = JSON.parse(readFileSync(new URL("../brand/source/wordmark-outline.json", import.meta.url)));
// Wordmark: Archivo, width 125, weight 800, tracking -0.03em, outlined.
const WORD = { d: word.d.replace(/-?\d+\.\d+/g, (n) => String(+(+n).toFixed(1))), x: 0, y: -725, w: Math.ceil(word.width), h: 737 };

const svg = (viewBox, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

function mark(color, opts) {
  const m = markPaths(opts);
  return svg(`${m.box.x} ${m.box.y} ${m.box.w} ${m.box.h}`, `<path fill="${color}" d="${m.v}${m.drop}"/>`, "Vidzilla");
}

function lockup(markColor, wordColor) {
  const m = markPaths();
  const s = WORD.h / m.box.h * 0.985; // mark spans ascender to baseline
  const gap = 260;
  const mw = m.box.w * s;
  const body =
    `<g transform="translate(0 ${WORD.y}) scale(${r(s)}) translate(${-m.box.x} ${-m.box.y})"><path fill="${markColor}" d="${m.v}${m.drop}"/></g>` +
    `<path fill="${wordColor}" transform="translate(${r(mw + gap)} 0)" d="${WORD.d}"/>`;
  return svg(`0 ${WORD.y} ${Math.ceil(mw + gap + WORD.w)} ${WORD.h}`, body, "Vidzilla");
}

function symbols() {
  const m = markPaths();
  return (
    `<svg xmlns="http://www.w3.org/2000/svg">` +
    `<symbol id="vz-mark" viewBox="${m.box.x} ${m.box.y} ${m.box.w} ${m.box.h}"><path fill="currentColor" d="${m.v}"/><path class="vz-mark-drop" fill="currentColor" d="${m.drop}"/></symbol>` +
    `<symbol id="vz-wordmark" viewBox="${WORD.x} ${WORD.y} ${WORD.w} ${WORD.h}"><path fill="currentColor" d="${WORD.d}"/></symbol>` +
    `</svg>\n`
  );
}

function appIcon(size, { tile = FILM, color = VERMILION_DARK } = {}) {
  // Small sizes open the cut so it survives the pixel grid.
  const g = size <= 16 ? 9 : size <= 32 ? 7 : 5;
  const m = markPaths({ a: 12, g });
  const pad = size <= 32 ? 10 : 16;
  const scale = (96 - 2 * pad) / m.box.w;
  const ty = (96 - m.box.h * scale) / 2;
  const radius = size <= 16 ? 18 : 22;
  return svg(
    "0 0 96 96",
    `<rect width="96" height="96" rx="${radius}" fill="${tile}"/>` +
      `<g transform="translate(${pad} ${r(ty)}) scale(${r(scale)}) translate(${-m.box.x} ${-m.box.y})"><path fill="${color}" d="${m.v}${m.drop}"/></g>`,
    "Vidzilla",
  );
}

function toolbarIcon(size) {
  // Chrome's toolbar sits on light and dark themes; the bare vermilion mark reads on both.
  const g = size <= 16 ? 9 : size <= 32 ? 7 : 5;
  const m = markPaths({ a: 12, g });
  const pad = 4;
  const scale = (96 - 2 * pad) / m.box.w;
  const ty = (96 - m.box.h * scale) / 2;
  return svg(
    "0 0 96 96",
    `<g transform="translate(${pad} ${r(ty)}) scale(${r(scale)}) translate(${-m.box.x} ${-m.box.y})"><path fill="${VERMILION_LIGHT}" d="${m.v}${m.drop}"/></g>`,
    "Vidzilla",
  );
}

const out = new URL("../brand/", import.meta.url);
mkdirSync(out, { recursive: true });
const files = {
  "mark.svg": mark(VERMILION_LIGHT),
  "mark-dark.svg": mark(VERMILION_DARK),
  "mark-ink.svg": mark(INK),
  "wordmark.svg": svg(`${WORD.x} ${WORD.y} ${WORD.w} ${WORD.h}`, `<path fill="${INK}" d="${WORD.d}"/>`, "Vidzilla"),
  "lockup.svg": lockup(VERMILION_LIGHT, INK),
  "lockup-dark.svg": lockup(VERMILION_DARK, PAPER),
  "app-icon.svg": appIcon(128),
  "favicon.svg": appIcon(32),
  // Symbols for inline use: <svg><use href="brand/symbols.svg#vz-mark"/></svg>, coloured with `color`.
  "symbols.svg": symbols(),
};
for (const [name, body] of Object.entries(files)) writeFileSync(new URL(name, out), body);

// PNG exports: toolbar icons (transparent) and app icon tiles.
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright"));
} catch {
  console.warn("Playwright not found; skipped PNG export.");
  process.exit(0);
}
const browser = await chromium.launch();
const page = await browser.newPage();
const png = async (name, svgText, size) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svgText.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: new URL(name, out).pathname, omitBackground: true });
};
for (const size of [16, 32, 48, 128]) {
  await png(`icon-${size}.png`, toolbarIcon(size), size);
  await png(`app-icon-${size}.png`, appIcon(size), size);
}
await png("app-icon-512.png", appIcon(512), 512);
await browser.close();
console.log("brand/ written");
