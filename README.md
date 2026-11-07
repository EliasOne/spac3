# SPAC3

The SPAC3 / Space Radio web app: a 3D globe of rooms, the room itself (chat, radio, games, sketchpad, stickers, Craft) and the standalone Sketchpad. Static pages backed by Supabase.

## Quick start

Requires **Node 22+**.

```bash
npm install      # once, and again whenever package.json changes
npm run dev      # builds, then serves the site at http://localhost:8000 and rebuilds on save
npm run build    # one-off build into dist/
npm run verify   # compares dist/ with the deployed v147 and lists every difference
```

## Folder layout

```
src/                 everything you edit
  *.html, *.css      pages and styles
  *.js               readable source modules (sketch*, craft, floatBox, auth, ...)
  *.app.js           LEGACY minified bundles: room, globe, stickers. Do not edit.
                     Phase 1 rebuilds them from readable modules.
  vendor/            entry files for npm libraries (built, not copied)
scripts/
  build.mjs          the build: copies src/ to dist/, bundles vendor/ with esbuild
  verify-baseline.mjs
baseline/
  v147.sha256        fingerprints of every file in the deployed v147
dist/                build output. The ONLY folder that gets deployed. Not in git.
```

## How the build works

1. `dist/` is emptied.
2. Every file in `src/` is copied to `dist/` at the same path, so every URL stays as it was in v147.
3. esbuild bundles each npm library entry in `src/vendor/` (currently Supabase, pinned to 2.117.3 in `package.json`) into `dist/`.

As Phase 1 rebuilds the legacy `*.app.js` files from readable modules, they move from step 2 (copied) to step 3 (bundled).

## Deploying

The host serves `dist/`. Build command: `npm run build`. Output directory: `dist`.
On Cloudflare Pages, put these in the project's build settings and add the environment variable `NODE_VERSION=22`.

## Rules

- Never edit files in `dist/`, and never edit the minified `*.app.js` files.
- Library versions live in `package.json` only. Don't copy library files into `src/`.
- Run `npm run build && npm run verify` before every deploy. Any `UNEXPECTED` line means a file changed that you didn't intend to change.
- Every intended change to a deployed file gets added to `EXPECTED_CHANGES` in `scripts/verify-baseline.mjs`, in the same commit.
- Tag `v147-baseline` is the exact deployed v147. Roll back with `git checkout v147-baseline`.

See the refactor game plan in the SPAC3 project for the phases that follow.
