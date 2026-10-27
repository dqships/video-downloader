// Builds a deployable copy of the website into site-dist/: the pages plus the
// design/ and brand/ files they use, with paths flattened to one root.
// Usage: node scripts/build-site.mjs
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const out = new URL("site-dist/", root);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of readdirSync(new URL("site/", root))) {
  const text = readFileSync(new URL(`site/${f}`, root), "utf8");
  writeFileSync(new URL(f, out), text.replaceAll("../design/", "design/").replaceAll("../brand/", "brand/"));
}
for (const dir of ["design", "brand"]) cpSync(new URL(dir, root), new URL(dir, out), { recursive: true });
rmSync(new URL("brand/source", out), { recursive: true, force: true });
console.log("site-dist/ written");
