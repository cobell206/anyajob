// src/routes/admin.js
// Manual triggers for jobs that normally run on cron. Right now: just the
// daily pipeline (fetch → dedupe → score → email). The cron in production
// fires this same script at 6am UTC; this endpoint exists so she can
// trigger an out-of-band run from the settings page.

import { Router } from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger } from '../log.js';

const log = createLogger('admin-route');
const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAILY_SCRIPT = join(__dirname, '..', 'daily.js');
const REPO_ROOT = join(__dirname, '..', '..');

// In-memory lock so two concurrent runs can't clobber each other's writes
// to listings.json / spend.json. Single-process only — fine for our deploy.
let dailyState = { running: false, startedAt: null };

router.post('/run-daily', (req, res) => {
  if (dailyState.running) {
    return res.status(409).json({ running: true, startedAt: dailyState.startedAt });
  }

  const startedAt = new Date().toISOString();
  dailyState = { running: true, startedAt };
  log.info({ startedAt }, 'manual daily run starting');

  // Detach stdio from the parent so the response can return immediately
  // without holding pipe buffers open. Output still goes through pino in
  // the child via the inherited env.
  const child = spawn(process.execPath, [DAILY_SCRIPT], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'ignore',
    detached: false,
  });

  child.on('exit', (code, signal) => {
    log.info({ code, signal, startedAt }, 'manual daily run finished');
    dailyState = { running: false, startedAt: null };
  });

  child.on('error', (err) => {
    log.error({ err, startedAt }, 'manual daily run failed to spawn');
    dailyState = { running: false, startedAt: null };
  });

  res.json({ started: true, at: startedAt });
});

router.get('/run-daily', (req, res) => {
  res.json(dailyState);
});

export default router;
