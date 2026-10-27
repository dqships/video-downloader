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
| 5. Media declared in page markup; site extractors (Twitch clips, X) | Done |
| 6. Settings, history, player recording (MSE) | Done |
| 7. WebM DASH, live DASH, silence for late audio | Done |
| Store listing, screenshots, package, website on Vercel | Ready ([store/README.md](store/README.md)) |
| House ads for the maker's other apps, edited in `site/ads.json` | Done ([docs/house-ads.md](docs/house-ads.md)) |
| Paid ad-free upgrade, $0.99/yr or $9 once (Stripe) | Done ([docs/ad-free-upgrade.md](docs/ad-free-upgrade.md)) |

YouTube isn't supported (Chrome Web Store policy).

Live HLS and DASH streams record until they end or you press stop.

## Ship it

`pnpm package` writes `release/vidzilla-<version>.zip` for the Chrome Web
Store. [store/README.md](store/README.md) has the listing copy, permission
justifications, store images and the Vercel steps for the website.

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
  `chrome.storage.session` (`registry.ts`). The list shows the video playing
  now: media the player loads 15 s or more after the last means the page
  moved on to another video (BBC plays them back to back), so the older
  entries go, unless one is downloading.
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
  WebM DASH (VP8, VP9, AV1, Opus, Vorbis) can't go through the HLS reader:
  the worker fetches each track's init and segments (or its one file) into
  OPFS and joins them packet by packet (`src/worker/fetch-tracks.ts`, with
  the same joiner as player recording). The file is MP4, or WebM when the
  sound is Vorbis. Where a height comes in both H.264 and VP9/AV1, the
  H.264 one is listed.
- **Live DASH** (`src/worker/record-live-dash.ts`): the worker follows the
  manifest itself. Timelines list the segments; numbered templates imply
  them from `availabilityStartTime` and the clock (`liveSegments`). It joins
  three segments behind the live edge, appends each new one to its track's
  file, and on stop (or when the manifest turns static) joins the tracks.
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
- **Page-declared media** (`src/shared/page-media.ts`, `src/sw/page-probe.ts`):
  after each page load (and each single-page-app route change) the page's
  JSON-LD VideoObjects, Open Graph / Twitter player tags and `<video src>` are
  read, and each URL is checked with a one-byte request, so a video is listed
  with its own title before it plays. When the player later requests it, its
  real headers (cookies included) replace the guessed ones.
- **Site extractors** (`src/sw/sites.ts`): small additions on top of
  detection, never replacing it. Twitch clips offer every height the CDN
  has; X names each video after its own post and lists the page's main post
  first. Titles drop the site's name (`src/shared/titles.ts`).
- **Player recording** (`src/content/mse-*.ts`, `src/capture/`): a last
  resort for players whose stream can't be fetched (custom transports,
  hidden manifests). A page-world script notes Media Source Extensions use
  and, only while the user records, copies each buffer the player appends to
  an invisible extension frame, which joins the tracks into one file
  (Mediabunny, no re-encoding) and saves it. Quality switches are joined
  into one track by Media Source's own rule (a later append replaces what
  it overlaps, the rest stays), so re-appends and switches back and forth
  come out as the player had them (H.264 with differing parameter sets is written as avc3,
  with them in each keyframe); each run is placed by the SourceBuffer's
  timestampOffset, and WebM init segments lose the source file's index
  (SeekHead, Cues). Sound that the player loaded later than the picture
  gets silence in front (AAC-LC and Opus frames that need no encoder), so it
  starts with the video in any player. The recording ends once every MediaSource
  that got media has ended, so probe players and ads don't cut it short. Record reloads the page with
  the recording armed: the script holds the player's first buffers until
  the service worker answers, so the file starts at the beginning. The frame
  gets its job id privately and claims it from the service worker once, so
  a page can't make it save anything. Listed only when no HLS/DASH stream
  with a saveable quality is on the page.
- **Settings and history** (`src/ui/settings-*`, `src/ui/history-view.ts`,
  `src/shared/history.ts`): the gear in the popup opens the filename
  template, length, folder and save dialog in place (also on the options
  page), and Saved files lists what Vidzilla saved (show in folder, open the
  page it came from) inside the popup or side panel. History lives in
  `chrome.storage.local`, capped at 300 entries.
- **Popup** (`src/ui/`): reads storage and sends commands. It holds no state of
  its own. It is built from the shared Vidzilla design system (`design/`,
  `brand/`, see `DESIGN.md`), the same tokens and components the website uses,
  so the two can't drift apart.
- **Website** (`site/`, plus `src/web/` for paste-a-link): static pages. The
  paste box under the hero saves a pasted video file or `.m3u8` stream in the
  browser with the same download worker the extension uses, when the site
  hosting it allows other websites to read its files (CORS). Web pages, sites
  that don't allow it, DASH and YouTube get a plain explanation instead; there
  is no server. `pnpm site` builds a deployable copy into `site-dist/`, and
  `pnpm site:serve` serves it the way Vercel will.
- **Site launch setup** (`site/pages.mjs`, `scripts/build-site.mjs`,
  `middleware.js`, `vercel.json`): the build adds each page's canonical, Open
  Graph, Twitter and JSON-LD tags and the shared header and footer
  (`site/partials/`), writes `robots.txt`, `sitemap.xml` and `llms.txt`, and
  copies each page's markdown twin (`site/md/`). It fails if a title isn't
  30–60 characters, a description isn't 120–160, a page has other than one
  `<h1>`, or an inline script isn't allowed by the CSP in `vercel.json`.
  `vercel.json` sets the security headers (HSTS, CSP, X-Frame-Options and
  friends) and `Vary: Accept`; `middleware.js` answers `Accept: text/markdown`
  with the page's markdown at the same URL, or a markdown 404. Missing pages get
  `404.html` with a real 404 status. The domain lives in `site/pages.mjs`
  (`origin`); `brand/og-image.png` is made by `pnpm og`.
- **Vercel deploys only for website changes** (`scripts/vercel-ignore.mjs`,
  the `ignoreCommand` in `vercel.json`): a push that touches nothing the site
  is built from (`scripts/site-inputs.mjs`: `site/`, `design/`, `brand/`,
  `api/`, the Vercel and package config, and the extension modules the
  paste box bundles, found by following imports) skips the deployment, and
  Vercel marks it ignored. It compares with the branch's last deployment, or
  with `main` on a branch's first. Redeploying a commit always builds. If
  the site build starts reading a new file, add it to `sitePaths`; a unit test
  fails when a bundled file isn't covered. Try it with
  `node scripts/vercel-ignore.mjs <commit>`.

## Tests

```sh
pnpm test        # unit tests (Vitest)
pnpm fixtures    # generate test media with ffmpeg (once)
pnpm test:e2e    # loads dist/ in Chromium via Playwright against a local test site
node scripts/screenshots.mjs out/   # popup in light and dark mode
```

The end-to-end tests cover detection, real downloads verified with ffprobe
(direct MP4; HLS plain, AES-128, fMP4 and two-quality with separate audio;
DASH numbered, timeline, byte-range and single indexed file; WebM DASH
segmented (VP9/Opus to MP4) and one file per track (VP8/Vorbis to WebM);
audio only; live
recording (HLS and DASH) stopped by hand and to the end; subtitles from HLS, DASH and a page
track; the EME warning),
Referer replay for a file and for every segment of a stream, and that live and
DRM streams stay unavailable. `tests/e2e/site.test.mjs` does the same for the
website's paste box, with the media on a separate origin and the site served
with its real headers and CSP. `tests/e2e/site-launch.test.mjs` checks the
launch setup: every page's head, the security headers, `robots.txt`,
`sitemap.xml` and `llms.txt` (every link resolves), markdown negotiation, real
404s in HTML and markdown, and no console errors on any page.

## License

The code is under the [MIT License](LICENSE). The Vidzilla name, logo, icons
and store images are not: they stay all rights reserved, so a fork needs its
own name and artwork. [TRADEMARKS.md](TRADEMARKS.md) lists what that covers.

Bundled third-party code keeps its own licence: Mediabunny (MPL-2.0) and the
Archivo font (SIL OFL 1.1). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
