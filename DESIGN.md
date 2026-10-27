# Design

> **Provisional.** The Vidzilla brand, logo and website are being designed separately, and this file will be replaced by that design system. The extension's popup will then be restyled to match the website. Until then, these tokens keep the popup consistent.

## Concept: the darkroom

Every surface comes from a photographer's darkroom. The popup is a strip of
film laid on a light table: each detected video is one frame, with sprocket
holes down its left edge. The only strong colour is the amber of a darkroom
safelight. It marks what you can act on and shows progress. In light mode the
strip becomes a contact sheet on paper and the amber reads as a grease-pencil
mark.

Rules that follow from the concept:

- Frames, not cards. A media item is a flat frame on the strip, separated by
  hairlines and the sprocket rail. There are no floating card stacks and no
  gradients.
- Amber is only for action and progress. Everything else is neutral.
- A protected (DRM) frame is "fogged": dimmed, with a lock and plain words.

## Tokens

All values live in `src/ui/tokens.css` as CSS custom properties. Screens use
only tokens: never a raw colour, size, spacing, radius, shadow or easing.

### Colour

| Token | Light (contact sheet) | Dark (darkroom) | Use |
| --- | --- | --- | --- |
| `--color-bg` | `#F4F1EA` paper | `#121110` | Page background |
| `--color-surface` | `#FFFDF8` | `#1C1A18` | Frames |
| `--color-surface-sunken` | `#E9E4D8` | `#0B0A09` | Sprocket rail, thumbnails |
| `--color-border` | `#D9D2C3` | `#2E2A26` | Hairlines |
| `--color-text` | `#1F1B16` | `#F2ECE2` | Primary text |
| `--color-text-muted` | `#6E665A` | `#A39A8C` | Secondary text |
| `--color-primary` | `#B5650F` | `#F0A23B` | Safelight: actions, progress |
| `--color-on-primary` | `#FFFFFF` | `#1A1205` | Text and icons on primary |
| `--color-accent` | `#B23A2E` | `#E2604F` | Errors and DRM |
| `--color-success` | `#2F7A4B` | `#6CC08A` | Saved |

### Type

One family: the system UI font (`-apple-system`, `BlinkMacSystemFont`,
`Segoe UI`, `Roboto`, sans-serif), with tabular numbers for sizes and
progress.

| Token | Size / line height | Use |
| --- | --- | --- |
| `--text-xs` | 11 / 14 | Badges |
| `--text-sm` | 12 / 16 | Metadata |
| `--text-md` | 13 / 18 | Body, filenames |
| `--text-lg` | 15 / 20 | Section titles |
| `--text-xl` | 17 / 22 | Popup title |

### Spacing, radius, shadow, motion

- Spacing: `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16,
  `--space-5` 24, `--space-6` 32 (px).
- Radius: `--radius-sm` 4 (badges, sprockets), `--radius-md` 8 (buttons,
  thumbnails), `--radius-lg` 12 (the strip).
- Shadow: `--shadow-strip`, a single soft shadow under the film strip. Nothing
  else casts a shadow.
- Motion: one spring, `--ease-spring: cubic-bezier(0.34, 1.36, 0.64, 1)`,
  with `--duration-fast` 160 ms and `--duration-base` 260 ms. Respect
  `prefers-reduced-motion`.

### Controls

- Icon button: 32 × 32 hit area, a 20 px icon, `--radius-md`. At rest it is
  text-coloured with no fill. On hover it gets a 12 % primary fill. The primary
  icon button (Download) is filled `--color-primary` with `--color-on-primary`
  icons.
- Text input (filename): `--text-md`, a 1 px `--color-border` underline only.
  It turns primary on focus.
- Badge: `--text-xs`, uppercase, `--radius-sm`, a 1 px border in
  `--color-border`, muted text.
- Progress: a 2 px bar along the bottom edge of the frame in primary.

### Icons

Icons are drawn in `src/ui/icons.ts` to match SF Symbols' regular weight: a
24 px grid, 1.75 px strokes, round caps and joins, no fills except small
dots. The set is download (arrow in a circle), copy (two sheets), check, close,
lock, film and waveform. No other icon library is used, and there is no sparkles
icon.
