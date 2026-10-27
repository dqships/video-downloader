# Shipping Vidzilla

Everything needed to publish the extension on the Chrome Web Store and put
the website on Vercel. You need Node 22.12 or later and pnpm 10.

```sh
git clone https://github.com/dqships/video-downloader.git
cd video-downloader
pnpm install
pnpm package        # builds and writes release/vidzilla-1.0.0.zip
```

The images in this folder are ready to upload. `pnpm store-assets` makes them
again from the real popup, after a UI change (it needs Playwright's Chromium
and the test fixtures from `pnpm fixtures`).

| File | Store field |
| --- | --- |
| `screenshot-1.png` … `screenshot-5.png` | Screenshots (1280×800) |
| `promo-small.png` | Small promo tile (440×280) |
| `promo-marquee.png` | Marquee promo tile (1400×560), optional |
| `../brand/app-icon-128.png` | Store icon (128×128) |

## 1. Put the website on Vercel

Do this first: the store listing needs the privacy policy's address.

1. On vercel.com, **Add New → Project**, and import the `video-downloader`
   repository.
2. Leave the settings as Vercel reads them from `vercel.json` (Framework:
   Other, build `pnpm site`, output `site-dist`) and press **Deploy**.
3. Under **Settings → Domains**, add `vidzilla.followusai.com` and set the
   DNS record Vercel shows (a CNAME for `vidzilla` on `followusai.com`).
   Canonical links, the sitemap and `llms.txt` already point there
   (`origin` in `site/pages.mjs`).

The privacy policy is then at `https://vidzilla.followusai.com/privacy`. Every push to
`main` redeploys the site.

To check the deploy (the markdown middleware only runs on Vercel, not in a
plain static preview):

```sh
curl -sI https://vidzilla.followusai.com/                # 200, with the security headers and Vary: Accept
curl -s -H "Accept: text/markdown" https://vidzilla.followusai.com/pricing   # the page as markdown
curl -sI https://vidzilla.followusai.com/no-such-page    # 404
```

## 2. Submit the extension

In the [developer dashboard](https://chrome.google.com/webstore/devconsole),
press **New item** and upload `release/vidzilla-1.0.0.zip`. Then fill in the
tabs as below.

### Store listing

- **Name:** Vidzilla (from the manifest)
- **Summary** (from the manifest): Finds the video and audio a page plays and saves it to your computer.
- **Category:** Tools
- **Language:** English
- **Homepage URL:** `https://vidzilla.followusai.com`
- **Support URL:** `https://vidzilla.followusai.com/support`
- **Support email:** `support@followusai.com`
- **Description:**

```
Vidzilla saves the video you're watching.

Play a video on almost any site, click the Vidzilla button, and pick the
quality. The file lands in your Downloads folder, at the quality the site sent.
Nothing is re-encoded, and there's nothing to sign up for.

What it saves
• Plain video and audio files: MP4, WebM, MOV, MP3, M4A and more
• HLS streams (.m3u8), including AES-128 encrypted ones, joined into one MP4
• DASH streams (.mpd), including WebM (VP9, AV1, Opus), with your choice of quality
• Separate audio and video tracks, merged into one file, or the audio on its own
• Subtitles, saved as .srt next to the video
• Live streams: press Record, then Stop
• Players that hide their stream: Record reloads the page and keeps what the
  player loads, from the start

How it works
Everything happens in your browser. Vidzilla watches the requests a page
makes, recognises video and audio, and fetches the file the same way the page
did. Streams are joined into a single file without re-encoding, so quality
and sound stay exactly as the site sent them.

Private by design
No accounts, no analytics, no servers. Vidzilla only talks to the sites that
host the media you choose to save.

Not supported
• Video protected by DRM (Netflix, Disney+, Prime Video, Spotify and similar).
  Vidzilla shows it as protected and never tries to get around it.
• YouTube, which Chrome Web Store policy doesn't allow.

Please only save media you have the right to keep.
```

### Privacy practices

- **Single purpose:** Vidzilla finds the video and audio a web page plays and
  saves it as a file to the user's computer.
- **Permission justifications:**

| Permission | Justification |
| --- | --- |
| Host permission `<all_urls>` | Video can come from any site. Vidzilla watches media requests in every tab to list them, and fetches the file the user chooses from the site that serves it. |
| `webRequest` | Recognises video, audio, HLS and DASH responses by their address and content type, and notes the referrer, origin and cookie headers the page sent so the download works the same way. |
| `declarativeNetRequest` | While a download runs, sets the same referrer and origin headers the page used on Vidzilla's own requests, since many video servers refuse requests without them. Rules are removed when the download ends. |
| `downloads` | Saves the finished file to the Downloads folder with the name the user chose. |
| `tabs` | Keeps each tab's list of media separate, shows the count on the toolbar button, and reloads the tab when the user asks to record a player from the start. |
| `webNavigation` | Clears a tab's media list when it goes to another page, including pages that change address without reloading. |
| `scripting` | Reads the page's title, thumbnail and the media it declares in its markup, to name files and list media the network doesn't show. When a server only answers the page itself, reads the stream's playlist from inside the page. |
| `offscreen` | Runs the download worker that fetches stream segments and joins them into one file, which a service worker can't do for long downloads. |
| `storage` | Keeps the media list, settings and saved-file history on the user's device. |
| `unlimitedStorage` | Large videos are assembled in the extension's private storage before saving, which can exceed the default quota. |

- **Remote code:** No, I am not using remote code.
- **Data usage:** tick **Web history** (the addresses of pages and media are
  kept on the device for the media list and history) and **Website content**
  (page titles and thumbnails). Then tick all three certifications: no sale
  of data, no use for unrelated purposes, no use for creditworthiness.
- **Privacy policy URL:** `https://vidzilla.followusai.com/privacy`

### Distribution

- **Visibility:** Public, or Unlisted for a soft launch
- **Regions:** All

Press **Submit for review**. Review usually takes from a few days to a few
weeks. Downloaders with broad host access are reviewed by hand, so a
question from the review team is normal: the permission table above answers
most of them.

## 3. After it's published

Put the listing's address into `site/release.js` (`storeUrl`) so every
"Add to Chrome" button links to it, then push to `main`. Vercel redeploys the
site.

For an update, raise `version` in `src/manifest.json` and `package.json`, run
`pnpm package`, and upload the new zip under **Package** in the dashboard.
