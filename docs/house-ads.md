# House ads

Vidzilla shows short ads for the maker's other apps before some downloads. The
list lives on the website as data, so ads can be added, changed or switched
off without a new extension release.

## Where the list lives

`site/ads.json`, published at `https://vidzilla.followusai.com/ads.json`.
Edit it, commit and push: Vercel redeploys the site, and every installed copy
of Vidzilla picks the new list up within 6 hours (it fetches the list at most
once every 6 hours, on a completed download). A copy of the same file ships
inside the extension and is used only until the first fetch works.

The file is data only. Vidzilla reads the fields below, shows them as plain
text and never runs anything from it, which is what the Chrome Web Store's
Manifest V3 rules require.

```json
{
  "schedule": { "firstAfter": 2, "every": 2, "minHours": 0.0167, "seconds": 15 },
  "upgradeUrl": "https://vidzilla.followusai.com/upgrade",
  "ads": [
    {
      "id": "webtomarkdown",
      "name": "WebToMarkdown",
      "line": "Copy any web page as clean Markdown, ready for notes, docs or an AI chat.",
      "cta": "Get WebToMarkdown",
      "url": "https://chromewebstore.google.com/detail/gaglchmlnkelnokjkilcbkggfdembeem",
      "image": "https://vidzilla.followusai.com/ads/webtomarkdown.png",
      "active": true
    }
  ]
}
```

### An ad

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | Unique, up to 40 characters. Never reuse one for a different app. |
| `name` | yes | The app's name, up to 40 characters. Shown large. |
| `line` | yes | One sentence on what the app does, up to 120 characters. |
| `cta` | yes | The button label, up to 32 characters, such as "Get Bloomin". |
| `url` | yes | Where the button goes. Must start with `https://`. |
| `image` | no | A square icon, `https://` only. Put it in `site/ads/` so it's served from the Vidzilla site. Shown at 56 × 56. |
| `active` | no | `false` hides the ad without deleting it. |

An ad that breaks a rule (missing field, too long, not https) is skipped, not
shown broken. `pnpm test` checks that every active ad in `site/ads.json` is
valid, so run it before pushing.

Ads take turns in the order they're listed.

### The schedule

| Field | Default | Meaning | Allowed |
| --- | --- | --- | --- |
| `firstAfter` | 5 | Completed downloads before the first ad ever | 1–100 |
| `every` | 4 | Completed downloads from one ad to the next | 2–100 |
| `minHours` | 6 | Hours that must pass between two ads, however many downloads. Fractions work from 1.0.4 (0.0167 is one minute); 1.0.3 and earlier round to whole hours | 0–720 |
| `seconds` | 15 | How long the ad stays up before Continue can be pressed | 0–15 |

The defaults (used when the file has no schedule): the first ad comes
before the 6th download, once 5 have finished (the review prompt comes on
the 3rd and the share prompt on the 6th), then at most one ad every 4
downloads and never more than one in 6 hours. Someone saving a couple of
videos a day sees about one ad every two days; a heavy user sees at most
four a day.

The live file (DQ, 2026-10-30) is busier: the first ad before the 3rd
download, then one before every other download, at least a minute apart.
A prompt that falls on a download with an ad waits for the next one.

### Remove ads

`upgradeUrl` is the page that sells the ad-free upgrade
(`https://vidzilla.followusai.com/upgrade`); the ad's "Remove ads" link opens
it with the install's ID. Empty hides the link. See
[ad-free-upgrade.md](ad-free-upgrade.md).

## How an ad behaves

- It shows when the person presses Download and an ad is due, before the
  download starts (decided 29 October 2026; it used to show after the file
  saved). The popup asks the service worker (`{kind: "ad-gate"}`), which
  decides from the schedule.
- It takes the place of the video list in the popup or side panel, labelled
  "Ad" with "From the maker of Vidzilla", for 15 seconds. Then the button
  reads Continue, and pressing it closes the ad and starts the download.
- The countdown only runs while the ad is on screen. Closing the popup pauses
  it and starts nothing; the ad comes back with the time it had left the next
  time the person presses Download.
- Settings stay reachable while an ad is up; the countdown pauses while they are open.
- One prompt per download: a download that had an ad before it gets no
  review or share prompt when it saves; that prompt waits for a later one.

## Chrome Web Store rules this follows

From the Program Policies ("Ads", "Quality guidelines", "Additional
requirements for Manifest V3"), checked 27 October 2026:

- Ads "must be presented in context or clearly state which product they are
  bundled with": the ad is inside Vidzilla's own popup and says it's from the
  maker of Vidzilla.
- Ads "must also be easily removable by either adjusting the settings or
  uninstalling the product altogether": uninstalling removes them; the paid
  upgrade is an extra way.
- Ads "may not simulate or impersonate system notifications": the ad is never
  a Chrome notification.
- "Forcing the user to click on ads ... is prohibited": the ad only asks the
  user to wait; Continue never requires clicking the ad.
- Remote data is allowed, remote code is not: `ads.json` is text and links.
- None of the policies mention timed or unskippable ads. The 15-second wait is
  the part a reviewer could still judge as disruptive under the quality
  guideline ("minimal distractions"). If a review is rejected for it, lower
  `seconds` in `ads.json`; no release needed.

The store listing, the privacy policy and the pricing page say Vidzilla shows
ads for the maker's other apps and fetches this list.
