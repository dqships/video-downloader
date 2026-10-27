# About Vidzilla

Independent · Open source · Free

Vidzilla is a Chrome extension that saves the video you're watching. Play a video on a page, click the Vidzilla mark in Chrome's toolbar, and it lists what the page is playing: plain files, HLS and DASH streams, audio tracks and subtitles. Pick a quality and the file lands in your Downloads folder, exactly as the site sent it.

## Why it exists

Saving a video you can already watch shouldn't mean pasting links into an ad-covered website, installing a desktop app, or creating an account. Vidzilla does the job inside the browser you're already using, with the same access the page already has, and nothing in between.

## How it's built

Everything runs in Chrome. Vidzilla watches the requests a page makes, keeps the ones that are video, and fetches them the same way the page did. Streams are joined into one file without re-encoding, so the picture and sound are untouched. There are no Vidzilla servers: nothing you watch or save passes through anyone else.

The code is public on [GitHub]({{repoUrl}}), for the extension and for this site.

## What it leaves alone

Video protected by DRM, such as Netflix or Disney+, stays protected: Vidzilla shows it in the list and says it can't be saved. It doesn't get around paywalls or sign-ins either. It saves what your browser already plays, so please respect the sites you save from and the people who made the video.

## Get in touch

Found a site where it doesn't work, or have an idea? The [contact page]({{origin}}/contact) says where to send it. Vidzilla is [free]({{origin}}/pricing), and the [privacy policy]({{origin}}/privacy) lists exactly what it reads.
