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

// Live discovery — wraps src/discover.js. Used by the "Find new sources"
// button. Returned candidates are NOT persisted; the cron path in
// scripts/discover.js is what writes to data/discoveries.json.
router.post('/discover', discoverLimiter, async (req, res) => {
  try {
    const { discoverSources } = await import('../discover.js');
    const result = await discoverSources({
      maxCandidates: req.body?.maxCandidates || 12,
    });
    res.json(result);
  } catch (err) {
    log.error({ err }, 'live discovery failed');
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
