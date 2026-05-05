// src/routes/logs.js
// Recent log lines from the cron *.log files, redacted before return.
//
// Endpoints:
//   GET /api/logs/sources       what log files exist
//   GET /api/logs/:source       read one (?since=1h&limit=500&level=warn)
//
// :source must be one of the allow-listed names below — we don't accept
// arbitrary file paths from the URL.
//
// Redaction is applied to every line before it leaves the server. See
// src/redact.js for the patterns.

import { Router } from 'express';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { redactLogText, redactObject } from '../redact.js';
import { createLogger } from '../log.js';

const log = createLogger('logs-route');
const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// Allow-list. Each source maps to a relative path under the repo root.
// Adding a new source means an explicit edit here, not pattern-matching a
// user-supplied filename.
const SOURCES = {
  daily: 'daily.log',
  weekly: 'weekly.log',
  discover: 'discover.log',
  backup: 'backup.log',
  server: 'server.log',
};

// Pino level numbers, for filtering by minimum level
const LEVEL_NUM = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function parseDuration(spec) {
  // Accepts '1h', '30m', '2d', or absolute ISO timestamp.
  if (!spec) return null;
  const m = String(spec).match(/^(\d+)([smhd])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[m[2]];
    return Date.now() - n * unitMs;
  }
  const t = Date.parse(spec);
  return isNaN(t) ? null : t;
}

router.get('/sources', async (req, res) => {
  const out = [];
  for (const [name, path] of Object.entries(SOURCES)) {
    try {
      const s = await stat(join(REPO_ROOT, path));
      out.push({ name, path, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() });
    } catch {
      out.push({ name, path, exists: false });
    }
  }
  res.json({ sources: out });
});

router.get('/:source', async (req, res) => {
  const { source } = req.params;
  const path = SOURCES[source];
  if (!path) {
    return res.status(404).json({ error: `Unknown source. Try: ${Object.keys(SOURCES).join(', ')}` });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const sinceMs = parseDuration(req.query.since);
  const minLevelName = String(req.query.level || '').toLowerCase();
  const minLevel = LEVEL_NUM[minLevelName] || 0;

  let raw;
  try {
    raw = await readFile(join(REPO_ROOT, path), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json({ source, lines: [], note: 'log file does not exist yet' });
    }
    log.error({ err, source }, 'failed to read log file');
    return res.status(500).json({ error: 'failed to read log file' });
  }

  // Parse line-by-line (each line is pino JSON) and apply filters.
  const allLines = raw.split('\n').filter((l) => l.trim());
  const matching = [];
  // Iterate from the end so we can stop as soon as we have `limit` matches —
  // log files are append-only so newest is at the bottom.
  for (let i = allLines.length - 1; i >= 0 && matching.length < limit; i--) {
    let parsed;
    try { parsed = JSON.parse(allLines[i]); } catch { parsed = null; }

    if (parsed) {
      if (minLevel && (parsed.level ?? 0) < minLevel) continue;
      if (sinceMs) {
        const t = parsed.time ? Date.parse(parsed.time) : NaN;
        if (!isNaN(t) && t < sinceMs) break; // older entries below; we're done
      }
      matching.push(redactObject(parsed));
    } else {
      // Plaintext fallback (older entries, non-pino output)
      matching.push({ raw: redactLogText(allLines[i]) });
    }
  }

  // Reverse so caller sees chronological order
  matching.reverse();

  res.json({
    source,
    count: matching.length,
    truncated: matching.length === limit,
    lines: matching,
  });
});

export default router;
