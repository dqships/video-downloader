// Packs design/icons/*.svg into design/icons.svg, a sprite of <symbol>s, so
// static pages can use <svg><use href="design/icons.svg#i-name"/></svg>.
// The individual files stay the source of truth. Usage: node scripts/make-icon-sprite.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../design/icons/", import.meta.url);
const symbols = readdirSync(dir)
  .filter((f) => f.endsWith(".svg"))
  .sort()
  .map((f) => {
    const src = readFileSync(new URL(f, dir), "utf8");
    const attrs = src.match(/<svg([^>]*)>/)[1].replace(/\s(xmlns|width|height|aria-hidden)="[^"]*"/g, "");
    const body = src.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    return `<symbol id="i-${f.slice(0, -4)}"${attrs}>${body}</symbol>`;
  });
writeFileSync(new URL("../design/icons.svg", import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join("\n")}\n</svg>\n`);
console.log(`design/icons.svg: ${symbols.length} icons`);
