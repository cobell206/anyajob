// src/routes/paste.js
// Manual paste-and-score: she pastes a JD (e.g., from LinkedIn) and gets
// the same scoring rubric applied as the daily cron. The result is appended
// to listings.json so it shows up in the table alongside auto-scraped ones.

import { Router } from 'express';
import { readJson, writeJson } from '../io.js';
import { scoreOne, loadRecentFeedback } from '../score.js';
import { fingerprint, dedupKey } from '../dedupe.js';

const router = Router();

router.post('/', async (req, res) => {
  const { company, title, location, description, url } = req.body;
  if (!title || !description) {
    return res.status(400).json({ error: 'title and description required' });
  }
  const listing = {
    source: 'manual-paste',
    company: company || 'Unknown',
    title,
    location: location || '',
    description,
    url: url || '',
    postedAt: new Date().toISOString(),
  };
  listing.fingerprint = fingerprint(listing);
  // For manual-paste there's no externalId, so dedupKey falls back to fingerprint.
  // That's correct: pasting the same JD twice is dedup-equivalent.
  listing.dedupKey = dedupKey(listing);

  try {
    const prefs = await readJson('preferences.json');
    const examples = await loadRecentFeedback(6);
    const score = await scoreOne(listing, prefs, examples);

    const all = await readJson('listings.json');
    all.listings.push({
      ...listing,
      score,
      ingestedAt: new Date().toISOString(),
    });
    await writeJson('listings.json', all);

    res.json({ listing, score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
