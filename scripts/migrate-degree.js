// scripts/migrate-degree.js
//
// One-shot retroactive cleanup: walk every existing listing and auto-ignore
// (status='rejected', reason='degree') any that explicitly require a JD,
// Juris Doctor, or bar admission. Listings already 'rejected' are left alone.
//
// Usage:
//   node scripts/migrate-degree.js           # write changes
//   node scripts/migrate-degree.js --dry-run # preview only

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../src/atomic.js';
import { requiresLawDegree } from '../src/degree.js';
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
  let alreadyRejected = 0;
  let autoIgnored = 0;
  let kept = 0;
  const samples = [];
  const at = new Date().toISOString();

  for (const l of listings) {
    const key = fbKey(l);
    if (feedback.status[key] === 'rejected') {
      alreadyRejected += 1;
      continue;
    }
    if (requiresLawDegree(l)) {
      feedback.status[key] = 'rejected';
      feedback.rejectReasons[key] = {
        reason: 'degree',
        note: 'auto-filtered: requires JD or law degree',
        at,
      };
      autoIgnored += 1;
      if (samples.length < 10) {
        samples.push(`  - ${l.company} — ${l.title}`);
      }
    } else {
      kept += 1;
    }
  }

  console.log('--- migrate-degree summary ---');
  console.log(`total listings:       ${listings.length}`);
  console.log(`already 'rejected':   ${alreadyRejected} (skipped)`);
  console.log(`auto-ignored:         ${autoIgnored}`);
  console.log(`kept:                 ${kept}`);
  if (samples.length) {
    console.log('sample auto-ignored listings:');
    for (const s of samples) console.log(s);
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
