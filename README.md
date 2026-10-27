# Vidzilla

A personal Chrome extension (Manifest V3) that finds the video and audio a page
plays and saves it to your computer. Everything runs in the browser, with no
companion app.

`VDH-handoff.md` is the study of Video DownloadHelper that this design follows.
DRM-protected media (Widevine, PlayReady, FairPlay) is detected and never
downloaded.

## Status

| Milestone | State |
| --- | --- |
| 1. Detection and direct files (mp4, webm, mp3...) | Done |
| 2. HLS (m3u8), AES-128, quality picker, remux to MP4 | Done |
| 3. DASH (mpd), audio-only | Done |
| 4. Live recording, subtitles, DRM detection everywhere | Done |
| 5. Site extractors (Vimeo, Facebook, Instagram, Kick, ...) | Next |
| 6. MSE fallback, settings, history | Planned |
| 7. YouTube | Not planned (Chrome Web Store policy) |

Live HLS streams record until they end or you press stop; live DASH recording
comes later. WebM-only DASH streams are listed but can't be saved yet.

## Try it

```sh
pnpm install
pnpm build          # writes dist/
```

Then open `chrome://extensions`, turn on Developer mode, click **Load
unpacked** and pick the `dist` folder. Play a video on any page and click the
toolbar icon. `pnpm watch` rebuilds on every change, after which you click the
extension's reload button.

## How it works

- **Service worker** (`src/sw/`): watches network responses with `webRequest`
  and classifies media (`classify.ts`). It also records the request headers
  the page sent (`headers.ts`) and keeps a per-tab list in
  `chrome.storage.session` (`registry.ts`).
- **Header replay** (`src/sw/replay.ts`): Chrome won't let an extension set
  Cookie, Referer or Origin itself, so each job adds `declarativeNetRequest`
  session rules that set them for the media's URL directory. The rules are
  removed when the job ends. Chrome's own downloader ignores these rules, so
  all fetching goes through the worker below.
- **Offscreen document and download worker** (`src/offscreen/`, `src/worker/`):
  the worker fetches the file into the origin-private file system (OPFS). It
  resumes with Range requests after network errors, then hands back a `blob:`
  URL that `chrome.downloads` saves under the chosen filename.
- **HLS** (`src/shared/hls.ts`, `src/sw/hls-probe.ts`, `src/worker/remux-hls.ts`):
  when a page loads a playlist, the service worker reads it to list the
  qualities, the length, and whether it is live or DRM-protected. Quality and
  audio playlists of a listed master are hidden. A download builds a
  one-quality master for the picked variant, adds header replay for every
  directory its segments live in, and the worker remuxes it to MP4 with
  [Mediabunny](https://mediabunny.dev) (AES-128, fMP4 and separate audio
  included, no re-encoding), writing straight to OPFS.
- **DASH** (`src/shared/dash.ts`, `src/shared/xml.ts`, `src/sw/dash-probe.ts`):
  the manifest is read the same way (no DOMParser in a service worker, so a
  small XML reader). SegmentTemplate (numbers or timeline), SegmentList with
  byte ranges, and SegmentBase (the file's sidx is read for the ranges) all
  become HLS media playlists with `EXT-X-MAP` and byte ranges, so the same
  worker job remuxes DASH. Multi-period manifests use the longest period.
- **Audio only**: every stream offers it; the picture is dropped and the file
  is saved as `.m4a`.
- **Live recording** (`src/worker/record-live.ts`): packets are copied from the
  live playlist as segments appear, shifted to start at zero, into an MP4 that
  is finalized when the stream ends or you press stop.
- **Subtitles** (`src/shared/subtitles.ts`, `src/sw/subtitles.ts`): HLS
  WebVTT renditions, DASH WebVTT/TTML tracks and a page's `<track>` captions
  are offered in a second picker and saved next to the video as `.srt`
  (segments merged, repeats across segment edges dropped).
- **DRM** (`src/content/`): besides manifest checks, a page-world script sees
  when a player hands a media element DRM keys (EME) and the popup warns on
  that page's streams. Capability probes alone don't count, since players
  probe for clear video too.
- **Popup** (`src/ui/`): reads storage and sends commands. It holds no state of
  its own. It is built from the shared Vidzilla design system (`design/`,
  `brand/`, see `DESIGN.md`), the same tokens and components the website uses,
  so the two can't drift apart.
- **Website** (`site/`, plus `src/web/` for paste-a-link): static pages. The
  paste box under the hero saves a pasted video file or `.m3u8` stream in the
  browser with the same download worker the extension uses, when the site
  hosting it allows other websites to read its files (CORS). Web pages, sites
  that don't allow it, DASH and YouTube get a plain explanation instead; there
  is no server. `pnpm site` builds a deployable copy into `site-dist/`.

## Tests

```sh
pnpm test        # unit tests (Vitest)
pnpm fixtures    # generate test media with ffmpeg (once)
pnpm test:e2e    # loads dist/ in Chromium via Playwright against a local test site
node scripts/screenshots.mjs out/   # popup in light and dark mode
```

The end-to-end tests cover detection, real downloads verified with ffprobe
(direct MP4; HLS plain, AES-128, fMP4 and two-quality with separate audio;
DASH numbered, timeline, byte-range and single indexed file; audio only; live
recording stopped by hand and to the end; subtitles from HLS, DASH and a page
track; the EME warning),
Referer replay for a file and for every segment of a stream, and that live and
DRM streams stay unavailable. `tests/e2e/site.test.mjs` does the same for the
website's paste box, with the media on a separate origin.
