// Local test site: pages that play fixture media, with Range support and one
// path that refuses requests without the page's Referer.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const media = fileURLToPath(new URL("../fixtures/media/", import.meta.url));
const TYPES = { ".mp4": "video/mp4", ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t" };

const pages = {
  "/page.html": `<title>Test Clip | Fixture Site</title><meta property="og:image" content="/poster.png">
    <video src="/media/clip.mp4" muted autoplay controls></video>`,
  "/protected.html": `<title>Protected Clip</title><video src="/protected/clip.mp4" muted autoplay controls></video>`,
  "/hls.html": `<title>HLS Page</title><script>fetch("/media/hls/master.m3u8")</script>`,
  "/mixed.html": `<title>Northern Lights Over Tromsø, Full Timelapse | Fixture Site</title>
    <video src="/media/clip.mp4" muted autoplay controls></video>
    <script>fetch("/media/hls/master.m3u8")</script>`,
};

function sendFile(req, res, file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    res.writeHead(404).end();
    return;
  }
  const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Accept-Ranges": "bytes" };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "Content-Length": size });
    createReadStream(file).pipe(res);
  }
}

export function startServer(port = 0) {
  /** Every request to /protected/, with the Referer it carried. */
  const protectedLog = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (pages[url.pathname]) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>${pages[url.pathname]}`);
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      sendFile(req, res, join(media, normalize(url.pathname.slice("/media/".length)).replace(/^(\.\.[/\\])+/, "")));
      return;
    }
    if (url.pathname === "/protected/clip.mp4") {
      const referer = req.headers.referer ?? "";
      protectedLog.push({ referer, range: req.headers.range });
      if (!referer.endsWith("/protected.html")) {
        res.writeHead(403).end("missing referer");
        return;
      }
      sendFile(req, res, join(media, "clip.mp4"));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, protectedLog })),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { origin } = await startServer(Number(process.env.PORT ?? 8787));
  console.log(`fixture site at ${origin}/page.html`);
}
