// scripts/discover.js
//
// Cron-driven Discovery. Runs Mon + Thu at 7am ET. Asks Claude (with web
// search) to propose new sources matching her profile, merges with any
// previously-discovered-but-not-yet-acted-on candidates, and writes the
// combined list to data/discoveries.json.
//
// The morning email reads from this file and surfaces the count.
// The settings UI lets her review and approve/dismiss each candidate.
//
// Cost ceiling: ~$0.50-0.80 per run × 2 runs/week ≈ $4/month worst case.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { discoverSources } from '../src/discover.js';
import { writeJsonAtomic } from '../src/atomic.js';
import { createLogger } from '../src/log.js';

const log = createLogger('discover-cron');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISCOVERIES_PATH = join(__dirname, '..', 'data', 'discoveries.json');

async function loadExisting() {
  try {
    return JSON.parse(await readFile(DISCOVERIES_PATH, 'utf-8'));
  } catch {
    return { candidates: [], lastRunAt: null, history: [] };
  }
}

// Merge a fresh candidate into the existing list. Dedup by (kind + slug-or-url).
// If a candidate is already pending, leave it alone (don't reset its first-seen
// timestamp, don't overwrite her review status).
function mergeCandidate(existing, fresh) {
  const key = (c) => c.kind + ':' + (c.config?.slug || c.config?.url || '').toLowerCase();
  const seen = new Map(existing.map((c) => [key(c), c]));
  const candidates = [...existing];
  let added = 0;
  for (const f of fresh) {
    if (seen.has(key(f))) continue;
    candidates.push({
      id: 'cand-' + randomUUID().slice(0, 8),
      ...f,
      firstSeenAt: new Date().toISOString(),
      status: 'pending', // pending | approved | dismissed
    });
    added++;
  }
  return { candidates, added };
}

// Drop candidates that are stale (dismissed > 30 days ago, or pending > 60 days).
// Keeps the file from growing forever.
function prune(candidates) {
  const now = Date.now();
  return candidates.filter((c) => {
    if (c.status === 'approved') return false; // approval already created a Source
    const seen = c.firstSeenAt ? new Date(c.firstSeenAt).getTime() : now;
    const age = now - seen;
    if (c.status === 'dismissed') return age < 30 * 86400000;
    return age < 60 * 86400000;
  });
}

async function main() {
  log.info('discovery run starting');

  const existing = await loadExisting();
  const pruned = prune(existing.candidates || []);
  log.info({ pendingBefore: pruned.filter((c) => c.status === 'pending').length });

  let result;
  try {
    result = await discoverSources({ maxCandidates: 12 });
  } catch (err) {
    log.error({ err }, 'discovery API call failed');
    // Persist the failure for visibility but don't blow up the cron
    await writeJsonAtomic(DISCOVERIES_PATH, {
      ...existing,
      candidates: pruned,
      lastRunAt: new Date().toISOString(),
      lastError: err.message,
      history: [
        ...(existing.history || []).slice(-9),
        { at: new Date().toISOString(), error: err.message },
      ],
    });
    process.exit(1);
  }

  const { candidates: merged, added } = mergeCandidate(pruned, result.candidates);

  await writeJsonAtomic(DISCOVERIES_PATH, {
    candidates: merged,
    lastRunAt: new Date().toISOString(),
    lastSummary: result.summary,
    lastError: null,
    history: [
      ...(existing.history || []).slice(-9),
      {
        at: new Date().toISOString(),
        added,
        totalReturned: result.candidates.length,
        usage: result.usage,
      },
    ],
  });

  const pending = merged.filter((c) => c.status === 'pending').length;
  log.info(
    {
      fresh: result.candidates.length,
      added,
      pendingTotal: pending,
      tokensIn: result.usage.input_tokens,
      tokensOut: result.usage.output_tokens,
      summary: result.summary,
    },
    'discovery run complete',
  );
}

main().catch((err) => {
  log.fatal({ err }, 'discovery cron failed');
  process.exit(1);
});
