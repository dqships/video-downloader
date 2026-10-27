// Local test site: pages that play fixture media, with Range support and one
// path that refuses requests without the page's Referer.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const media = fileURLToPath(new URL("../fixtures/media/", import.meta.url));
const TYPES = {
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
};

/** Plays a playlist the way a player would: master first, then its children. */
const player = (...urls) => `<script>(async () => { for (const u of ${JSON.stringify(urls)}) await fetch(u); })()</script>`;

/** Playlists made on the fly, for cases ffmpeg fixtures don't cover. */
const dynamic = {
  // No end marker: a stream still being broadcast.
  "/live/index.m3u8": "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:40\n#EXTINF:2,\n/media/hls/seg000.ts\n#EXTINF:2,\n/media/hls/seg001.ts\n",
  // FairPlay-style key: must be listed as DRM and never downloaded.
  "/drm/index.m3u8":
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-1",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:2,\n/media/hls/seg000.ts\n#EXT-X-ENDLIST\n',
};

const pages = {
  "/page.html": `<title>Test Clip | Fixture Site</title><meta property="og:image" content="/poster.png">
    <video src="/media/clip.mp4" muted autoplay controls></video>`,
  "/protected.html": `<title>Protected Clip</title><video src="/protected/clip.mp4" muted autoplay controls></video>`,
  "/hls.html": `<title>HLS Page</title><script>fetch("/media/hls/master.m3u8")</script>`,
  "/hls-aes.html": `<title>Encrypted Stream</title>${player("/media/hls-aes/index.m3u8")}`,
  "/hls-fmp4.html": `<title>Fragmented Stream</title>${player("/media/hls-fmp4/index.m3u8")}`,
  "/hls-multi.html": `<title>Two Qualities</title>${player("/media/hls-multi/master.m3u8", "/media/hls-multi/360p.m3u8", "/media/hls-multi/audio.m3u8")}`,
  "/hls-protected.html": `<title>Protected Stream</title>${player("/protected-hls/index.m3u8")}`,
  "/live.html": `<title>Live Now</title>${player("/live/index.m3u8")}`,
  "/drm.html": `<title>Locked Stream</title>${player("/drm/index.m3u8")}`,
  "/mixed.html": `<title>Northern Lights Over Tromsø, Full Timelapse | Fixture Site</title>
    <video src="/media/clip.mp4" muted autoplay controls></video>
    ${player("/media/hls-multi/master.m3u8", "/media/hls-multi/360p.m3u8")}`,
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
    if (dynamic[url.pathname]) {
      res.writeHead(200, { "Content-Type": TYPES[".m3u8"] }).end(dynamic[url.pathname]);
      return;
    }
    // Every file of this stream, playlist and segments, needs the page's Referer.
    if (url.pathname.startsWith("/protected-hls/")) {
      const referer = req.headers.referer ?? "";
      protectedLog.push({ path: url.pathname, referer });
      if (!referer.endsWith("/hls-protected.html")) {
        res.writeHead(403).end("missing referer");
        return;
      }
      sendFile(req, res, join(media, "hls", normalize(url.pathname.slice("/protected-hls/".length)).replace(/^(\.\.[/\\])+/, "")));
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
