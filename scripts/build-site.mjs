// Builds a deployable copy of the website into site-dist/: the pages plus the
// design/ and brand/ files they use, with paths flattened to one root, and the
// paste-a-link downloader bundled with the extension's download worker.
// Usage: node scripts/build-site.mjs
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

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
await esbuild.build({
  entryPoints: {
    paste: fileURLToPath(new URL("src/web/paste.ts", root)),
    worker: fileURLToPath(new URL("src/worker/main.ts", root)),
  },
  outdir: fileURLToPath(out),
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
  logLevel: "warning",
  loader: { ".svg": "text" },
});
console.log("site-dist/ written");
