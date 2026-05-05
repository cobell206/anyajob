// src/routes/preferences.js
// Read and write user preferences. The example template is exposed so the
// settings UI can offer a "Reset to defaults" action.

import { Router } from 'express';
import { readJson, writeJson } from '../io.js';

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
  await writeJson('preferences.json', req.body);
  res.json({ ok: true });
});

export default router;
