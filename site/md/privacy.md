# Privacy policy

Effective 27 October 2026

Vidzilla is a Chrome extension that finds the video and audio a page plays and saves it to your computer. It has no accounts. It doesn't collect, sell or share your personal information, and it contains no analytics code or third-party ad code. Every few downloads it shows a short ad for another app by the same maker.

## What Vidzilla reads

To find media, Vidzilla looks at the network requests Chrome makes in your tabs: their addresses and content types. For requests that turn out to be video or audio, it also notes the cookie, referrer and origin headers the page sent, so that saving the file works the same way playing it did. It reads the page's title to name the file.

On a page whose video can't be fetched as a file, Vidzilla offers to record the player instead. Only when you press Record does it copy the video and audio the player loads, and only on that tab, until the recording ends or you stop it.

## Where that information stays

On your computer. The list of media found in each tab is kept in Chrome's session storage for the extension and is cleared when the tab closes or Chrome quits. Your settings, such as the filename pattern, are kept in Chrome's local storage for the extension, and so is the history of files you saved: each file's name, page address, title, thumbnail, size and date. You can clear the history from the settings page at any time. A count of how many files you've saved and when you last saw an ad is kept there too, to space the ads out. Files you save go to your Downloads folder, fetched directly from the site that served them.

## What Vidzilla sends

Nothing about you or what you save. Vidzilla makes two kinds of requests. Most go to the sites that host the media you choose to save, the same requests the page itself made. The other, every few hours, downloads the list of ads (vidzilla.followusai.com/ads.json, text and links only) from our website. That request carries no cookies and no information about you or your downloads; like any web request it reaches our host, Vercel, from your IP address, which we don't use to identify you. Seeing or clicking an ad isn't reported anywhere.

## Why it asks for its permissions

- **Read and change data on all websites**: Video can come from any site, so Vidzilla watches requests in every tab and replays a page's headers when you save.
- **Manage your downloads**: To save the finished file to your Downloads folder.
- **Tabs and navigation**: To keep each tab's list of media separate and clear it when you leave the page.
- **Storage**: To keep the media list, your settings, your download history and in-progress downloads on your device.

## Protected video

Vidzilla does not save video protected by DRM and does not try to get around it.

## Changes and contact

If this policy changes, the new version will be posted here with a new effective date. Questions about privacy go to [{{supportEmail}}](mailto:{{supportEmail}}) or the [contact page]({{origin}}/contact).
