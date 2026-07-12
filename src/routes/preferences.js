// src/routes/preferences.js
// Read and write user preferences. The example template is exposed so the
// settings UI can offer a "Reset to defaults" action.

import { Router } from 'express';
import { readJson, readJsonSafe, writeJson } from '../io.js';

const router = Router();

router.get('/', async (req, res) => {
  res.json(await readJson('preferences.json'));
});

router.get('/example', async (req, res) => {
  try {
    res.json(await readJson('preferences.example.json'));
  } catch {
    res.status(404).json({ error: 'preferences.example.json not found' });
  }
});

router.post('/', async (req, res) => {
  const incoming = req.body || {};

  // Stamp scoringConfigUpdatedAt whenever the scoring-relevant knobs (goals or
  // weighting) actually change. The roles modal compares this against each
  // listing's score._scoredAt to flag scores produced under an older config,
  // so the re-score prompt is only offered when it would actually differ.
  const prev = await readJsonSafe('preferences.json', { fallback: {} });
  const configChanged =
    (prev.goals || '') !== (incoming.goals || '') ||
    (prev.scoreWeighting || '') !== (incoming.scoreWeighting || '');
  incoming.scoringConfigUpdatedAt = configChanged
    ? new Date().toISOString()
    : (prev.scoringConfigUpdatedAt || null);

  await writeJson('preferences.json', incoming);
  res.json({ ok: true, scoringConfigUpdatedAt: incoming.scoringConfigUpdatedAt });
});

export default router;
