# Save the video you're watching.

Vidzilla is a free Chrome extension that finds the video playing on a page and saves it to your computer as a file, at the quality the site sent. Nothing is re-encoded, and there is nothing to sign up for.

- [Add Vidzilla to Chrome]({{storeUrl}}) (Chrome 116 or later)
- No account, no tracking, no ads

## Or paste a link

Have a link to a video file or an .m3u8 stream? Paste it into the box on [the home page]({{origin}}/#paste) and save it right there, without installing anything. It handles MP4, WebM, MOV, M4A, MP3 and M3U8 links, and runs in your browser.

## What it saves

Files, streams, audio and subtitles, in the format the page sends them. Protected video stays protected.

- **MP4, WebM, MOV**: video files a page loads directly, at full size.
- **HLS**: .m3u8 streams, joined from their segments. You pick the quality.
- **DASH**: .mpd streams, with the separate audio track put back in.
- **M4A, MP3**: just the audio, when that's all you want.
- **VTT, SRT**: subtitles, saved next to the video.
- **Live**: live streams, recorded from the moment you press save.
- **DRM** (never): Netflix, Disney+ and other protected video. Vidzilla shows it and leaves it alone.

## What happens when you press save

It all happens inside Chrome, with nothing else to install.

1. **It watches.** While a page plays, Vidzilla reads the requests Chrome is already making and keeps the ones that are video: files, HLS playlists and DASH manifests.
2. **It remembers how you got in.** It keeps the cookies, referrer and origin the page sent, so when you save, the site sees the same request it already allowed.
3. **It fetches.** A background worker downloads the file in ranges and picks up where it stopped if the connection drops.
4. **It joins.** Streamed pieces are joined in the browser without re-encoding, so the picture is exactly what the site sent.
5. **It saves.** The file lands in your Downloads folder, named after the page title. Rename it in the popup first if you want.

## Get Vidzilla

Three steps and about a minute, from the Chrome Web Store to your first saved video.

1. **Add it to Chrome.** Open Vidzilla on the [Chrome Web Store]({{storeUrl}}) and click Add to Chrome.
2. **Pin it.** Click the puzzle piece in Chrome's toolbar and pin Vidzilla, so the mark is always in reach.
3. **Play, then click the mark.** Start a video on any page, click the Vidzilla mark, and save what it found.

## More

- [About Vidzilla]({{origin}}/about)
- [Pricing]({{origin}}/pricing): free
- [Contact]({{origin}}/contact)
- [Privacy policy]({{origin}}/privacy)
- [Source code on GitHub]({{repoUrl}})

Vidzilla saves what your browser already plays. Respect the sites you save from.
