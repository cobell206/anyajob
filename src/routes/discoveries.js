// src/routes/discoveries.js
// Pending source candidates from cron-driven Discovery runs
// (scripts/discover.js writes to data/discoveries.json twice a week).
//
// Live one-shot discovery lives in src/routes/sources.js as POST /sources/discover.

import { Router } from 'express';
import { readJson, writeJson } from '../io.js';
import { addSource } from '../sources/registry.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const data = await readJson('discoveries.json').catch(() => ({ candidates: [], lastRunAt: null }));
    const pending = (data.candidates || []).filter((c) => c.status === 'pending');
    res.json({
      pending,
      lastRunAt: data.lastRunAt || null,
      lastSummary: data.lastSummary || null,
      lastError: data.lastError || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve a candidate — creates a Source from its config and marks the
// candidate approved (so it won't reappear).
router.post('/:id/approve', async (req, res) => {
  try {
    const data = await readJson('discoveries.json');
    const cand = (data.candidates || []).find((c) => c.id === req.params.id);
    if (!cand) return res.status(404).json({ error: 'Candidate not found' });
    if (cand.status !== 'pending') {
      return res.status(409).json({ error: 'Candidate is already ' + cand.status });
    }
    const created = await addSource({
      kind: cand.kind,
      name: cand.name || cand.config?.slug || cand.config?.url || cand.kind,
      config: cand.config || {},
      enabled: true,
    });
    cand.status = 'approved';
    cand.approvedAt = new Date().toISOString();
    cand.createdSourceId = created.id;
    await writeJson('discoveries.json', data);
    res.json({ source: created, candidate: cand });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss — won't reappear unless Claude proposes it again after the
// 30-day prune window in scripts/discover.js.
router.post('/:id/dismiss', async (req, res) => {
  try {
    const data = await readJson('discoveries.json');
    const cand = (data.candidates || []).find((c) => c.id === req.params.id);
    if (!cand) return res.status(404).json({ error: 'Candidate not found' });
    cand.status = 'dismissed';
    cand.dismissedAt = new Date().toISOString();
    await writeJson('discoveries.json', data);
    res.json({ candidate: cand });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
