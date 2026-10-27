// Builds a deployable copy of the website into site-dist/: the pages plus the
// design/ and brand/ files they use, with paths flattened to one root, and the
// paste-a-link downloader bundled with the extension's download worker.
// Each page gets the shared parts (site/partials/), its canonical, Open Graph,
// Twitter and JSON-LD tags, and a markdown twin (site/md/). The root files
// for crawlers and agents (robots.txt, sitemap.xml, llms.txt) are written
// from site/pages.mjs. The build fails if a page breaks the launch rules
// (title and description length, one h1) or if an inline script isn't
// allowed by the Content-Security-Policy in vercel.json.
// Usage: node scripts/build-site.mjs [outDir]   (default site-dist/)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { notFoundMarkdown, origin, pages, repoUrl, supportEmail } from "../site/pages.mjs";
import { release } from "../site/release.js";

const root = new URL("../", import.meta.url);
const out = process.argv[2] ? pathToFileURL(`${process.argv[2].replace(/\/$/, "")}/`) : new URL("site-dist/", root);
const read = (path) => readFileSync(new URL(path, root), "utf8");
// Root-absolute asset paths, so the 404 page works at any depth.
const flatten = (text) => text.replaceAll("../design/", "/design/").replaceAll("../brand/", "/brand/");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const partials = Object.fromEntries(
  readdirSync(new URL("site/partials/", root)).map((f) => [f.replace(/\.html$/, ""), read(`site/partials/${f}`).trimEnd()]),
);
const fill = (text) => text.replaceAll("{{origin}}", origin).replaceAll("{{supportEmail}}", supportEmail).replaceAll("{{repoUrl}}", repoUrl).replaceAll("{{storeUrl}}", release.storeUrl);
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const pageUrl = (path) => origin + path;

/** The last commit date of a source file, or today when git can't say (shallow clones). */
function lastmod(file) {
  try {
    const date = execFileSync("git", ["log", "-1", "--format=%cs", "--", file], { cwd: fileURLToPath(root) }).toString().trim();
    if (date) return date;
  } catch {}
  return new Date().toISOString().slice(0, 10);
}

const CSP = JSON.parse(read("vercel.json"))
  .headers.flatMap((h) => h.headers)
  .find((h) => h.key === "Content-Security-Policy")?.value;
if (!CSP) throw new Error("vercel.json has no Content-Security-Policy header");

const problems = [];

function structuredData(page, title, description) {
  const org = `${origin}/#organization`;
  const app = `${origin}/#app`;
  const types = { "/about": "AboutPage", "/contact": "ContactPage" };
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": org,
        name: "Vidzilla",
        url: `${origin}/`,
        logo: `${origin}/brand/app-icon-512.png`,
        email: supportEmail,
        address: { "@type": "PostalAddress", addressRegion: "MI", addressCountry: "US" },
        sameAs: [repoUrl],
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: supportEmail,
          url: `${origin}/contact`,
          availableLanguage: "en",
        },
      },
      {
        "@type": "WebApplication",
        "@id": app,
        name: "Vidzilla",
        description: "A Chrome extension that finds the video playing on a page and saves it to your computer as a file.",
        url: `${origin}/`,
        image: `${origin}/brand/og-image.png`,
        applicationCategory: "MultimediaApplication",
        applicationSubCategory: "Browser extension",
        operatingSystem: "Windows, macOS, Linux, ChromeOS",
        browserRequirements: "Requires Google Chrome 116 or later",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": org },
      },
      {
        "@type": types[page.path] ?? "WebPage",
        "@id": pageUrl(page.path),
        url: pageUrl(page.path),
        name: title,
        description,
        inLanguage: "en",
        isPartOf: { "@type": "WebSite", "@id": `${origin}/#website`, name: "Vidzilla", url: `${origin}/` },
        about: { "@id": app },
      },
    ],
  };
}

function meta(page, title, description) {
  const image = `${origin}/brand/og-image.png`;
  const tags = [
    page && `<link rel="canonical" href="${pageUrl(page.path)}" />`,
    `<meta name="is-agentic-site-type" content="app" />`,
    page && `<link rel="alternate" type="text/markdown" href="${pageUrl(page.path === "/" ? "/index.md" : `${page.path}.md`)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Vidzilla" />`,
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:description" content="${escape(description)}" />`,
    page && `<meta property="og:url" content="${pageUrl(page.path)}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="The Vidzilla logo above the words: Save the video you're watching." />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(title)}" />`,
    `<meta name="twitter:description" content="${escape(description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    page && `<script type="application/ld+json">${JSON.stringify(structuredData(page, title, description)).replaceAll("<", "\\u003c")}</script>`,
  ];
  return tags.filter(Boolean).join("\n    ");
}

function buildPage(file, page) {
  let html = read(`site/${file}.html`);
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
  const description = html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1];
  const check = (ok, message) => ok || problems.push(`${file}.html: ${message}`);
  check(title && title.length >= 30 && title.length <= 60, `title must be 30–60 characters (${title?.length})`);
  check(description && description.length >= 120 && description.length <= 160, `description must be 120–160 characters (${description?.length})`);
  check((html.match(/<h1[\s>]/g) ?? []).length === 1, "needs exactly one <h1>");

  html = html.replace("<!-- vz:meta -->", meta(page, title, description));
  for (const [name, text] of Object.entries(partials)) html = html.replace(`    <!-- vz:${name} -->`, text);
  check(!html.includes("<!-- vz:"), "has an unknown <!-- vz: --> marker");

  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const hash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
    check(CSP.includes(hash), `an inline script isn't allowed by the CSP in vercel.json; add ${hash} to script-src`);
  }
  writeFileSync(new URL(`${file}.html`, out), flatten(html));
}

for (const page of pages) {
  buildPage(page.file, page);
  writeFileSync(new URL(`${page.file}.md`, out), fill(read(`site/md/${page.file}.md`)));
}
buildPage("404", null);
writeFileSync(new URL("404.md", out), notFoundMarkdown);
if (problems.length) throw new Error(`The site breaks the launch rules:\n  ${problems.join("\n  ")}`);

// Scripts and styles, minified one by one (the modules keep their imports).
const minify = async (text, loader) => (await esbuild.transform(text, { loader, minify: true, target: "chrome116" })).code;
for (const f of readdirSync(new URL("site/", root))) {
  if (f.endsWith(".js")) writeFileSync(new URL(f, out), await minify(flatten(read(`site/${f}`)), "js"));
}
// One stylesheet instead of three chained ones, for a faster first paint.
const styles = [read("design/tokens.css").replaceAll("url(\"fonts/", "url(\"/design/fonts/"), read("design/components.css"), read("site/site.css")];
writeFileSync(new URL("styles.css", out), await minify(styles.join("\n"), "css"));
for (const dir of ["design", "brand"]) cpSync(new URL(dir, root), new URL(dir, out), { recursive: true });
rmSync(new URL("brand/source", out), { recursive: true, force: true });

// Files at the root for crawlers and agents.
writeFileSync(
  new URL("robots.txt", out),
  `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`,
);
writeFileSync(
  new URL("sitemap.xml", out),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map((p) => `  <url><loc>${pageUrl(p.path)}</loc><lastmod>${lastmod(`site/${p.file}.html`)}</lastmod></url>`)
  .join("\n")}
</urlset>
`,
);
const describe = (file) => read(`site/${file}.html`).match(/<meta\s+name="description"\s+content="([^"]*)"/)[1];
const label = { index: "Home", about: "About", pricing: "Pricing", contact: "Contact", privacy: "Privacy policy" };
writeFileSync(
  new URL("llms.txt", out),
  `# Vidzilla

> Vidzilla is a free Chrome extension that finds the video playing on a page and saves it to your computer as a file, at the quality the site sent. It saves direct video files, HLS (.m3u8) and DASH (.mpd) streams, audio on its own, subtitles and live streams, and leaves DRM-protected video alone. Everything runs in the browser: no servers, no account, no tracking.

Every page below is also served as markdown: request its URL with \`Accept: text/markdown\`, or add \`.md\` as linked here.

## Pages

${pages.map((p) => `- [${label[p.file]}](${origin}/${p.file}.md): ${describe(p.file)}`).join("\n")}

## Optional

- [Source code](${repoUrl}): the extension and this website, on GitHub
`,
);

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
console.log(`${fileURLToPath(out)} written`);
