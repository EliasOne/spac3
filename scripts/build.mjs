// Builds the site into dist/. dist/ is the only folder that gets deployed.
//
//   npm run build   build once
//   npm run dev     build, serve dist/ at http://localhost:8000, rebuild on changes
//
// Steps:
//   1. Empty dist/.
//   2. Copy every file in src/ to dist/ unchanged, keeping the same paths, so all
//      page URLs stay exactly as they were in v147. (src/vendor/ is skipped:
//      those files are build inputs, not pages.)
//   3. Bundle the npm libraries in src/vendor/ with esbuild.
//
// As each legacy *.app.js bundle is rebuilt from readable modules (Phase 1), it
// moves out of "copied as-is" and into the esbuild step below.

import * as esbuild from 'esbuild';
import { cp, rm, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const DIST = path.join(root, 'dist');
const VENDOR = path.join(SRC, 'vendor');

// Library bundles: input in src/vendor/ -> output file name in dist/.
const VENDOR_BUNDLES = [
  { entry: 'supabase.js', out: 'supabase-js.bundle.js' },
];

async function build() {
  const started = Date.now();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  await cp(SRC, DIST, {
    recursive: true,
    filter: (from) => from !== VENDOR && !from.startsWith(VENDOR + path.sep),
  });

  await Promise.all(VENDOR_BUNDLES.map(({ entry, out }) => esbuild.build({
    entryPoints: [path.join(VENDOR, entry)],
    outfile: path.join(DIST, out),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  })));

  console.log(`Built dist/ in ${Date.now() - started} ms`);
}

await build();

if (process.argv.includes('--serve')) {
  // Rebuild when anything in src/ changes (debounced so a save of many files
  // triggers one build).
  let timer = null;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((err) => console.error(err)), 150);
  });

  const ctx = await esbuild.context({});
  const { port } = await ctx.serve({ servedir: DIST, port: 8000 });
  console.log(`Serving dist/ at http://localhost:${port}  (Ctrl+C to stop)`);
}
