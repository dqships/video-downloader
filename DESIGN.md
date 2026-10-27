# Vidzilla design system

This file is the source of truth for every Vidzilla surface: the website in
`site/` and the extension's popup and side panel. Read it before building,
revising or reviewing any screen. Need something that isn't here? Add it to this
file first, then to `design/tokens.css`, then use it.

| File | What it holds |
| --- | --- |
| `design/tokens.css` | Every colour, type, spacing, radius, shadow, size and motion value, as CSS custom properties, with the font face |
| `design/components.css` | Shared components (buttons, inputs, edge print, the strip and its frames, perforated progress). The site and the popup both use these classes, so they can't drift apart |
| `design/icons/*.svg` | The only icon set |
| `design/fonts/` | Archivo (variable, latin subset) and its licence. Bundled, never loaded from a CDN |
| `brand/` | Logo files and app/toolbar icons; regenerate with `node scripts/make-brand.mjs` |

## The world: film on a lightbox

Vidzilla catches the video a page is playing and hands it to you as a file. The
product is built from one material: **35 mm film stock**, the thing video used
to be before it was a stream.

- **A detected video is a frame on a strip.** The popup list is a run of film:
  sprocket holes down the left edge, one frame per video, hairlines between
  frames. Never a stack of floating cards.
- **Metadata is edge print.** Film stock carries tiny condensed codes along its
  edge (stock, roll, frame number). Format, resolution, size and status use the
  same treatment: condensed caps, amber, tabular numbers (`.vz-edge`,
  `.vz-badge`).
- **Progress is perforation.** A download fills a row of perforations with
  safelight (`.vz-perf`), not a smooth bar.
- **Protected video is fogged film.** DRM frames are dimmed with a lock and a
  plain sentence. Vidzilla doesn't touch them.
- **Light mode is the lightbox, dark mode is the darkroom.** The lightbox is
  warm backlit paper; the darkroom is near black lit only by a vermilion
  safelight. Film itself (`--color-film`) stays dark in both, with amber edge
  print.
- **Install is a countdown leader.** The 3, 2, 1 of a film leader numbers the
  install steps on the site.

What follows from the concept: one strong colour (safelight vermilion) reserved
for action and progress; amber only for edge print; everything else neutral
paper or ink. No gradients, no glass, no tinted icon circles, no eyebrow pills
above headings, no three-column feature grids, no sparkles.

## Logo

A logo-modernism mark: constructed from two geometric figures, no drawing.

- **Construction.** An equilateral triangle pointing down (the play symbol
  turned toward the ground: download) is cut by a chevron parallel to its
  sides. The cut leaves a **V** (for Vidzilla, and the jaw that grabs) and a
  **rhombus** made of two equilateral triangles (the piece you take away).
- **Grid.** 96 units. Triangle from (4, 14) to (92, 14) to (48, 90.2). Rhombus
  half-width `a` = 12. Cut width `g` = 5 measured square to the cut. Toolbar
  and favicon sizes open the cut (`g` = 7 at 32 px, 9 at 16 px) so it survives
  the pixel grid. Geometry lives in `scripts/make-brand.mjs`.
- **Wordmark.** "vidzilla", lowercase, Archivo at width 125 and weight 800,
  tracking -0.03 em, outlined to paths (`brand/source/` holds the outline
  script and data).
- **Lockup.** Mark left of the wordmark, mark spanning ascender to baseline,
  gap of 0.36 × the mark height.
- **Colour.** Vermilion on paper (`mark.svg`, `lockup.svg`), bright vermilion on
  the darkroom (`mark-dark.svg`, `lockup-dark.svg`), or ink when only one colour
  is possible (`mark-ink.svg`). App icon: bright vermilion mark on a film tile.
- **Clear space** equals the rhombus height on all sides. Minimum size 16 px
  for the mark, 96 px wide for the lockup.
- Never redraw, outline, rotate, add effects to, or recolour the mark outside
  these colours. Never replace it with a generic SVG.

## Colour

| Token | Lightbox (light) | Darkroom (dark) | Use |
| --- | --- | --- | --- |
| `--color-bg` | `#F3EEE4` | `#0E0C0A` | Page background |
| `--color-surface` | `#FBF8F2` | `#191512` | Frames, the strip, raised areas |
| `--color-surface-sunken` | `#E6DFD1` | `#070605` | Sprocket rail, empty perforations |
| `--color-border` | `#D5CCBB` | `#2D2722` | Hairlines |
| `--color-text` | `#1B1713` | `#F2EADD` | Primary text, ink |
| `--color-text-muted` | `#675E52` | `#A2978A` | Secondary text |
| `--color-primary` | `#C43716` | `#FF6633` | Safelight vermilion: actions, progress, focus |
| `--color-primary-soft` | primary at 10 % | primary at 14 % | Hover fills |
| `--color-on-primary` | `#FFF7EF` | `#1C0A03` | Text and icons on primary |
| `--color-accent` | `#93590A` | `#EDA746` | Edge print amber |
| `--color-success` | `#2E6F45` | `#72C48F` | Saved |
| `--color-danger` | `#A8203F` | `#FF7D93` | Errors |
| `--color-film` | `#17130F` | `#050403` | Film stock, thumbnails (dark in both modes) |
| `--color-film-frame` | `#241E19` | `#15110E` | A frame's image area on film |
| `--color-film-edge` | `#E9A63E` | `#E9A63E` | Edge print on film |
| `--color-film-text` | `#F2EADD` | `#F2EADD` | Text on film |
| `--color-film-muted` | `#A89C8C` | `#A89C8C` | Secondary text on film |

All text pairs meet WCAG AA (body text 4.5:1). Pages follow the system theme;
setting `data-theme="light"` or `"dark"` on `<html>` overrides it. Masks use
alpha (`#000` / `transparent` in `mask` gradients); that is not a colour and is
the one place a literal appears.

## Type

One family: **Archivo** (Omnibus-Type, SIL OFL), variable on weight (100–900)
and width (62–125). The width axis does the work other systems use a second
font for: wide for display and buttons, condensed for edge print.

| Token | Size / line height | Use |
| --- | --- | --- |
| `--text-xs` | 11 / 14 px | Edge print, badges |
| `--text-sm` | 13 / 18 px | Popup body and filenames, metadata, captions |
| `--text-md` | 16 / 24 px | Site body, buttons, popup title |
| `--text-lg` | 22 → 32 px fluid / 1.15 | Section headings |
| `--text-xl` | 44 → 112 px fluid / 0.92 | Hero headline only |

- Weights: `--weight-regular` 400, `--weight-medium` 500, `--weight-bold` 700,
  `--weight-heavy` 800.
- Widths: `--stretch-condensed` 75 % (edge print), `--stretch-normal` 100 %
  (body), `--stretch-wide` 125 % (headlines, buttons, wordmark).
- Tracking: `--tracking-tight` -0.03 em on wide headlines, `--tracking-caps`
  0.08 em on condensed caps.
- Numbers that change (sizes, progress) use tabular figures.

## Spacing

`--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 ·
`--space-5` 24 · `--space-6` 32 px for components. Layout steps for the site
only: `--space-7` 48 · `--space-8` 64 · `--space-9` 96 · `--space-10` 128 px.

## Shape and depth

- Radius: `--radius-sm` 2 px (sprockets, badges, thumbnails: film corners are
  nearly square), `--radius-md` 6 px (buttons, icon buttons),
  `--radius-lg` 10 px (the strip, the popup body), `--radius-full` 50 % (dots
  only, such as browser window dots in the site demo).
- Shadow: `--shadow-strip` only, under a strip lying on the lightbox. Nothing
  else casts a shadow; separation comes from hairlines (`--size-hairline`).
- Sizes: hit target `--size-hit` 32 px (popup), control height
  `--size-control` 44 px (site and touch), icon `--size-icon` 20 px, popup width
  `--size-popup-width` 380 px, popup height cap `--size-popup-max-height` 600 px
  (Chrome's own limit), thumbnail 72 × 44, rail 16 px, sprocket 6 px,
  perforation 6 px with 4 px gaps, content width 1120 px, prose width 620 px,
  house ad icon `--size-ad-icon` 56 px.

## Controls

- **Primary button** (`.vz-btn`): filled vermilion, `--radius-md`, label in
  `--text-md` bold at wide width, 44 px tall. Hover darkens toward ink; press
  scales to 0.97 on the spring.
- **Quiet button** (`.vz-btn--quiet`): hairline border, ink label, vermilion
  border and soft fill on hover. `.vz-btn--small` is 32 px tall at `--text-sm`.
- **Icon button** (`.vz-icon-btn`): 32 × 32, 20 px icon, no fill at rest, soft
  vermilion fill on hover. `.vz-icon-btn--primary` is filled (the popup's
  Download).
- **Input** (`.vz-input`): a grease-pencil underline, never a box. Hairline at
  rest, muted on hover, vermilion on focus.
- **Select** (`.vz-select` wrapping a native `<select>` and a `chevron.down`
  icon): edge-print type, hairline box at `--radius-sm`, sits in a frame's meta
  row next to the badge. Options read like `1080p · 4.0 Mbps`. A frame can
  carry two: quality, then subtitles.
- **Toggle** (`.vz-toggle`, an `<input type="checkbox" role="switch">`): a
  small gate with one square sprocket that slides across on the spring. Off:
  sunken track, muted sprocket. On: vermilion track, `--color-on-primary`
  sprocket.
- **Text button** (`.vz-text-btn`): an action inside a sentence, such as
  "Saved as clip.mp4. **Show in folder**". Vermilion, bold, hairline
  underline that thickens on hover. A note holding one gets `.has-action` so it
  reads as one line of text.
- **Focus**: a 2 px vermilion outline offset 2 px on every interactive element.
- **Disabled**: 40 % opacity, no motion.

## Extension pages

The options page opens in a full tab and is built from the same parts as the
popup, laid out like a lab's log book.

- **Page** (`.vz-page` on `<body>`): one column, `--size-prose` + 128 px wide,
  centred. `.vz-page-head` holds the mark (`.vz-popup-mark`), the
  `.vz-page-title` and, on the right, `.vz-page-nav` (icon buttons or quiet
  small buttons).
- **Section** (`.vz-section`): a `.vz-section-head` with a `.vz-section-title`
  and an optional action on the right (for example "Clear history" as a quiet
  small button), then its content.
- **Settings** (`.vz-fields` holding `.vz-field` rows): one surface with
  hairlines between rows. Each row has `.vz-field-text` (a `.vz-field-label`
  and an optional `.vz-field-help`) on the left and its control on the right.
  Template variables in help text are `<code>` and print as amber edge type.
  `.vz-field--wide` puts the control under the label (the filename template);
  `.vz-input--short` is for numbers (max length). Rows stack under 560 px.
- **History** (`.vz-history` list of `.vz-history-row`): a contact sheet.
  Thumbnail (`.vz-thumb`), then `.vz-history-title`, `.vz-history-file` and a
  `.vz-history-meta.vz-edge` line (site · date · size), then
  `.vz-frame-actions` with icon buttons: `folder` (Show in folder) and
  `arrow.up.right` (Open page). `.is-missing` fogs a row whose file was
  moved or deleted. Thumbnails hide under 480 px.
- **Entry point**: a `gearshape` `.vz-icon-btn` at the right end of
  `.vz-popup-head` opens the options page.

## Popup and side panel

One page, two shells. `popup.html` is the popup; the build writes
`sidepanel.html` from it with `.vz-popup--panel` on `<body>`.

- **Head** (`.vz-popup-head`): mark, wordmark, the page's host as edge print,
  then icon buttons: the mode switch (`sidebar.right` "Switch to the side
  panel" in the popup, `rectangle.inset.topright.filled` "Switch to the popup"
  in the panel) and `gearshape` (settings, which turns into `xmark` while
  they are open).
- **Settings view** (`.vz-popup-settings`): the gear swaps the strip and foot
  for the same `.vz-fields` rows as the options page, in place, never in a new
  tab. The rows live once in `src/ui/settings-fields.html` and the build puts
  them in both pages.
- **Strip**: the only part that scrolls. The head and foot never move, so every
  control stays in view however many videos a page has.
- **Foot** (`.vz-popup-foot`): the tail of the roll, a grid of two equal
  columns and a narrow one. First row: quiet small buttons `folder`
  **Downloads** (opens the Downloads folder) and `clock` **Saved files** (the
  options page's history), then a `trash` icon button that clears the list for
  this tab. Second row: `star` **Rate** (opens Vidzilla's review page on the
  Chrome Web Store) and `square.and.arrow.up` **Share** (copies the store
  link, then reads "Copied" for a moment).
- **Ask** (`.vz-ask`): a title card spliced into the roll between the strip
  and the foot, shown when a rating or share ask is due (rules in
  `src/shared/asks.ts`). Film in both modes, its own sprocket rail with holes
  that show the page through them, amber edge print counting the files saved,
  a `.vz-ask-title`, one `.vz-ask-text` sentence and `.vz-ask-actions`: a
  primary small button and quiet small ones. It is always skippable ("Not
  now"), never blocks the strip, and waits behind the settings view.
- **House ad** (`.vz-ad`): one frame of film projected in place of the strip
  and foot, for the maker's other apps (list in `site/ads.json`, rules in
  `src/shared/ads.ts`, see `docs/house-ads.md`). The film tile (`.vz-ad-film`,
  `--radius-lg`, `--shadow-strip` like a strip on the lightbox) has sprocket
  holes along its top and bottom edges that show the page through them. Amber
  edge print reads "Ad · From the maker of Vidzilla" on the left and counts
  down the seconds on the right. Inside: a `--size-ad-icon` square (the app's
  icon, or its initial in wide heavy amber type on `--color-film-frame`), the
  app's name (`.vz-ad-name`, `--text-md` wide heavy), one `.vz-ad-line`
  sentence in film muted, and a primary button. Under the film, a
  perforation row fills as the wait runs out; then `.vz-ad-foot` holds a
  "Remove ads" text button (only when an upgrade page is set) and a quiet small
  Close button that reads "Close in 12" and is disabled until the time is up.
  The countdown only runs while the ad is on screen, waits behind the settings
  view, and never shows on the same download as an ask.
- **Sizing**: the popup is `--size-popup-width` wide and at most
  `--size-popup-max-height` tall. Never size it with `vw` or `vh`: Chrome opens
  a popup tiny and grows it to fit the page, so viewport units collapse it and
  clip the controls. The side panel fills Chrome's panel (`100vh`) and follows
  the active tab.
- **Mode**: whichever the user picks, popup or side panel, sticks. Opening
  the side panel makes it the toolbar button's target until the user switches
  back with the head button or the "Open in the side panel" setting.

## Icons

SF Symbols can't ship on the web, so `design/icons/` holds one set drawn to SF
Symbols' regular weight and metrics: 24-unit grid, 1.75 strokes, round caps and
joins, filled shapes only for `*.fill` symbols. Files are named after the SF
Symbol they stand in for (`arrow.down.circle`, `doc.on.doc`, `checkmark`,
`xmark`, `lock`, `film`, `waveform`, `play.fill`, `pause.fill`,
`arrow.up.right`, `chevron.right`, `chevron.down`, `sun.max`, `moon`, `folder`,
`exclamationmark.triangle`, `gearshape`, `clock`, `trash`, `stop.fill`, `record.circle`,
`sidebar.right`, `rectangle.inset.topright.filled`, `star`,
`square.and.arrow.up`). Icons use `currentColor`. Add a new icon by drawing
it to the same rules; never mix in another library, and never use a sparkles
icon. Import them as text (esbuild `loader: { ".svg": "text" }`) or inline them.

## Motion

One spring everywhere: `--ease-spring`, a `linear()` sampling of a damped spring
(stiffness 210, damping 22, mass 1; 2.6 % overshoot, settles in 540 ms).
Durations: `--duration-base` 540 ms for movement (frames arriving, progress),
`--duration-fast` 240 ms for hover and press. With
`prefers-reduced-motion`, both durations drop to 0.

## Illustration and image style

Build assets in code first: the mark, film strips, frames, edge print and the
countdown leader are all drawn with CSS and SVG. The site's social preview
(`brand/og-image.png`, 1200 × 630) is too: the lockup and the hero line on the
lightbox above a strip of film with edge print, rendered from the tokens by
`scripts/make-og.mjs`. If an image ever has to be
generated (Replicate), use this prompt and change only the scene:

> Flat logo-modernism illustration, 1960s corporate identity style. Built only
> from equilateral triangles, rhombuses, circles and straight film strips with
> sprocket holes. Two inks: vermilion #C43716 and warm black #1B1713, on warm
> paper #F3EEE4, no gradients, no texture, no shading, no text. Scene: {scene}.

Use `brand/app-icon-512.png` as the reference image so the mark stays
identical. No stock photos, no mixed styles.

## Checking work

Before calling any screen done: screenshots at phone (390 px) and desktop
(1440 px) widths for the site, at 380 px and as a tab for the popup, in both
light and dark, with nothing overflowing or clipped.
