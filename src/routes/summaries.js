// src/routes/summaries.js
// Current daily brief + weekly reflection, plus manual refresh endpoints.
// Cron runs (src/daily.js, scripts/weekly.js) generate these on schedule;
// the refresh endpoints are useful for manual testing or after editing
// preferences.

import { Router } from 'express';
import {
  generateDailyBrief,
  generateWeeklyReflection,
  getCurrentSummaries,
} from '../summaries.js';

const router = Router();

router.get('/', async (req, res) => {
  res.json(await getCurrentSummaries());
});

router.post('/daily/refresh', async (req, res) => {
  try {
    const brief = await generateDailyBrief();
    res.json(brief);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/weekly/refresh', async (req, res) => {
  try {
    const reflection = await generateWeeklyReflection();
    res.json(reflection);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
