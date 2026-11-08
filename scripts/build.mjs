// Builds the site into dist/. dist/ is the only folder that gets deployed.
//
//   npm run build       build once (talks to PRODUCTION Supabase)
//   npm run dev         build, serve dist/ at http://localhost:8000, rebuild on changes
//   npm run dev:local   same, but pointed at the local Supabase (npx supabase start)
//
// Steps:
//   1. Empty dist/.
//   2. Copy every file in src/ to dist/ unchanged, keeping the same paths, so all
//      page URLs stay exactly as they were in v147. (src/vendor/ is skipped:
//      those files are build inputs, not pages.)
//   3. Bundle the npm libraries in src/vendor/ with esbuild.
//   4. Local mode only (--local): swap the production Supabase URL and key for
//      the local stack's in every built .js file. Production builds skip this.
//
// As each legacy *.app.js bundle is rebuilt from readable modules (Phase 1), it
// moves out of "copied as-is" and into the esbuild step below.

import * as esbuild from 'esbuild';
import { cp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
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

// The local stack's URL and publishable key. These are the shared defaults
// every `supabase start` prints; they only work on your own machine.
// Override with SPAC3_LOCAL_SUPABASE_URL / SPAC3_LOCAL_SUPABASE_KEY.
const LOCAL = process.argv.includes('--local');
const LOCAL_URL = process.env.SPAC3_LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_KEY = process.env.SPAC3_LOCAL_SUPABASE_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

// Production values come from src/config.js, the single place they're defined.
async function productionConfig() {
  const text = await readFile(path.join(SRC, 'config.js'), 'utf8');
  const url = text.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
  const key = text.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)?.[1];
  if (!url || !key) throw new Error('Could not read SUPABASE_URL / SUPABASE_ANON_KEY from src/config.js');
  return { url, key };
}

async function pointAtLocalSupabase() {
  const prod = await productionConfig();
  let changed = 0;
  for (const name of await readdir(DIST, { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    const file = path.join(DIST, name);
    const before = await readFile(file, 'utf8');
    const after = before.split(prod.url).join(LOCAL_URL).split(prod.key).join(LOCAL_KEY);
    if (after !== before) { await writeFile(file, after); changed++; }
  }
  if (!changed) throw new Error('Local mode: found no production Supabase URL to replace');
  console.log(`Local mode: ${changed} file(s) now use ${LOCAL_URL}`);
}

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

  if (LOCAL) await pointAtLocalSupabase();

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
