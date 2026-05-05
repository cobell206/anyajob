// src/log.js
// Centralized logger. Wraps pino so every module gets a component-scoped
// child logger — `log.info({...}, 'msg')` everywhere, with `component` auto-
// added to every line so we can grep one cron's output cleanly.
//
// Levels (pino defaults): trace=10, debug=20, info=30, warn=40, error=50, fatal=60
//
// Configure via env:
//   LOG_LEVEL    — default 'info'. Set to 'debug' for noisy local debugging.
//   LOG_FORMAT   — 'pretty' (default in dev) or 'json' (default in production)
//
// Output goes to stdout. systemd captures it via journalctl; cron captures
// it to the *.log files via shell redirection in the crontab.
//
// Usage:
//   import { createLogger } from './log.js';
//   const log = createLogger('daily');
//   log.info({ count: 7 }, 'scrape complete');
//   log.error({ err }, 'something broke');  // pino auto-formats error stack
//   const child = log.child({ sourceId: 'davispolk' });  // further-scoped
//   child.warn({ status: 404 }, 'fetch failed');

import { pino } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const format = process.env.LOG_FORMAT || (isProduction ? 'json' : 'pretty');
const level = process.env.LOG_LEVEL || 'info';

const transport = format === 'pretty'
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        // Show component prefix in pretty output: [daily] message
        messageFormat: '[{component}] {msg}',
      },
    }
  : undefined; // raw JSON to stdout

// Root logger. Modules call createLogger() to get a child with `component`
// bound — keeps call-site syntax compact while structured logs stay rich.
const root = pino({
  level,
  base: undefined, // drop pid/hostname from every line; we don't need them
  timestamp: pino.stdTimeFunctions.isoTime,
  transport,
});

export function createLogger(component) {
  return root.child({ component });
}

// Default export for one-off scripts that don't care about component scoping.
export default root;
