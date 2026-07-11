// scripts/discover.js
//
// Cron-driven Discovery. Runs Mon + Thu at 7am ET. Asks Claude (with web
// search) to propose new sources matching her profile, persists them to
// data/discoveries.json (status=pending), and exits.
//
// The same persistence logic is used by the "Find sources" button on the
// profile page — see src/discover.js for the shared helpers.
//
// The morning email reads from this file and surfaces the count.
// The settings UI lets her review and approve/dismiss each candidate.
//
// Cost ceiling: ~$0.50-0.80 per run × 2 runs/week ≈ $4/month worst case.

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../src/atomic.js';
import {
  discoverSources,
  loadDiscoveries,
  persistDiscoveryResult,
} from '../src/discover.js';
import { createLogger } from '../src/log.js';

const log = createLogger('discover-cron');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISCOVERIES_PATH = join(__dirname, '..', 'data', 'discoveries.json');

export async function main() {
  log.info('discovery run starting');

  let result;
  try {
    result = await discoverSources({ maxCandidates: 12 });
  } catch (err) {
    log.error({ err }, 'discovery API call failed');
    // Persist the failure so the morning email and UI can show it,
    // without dropping any pending candidates that were already there.
    const existing = await loadDiscoveries();
    await writeJsonAtomic(DISCOVERIES_PATH, {
      ...existing,
      lastRunAt: new Date().toISOString(),
      lastError: err.message,
      history: [
        ...(existing.history || []).slice(-9),
        { at: new Date().toISOString(), error: err.message },
      ],
    });
    throw err; // rethrow (was process.exit(1)) so the Lambda invocation fails cleanly
  }

  const persisted = await persistDiscoveryResult(result);

  log.info(
    {
      fresh: result.candidates.length,
      added: persisted.added,
      pendingTotal: persisted.pendingTotal,
      tokensIn: result.usage.input_tokens,
      tokensOut: result.usage.output_tokens,
      summary: result.summary,
    },
    'discovery run complete',
  );
}

// Run only when invoked directly; imported by the cron Lambda otherwise.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, 'discovery cron failed');
    process.exit(1);
  });
}
