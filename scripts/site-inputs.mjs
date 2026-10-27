// What the website on Vercel is made of, so a commit that touches none of it
// (extension-only work) can skip the Vercel deployment (scripts/vercel-ignore.mjs).
// The site is site/, design/ and brand/, the Vercel functions and config, the
// build script, and the extension modules the paste-a-link downloader bundles,
// found by following imports from the bundle entries. When the site build
// starts reading something new, add it to sitePaths.
import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

// The site's esbuild entries (scripts/build-site.mjs bundles these).
export const bundleEntries = { paste: "src/web/paste.ts", worker: "src/worker/main.ts" };

// Folders (ending in /) and files the site build or Vercel reads directly.
export const sitePaths = [
  "site/",
  "design/",
  "brand/",
  "api/",
  "middleware.js",
  "vercel.json",
  ".vercelignore",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "scripts/build-site.mjs",
  "scripts/site-inputs.mjs",
  "scripts/vercel-ignore.mjs",
];

const imports = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
const extensions = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"];

/** Every repo file the bundle entries pull in, following relative imports. */
export function bundledFiles(root) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!/\.(m?js|tsx?)$/.test(file)) return;
    for (const [, spec] of readFileSync(new URL(file, root), "utf8").matchAll(imports)) {
      const base = posix.join(posix.dirname(file), spec);
      const found = extensions.map((ext) => base + ext).find((f) => {
        const url = new URL(f, root);
        return existsSync(url) && statSync(url).isFile();
      });
      if (found) visit(found);
    }
  };
  for (const entry of Object.values(bundleEntries)) visit(entry);
  return seen;
}

/** The changed paths (repo-relative) that the website is built from. */
export function siteChanges(changed, root) {
  const bundled = bundledFiles(root);
  return changed.filter((f) => bundled.has(f) || sitePaths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
}
