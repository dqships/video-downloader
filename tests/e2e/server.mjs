// Local test site: pages that play fixture media, with Range support and one
// path that refuses requests without the page's Referer.
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const media = fileURLToPath(new URL("../fixtures/media/", import.meta.url));
const TYPES = {
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mpd": "application/dash+xml",
  ".vtt": "text/vtt",
  ".ttml": "application/ttml+xml",
};

/** Plays a playlist the way a player would: master first, then its children. */
const player = (...urls) => `<script>(async () => { for (const u of ${JSON.stringify(urls)}) await fetch(u); })()</script>`;

const LIVE_SEGMENTS = 10;
/** When each live run's broadcast started. */
const liveStarts = {};

/** Playlists made on the fly, for cases ffmpeg fixtures don't cover. */
const dynamic = {
  // No end marker: a stream still being broadcast.
  "/live/index.m3u8": "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:40\n#EXTINF:2,\n/media/hls/seg000.ts\n#EXTINF:2,\n/media/hls/seg001.ts\n",
  // FairPlay-style key: must be listed as DRM and never downloaded.
  "/drm/index.m3u8":
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-1",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:2,\n/media/hls/seg000.ts\n#EXT-X-ENDLIST\n',
};

/** Ad servers that answer a .m3u8 URL with VAST XML instead of a playlist. */
const notPlaylists = {
  "/ads/vast.m3u8": '<?xml version="1.0"?><VAST version="3.0"></VAST>',
  "/ads/vast.mpd": '<?xml version="1.0"?><VAST version="3.0"></VAST>',
};

let flakyHits = 0;

const pages = {
  "/page.html": `<title>Test Clip | Fixture Site</title><meta property="og:image" content="/poster.png">
    <video src="/media/clip.mp4" muted autoplay controls></video>`,
  "/protected.html": `<title>Protected Clip</title><video src="/protected/clip.mp4" muted autoplay controls></video>`,
  "/hls.html": `<title>HLS Page</title><script>fetch("/media/hls/master.m3u8")</script>`,
  "/hls-aes.html": `<title>Encrypted Stream</title>${player("/media/hls-aes/index.m3u8")}`,
  "/hls-fmp4.html": `<title>Fragmented Stream</title>${player("/media/hls-fmp4/index.m3u8")}`,
  "/hls-multi.html": `<title>Two Qualities</title>${player("/media/hls-multi/master.m3u8", "/media/hls-multi/360p.m3u8", "/media/hls-multi/audio.m3u8")}`,
  "/hls-protected.html": `<title>Protected Stream</title>${player("/protected-hls/index.m3u8")}`,
  "/dash.html": `<title>Dash Two Qualities</title>${player("/media/dash/manifest.mpd", "/media/dash/init-0.m4s")}`,
  "/dash-timeline.html": `<title>Dash Timeline</title>${player("/media/dash-timeline/manifest.mpd")}`,
  "/dash-single.html": `<title>Dash Byte Ranges</title>${player("/media/dash-single/manifest.mpd")}`,
  // A player reading one file per track by byte range, as on Facebook.
  "/dash-base.html": `<title>Dash One File</title><script>(async () => {
    await fetch("/media/dash-base/manifest.mpd");
    await fetch("/media/dash-base/video.mp4", { headers: { range: "bytes=0-1000000" } });
  })()</script>`,
  "/subs-hls.html": `<title>Stream With Subtitles</title>${player("/media/subs/master.m3u8")}`,
  "/subs-dash.html": `<title>Dash With Subtitles</title>${player("/media/dash/subs.mpd")}`,
  "/track.html": `<title>Captioned Clip</title><video src="/media/clip.mp4" muted autoplay controls>
    <track kind="subtitles" src="/media/subs/page.vtt" srclang="fr" label="Français"></video>`,
  // Headless Chromium has no Widevine, so hand setMediaKeys a stand-in: the
  // extension only needs to see the call.
  "/eme.html": `<title>Protected Player</title><video></video>${player("/media/hls/master.m3u8")}<script>
    setTimeout(() => document.querySelector("video").setMediaKeys({ keySystem: "com.widevine.alpha" }).catch(() => {}), 300);
  </script>`,
  "/encrypted.html": `<title>Encrypted Player</title><video></video>${player("/media/hls/master.m3u8")}<script>
    setTimeout(() => document.querySelector("video").dispatchEvent(new Event("encrypted")), 300);
  </script>`,
  "/declared.html": `<title>Morning Bulletin | Fixture News</title>
    <meta property="og:title" content="Morning Bulletin">
    <meta property="og:video" content="/embed/7"><meta property="og:video:type" content="text/html">
    <meta property="og:video:secure_url" content="/media/hls/master.m3u8"><meta property="og:video:type" content="application/x-mpegURL">
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      video: { "@type": "VideoObject", name: "Harbour at Dawn", contentUrl: "/media/clip.mp4", thumbnailUrl: "/poster.png", duration: "PT6S" },
    })}</script>
    <video controls preload="none"></video>`,
  "/spa.html": `<title>Feed</title><main></main><script>
    setTimeout(() => {
      history.pushState({}, "", "/spa/clip-2");
      document.querySelector("main").innerHTML = '<video src="/media/clip.mp4" preload="none" controls></video>';
    }, 300);
  </script>`,
  "/dash-tail.html": `<title>Dash Short Tail</title>${player("/media/dash/tail.mpd")}`,
  "/flaky.html": `<title>Busy Server</title>${player("/flaky/index.m3u8")}`,
  "/ad-manifest.html": `<title>Ad Before The Show</title>${player("/ads/vast.m3u8", "/ads/vast.mpd", "/media/hls/master.m3u8")}`,
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

/** `cors` lets other origins read every response, like a CDN that shares its files. */
export function startServer(port = 0, { cors = false } = {}) {
  /** Every request to /protected/, with the Referer it carried. */
  const protectedLog = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (cors) res.setHeader("Access-Control-Allow-Origin", "*");
    if (pages[url.pathname]) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>${pages[url.pathname]}`);
      return;
    }
    // A broadcast in progress: segments of media/live appear every 2 s, three at
    // a time, and the stream ends after the tenth. /live-rec/<run>/index.m3u8,
    // so each test gets its own clock.
    const livePage = /^\/live-page\/([\w-]+)\.html$/.exec(url.pathname);
    if (livePage) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Live Broadcast</title>${player(`/live-rec/${livePage[1]}/index.m3u8`)}`);
      return;
    }
    const live = /^\/live-rec\/([\w-]+)\/index\.m3u8$/.exec(url.pathname);
    if (live) {
      liveStarts[live[1]] ??= Date.now();
      const available = Math.min(LIVE_SEGMENTS, 3 + Math.floor((Date.now() - liveStarts[live[1]]) / 2000));
      const first = available - 3;
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", `#EXT-X-MEDIA-SEQUENCE:${first}`];
      for (let i = first; i < available; i++) lines.push("#EXTINF:2.000000,", `/media/live/seg${String(i).padStart(3, "0")}.ts`);
      if (available === LIVE_SEGMENTS) lines.push("#EXT-X-ENDLIST");
      res.writeHead(200, { "Content-Type": TYPES[".m3u8"], "Cache-Control": "no-store" }).end(lines.join("\n") + "\n");
      return;
    }
    // The length runs a sliver past the last video segment, so counting
    // segments from it names one more than the server has (as BBC's do).
    if (url.pathname === "/media/dash/tail.mpd") {
      const mpd = readFileSync(join(media, "dash/manifest.mpd"), "utf8").replace(/mediaPresentationDuration="[^"]+"/, 'mediaPresentationDuration="PT6.05S"');
      res.writeHead(200, { "Content-Type": TYPES[".mpd"] }).end(mpd);
      return;
    }
    // Turns the second request away, as Dailymotion does when the extension
    // reads a playlist at the same moment as the player.
    if (url.pathname === "/flaky/index.m3u8") {
      flakyHits++;
      if (flakyHits === 2) res.writeHead(403).end();
      else res.writeHead(200, { "Content-Type": TYPES[".m3u8"] }).end(dynamic["/drm/index.m3u8"].replace(/#EXT-X-KEY[^\n]*\n/, ""));
      return;
    }
    if (notPlaylists[url.pathname]) {
      res.writeHead(200, { "Content-Type": "application/xml" }).end(notPlaylists[url.pathname]);
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
