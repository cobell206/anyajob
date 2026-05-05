// src/routes/diagnostic.js
// Single endpoint that returns a snapshot of relevant state for debugging.
// All output passes through redaction, so it's safer to share than raw logs.
//
// GET /api/diagnostic    returns the bundle as JSON
// GET /api/diagnostic.txt returns it as pretty text (easier to paste in chat)

import { Router } from 'express';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { redactObject, redactLogText } from '../redact.js';
import { loadSources } from '../sources/registry.js';
import { createLogger } from '../log.js';

const log = createLogger('diag-route');
const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA = join(REPO_ROOT, 'data');

async function readJsonSafe(filename, fallback = null) {
  try {
    return JSON.parse(await readFile(join(DATA, filename), 'utf-8'));
  } catch {
    return fallback;
  }
}

async function tailLog(filename, n = 50) {
  try {
    const raw = await readFile(join(REPO_ROOT, filename), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    return lines.slice(-n).map((l) => {
      try { return redactObject(JSON.parse(l)); } catch { return { raw: redactLogText(l) }; }
    });
  } catch {
    return [];
  }
}

async function buildBundle() {
  const now = new Date().toISOString();

  // Source registry — with config sanitized to omit URLs and slugs
  // (those are usually safe but redaction will strip if they look secret)
  const sourcesData = await loadSources().catch(() => ({ sources: [] }));
  const sources = sourcesData.sources.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    enabled: s.enabled,
    builtIn: s.builtIn || false,
    lastRunAt: s.lastRunAt || null,
    lastCount: s.lastCount ?? null,
    lastError: s.lastError || null,
  }));

  // Listings summary — counts by status, recent dates, no actual content
  const listingsFile = await readJsonSafe('listings.json', { listings: [] });
  const feedback = await readJsonSafe('feedback.json', { status: {}, ratings: {}, appliedDate: {} });
  const statusCounts = { new: 0, saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0, pass: 0 };
  const ratingCounts = { up: 0, down: 0, none: 0 };
  for (const l of listingsFile.listings) {
    const key = l.dedupKey || l.fingerprint;
    const s = feedback.status[key] || 'new';
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
    const r = feedback.ratings[key];
    if (r === 'up') ratingCounts.up++;
    else if (r === 'down') ratingCounts.down++;
    else ratingCounts.none++;
  }

  // Spend
  const spend = await readJsonSafe('spend.json', { byDay: {} });
  const recentSpend = Object.entries(spend.byDay || {})
    .sort()
    .slice(-7)
    .map(([day, cost]) => ({ day, cost }));

  // Discoveries
  const disc = await readJsonSafe('discoveries.json', { candidates: [] });
  const pendingDiscoveries = (disc.candidates || []).filter((c) => c.status === 'pending').length;

  // Recent log tails (last 30 lines per file)
  const logs = {
    daily: await tailLog('daily.log', 30),
    weekly: await tailLog('weekly.log', 30),
    discover: await tailLog('discover.log', 30),
    backup: await tailLog('backup.log', 30),
  };

  // Process info
  const memMB = process.memoryUsage().rss / (1024 * 1024);
  const uptimeSec = process.uptime();

  return {
    generatedAt: now,
    nodeVersion: process.version,
    uptimeSeconds: Math.round(uptimeSec),
    rssMB: Math.round(memMB),
    listings: {
      total: listingsFile.listings.length,
      byStatus: statusCounts,
      byRating: ratingCounts,
    },
    sources,
    spend: {
      last7Days: recentSpend,
      total7Days: recentSpend.reduce((sum, d) => sum + d.cost, 0),
    },
    discoveries: { pending: pendingDiscoveries, lastRunAt: disc.lastRunAt || null },
    recentLogs: logs,
  };
}

function bundleAsText(bundle) {
  // Pretty-printed text format that pastes well into a chat with Claude.
  const lines = [];
  lines.push('=== Lawbound Diagnostic Bundle ===');
  lines.push(`Generated:     ${bundle.generatedAt}`);
  lines.push(`Node:          ${bundle.nodeVersion}`);
  lines.push(`Uptime:        ${bundle.uptimeSeconds}s`);
  lines.push(`Memory (RSS):  ${bundle.rssMB} MB`);
  lines.push('');
  lines.push('--- Listings ---');
  lines.push(`Total: ${bundle.listings.total}`);
  lines.push('By status: ' + JSON.stringify(bundle.listings.byStatus));
  lines.push('By rating: ' + JSON.stringify(bundle.listings.byRating));
  lines.push('');
  lines.push('--- Sources ---');
  for (const s of bundle.sources) {
    const flag = s.enabled ? '✓' : '✗';
    const stats = s.lastError ? `ERROR: ${s.lastError}` :
                  s.lastCount != null ? `${s.lastCount} listings` : 'never run';
    lines.push(`${flag} [${s.kind}] ${s.name} — ${stats} (${s.lastRunAt || 'never'})`);
  }
  lines.push('');
  lines.push(`--- Spend (last 7 days: $${bundle.spend.total7Days.toFixed(4)}) ---`);
  for (const d of bundle.spend.last7Days) {
    lines.push(`  ${d.day}  $${d.cost.toFixed(4)}`);
  }
  lines.push('');
  lines.push(`--- Discoveries ---  pending: ${bundle.discoveries.pending}, lastRun: ${bundle.discoveries.lastRunAt || 'never'}`);
  lines.push('');
  for (const [name, entries] of Object.entries(bundle.recentLogs)) {
    lines.push(`--- ${name}.log (last ${entries.length}) ---`);
    for (const e of entries) {
      lines.push(JSON.stringify(e));
    }
    lines.push('');
  }
  return lines.join('\n');
}

// GET /api/diagnostic           → JSON
// GET /api/diagnostic?format=text → pretty text (easier to paste in chat)
router.get('/', async (req, res) => {
  try {
    const bundle = redactObject(await buildBundle());
    if (req.query.format === 'text') {
      return res.type('text/plain').send(bundleAsText(bundle));
    }
    res.json(bundle);
  } catch (err) {
    log.error({ err }, 'failed to build diagnostic bundle');
    if (req.query.format === 'text') {
      return res.status(500).type('text/plain').send('Error: ' + err.message);
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
