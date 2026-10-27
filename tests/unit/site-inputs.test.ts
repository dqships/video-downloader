import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS build module
import { bundleEntries, bundledFiles, siteChanges } from "../../scripts/site-inputs.mjs";

const root = new URL("../../", import.meta.url);

describe("site inputs", () => {
  it("covers every repo file the site's bundles and Vercel functions read", async () => {
    const result = await esbuild.build({
      entryPoints: [...Object.values(bundleEntries as Record<string, string>), "middleware.js", "api/checkout.js", "api/license.js"],
      absWorkingDir: new URL(".", root).pathname,
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "node",
      outdir: "out",
      loader: { ".svg": "text" },
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).filter((f) => !f.includes("node_modules"));
    expect(inputs.length).toBeGreaterThan(10);
    expect(siteChanges(inputs, root)).toEqual(inputs);
  });

  it("follows imports into the extension code the paste box shares", () => {
    const files = bundledFiles(root) as Set<string>;
    expect(files.has("src/shared/hls.ts")).toBe(true);
    expect(files.has("src/capture/mux.ts")).toBe(true);
    expect(files.has("src/content/mse-main.ts")).toBe(false);
  });

  it("ignores extension-only changes and keeps website ones", () => {
    const changed = [
      "README.md",
      ".gitignore",
      "store/README.md",
      "tests/unit/hls.test.ts",
      "src/sw/sites.ts",
      "src/ui/popup.ts",
      "scripts/build.mjs",
      "site/index.html",
      "src/shared/hls.ts",
      "vercel.json",
    ];
    expect(siteChanges(changed, root)).toEqual(["site/index.html", "src/shared/hls.ts", "vercel.json"]);
  });
});
