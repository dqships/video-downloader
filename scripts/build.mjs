// Bundles the extension into dist/. `--watch` rebuilds on change.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (const f of ["popup.css", "options.css"]) cpSync(join(root, "src/ui", f), join(out, f));
  // The settings rows live in one file and go into every page that shows them.
  const fields = readFileSync(join(root, "src/ui/settings-fields.html"), "utf8").replace(/^<!--[\s\S]*?-->\n/, "");
  const page = (f) => readFileSync(join(root, "src/ui", f), "utf8").replace(/^ *<!-- settings-fields -->\n/m, fields);
  writeFileSync(join(out, "options.html"), page("options.html"));
  const popupHtml = page("popup.html");
  writeFileSync(join(out, "popup.html"), popupHtml);
  // The side panel is the popup with a fluid layout that follows the active tab.
  writeFileSync(join(out, "sidepanel.html"), popupHtml.replace('<body class="vz-popup">', '<body class="vz-popup vz-popup--panel">'));
  // The shared design system: tokens, components and the bundled font.
  for (const f of ["tokens.css", "components.css", "fonts"]) {
    cpSync(join(root, "design", f), join(out, "design", f), { recursive: true });
  }
  for (const f of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) {
    cpSync(join(root, "brand", f), join(out, "brand", f));
  }
  cpSync(join(root, "src/offscreen/offscreen.html"), join(out, "offscreen.html"));
  cpSync(join(root, "src/capture/capture.html"), join(out, "capture.html"));
};

const options = {
  entryPoints: {
    sw: join(root, "src/sw/main.ts"),
    popup: join(root, "src/ui/popup.ts"),
    options: join(root, "src/ui/options.ts"),
    offscreen: join(root, "src/offscreen/offscreen.ts"),
    worker: join(root, "src/worker/main.ts"),
    capture: join(root, "src/capture/capture.ts"),
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

// Content scripts can't be modules.
const contentOptions = {
  ...options,
  entryPoints: {
    "eme-main": join(root, "src/content/eme-main.ts"),
    "eme-bridge": join(root, "src/content/eme-bridge.ts"),
    "mse-main": join(root, "src/content/mse-main.ts"),
    "mse-bridge": join(root, "src/content/mse-bridge.ts"),
  },
  format: "iife",
  plugins: [],
};

if (watch) {
  await (await esbuild.context(options)).watch();
  await (await esbuild.context(contentOptions)).watch();
} else {
  await esbuild.build(options);
  await esbuild.build(contentOptions);
}
