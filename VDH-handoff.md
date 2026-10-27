# Video DownloadHelper 10.6.7.2: how it works

This is a study of the Chrome Web Store build of Video DownloadHelper (extension ID `lmjnegcaeklhafolokijcfjliaokphfk`, version 10.6.7.2, Default profile), written in my own words for a personal project. I worked from a read-only copy and never ran or modified the extension's code. Line references point to prettier-beautified files and are only for orientation. No VDH code is reproduced here.

**Contents**

1. One-paragraph summary
2. Architecture
3. Media detection
4. HLS and DASH parsing, quality picking, split audio/video
5. Site-specific extractors (and which sites)
6. Segment downloading
7. Merging and remuxing (libav.js)
8. Saving and naming files
9. DRM detection and refusal
10. Supported formats and sites (reference lists)
11. Licensing, gating, and other things not worth copying
12. Techniques worth copying
13. Known weak spots in VDH (do better)
14. Ready-to-paste build prompt

---

## 1. One-paragraph summary

VDH v10 runs entirely in the browser. Unlike v9, it has no native companion app. A Manifest V3 **module service worker** watches network traffic with `webRequest` and recognises manifests and media files. Per-site **content scripts** pull stream URLs straight from page data or site APIs. Everything found becomes a normalised "media object", stored per tab. When the user clicks download, the service worker uses `declarativeNetRequest` session rules to replay the original request headers (Cookie, Referer, Origin). It then asks a **Web Worker**, hosted in an **offscreen document**, to do the job. The worker fetches segments and decrypts AES-128 HLS. It remuxes with **libav.js**, FFmpeg compiled to WebAssembly in a slim h264/aac/mp3 build, and never re-encodes video. It writes the output to **OPFS** and returns a blob URL. The service worker then saves that URL with `chrome.downloads` under a template-based "smart" filename. Media marked with Widevine, PlayReady or FairPlay is detected and refused.

---

## 2. Architecture

```
 page (MAIN world)          page (ISOLATED world)           service worker (module)                 offscreen doc            Web Worker
 ───────────────────        ─────────────────────           ───────────────────────                 ─────────────            ──────────
 reads page globals   ──►   site extractor builds    ──►    media registry per tab        ──create──►  factory.html  ──new──►  download_worker
 hooks fetch/XHR      BC    media object             msg    webRequest sniffer                          (only spawns            m3u8/mpd fetch
 (few sites only)           (m3u8/mpd/http/yt)              header-replay DNR rules                      the worker)            AES-128 decrypt
                                                            quality/strategy choice      ◄──────────── BroadcastChannel ──────►  libav.js remux
                                                            QuickJS sandbox (YT sig)                                             OPFS write → blob URL
                                                            chrome.downloads save
 popup / side panel UI  ◄── reads chrome.storage.session/local (state is not pushed; the UI subscribes to storage.onChanged)
```

**Moving parts**

| Piece | File(s) | Role |
|---|---|---|
| Service worker | `service/main.js` (esbuild ESM bundle, about 23k lines beautified) | Detection, registry, policy, strategy choice, header rules, saving, licensing, menus, notifications |
| Offscreen factory | `factory/factory.html` + `factory.js` (tiny) | Exists only because an MV3 service worker cannot call `new Worker`. It is created with reason `WORKERS` and justification "Needed to create workers". |
| Download worker | `download_worker/main.js` + `libav-6.5.7.1-h264-aac-mp3.wasm(.mjs)` (about 4.9 MB) | Fetch, decrypt, demux, mux, write to OPFS |
| QuickJS | `service/emscripten-module.wasm` (about 0.5 MB) | A sandboxed JS engine in the service worker that runs YouTube player code (signature and `n`-parameter functions), since MV3 forbids `eval` |
| Content scripts | `injected/*.js`, 22 entries | Site extractors (ISOLATED world, plus small MAIN-world helpers) |
| UI | `content/popup.html`, `sidebar.html`, `panel.js`, `details.*`, `history.*`, `smartnaming.*` | Vanilla Custom Elements built from `<template>`s. The same UI serves both popup and side panel. |

**Permissions:** tabs, offscreen, downloads, sidePanel, webRequest, webNavigation, scripting, declarativeNetRequest, storage, notifications, contextMenus, unlimitedStorage. Optional permissions are browsingData and downloads.open. Host permission is `<all_urls>`. The CSP for extension pages is `script-src 'self' 'wasm-unsafe-eval'`, which wasm needs.

**Messaging**
- Every message carries `{msg:{name,data}, channel}`, where `channel` is a small numeric enum naming the direction (injected→service, service→injected, UI→service, MAIN→ISOLATED, and so on).
- The service worker and the worker talk over `BroadcastChannel("worker_service")`.
- MAIN and ISOLATED scripts talk over a `BroadcastChannel` named from a hash of `location.href`.
- Messages to tabs are retried up to 10 times, 1 s apart, because content scripts may not be ready yet.
- A tagged serializer turns `URL`, `Headers`, `Map`, `Set`, `RegExp` and Option/Result values into plain JSON-safe objects and back, so rich objects survive `sendMessage` and storage. This pattern is worth copying.

**State**
- Session state lives in `chrome.storage.session`: discovered media per tab, downloads in progress, notifications and transient history.
- Persistent state lives in `chrome.storage.local`: settings, the license, history and naming rules.
- Both are written with a 500 ms debounce, and the UI is a pure reader. This survives service-worker restarts without effort.
- Empty `webRequest` listeners are registered at top level so Chrome wakes the service worker on traffic.

**Remote ruleset.** Once a day the service worker fetches a JSON ruleset from the vendor's server. It holds per-domain behaviour flags, an experiment list, and the YouTube client order. Rule and domain names in it are stored only as hashes. The ruleset lets the vendor change behaviour without shipping an update.

**Extension-ID gate.** The service worker and the factory both check `runtime.id` against a short list of the official store IDs. On a mismatch the worker is never spawned and downloads hang silently. This is anti-cloning. Do not copy it.

---

## 3. Media detection

**A. Network sniffing.** This is the main generic path.
- It registers `webRequest.onSendHeaders` (with `requestHeaders` and `extraHeaders`) and `webRequest.onResponseStarted` (with `responseHeaders` and `extraHeaders`). Both cover `<all_urls>` and the request types `xmlhttprequest`, `media`, `main_frame`, `sub_frame` and `other`.
- Request headers are cached by `requestId` for 10 minutes, so each detected media keeps the exact Cookie, Referer, Origin and UA that the page used.
- On each response it skips:
  - non-2xx responses;
  - requests initiated by extension pages or non-http pages;
  - segment-looking paths (`.ts`, `.m4s`, `.m2ts`);
  - domains that have their own content-script extractor;
  - domains the ruleset blocks.
- It then classifies each response:
  - **HLS:** content-type containing `mpegurl`, a URL matching `m3u8|hls`, or a known master-playlist path. It re-fetches the manifest with the captured headers and parses it. A master playlist becomes `m3u8_playlist`; a media playlist becomes `m3u8`.
  - **DASH:** content-type containing `dash`, or a `.mpd` URL. It re-fetches and parses into `mpd_playlist`. A ruleset flag can try the `.m3u8` twin of an `.mpd` first.
  - **Direct file:** request type `media`, or a MIME subtype in a table (mp4, webm, matroska, mov, m4a, m4v, mpeg, mp2t, ogg, flac, wav, flv, 3gpp, msvideo, mts, vorbis). The extension is worked out from the URL, then Content-Disposition, then MIME, with mp4 as the fallback. Byte-range support is recorded from `accept-ranges` or `content-range`.
- **Size thresholds for direct files:**
  - Files under about 500 KB are ignored, unless a site flag allows small files.
  - Files under 20 MB are ignored when the same page has already served a DASH manifest, because they are probably segments.

**B. Content-script extractors.** These cover sites where sniffing alone is not enough; see §5. They yield the same media-object shape.

**C. MSE and blob hooks: none.** No script hooks `MediaSource`, `SourceBuffer.appendBuffer` or `URL.createObjectURL`. VDH does not record what the player feeds into MSE. It always goes back to the manifest or file URLs.

**D. EME probe.** Separately, an injected check looks for any `<video>` that has `mediaKeys` set. The result is used only for DRM labelling (§9).

**De-duplication and grouping**
- Each media object gets a hash:
  - HLS: a fast 53-bit string hash (cyrb53) of the manifest text plus its URL;
  - DASH: the hash of the manifest text;
  - direct files: the hash of the URL.
- Media are grouped per tab, along with tab metadata: title, favicon, thumbnail, and the resolved naming rule.
- Clean-up rules:
  - when a master playlist arrives, its child variant playlists are removed;
  - at most 10 items of one type are kept per tab;
  - small http items are removed once an MPD appears;
  - some sites (TikTok, Facebook, Instagram, Douyin, Rumble, Kick) keep a FIFO capped at 30 entries;
  - some sites (Twitch, Rumble, NicoNico and others) drop stray http/m3u8 items once a playlist exists.
- A tab's list is cleared on top-frame `webNavigation.onBeforeNavigate` and on tab close.
- Media detected with no tab ID is matched to a tab by its initiator URL.

**Thumbnails and titles** are scraped with `scripting.executeScript`. The thumbnail comes from `video[poster]`, `og:image`-style meta tags, or `link[rel=image_src]`. The title is `document.title`, with meta title tags as a fallback.

---

## 4. HLS and DASH parsing, quality picking, split audio/video

**Libraries:** video.js **m3u8-parser 7.2** and **mpd-parser 1.3** (with xmldom) are bundled into the service worker and into several content scripts.

**HLS master playlists** are parsed in the service worker or the content script, never in the download worker.
- Each variant's CODECS value is mapped to a container family:
  - avc1, avc3, hvc1, hev1 and mp4v → mp4 family;
  - av01, vp8 and vp9 → webm family;
  - unknown codecs are dropped.
- HDR variants (`VIDEO-RANGE=PQ`) are skipped.
- Each variant's AUDIO group is resolved, and the rendition is picked by the user's language list:
  1. an exact language-tag match;
  2. otherwise a primary-subtag match;
  3. otherwise the `DEFAULT=YES` rendition.
- SUBTITLES and CLOSED-CAPTIONS groups become subtitle options. Playlists made only of vtt/srt/ttml segments are rejected as media.
- **Duration and live detection:** the first variant's media playlist is fetched. A stream counts as live if the last segment's PROGRAM-DATE-TIME is within 10 minutes of now. `ENDLIST` is not used for this.
- **Ordering:** height descending, then bandwidth descending.

**DASH**
- The service worker parses the MPD with mpd-parser and keeps only representations whose codecs it recognises. It records each one's index and sorts by height, then bandwidth.
- Audio is chosen by language preference (or DEFAULT), then by the highest bandwidth in that group.
- Subtitles are chosen by Representation id, excluding `wvtt`.
- The actual segment addressing ($Number$/$Time$, SegmentTimeline, SegmentList, SegmentBase/sidx, BaseURL) is not done in JS at all. FFmpeg's own `dash` demuxer, inside libav.js, does it from the index the service worker chose (§7).

**Default quality choice.** The same rule appears in the service worker and the UI:
1. the user's remembered pick for that media;
2. otherwise the first variant whose height equals the preferred quality (highest, 1080 by default, 720 or 480), trying containers in the order mp4, webm, mkv, mp3, m4a, ogg;
3. otherwise index 0, the best.

Previews use 480p, then 260p, then the last entry.

**Split audio and video**
- Each media object carries a `playlist[]` of variants. Every variant has `{demuxer, quality{size,bitrate}, av{video, audio}, audio_language}`.
- When video and audio are separate, both URLs are kept and the strategy becomes "two sources". The worker muxes them with stream copy.
- On YouTube, each video-only format is paired with the best audio *of the same family*: H.264/HEVC with AAC (m4a), and VP9/AV1 with Opus. That avoids muxing Opus into MP4 or AAC into WebM.

**Output container rule**
- mp4-family sources → the user's choice of mp4 (default) or mkv.
- webm-family sources (VP8, VP9, AV1) → always **mkv**, because this libav build has no webm muxer.
- audio-only → always **mp3**, re-encoded with LAME at 128 kbps.

**Download strategy names.** The service worker picks a strategy string and the worker dispatches on it:
- `m3u8_audio_only`, `m3u8_audio_video_one_source`, `m3u8_audio_video_two_sources`, `m3u8_video_preview`
- `mpd_audio_only`, `mpd_audio_video_one_source`, `mpd_video_preview`
- `youtube_*` and `http_*`, plus `*_jsfetch` variants

---

## 5. Site-specific extractors (and which sites)

Every extractor ends by sending an `on_media` message carrying a media object. Single-rendition HLS is often passed as a `data:text/plain` URL that holds the manifest text itself.

| Site | Worlds / timing | How it finds media | Yields |
|---|---|---|---|
| **YouTube** (`*.youtube.com`) | ISOLATED + MAIN, document_end | Bundled **youtubei.js (YouTube.js) v18**. MAIN reads `ytcfg.VISITOR_DATA`. It calls InnerTube `/player` with a list of clients tried in order: VISIONOS, ANDROID_VR, IOS (no cookies), then MWEB, WEB (with cookies). The list comes from the remote ruleset. Non-www hosts get a hidden `/embed/<id>` iframe. SPA navigation is caught with a MutationObserver. | Adaptive video and audio pairs; HLS for live |
| **Vimeo** | ISOLATED + MAIN, document_start | MAIN polls `window.playerConfig` with back-off. Reads `request.files.hls.cdns[default_cdn]` and `text_tracks`. The service worker also intercepts `/config` responses. | HLS master, split audio, VTT |
| **Facebook, Instagram** | ISOLATED, document_end | Polls for URL changes every 300 ms. Re-fetches the page HTML with credentials and regex-extracts the embedded DASH manifest XML (`dash_manifests` / `manifest_xml` and similar keys). | DASH (as a data: URL), split audio |
| **OK.ru** | ISOLATED | `div[data-options]` → `flashvars.metadata` JSON, read from the DOM on mobile or from a fetched `/videoembed/<id>` page otherwise | HLS (preferred), DASH, subtitles |
| **VK, vkvideo** | ISOLATED | Asks the service worker to POST `al_video.php` with spoofed Origin, Referer and X-Requested-With headers. Live uses the public `api.live.vkvideo.ru` endpoints. | HLS, live HLS, subtitles |
| **Bilibili** (.com / .tv) | ISOLATED + MAIN | MAIN reads `__INITIAL_STATE__` / `__initialState`. ISOLATED calls the playurl API; on .com this is **WBI-signed**, using a key from `/nav`, a 64-entry shuffle and an MD5 `w_rid`. | Separate progressive fMP4 video and audio files |
| **Kick** | ISOLATED | v1/v2 APIs for live, VOD and clips. For VODs it rebuilds a clean `master.m3u8` from the media base path to avoid the **ad-stitched** manifest. | HLS |
| **iQIYI** (iq.com) | ISOLATED + MAIN | MAIN polls `window.__playerdata__`. The m3u8 *text* is embedded inline in the DASH data. | Single HLS, WebVTT subtitles |
| **Canva** | ISOLATED | Regex for `hlsManifestUrl` in nonce'd `<script>` tags on `/watch` pages | HLS |
| **Osmosis** | ISOLATED | Fetches the playlist endpoint, whose response is the m3u8 *reversed character by character*, and reverses it back. Standard AES-128 keys are made absolute. | HLS, AES-128 |
| **TwitCasting** | ISOLATED | Calls `streamserver.php` and simply `fetch`es the m3u8 so the network sniffer sees it | (via sniffer) |
| **Chaturbate** | ISOLATED | POST to the edge-HLS ajax endpoint, with a fallback to `initialRoomDossier` JSON. Health-checks the stream every 20 s and removes it when it dies. | Live HLS |
| **91porna + a mirror** ("xgplayer_crypto") | ISOLATED + MAIN, document_start | MAIN wraps `fetch` and `XHR.open`, re-downloads any `.m3u8` and un-obfuscates it. The format is base64, XOR, or AES (ECB/CBC/CFB/OFB) with the key and IV **inside the same payload**. This is **obfuscation, not DRM**. | Single HLS |
| **javrank** | ISOLATED + MAIN | MAIN wraps `XHR.open` and keeps the m3u8 response text | Single HLS |
| **taiav** | MAIN | Only copies the JSON-LD thumbnail into an `og:image` meta tag | Thumbnail |
| **Generic (every other site)** | (service worker) | Network sniffing, §3 | HLS, DASH, direct files |

The remote ruleset also tunes these sites through sniffing alone: Loom (carry the playlist query string onto segments), SoundCloud (audio-only), TikTok, Douyin, Rumble, Twitch and NicoNico (list filtering).

**MAIN ↔ ISOLATED pattern.**
1. ISOLATED sends `<site>_request_config`.
2. MAIN polls a page global with growing back-off and answers `<site>_on_config`. It also pushes once on load.
3. The channel name is derived from a hash of the URL. Because a BroadcastChannel is shared with the whole origin, page scripts could listen in or forge messages. Use `window.postMessage` with a per-load random nonce, or `chrome.scripting` with `world:"MAIN"` returning values, instead.

**YouTube specifics**
- **Signature and `n` handling:**
  - The library fetches `base.js` and statically extracts the signature/`n` functions with an AST parser (meriyah).
  - It caches the result in IndexedDB, keyed by player ID.
  - VDH replaces the library's `eval` shim so that the extracted code goes to the service worker as a `qjs` message. The service worker runs it in a fresh **QuickJS** context and returns JSON. Nothing is `eval`'d in extension context.
- **No PO token / BotGuard.** VDH relies on client fallback order and cookie/visitor-data variants instead.
- **Formats** are classified by mimeType regex; there is no itag table. Progressive (muxed) formats are offered only when adaptive audio URLs are ciphered. The UI lists heights descending.
- **Not supported:** playlists (only the current `v=` is processed), Shorts beyond what ID parsing catches, and DRM checks (`has_drm` is hard-coded false).
- **Throttling:** the "YouTube throttle" setting, on by default, allows 1 YouTube job at a time, with 1 parallel request and a 6 s gap between jobs.
- **Store policy:** on the Chrome Web Store build, YouTube downloads are **blocked by policy** with a `no_youtube` notice, except on Brave behind an experiment flag. The code ships, but the Chrome build refuses to use it.

---

## 6. Segment downloading

There are two engines. The service worker picks one per job with a `will_use_jsfetch` flag.

**1. Manual JS path** (HLS)
- **Concurrency:**
  - 4 segments at once through a priority semaphore, or 1 when throttled;
  - all remaining segments are queued at once with descending priority, and results are consumed in playlist order;
  - read-ahead is not bounded.
- **Retries:**
  - playlist fetch: 5 attempts with no delay;
  - each segment: up to 5 attempts with linear back-off of 0, 0.5, 1 and 1.5 s;
  - a 30 s timeout on each body read, but no timeout on the `fetch()` call itself.
- **Bad segments:**
  - a segment that fails to demux is marked bad and skipped;
  - more than **35% bad** aborts the job;
  - a bad *required* segment (for example the first one) aborts it too.
- **Byte ranges:** EXT-X-BYTERANGE becomes a `Range` header. EXT-X-MAP init segments are prepended to each segment, with their byte range when one is set.
- **AES-128:**
  - decrypted with WebCrypto AES-CBC;
  - key bytes are fetched once per URI and cached;
  - when there is no IV, it is the media-sequence number, big-endian, in the last 4 bytes;
  - an encrypted init segment is decrypted as well.
- **Fake-PNG segments:** some hosts disguise TS segments as PNG. VDH finds the PNG `IEND` chunk and drops everything up to and including it.
- **Timestamps:** DISCONTINUITY tags are not handled explicitly. Instead, packet timestamps are re-stamped so they increase monotonically, and the first segment is rebased to 0 when the A/V start offset exceeds 250 ms.
- **Live recording:**
  - after each batch, it re-polls the playlist and keeps only segment URLs it has not seen;
  - when no new segments appear it waits 1.5 s, and stops after 5 empty polls;
  - "Stop" aborts and still writes a playable file from what was recorded.

**2. jsfetch path** (all DASH, some HLS and http)
- The whole job is handed to **FFmpeg's CLI entry point** inside libav.js. Inputs use a custom `jsfetch:` protocol, so FFmpeg's own hls/dash demuxers pull bytes through JS `fetch`.
- **Retries:** fetches get 6 attempts with a 30 s timeout and exponential back-off (250 ms × 2^n); 404 and 416 fail fast. Reads get 6 attempts and resume with `Range` when the server supports it. Without range support, a broken read is not retried for files above 40 MB.
- **Range probe:** it first tries `Range: bytes=0-` (except for playlists), then retries without it.
- **YouTube:** downloaded in 10 MB chunks using the `&range=a-b` URL parameter, which avoids throttling.

**Headers, cookies, referer.** This is the key trick.
- `fetch()` in extension context cannot set `Cookie`, `Referer`, `Origin` or `Sec-*`. So before a job, the service worker installs **`declarativeNetRequest` session rules** that set them. Each rule is a `modifyHeaders` "set" with priority 1 and `resourceTypes: ["xmlhttprequest"]`, using the exact header values captured when the page made the request.
- Each rule's `urlFilter` is the **directory** of the URL plus `*`, so one rule covers many segments.
- For HLS, the service worker walks the playlists and adds a rule for every distinct segment, init and key directory, up to 750 rules.
- Rules are removed when the job ends.
- `Range`, `User-Agent`, `Host`, `Connection` and `Proxy-*` are always stripped.
- The worker's own `fetch` uses default credentials. Cookies arrive through the rules, not through `credentials: "include"`.

**Progress and cancellation**
- Progress is posted at most every 500 ms, with bytes, percent and output duration. Percent comes from FFmpeg's `out_time` against the duration, or from bytes against the size. Two-stream YouTube jobs are scaled 50/50.
- Each job has its own AbortController; the jsfetch path also calls an FFmpeg interrupt hook.

**Queue.** At most 6 downloads run at once by default, configurable. YouTube-throttled jobs are serialised.

---

## 7. Merging and remuxing (libav.js)

**Engine.** [libav.js](https://github.com/Yahweasel/libav.js) 6.5.7.1, built with a custom "h264-aac-mp3" variant and run without its own worker inside the download worker. VDH's build adds:
- an exported `ffmpeg_main` (the full FFmpeg CLI);
- an interrupt hook and out-time/size getters;
- custom `-mpd_video_idx` / `-mpd_audio_idx` demuxer options;
- the `jsfetch` protocol.

**What is compiled in**

| Part | Included |
|---|---|
| Protocols | data, file, crypto, jsfetch |
| Demuxers | hls, dash (libxml2), mpegts, mov/mp4, matroska, flv, aac, mp3, h264, ogg, webvtt, srt, ass |
| Muxers | mp4, matroska, mp3, hls, webvtt, srt, ass (no webm, which is why webm sources go to mkv) |
| Decoders | aac, h264, mp3, opus, vp9, webvtt, srt, ass |
| Encoders | libmp3lame, mov_text only (no video encoder, no AAC/Opus encoder) |
| BSFs, filters | h264_metadata, extract_extradata, vp9_metadata, opus_metadata, aac_adtstoasc, vp9_superframe; aresample, asetnsamples |

**What it does with it**
- **Video is always stream-copied (`-c:v copy`) and never transcoded.**
- **Every job:** `-avoid_negative_ts make_zero` is passed every time. `-movflags faststart` is not used, so moov ends up at the end of the file.
- **HLS, two sources:** two hls inputs, mapping video from the first and audio from the second. Subtitles become `mov_text` for mp4, or are copied for mkv. An ISO-639-2 language tag is written on the audio stream.
- **DASH:** a single dash input at the chosen video index, plus the audio representation selected by its id.
- **Audio-only:** decode → resample to 44.1 kHz → `asetnsamples=1152` → LAME at 128 kbps → mp3.
- **Previews:** a 3–5 s, video-only copy.
- **Manual path:** libav's low-level API (demuxer per segment → packet arrays → muxer) instead of the CLI.

**Output and validity**
- The muxer writes straight to an **OPFS** file through a sync access handle. This avoids holding the whole output in memory, though each segment is still buffered whole.
- Output under 1 KB counts as failure.
- Output under 95% of the expected duration (or 90% of the size) is still delivered, but flagged `percentage_incomplete`.

---

## 8. Saving and naming files

**Saving**
1. The worker returns `URL.createObjectURL(File)` for the OPFS file.
2. The service worker calls `chrome.downloads.download` with `{url: blobURL, filename: "<subdir>/<name>.<ext>", conflictAction: "uniquify", saveAs}`.
3. On Chrome it also registers `downloads.onDeterminingFilename` only while the job runs, and re-asserts the same filename for its own blob URLs, so another extension cannot rename the file.
4. Afterwards it deletes the OPFS file and revokes the blob URL. OPFS is also purged whenever the service worker starts.
5. If `downloads.download` takes more than 5 s without saveAs, it assumes Chrome's "Ask where to save" setting is on and remembers that.

The default folder is Chrome's Downloads folder; a naming rule can add a subfolder.

**"Smart naming"** is a small template language written in **TOML**, with an in-UI editor.
- **Top-level default:** `template = "%title"`, `max_length = 64`, and an optional `force_doc_title`.
- **`[[rule]]` entries**, matched by URL substring, can set:
  - `template` and `max_length`;
  - `selector`: a CSS selector run in the page's MAIN world, whose `content` or `textContent` becomes `%selector`;
  - `directory`: a sanitised subfolder of at most 255 characters;
  - `replace = [{from, to}]`: case-insensitive global regex replacements;
  - `force_doc_title`.
- **Variables:**
  - `%title`: the media title, then the page title, then the filename;
  - `%hostname`: the second-level domain label, e.g. `youtube`;
  - `%selector`.
- An empty variable is removed together with the space, `-` or `_` before it.

**Sanitiser**
1. NFC-normalise and strip leading dots.
2. Keep only letters, digits, combining marks, `- _ .` and spaces, and collapse runs of dashes.
3. Cut to 190 characters, falling back to `no-name` if empty.
4. Cut to `max_length`, apply the replacements, then sanitise and cut again.

The extension comes from the chosen container (mp4, mkv or mp3) or from the original file.

---

## 9. DRM detection and refusal

**Detection**
- **HLS:** an `EXT-X-KEY` whose KEYFORMAT is FairPlay (`com.apple.streamingkeydelivery`), PlayReady (`com.microsoft.playready`) or Widevine (`urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`). These come with METHOD SAMPLE-AES, SAMPLE-AES-CTR or CENC.
- **DASH:** `ContentProtection` schemeIdUri values that map to Widevine or PlayReady.
- **EME:** an injected check for `<video>` elements whose `mediaKeys` is set. This feeds the history and error records and the UI's `⚠️ DRM` badge.
- **Not treated as DRM:** plain AES-128 HLS (key URI fetched normally), ClearKey, and site obfuscation such as Osmosis or the 91porna payload.

**Refusal**
- At download time the service worker checks `has_drm`. If it is set, it records a `download_error` notification with `has_drm: true` and returns **without starting the worker**.
- In the UI, the media card shows a DRM warning box.
- In the worker, SAMPLE-AES segments are never decrypted, so they fail as bad segments and the job aborts at the 35% threshold.

**Gaps.** Several extractors hard-code `has_drm: false`: YouTube, Vimeo, Facebook (which computes the flag and then discards it) and iQIYI. For them, DRM content is not filtered early and simply fails later. Your build should propagate the flag everywhere and also check YouTube's `drm_families` / playability status.

---

## 10. Supported formats and sites (reference lists)

**Input stream types:** HLS (master, media, live, LL-HLS tags parsed but not specially handled, AES-128, fMP4 or TS segments, byte ranges), DASH (anything FFmpeg's dash demuxer handles), direct progressive files, YouTube adaptive and progressive formats, and paired progressive audio+video files (Bilibili).

**Recognised direct-file types:** mp4, m4v, webm, mkv/matroska, mov, mpeg, mp2t/ts/mts, ogg, flac, wav, m4a, flv, 3gp, avi/msvideo, vorbis.

**Codecs:**
- **Video:** H.264 and HEVC go to mp4 or mkv. VP8, VP9 and AV1 go to mkv. HEVC and AV1 are copied without a parser, so I'm not sure that always works.
- **Audio:** AAC goes to mp4. Opus and Vorbis go to mkv. Audio-only output is always MP3, but Vorbis, AC-3 and HEVC-era audio cannot be converted to MP3 because the decoder is missing.

**Output containers:** MP4 (default), MKV (option, and forced for webm sources), MP3 (audio-only). Original files are kept as they are. Subtitles are embedded as mov_text in MP4 or copied into MKV. In VDH, embedding subtitles on non-YouTube media is a premium feature.

**Sites with dedicated code:** YouTube, Vimeo, Facebook, Instagram, OK.ru, VK / vkvideo (including live), Bilibili (.com and .tv), Kick, iQIYI (iq.com), Canva, Osmosis, TwitCasting, Chaturbate, 91porna (and a mirror), javrank, taiav.

**Sites tuned by ruleset flags only:** Loom, SoundCloud, TikTok, Douyin, Rumble, Twitch, NicoNico. Everything else is handled generically through sniffing.

---

## 11. Licensing, gating, and other things not worth copying

**Licensing and gating**
- **Licence:** a JWT checked locally with ES256 against an embedded key. It has to match the store, and it is renewed against the vendor's server near expiry.
- **Free tier:** on HLS/DASH (not direct files), after roughly the first 3 streamed downloads, one streamed download is allowed per **2 hours**. Linux and OpenBSD are exempt.
- **Other limits:** subtitles are stripped for free users. Downloads are blocked until the terms of service are accepted.
- **Upsell:** `activate.js` and `premium.js` exist only to talk to downloadhelper.net for activation and the premium page.

**Other things not to copy**
- The extension-ID gate, the remote ruleset with hashed names, and the review prompt after 100 downloads.
- Shared BroadcastChannels between page and extension worlds, which leak to page scripts.

---

## 12. Techniques worth copying

1. **Offscreen document as a worker host.** It is the standard MV3 workaround for running wasm-heavy work outside the service worker.
2. **Capture request headers at `onSendHeaders` (with `extraHeaders`), then replay them with DNR session rules scoped to the URL's directory.** This is the only clean way to send Cookie, Referer and Origin from an MV3 fetch. Remove the rules afterwards and cap their number.
3. **Re-fetch manifests yourself** instead of trying to read response bodies, which `webRequest` cannot do in MV3.
4. **A normalised media object** (`type`, `hash`, `playlist[]` of variants with `av{video,audio}`, `duration` or `"live"`, `has_drm`, `sent_headers`, `subtitles[]`, `title`, `thumbnail`). It decouples extractors from the downloader.
5. **Strategy strings chosen in the service worker and dispatched in the worker** (one source or two, audio-only, preview, live). The worker never makes policy decisions.
6. **Pair audio and video by codec family** (H.264/HEVC with AAC, VP9/AV1 with Opus) and pick the container from the family. Never transcode video.
7. **FFmpeg-in-wasm with a custom fetch protocol**, so FFmpeg's mature hls/dash demuxers do segment addressing. It is far less JS than writing a DASH engine.
8. **Write output to OPFS** through a sync access handle in the worker, then save it with `chrome.downloads` from a blob URL. Purge OPFS on startup.
9. **State in `storage.session` / `storage.local` with a debounce, and a UI that only reads it.** This survives service-worker restarts.
10. **A tagged serializer** for URL, Headers, Map and Set across `sendMessage` and storage.
11. **A QuickJS sandbox for untrusted JS** (YouTube player functions), keeping `eval` out of extension pages.
12. **Live HLS recording** by polling, de-duplicating by segment URL, and stopping after N empty polls. "Stop" still writes a valid file.
13. **Robustness tricks:**
    - stripping fake PNG headers from segments;
    - rebuilding monotonic timestamps across discontinuities;
    - a bad-segment threshold instead of failing on the first error;
    - resuming reads with Range;
    - delivering partial output with a flag instead of nothing.
14. **Smart default sort** for the UI: site-native and YouTube first, then DASH, then HLS master, then others; VOD before live; same-domain first; then length and quality.
15. **Template filenames with per-site rules and a CSS-selector variable**, plus a strict, Unicode-aware sanitiser.

## 13. Known weak spots in VDH (do better)

**Bugs and gaps**
- `has_drm` is hard-coded false in several extractors, so DRM content only fails at download time.
- Unbounded read-ahead: all segments are queued at once, so a slow head segment lets later ones pile up in memory. Use a bounded window, for example 4 in flight and at most 16 buffered.
- There is no fetch-level timeout on the manual path.
- Retry settings that look tunable are never wired up, so the defaults always apply.
- The IV for an encrypted init segment is built with the wrong byte order (likely bug), and IV derivation only covers 32-bit media-sequence numbers.
- No `faststart`: the MP4 moov ends up at the end of the file. Add `-movflags +faststart`, or remux once more at the end for short files.
- Bilibili WBI key substring indices are taken from the wrong string (fragile).

**Missing features**
- No MSE/blob capture fallback, so a site with only a blob player and an unreachable manifest gets nothing.
- No HLS AUDIO-group switching per variant beyond the first match, and no multi-audio output.
- No YouTube PO-token support, so YouTube breaks whenever all fallback clients get blocked.

---

## 14. Ready-to-paste build prompt

Paste everything inside the fence into a cloud Claude Code session started in an empty repo.

````text
Build an original Chrome Manifest V3 extension, "StreamSaver" (rename freely), that detects and downloads web video and audio streams entirely in the browser. It is a personal-use tool. Write all code yourself or use the open-source libraries named below. Do not copy code from any existing downloader extension.

HARD RULE — NO DRM: Detect Widevine, PlayReady and FairPlay (HLS EXT-X-KEY KEYFORMAT: com.apple.streamingkeydelivery, com.microsoft.playready, urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed; any METHOD of SAMPLE-AES, SAMPLE-AES-CTR or CENC; DASH ContentProtection schemeIdUri for Widevine/PlayReady; YouTube drm_families or a DRM playability status; any <video> with a non-null mediaKeys). Mark such media has_drm=true, show "Protected by DRM — not supported", and never start a download for it. Never implement CDM, license-server or key-extraction code. Plain HLS AES-128 with a fetchable key is not DRM and must be supported.

## Before any UI work
Create DESIGN.md first. It must define:
- colour tokens (primary, accent, background, surface, text) for light and dark mode
- one font family with 5 text sizes
- a spacing scale of 4/8/12/16/24/32
- radius, shadows, and button and input styles
- an icon set drawn to match SF Symbols' weight and metrics (no other icon library, no sparkles icon)
- one spring easing curve
Put the tokens in a single CSS custom-property file and use only tokens in every screen; never hardcode a colour, size, spacing, radius, shadow or easing value. Give the product one concept — a material, a place or a metaphor — that every surface is built from, and avoid generic card-stack and gradient UI. Before calling the UI done, take screenshots of the popup and side panel at narrow and wide widths, in light and dark mode, and confirm nothing overflows or is clipped.

## Stack
- TypeScript, Vite (or esbuild) producing an MV3 bundle; pnpm.
- Libraries:
  - m3u8-parser and mpd-parser (video.js), plus @xmldom/xmldom for the service worker
  - libav.js, with a custom build variant that includes: the hls, dash (libxml2), mpegts, mov, matroska, flv, aac, mp3, ogg, webvtt and srt demuxers; the mp4, matroska, webm, mp3 and webvtt muxers; the aac, h264, mp3, opus, vorbis and vp9 decoders; the libmp3lame and mov_text encoders; the aac_adtstoasc, extract_extradata and vp9_superframe bitstream filters; the aresample filter; and the crypto protocol. Expose ffmpeg's CLI entry point if feasible. If a custom build is too heavy, use ffmpeg.wasm (single-thread core) as the fallback.
  - youtubei.js (LuanRT) for YouTube
  - quickjs-emscripten as a sandboxed evaluator for YouTube player functions
  - zod for settings validation; smol-toml for naming rules
  - Check every library's licence and record it in THIRD_PARTY.md. libav.js/FFmpeg are LGPL; keep the build LGPL-only.
- Manifest:
  - permissions: tabs, offscreen, downloads, sidePanel, webRequest, webNavigation, scripting, declarativeNetRequest, storage, unlimitedStorage, contextMenus, notifications; optional: downloads.open
  - host_permissions: <all_urls>
  - CSP for extension pages: script-src 'self' 'wasm-unsafe-eval'
  - a module service worker; a popup and a side panel sharing one UI
  - commands: open the popup; run the default action on the top media

## Architecture
1. Service worker (src/sw):
   - media registry per tab
   - network sniffer
   - header capture and replay
   - strategy selection
   - download queue (max concurrent downloads, default 4; a YouTube lane of 1 at a time)
   - saving and naming
   - context menu with up to 12 items for the current tab's media
   - action badge (count of media; active downloads in a second colour)
   - QuickJS evaluator endpoint
2. Offscreen document (reason WORKERS): spawns one module Web Worker and does nothing else.
3. Download worker (src/worker): fetch, decrypt, remux with libav.js, write to OPFS, report progress, return a blob URL.
4. Content scripts (src/sites/*): one ISOLATED script per site, plus small MAIN-world helpers registered with world:"MAIN". MAIN→ISOLATED messaging uses window.postMessage with a random per-page nonce and origin checks (do NOT use a page-visible BroadcastChannel).
5. UI (src/ui): vanilla Web Components or Preact, using only DESIGN.md tokens.
6. Messaging:
   - one typed envelope {kind, payload, requestId}
   - a tagged serializer for URL, Headers, Map, Set and Error
   - retry tabs.sendMessage up to 10 times, 1 s apart, when a content script is not ready
7. State:
   - chrome.storage.session holds discovered media per tab, downloads, notifications and recent items
   - chrome.storage.local holds settings, history and naming rules
   - debounce writes by 500 ms
   - the UI only reads storage and listens to storage.onChanged
   - register webRequest listeners at top level so the service worker wakes on traffic

## Media object (shared type)
{ id/hash, tabId, type: "http" | "hls_master" | "hls_media" | "dash" | "youtube" | "pair",
  pageUrl, initiator, title, thumbnail, duration: number | "live" | "unknown",
  variants: [{ label, height, width, bitrate, codecs, family: "mp4" | "webm" | "audio",
               video?: SourceRef, audio?: SourceRef, audioLanguage?, sizeBytes? }],
  subtitles: [{ lang, label, url | dashId | hlsGroupUri, format }],
  sentHeaders: Record<string, string>, supportsRanges?: boolean, has_drm: boolean,
  detectedAt, sourceKind: "sniffer" | "<siteId>" }
Hash: HLS = hash(manifest text + URL), DASH = hash(manifest text), http = hash(URL).

## Detection
- webRequest.onSendHeaders with ["requestHeaders","extraHeaders"] on <all_urls> for the types xmlhttprequest, media, main_frame, sub_frame and other. Cache headers by requestId for 10 minutes.
- webRequest.onResponseStarted with ["responseHeaders","extraHeaders"]. Ignore:
  - non-2xx responses
  - requests from extension pages
  - segment paths (.ts, .m4s, .m2ts, .aac segments)
  - domains handled by a site extractor
- Classify:
  - HLS: content-type contains mpegurl, or the URL contains .m3u8
  - DASH: content-type contains dash+xml, or the URL contains .mpd
  - Direct file: type "media" or a MIME in {mp4, webm, x-matroska, quicktime, mpeg, mp2t, ogg, flac, wav, x-m4a, x-flv, 3gpp, x-msvideo}. Derive the extension from the URL, then Content-Disposition, then MIME. Ignore files under 500 KB, and under 20 MB when the page already has a DASH manifest. Record Accept-Ranges.
- Re-fetch HLS and DASH manifests in the service worker with the captured headers (via the header-replay rules below) and parse them.
- De-dup:
  - drop child media playlists once their master is known
  - keep at most 10 items per type per tab (FIFO 30 for feed sites: TikTok, Instagram, Facebook, Douyin, Rumble, Kick)
  - clear a tab's list on top-frame navigation and on tab close
- Metadata: get title and thumbnail with scripting.executeScript (document.title, og:title, video[poster], og:image, link[rel=image_src]).
- Fallback: MAIN-world MSE capture, opt-in per site and off by default.
  - Hook MediaSource.prototype.addSourceBuffer and SourceBuffer.prototype.appendBuffer to record mimeType and init segments.
  - Use them only to locate the manifest/segment URLs via performance.getEntriesByType("resource").
  - Never record decrypted frames, and disable this entirely when mediaKeys is set.

## HLS / DASH selection (service worker)
- Map CODECS to a family:
  - avc1, avc3, hvc1, hev1, mp4v → mp4
  - av01, vp08, vp8, vp09, vp9 → webm
  - mp4a, ac-3, ec-3, mp3 → audio (mp4-compatible)
  - opus, vorbis → audio (webm-compatible)
  - Drop unknown codecs. Skip VIDEO-RANGE=PQ unless the user enables HDR.
- Resolve AUDIO groups. Choose a language with this order:
  1. exact BCP-47 match against the user's ordered list
  2. primary-subtag match
  3. the DEFAULT=YES rendition
  4. the first rendition
  Offer "original language" as the default strategy.
- Sort variants by height descending, then bandwidth descending. Default pick: the remembered choice, else the preferred height (highest/2160/1440/1080/720/480), else the best.
- Live: no ENDLIST, or the last PROGRAM-DATE-TIME within 10 minutes. Treat EXT-X-PLAYLIST-TYPE:VOD/EVENT correctly.
- DASH: parse with mpd-parser for listing and choice only; pass the chosen video and audio representation ids to the worker.
- Subtitles: HLS SUBTITLES groups; DASH text AdaptationSets (skip wvtt-in-mp4 unless supported).
- Output container:
  - mp4 family → user choice of MP4 (default) or MKV
  - webm family → WebM when the codecs are VP8/VP9/AV1 + Opus/Vorbis, else MKV
  - audio-only → user choice of M4A (copy, when AAC) or MP3 (LAME VBR ~V2) or OPUS/OGG (copy)
- The strategy string for the worker is one of:
  - http_single
  - http_pair
  - hls_single
  - hls_pair (separate audio rendition)
  - hls_audio
  - hls_live
  - dash_pair
  - dash_audio
  - youtube_pair
  - youtube_single
  - *_preview (5 s, video only)

## Header replay (service worker)
- Before a job, install declarativeNetRequest.updateSessionRules "modifyHeaders"/"set" rules with:
  - the captured Cookie, Referer, Origin and needed Sec-Fetch-* values
  - resourceTypes ["xmlhttprequest","media","other"]
  - initiatorDomains = [chrome.runtime.id]
  - urlFilter = the directory of each distinct playlist, segment, init and key URL, followed by "*"
- Track rule ids per job, cap at 500 per job, and remove them on finish, error or abort.
- Strip Range, Host, Connection, Proxy-* and User-Agent from the replay set. Set User-Agent via a rule only when a site needs it.
- Keep a global rule-id allocator and remove stale rules on service-worker startup.

## Download worker
- Engine A (JS segment loop) for HLS:
  - fetch the media playlist with 5 attempts and exponential backoff plus jitter (250 ms × 2^n)
  - a 20 s timeout on fetch and a 30 s timeout per read
  - a bounded window: 4 in flight, at most 16 buffered, results consumed in order
  - segment retries: 5 with backoff; if a segment fails after retries, mark it bad and skip it; abort when more than 25% are bad or a required init fails
  - support EXT-X-BYTERANGE and EXT-X-MAP (prepend the init to each segment for demux)
  - AES-128 via WebCrypto AES-CBC; cache keys per URI; IV = the explicit IV or the 128-bit big-endian media sequence; decrypt encrypted init segments too
  - refuse SAMPLE-AES / anything marked DRM
  - strip fake PNG headers (skip through the IEND chunk) when a segment starts with a PNG signature
  - rebuild monotonic DTS/PTS across discontinuities; rebase the start to 0
  - live recording: poll at TARGETDURATION/2 (minimum 1 s), de-dup by URI + media sequence, and stop after 5 empty polls or on user stop; always finalise a valid file
- Engine B (FFmpeg-driven) for DASH and as a fallback for HLS:
  - run the ffmpeg CLI in libav.js with a custom JS-backed protocol (or pre-download segments into the virtual FS when a custom protocol isn't available)
  - map the chosen representations; resume reads with Range
- HTTP: download with Range chunks of 10 MB when Accept-Ranges is present (resumable, retried per chunk); otherwise stream fetch.
- YouTube: append &range=a-b chunks of 10 MB; one request at a time when "polite mode" is on.
- Remux rules:
  - always stream-copy video
  - copy audio when the container allows it, else transcode audio only (AAC→MP3 or Opus→MP3 for audio-only MP3)
  - pass -avoid_negative_ts make_zero and -movflags +faststart for MP4
  - set an ISO 639-2 language on the audio stream
  - subtitles: mov_text in MP4, copy (or convert to srt/ass) in MKV, keep WebVTT in WebM; also offer "save subtitles as a separate .vtt/.srt"
- Output:
  - write through an OPFS FileSystemSyncAccessHandle; return URL.createObjectURL(file)
  - validate: fail under 1 KB; flag "incomplete" when the duration is below 95% of the expected duration
  - progress at most every 500 ms (bytes, percent, speed, ETA; live = elapsed + size)
  - abort through an AbortController plus an ffmpeg interrupt
  - purge OPFS when the worker or service worker starts

## Saving and naming
- chrome.downloads.download({url: blobURL, filename: subdir + name + "." + ext, conflictAction: "uniquify", saveAs}).
- While a job is saving, register downloads.onDeterminingFilename to re-assert our filename for our own blob URLs.
- Revoke the blob URL and delete the OPFS file on completion.
- Naming rules in TOML (editable in a settings page with validation):
  - a top-level default: template = "%title", max_length = 80
  - [[rule]] url substring / regex, template, max_length, selector, directory, replace = [{from, to}], force_doc_title
  - variables: %title, %hostname, %domain, %selector, %date (YYYY-MM-DD), %quality (e.g. 1080p), %lang, %id (site id when known)
  - drop an empty variable together with the separator before it
- Sanitise:
  1. NFC; strip leading dots and control characters
  2. replace characters reserved on any OS (<>:"/\|?* and trailing dot/space)
  3. collapse whitespace and dashes; cut to max_length (≤ 200 bytes UTF-8); fallback "untitled"
  4. avoid Windows reserved names (CON, NUL, COM1…)
- History: an optional, opt-in log of the last N days with search; "show in folder" and "open" (optional permission).

## Site extractors (each yields the shared media object; each lives in its own module with a fixture test)
- YouTube:
  - youtubei.js Innertube with the page's fetch, visitor data (from ytcfg in MAIN) and a configurable ordered client list (default: WEB_EMBEDDED, ANDROID_VR, IOS, MWEB, WEB)
  - try clients in order and merge the best format list; HLS for live
  - pair video with audio of the same family (H.264/HEVC + AAC; VP9/AV1 + Opus)
  - run signature/n functions through quickjs-emscripten in the service worker (a fresh context per call, a memory limit, an interrupt handler)
  - support /watch, /shorts/, /live/, youtu.be, embeds, and SPA navigation
  - optionally enumerate playlists (list=)
  - respect DRM flags
  - leave room for a PO-token provider interface (no BotGuard code required)
- Vimeo: playerConfig (MAIN) or a /config fetch → HLS (or DASH) + text_tracks.
- Facebook / Instagram: fetch the page HTML with credentials, extract the embedded DASH manifest XML / progressive URLs, and watch for SPA URL changes.
- OK.ru: data-options → flashvars.metadata (HLS preferred, DASH fallback, subtitles), with a /videoembed fallback.
- VK / vkvideo: video metadata via the al_video.php "show" endpoint (POST from the service worker with replayed Origin/Referer); live via the public vkvideo live API.
- Bilibili: __INITIAL_STATE__ ids → playurl API (WBI-signed on .com: nav key mix + MD5) → separate video/audio → pair.
- Kick: v2 channel API (live), v1 VOD playback (rebuild a clean master from the media base to skip ad-stitched manifests), clips API.
- iQIYI, Canva, TwitCasting, Chaturbate (live, with a 20 s health check that removes dead streams): same approaches — read page JSON or the site API and emit HLS.
- Generic obfuscation helpers (opt-in per domain list): reversed-text playlists, base64-wrapped playlists, fake-PNG segments.
- A small "site rules" JSON bundled with the extension (not remote):
  - per-domain flags: carry the playlist query string onto segments (Loom); audio-only (SoundCloud); FIFO list; drop stray http/m3u8 once a playlist exists (Twitch, Rumble, NicoNico); allow small files; mpd→m3u8 swap
  - the user can edit it in advanced settings

## UI
- Popup and side panel (switchable). Per tab: a list sorted SMART:
  1. site-native and YouTube first
  2. then DASH, then HLS master, then other
  3. VOD before live
  4. same registrable domain first
  5. newer (>4 s), then longer, then higher quality
- Each card has:
  - a thumbnail or a short muted preview
  - an editable filename
  - type and quality badges
  - a variant picker ("1080p · MP4 · 4.2 Mb/s")
  - an audio-language picker
  - a subtitle picker
  - a primary action (Download / Download as / Audio only / Copy URL), with a per-site default action
  - a DRM state that disables actions
- Downloading card: progress, speed, ETA, Stop (for live: "Stop & save").
- Done card: Open, Show in folder, Remove, Retry.
- Settings: quality, container (MP4/MKV), audio strategy and languages, subtitle languages, concurrency, polite YouTube mode, download subfolder, naming rules editor, history days, notifications, context menu, dock mode, theme.
- A details/debug page per media showing all URLs, variants, headers sent, and an ffmpeg -version check.
- No licences, limits, upsells, remote config or telemetry.

## Quality bar
- Unit tests (Vitest):
  - m3u8/mpd selection, the codec→family map, language matching, the naming template and sanitiser
  - IV derivation, PNG stripping, the header-rule builder, the DRM detector (with HLS/DASH fixtures including Widevine/PlayReady/FairPlay that must be refused)
- Integration test:
  - a local fixture server (HLS TS + fMP4 + AES-128 + byte-range + live sliding window; DASH SegmentTemplate/Timeline; progressive mp4; separate audio)
  - Playwright loading the unpacked extension; assert the produced files play (check with ffprobe in CI)
- Write ARCHITECTURE.md (diagram + message list), SITES.md (coverage table) and THIRD_PARTY.md (licences).
- Build in this order and commit after each milestone:
  1. scaffolding + DESIGN.md
  2. sniffer + registry + UI list
  3. HTTP download + save + naming
  4. HLS engine + AES-128 + live
  5. DASH via libav.js
  6. header replay
  7. YouTube
  8. remaining site extractors
  9. settings, history, polish, tests
````
