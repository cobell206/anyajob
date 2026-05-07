// scripts/migrate-location.js
//
// One-shot retroactive cleanup: walk every existing listing, classify its
// location, and auto-ignore (status='rejected', reason='location') any that
// land outside NYC/remote/hybrid/unknown. Listings already 'rejected' are
// left alone.
//
// Usage:
//   node scripts/migrate-location.js           # write changes
//   node scripts/migrate-location.js --dry-run # preview only

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../src/atomic.js';
import { classifyLocation } from '../src/location.js';
import { fbKey } from '../src/io.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const LISTINGS_PATH = join(DATA, 'listings.json');
const FEEDBACK_PATH = join(DATA, 'feedback.json');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const listingsRaw = JSON.parse(await readFile(LISTINGS_PATH, 'utf-8'));
  const feedback = JSON.parse(await readFile(FEEDBACK_PATH, 'utf-8'));

  if (!feedback.status) feedback.status = {};
  if (!feedback.rejectReasons) feedback.rejectReasons = {};

  const listings = listingsRaw.listings || [];
  const breakdown = { nyc: 0, remote: 0, hybrid: 0, unknown: 0, other: 0 };
  let alreadyRejected = 0;
  let autoIgnored = 0;
  const at = new Date().toISOString();

  for (const l of listings) {
    const key = fbKey(l);
    if (feedback.status[key] === 'rejected') {
      alreadyRejected += 1;
      continue;
    }
    const cat = classifyLocation(l.location);
    breakdown[cat] += 1;
    if (cat === 'other') {
      feedback.status[key] = 'rejected';
      feedback.rejectReasons[key] = {
        reason: 'location',
        note: 'auto-filtered: non-NYC location',
        at,
      };
      autoIgnored += 1;
    }
  }

  const kept = listings.length - alreadyRejected - autoIgnored;

  console.log('--- migrate-location summary ---');
  console.log(`total listings:       ${listings.length}`);
  console.log(`already 'rejected':   ${alreadyRejected} (skipped)`);
  console.log(`auto-ignored (other): ${autoIgnored}`);
  console.log(`kept:                 ${kept}`);
  console.log('breakdown by classification (excluding already-rejected):');
  for (const [cat, n] of Object.entries(breakdown)) {
    console.log(`  ${cat.padEnd(8)} ${n}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] feedback.json NOT written');
    return;
  }

  await writeJsonAtomic(FEEDBACK_PATH, feedback);
  console.log('\nfeedback.json written.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
