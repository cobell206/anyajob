// src/routes/sources.js
// Source registry CRUD + a few action endpoints:
//   POST /test       run a config without persisting (validate before save)
//   POST /discover   live discovery via Claude web_search (rate-limited)
//
// Static endpoints (/test, /discover) are declared BEFORE /:id so Express
// doesn't treat "test" or "discover" as a source id.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  loadSources,
  addSource,
  updateSource,
  deleteSource,
  runOne,
} from '../sources/registry.js';
import { SOURCE_KINDS } from '../constants.js';
import { createLogger } from '../log.js';

const log = createLogger('sources-route');

const router = Router();

// Rate limit Discovery harder than the rest of the API — each call costs
// ~$0.50 in Claude tokens.
const discoverLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: { error: 'Discovery is rate-limited to 6 runs per hour' },
});

router.get('/', async (req, res) => {
  try {
    const data = await loadSources();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { kind, name, config, enabled } = req.body;
    if (!SOURCE_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${SOURCE_KINDS.join(', ')}` });
    }
    if (kind === 'greenhouse' || kind === 'lever') {
      if (!config?.slug) return res.status(400).json({ error: 'slug required for ' + kind });
    }
    if (kind === 'smartfetch' || kind === 'bookmark') {
      if (!config?.url) return res.status(400).json({ error: 'url required for ' + kind });
      try { new URL(config.url); } catch { return res.status(400).json({ error: 'invalid url' }); }
    }
    const created = await addSource({ kind, name, config, enabled });
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test a source without persisting. Used by the settings UI to validate a
// smartfetch URL before committing.
router.post('/test', async (req, res) => {
  try {
    const { kind, name, config } = req.body;
    const fakeSource = {
      id: 'test-' + Date.now(),
      kind,
      name: name || kind,
      config: config || {},
      enabled: true,
    };
    const result = await runOne(fakeSource);
    const sample = (result.listings || []).slice(0, 3).map((l) => ({
      title: l.title, company: l.company, location: l.location, url: l.url,
    }));
    res.json({
      count: result.listings?.length || 0,
      sample,
      error: result.error,
      durationMs: result.durationMs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live discovery — wraps src/discover.js. Used by the "Find sources" button.
// Persists candidates the same way the Mon+Thu cron does, so they show up
// on Settings for approve/dismiss instead of vanishing on page navigation.
router.post('/discover', discoverLimiter, async (req, res) => {
  // Discovery calls Claude with web_search — can take 60–120s. Guard against
  // Cloudflare's 100s upstream timeout by setting an explicit server timeout.
  req.setTimeout(110_000);
  res.setTimeout(110_000);
  try {
    const { discoverSources, persistDiscoveryResult } = await import('../discover.js');
    const result = await discoverSources({
      maxCandidates: req.body?.maxCandidates || 12,
    });
    const persisted = await persistDiscoveryResult(result);
    log.info({ ...persisted }, 'live discovery persisted');
    res.json({ ...result, persisted });
  } catch (err) {
    log.error({ err }, 'live discovery failed');
    res.status(500).json({ error: err.message });
  }
});

// Run a saved source by id. Same response shape as /test, plus the full
// listings array so the UI can render the count without re-fetching.
router.post('/:id/run', async (req, res) => {
  // Smartfetch sources can take 5-15s and run sequentially with the cron's
  // 429 mitigation, so give the request enough headroom past the default.
  req.setTimeout(110_000);
  res.setTimeout(110_000);
  try {
    const data = await loadSources();
    const source = data.sources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    const result = await runOne(source);
    res.json({
      listings: result.listings || [],
      count: result.listings?.length || 0,
      durationMs: result.durationMs,
      error: result.error,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suggest a replacement URL for a source that's been failing with 404/403.
// Calls Claude with web_search; ~$0.05–0.15 per call, ~30–60s.
router.post('/:id/repair', async (req, res) => {
  req.setTimeout(60_000);
  res.setTimeout(60_000);
  try {
    const data = await loadSources();
    const source = data.sources.find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    const err = source.lastError || '';
    if (!/404|403/.test(err)) {
      return res.status(400).json({ error: 'Source does not have a 404/403 error to repair' });
    }
    const { repairSourceUrl } = await import('../repair.js');
    const suggestion = await repairSourceUrl(source);
    log.info({ id: source.id, name: source.name, suggestion }, 'repair suggestion');
    res.json(suggestion);
  } catch (err) {
    log.error({ err }, 'repair failed');
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const updated = await updateSource(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await deleteSource(req.params.id);
    res.json({ deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
