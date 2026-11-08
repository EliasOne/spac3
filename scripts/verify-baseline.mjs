// Compares dist/ with the files of the deployed v147 (baseline/v147.sha256)
// and lists every file that was added, removed or changed.
//
//   npm run build && npm run verify
//
// Use it to confirm a change touched only the files you meant it to.
// Files in EXPECTED_CHANGES are known, intended differences; anything else
// makes the script exit with an error.

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');

const EXPECTED_CHANGES = new Set([
  // Rebuilt from npm instead of copied; same library version (2.117.3).
  'supabase-js.bundle.js',
  // Hotfix: removed the sticker_tags listeners/query that broke all room live updates (see README).
  'room.app.js',
]);

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const baseline = new Map(
  (await readFile(path.join(root, 'baseline/v147.sha256'), 'utf8'))
    .trim().split('\n')
    .map((line) => { const [hash, file] = line.split(/\s+/); return [file, hash]; }),
);

const report = { changed: [], added: [], removed: [] };
const distFiles = await listFiles(DIST);
for (const file of distFiles) {
  const hash = createHash('sha256').update(await readFile(path.join(DIST, file))).digest('hex');
  if (!baseline.has(file)) report.added.push(file);
  else if (baseline.get(file) !== hash) report.changed.push(file);
}
for (const file of baseline.keys()) if (!distFiles.includes(file)) report.removed.push(file);

let unexpected = 0;
for (const [kind, files] of Object.entries(report)) {
  for (const file of files) {
    const ok = EXPECTED_CHANGES.has(file);
    if (!ok) unexpected++;
    console.log(`${ok ? '  expected ' : 'UNEXPECTED'} ${kind.padEnd(7)} ${file}`);
  }
}
const same = distFiles.length - report.changed.length - report.added.length;
console.log(`\n${same} of ${baseline.size} v147 files identical; ${unexpected} unexpected difference(s).`);
process.exit(unexpected ? 1 : 0);
