// Makes the Chrome Web Store images: five 1280×800 screenshots of the real
// popup and settings page, the 440×280 small promo tile and the 1400×560
// marquee. Usage: pnpm build && node scripts/store-assets.mjs [outDir]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../tests/e2e/server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const out = resolve(process.argv[2] ?? join(root, "store"));
mkdirSync(out, { recursive: true });

const site = await startServer(0, { cors: true });
const media = (p) => `/media/${p}`;
const fetches = (...urls) => `<script>(async () => { for (const u of ${JSON.stringify(urls)}) await fetch(u); })()</script>`;

/** Stand-in video stills: simple landscapes, so the list doesn't show empty frames. */
const still = (sky, glow, land) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="${glow}"/></linearGradient></defs>
  <rect width="160" height="90" fill="url(#s)"/>
  <path d="M0 62 L30 48 L52 58 L80 40 L108 56 L130 46 L160 60 V90 H0Z" fill="${land}"/></svg>`;
const stills = {
  "/stills/aurora.svg": still("#0b1630", "#2fbf8f", "#0a0f14"),
  "/stills/harbour.svg": still("#26425f", "#e9a26a", "#14202b"),
  "/stills/ridge.svg": still("#f2c27b", "#f6e3c4", "#5b4636"),
};

// Pages on made-up sites, so the popup shows believable titles.
const pages = {
  "http://www.lumen-films.example/tromso": `<title>Northern Lights Over Tromsø, Full Timelapse</title><meta property="og:image" content="/stills/aurora.svg">
    <video src="${media("clip.mp4")}" muted autoplay></video>
    ${fetches(media("hls-multi/master.m3u8"), media("hls-multi/360p.m3u8"))}`,
  "http://live.harbour-cam.example/": `<title>Harbour Cam, Live</title><meta property="og:image" content="/stills/harbour.svg">${fetches("/live/index.m3u8")}`,
  "http://www.trailnotes.example/ridge-walk": `<title>Ridge Walk at First Light</title><meta property="og:image" content="/stills/ridge.svg"><video muted></video><script>
    const ms = new MediaSource();
    document.querySelector("video").src = URL.createObjectURL(ms);
    const get = (p) => fetch(${JSON.stringify(media("dash/"))} + p).then((r) => r.arrayBuffer());
    const append = (sb, data) => new Promise((r) => { sb.addEventListener("updateend", r, { once: true }); sb.appendBuffer(data); });
    ms.addEventListener("sourceopen", async () => {
      const v = ms.addSourceBuffer('video/mp4; codecs="avc1.64001e"');
      await append(v, await get("init-0.m4s"));
      await append(v, await get("chunk-0-00001.m4s"));
    });
  </script>`,
};

// The made-up sites resolve to this server: it answers their pages and passes
// everything else to the fixture server, so media requests are real traffic.
const front = createServer((req, res) => {
  const html = pages[`http://${req.headers.host}${req.url}`];
  if (html) return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  if (stills[req.url]) return void res.writeHead(200, { "content-type": "image/svg+xml" }).end(stills[req.url]);
  const target = new URL(req.url, site.origin);
  req.pipe(
    request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    }),
  );
});
await new Promise((r) => front.listen(0, "127.0.0.1", r));

/** Captures taller than this are cut off, so they fit beside the copy. */
const MAX_CAPTURE_HEIGHT = 560;

const TYPES = { ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const STORE = "https://store-assets.vidzilla.example/";

const profile = mkdtempSync(join(tmpdir(), "vz-store-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  deviceScaleFactor: 2,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    `--host-resolver-rules=MAP *.example 127.0.0.1:${front.address().port}`,
    "--no-proxy-server",
  ],
});
try {
  // The template and the design files it uses, served from the repo.
  await context.route(`${STORE}**`, (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    const file = path.startsWith("store/captures/") ? join(out, path.slice("store/captures/".length)) : join(root, path);
    route.fulfill({ contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;

  const tabOf = async (url, ready) => {
    const page = await context.newPage();
    await page.goto(url);
    for (let i = 0; i < 75; i++) {
      const tab = await sw.evaluate(async (u) => {
        const [t] = await chrome.tabs.query({ url: u });
        return t && (await chrome.storage.session.get(`tab:${t.id}`))[`tab:${t.id}`];
      }, url);
      if (tab?.title && ready(tab)) return tab;
      await page.waitForTimeout(200);
    }
    throw new Error(`media not detected on ${url}`);
  };

  /** Captures an extension page at its CSS width; returns that width. */
  const capture = async (name, url, scheme, width) => {
    const p = await context.newPage();
    await p.emulateMedia({ colorScheme: scheme });
    await p.setViewportSize({ width, height: 800 });
    await p.goto(url);
    await p.waitForTimeout(600);
    const h = await p.evaluate(() => document.body.scrollHeight);
    // Long pages are cut at the fold, as a browser window would show them.
    await p.setViewportSize({ width, height: Math.min(Math.ceil(h), MAX_CAPTURE_HEIGHT) });
    await p.screenshot({ path: join(out, `${name}.png`) });
    await p.close();
    return width;
  };

  const tromso = await tabOf("http://www.lumen-films.example/tromso", (t) => t.media.length >= 2);
  const live = await tabOf("http://live.harbour-cam.example/", (t) => t.media.some((m) => m.live || m.type === "hls"));
  const ridge = await tabOf("http://www.trailnotes.example/ridge-walk", (t) => t.media.some((m) => m.type === "mse"));

  const popup = (tab) => `chrome-extension://${id}/popup.html?tabId=${tab.tabId}&narrow=1`;
  const shots = [];
  shots.push({ img: "cap-list", w: await capture("cap-list", popup(tromso), "light", 380), theme: "light",
    title: "Save the video you're watching.", lede: "Vidzilla lists the video on the page. Pick a quality and it's saved as a file." });

  // A job part way through, for the progress view.
  const hls = tromso.media.find((m) => m.type === "hls") ?? tromso.media[0];
  await sw.evaluate(
    ({ tabId, mediaId }) =>
      chrome.storage.session.set({
        jobs: { demo: { jobId: "demo", mediaId, tabId, filename: "Northern Lights Over Tromsø, Full Timelapse.mp4", state: "running", phase: "fetching",
          bytesReceived: 61_400_000, totalBytes: 96_800_000, saveAs: false, startedAt: Date.now() - 9_000 } },
      }),
    { tabId: tromso.tabId, mediaId: hls.id },
  );
  shots.push({ img: "cap-progress", w: await capture("cap-progress", popup(tromso), "dark", 380), theme: "dark",
    title: "One file, at full quality.", lede: "Streams are joined into a single MP4. Nothing is re-encoded." });
  await sw.evaluate(() => chrome.storage.session.remove("jobs"));

  shots.push({ img: "cap-live", w: await capture("cap-live", popup(live), "light", 380), theme: "light",
    title: "Record live streams.", lede: "Press Record, and Stop when you have what you want." });
  shots.push({ img: "cap-player", w: await capture("cap-player", popup(ridge), "dark", 380), theme: "dark",
    title: "Hidden players, too.", lede: "Record reloads the page and keeps what the player loads, from the start." });

  await sw.evaluate(() => {
    const now = Date.now();
    return chrome.storage.local.set({
      history: [
        { id: "h1", filename: "Northern Lights Over Tromsø, Full Timelapse.mp4", pageUrl: "http://www.lumen-films.example/tromso", bytes: 96_800_000, quality: "1080p", savedAt: now - 60_000 },
        { id: "h2", filename: "Harbour Cam, Live.mp4", pageUrl: "http://live.harbour-cam.example/", bytes: 212_000_000, quality: "720p", recorded: true, savedAt: now - 3_600_000 },
        { id: "h3", filename: "Morning Bulletin.m4a", pageUrl: "https://news.example.org/story/1", bytes: 3_100_000, quality: "Audio only", savedAt: now - 86_400_000 },
      ],
    });
  });
  shots.push({ img: "cap-settings", w: await capture("cap-settings", `chrome-extension://${id}/options.html`, "light", 560), theme: "light",
    title: "Your names, your folder.", lede: "Pick a filename pattern and a folder inside Downloads." });

  const render = async (name, query, width, height) => {
    const p = await context.newPage();
    await p.setViewportSize({ width, height });
    await p.goto(`${STORE}store/template.html?${new URLSearchParams(query)}`);
    await p.waitForSelector("body[data-ready]");
    // Store images are exactly the listed size, so render at 1×.
    const shot = await p.screenshot({ type: "png", scale: "css" });
    await p.close();
    writeFileSync(join(out, `${name}.png`), shot);
  };

  for (const [i, s] of shots.entries()) {
    await render(`screenshot-${i + 1}`, { kind: "shot", n: i + 1, theme: s.theme, title: s.title, lede: s.lede, img: `captures/${s.img}.png`, w: Math.round(s.w * (s.w < 400 ? 1.4 : 1)) }, 1280, 800);
  }
  await render("promo-small", { kind: "tile", theme: "dark" }, 440, 280);
  await render("promo-marquee", { kind: "marquee", theme: "dark" }, 1400, 560);
  for (const s of shots) rmSync(join(out, `${s.img}.png`));
  console.log(`store images in ${out}`);
} finally {
  await context.close();
  site.server.close();
  front.close();
  rmSync(profile, { recursive: true, force: true });
}
