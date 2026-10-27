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
  for (const f of ["popup.html", "popup.css"]) cpSync(join(root, "src/ui", f), join(out, f));
  // The shared design system: tokens, components and the bundled font.
  for (const f of ["tokens.css", "components.css", "fonts"]) {
    cpSync(join(root, "design", f), join(out, "design", f), { recursive: true });
  }
  for (const f of ["mark.svg", "mark-dark.svg", "icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) {
    cpSync(join(root, "brand", f), join(out, "brand", f));
  }
  cpSync(join(root, "src/offscreen/offscreen.html"), join(out, "offscreen.html"));
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
  loader: { ".svg": "text" },
  plugins: [{ name: "static", setup: (b) => b.onEnd(copyStatic) }],
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
