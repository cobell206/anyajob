#!/usr/bin/env node
/**
 * clear-parse-failed.js
 *
 * Scans data/documents/index.json for any entries where
 * resume.current.alignmentScore.error === 'parse failed'
 * and nulls them out so the next modal open triggers a fresh score.
 *
 * Usage:
 *   node scripts/clear-parse-failed.js [--dry-run]
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const IDX_PATH = resolve(ROOT, 'data', 'documents', 'index.json');
const TMP_PATH = IDX_PATH + '.tmp';

const dryRun = process.argv.includes('--dry-run');

if (!existsSync(IDX_PATH)) {
  console.log('No documents/index.json found — nothing to do.');
  process.exit(0);
}

const raw = await readFile(IDX_PATH, 'utf8');
const idx = JSON.parse(raw);

let cleared = 0;
const clearedFingerprints = [];

for (const [fingerprint, entry] of Object.entries(idx)) {
  const score = entry?.resume?.current?.alignmentScore;
  if (score && score.error === 'parse failed') {
    clearedFingerprints.push(fingerprint);
    if (!dryRun) {
      idx[fingerprint].resume.current.alignmentScore = null;
    }
    cleared++;
  }
}

if (cleared === 0) {
  console.log('✓ No stale parse-failed entries found.');
  process.exit(0);
}

console.log(`Found ${cleared} stale parse-failed entr${cleared === 1 ? 'y' : 'ies'}:`);
for (const fp of clearedFingerprints) {
  console.log(`  - ${fp}`);
}

if (dryRun) {
  console.log('\n[dry-run] No changes written.');
} else {
  // Atomic write: write to .tmp then rename
  await writeFile(TMP_PATH, JSON.stringify(idx, null, 2), 'utf8');
  await rename(TMP_PATH, IDX_PATH);
  console.log(`\n✓ Cleared ${cleared} entr${cleared === 1 ? 'y' : 'ies'} from ${IDX_PATH}`);
  console.log('  Re-open the job modal to trigger a fresh score.');
}
