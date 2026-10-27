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
| 2. HLS (m3u8), AES-128, remux to MP4 | Next |
| 3. DASH (mpd), audio-only | Planned |
| 4. Live recording, subtitles, DRM detection everywhere | Planned |
| 5. Site extractors (Vimeo, Facebook, Instagram, Kick, ...) | Planned |
| 6. MSE fallback, settings, history | Planned |
| 7. YouTube (optional) | Planned |

HLS and DASH streams are already detected and listed, but can't be downloaded
until milestones 2 and 3.

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
- **Popup** (`src/ui/`): reads storage and sends commands. It holds no state of
  its own.

## Tests

```sh
pnpm test        # unit tests (Vitest)
pnpm fixtures    # generate test media with ffmpeg (once)
pnpm test:e2e    # loads dist/ in Chromium via Playwright against a local test site
node scripts/screenshots.mjs out/   # popup in light and dark mode
```

The end-to-end tests check three things: detection, a real download (verified
with ffprobe), and Referer replay against a server that refuses requests
without it.
