# Third-party notices

Vidzilla bundles the following third-party software. Each keeps its own
licence, which applies to that component instead of Vidzilla's MIT License.
Built copies of the extension carry these files in `licenses/`.

## Mediabunny 1.62.1

- Used for: reading and remuxing HLS, DASH and recorded media to MP4/WebM.
- Licence: Mozilla Public License 2.0 (`licenses/mediabunny-LICENSE.txt`).
- Source code: https://github.com/Vanilagy/mediabunny (unmodified; the exact
  version is pinned in `package.json` and `pnpm-lock.yaml`).
- Copyright: Vanilagy and Mediabunny contributors.

## Archivo

- Used for: all text in the extension and on the website
  (`design/fonts/archivo.woff2`, a latin subset of the variable font).
- Licence: SIL Open Font License 1.1 (`design/fonts/OFL.txt`).
- Source: https://github.com/Omnibus-Type/Archivo
- Copyright 2020 The Archivo Project Authors.

## Server only (not in the extension)

The website's `api/` functions use `@vercel/functions` (Apache License 2.0).
Build tools (esbuild, TypeScript, Vitest) are development dependencies and are
not shipped.
