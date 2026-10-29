// Serves site-dist/ the way Vercel will: vercel.json's clean URLs and headers,
// the routing middleware (markdown negotiation), 404.html with a 404 status,
// and empty stand-ins for Vercel's own /_vercel/ scripts. Not Vercel itself, but close enough to check the site before a deploy.
// Usage: node scripts/build-site.mjs && node scripts/serve-site.mjs [port]
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const { default: middleware, config: middlewareConfig } = await import(pathToFileURL(join(root, "middleware.js")).href);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

// The sources in vercel.json and the middleware matcher are written as plain regexes.
const matches = (source, path) => new RegExp(`^${source}$`).test(path);

function file(dist, path) {
  const candidates = path.endsWith("/") ? [`${path}index.html`] : [path, `${path}.html`];
  for (const c of candidates) {
    const full = join(dist, normalize(c).replace(/^(\.\.[/\\])+/, ""));
    try {
      if (statSync(full).isFile()) return full;
    } catch {}
  }
  return null;
}

// Header names are case-insensitive, so later sets replace earlier ones whatever their case.
const merge = (...sets) => Object.fromEntries(sets.reduce((all, set) => (new Headers(set).forEach((v, k) => all.set(k, v)), all), new Headers()));

function headersFor(path) {
  const out = {};
  for (const rule of config.headers) if (matches(rule.source, path)) for (const h of rule.headers) out[h.key] = h.value;
  return out;
}

async function handle(dist, req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = decodeURIComponent(url.pathname);
  const headers = headersFor(path);

  if (config.cleanUrls && /\.html$/.test(path)) {
    const clean = path.replace(/(index)?\.html$/, "");
    return void res.writeHead(308, merge(headers, { Location: clean || "/" })).end();
  }

  let extra = {};
  if (middlewareConfig.matcher.some((m) => matches(m, path))) {
    const request = new Request(url, { headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string") });
    const response = await middleware(request);
    if (response) {
      const rewrite = response.headers.get("x-middleware-rewrite");
      if (!rewrite) {
        res.writeHead(response.status, merge(headers, response.headers));
        return void res.end(Buffer.from(await response.arrayBuffer()));
      }
      path = new URL(rewrite).pathname;
      extra = Object.fromEntries([...response.headers].filter(([k]) => k !== "x-middleware-rewrite"));
    }
  }

  // Vercel serves its own /_vercel/ scripts (Web Analytics); here they're empty, so pages load cleanly.
  if (/^\/_vercel\/[\w-]+\/script\.js$/.test(path)) {
    return void res.writeHead(200, merge({ "Content-Type": TYPES[".js"] }, headers)).end("");
  }

  const found = file(dist, path);
  if (!found) {
    const body = readFileSync(join(dist, "404.html"));
    return void res.writeHead(404, merge({ "Content-Type": TYPES[".html"] }, headers)).end(body);
  }
  res.writeHead(200, merge({ "Content-Type": TYPES[extname(found)] ?? "application/octet-stream" }, headers, extra));
  res.end(readFileSync(found));
}

/** Serves a built site; dist defaults to site-dist/. */
export function serveSite(port = 0, dist = join(root, "site-dist")) {
  const server = createServer((req, res) =>
    handle(dist, req, res).catch((e) => {
      console.error(e);
      res.writeHead(500).end();
    }),
  );
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { origin } = await serveSite(Number(process.argv[2] ?? 4173));
  console.log(`site-dist/ at ${origin}`);
}
