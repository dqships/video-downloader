// Bundles the extension into dist/. `--watch` rebuilds on change.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const watch = process.argv.includes("--watch");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const copyStatic = () => {
  cpSync(join(root, "src/manifest.json"), join(out, "manifest.json"));
  for (const f of ["popup.html", "popup.css", "tokens.css"]) cpSync(join(root, "src/ui", f), join(out, f));
  cpSync(join(root, "src/offscreen/offscreen.html"), join(out, "offscreen.html"));
  cpSync(join(root, "assets/icons"), join(out, "icons"), { recursive: true });
};

const options = {
  entryPoints: {
    sw: join(root, "src/sw/main.ts"),
    popup: join(root, "src/ui/popup.ts"),
    offscreen: join(root, "src/offscreen/offscreen.ts"),
    worker: join(root, "src/worker/main.ts"),
  },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
  plugins: [{ name: "static", setup: (b) => b.onEnd(copyStatic) }],
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
