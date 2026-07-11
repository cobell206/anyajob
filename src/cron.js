// src/cron.js
// Scheduled-job Lambda entrypoint (M6, see SERVERLESS-TRANSITION.md). One
// function fired by three EventBridge schedules; the schedule's input picks the
// job: { "job": "daily" | "discover" | "weekly" }. Each job is the same main()
// the EC2 crons ran (now exported + guarded so importing doesn't auto-run).
//
// Errors from main() are intentionally NOT caught — they propagate so the Lambda
// invocation is marked failed and the CloudWatch alarm/metrics see it.

import { createLogger } from './log.js';

const log = createLogger('cron');

// Lazy imports: an invocation only loads the deps for its own job.
const JOBS = {
  daily: () => import('./daily.js'),
  discover: () => import('../scripts/discover.js'),
  weekly: () => import('../scripts/weekly.js'),
};

export const handler = async (event = {}) => {
  const job = event?.job;
  const load = JOBS[job];
  if (!load) {
    log.error({ job, valid: Object.keys(JOBS) }, 'unknown cron job');
    throw new Error(`unknown cron job: ${JSON.stringify(job)}`);
  }

  log.info({ job }, 'cron job starting');
  const mod = await load();
  await mod.main();
  log.info({ job }, 'cron job complete');
  return { ok: true, job };
};
