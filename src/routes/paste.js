// src/routes/paste.js
// Manual paste-and-score: she pastes a JD (e.g., from LinkedIn) and gets
// the same scoring rubric applied as the daily cron. The result is appended
// to listings.json so it shows up in the table alongside auto-scraped ones.
//
// If she ticks "I've already applied to this", we also seed feedback.json
// with status/appliedDate/notes and a positive rating so the listing
// flows into future scoring calibration and source discovery.

import { Router } from 'express';
import { readJson, updateJson } from '../io.js';
import { scoreOne, loadRecentFeedback } from '../score.js';
import { fingerprint, dedupKey } from '../dedupe.js';
import { extractSingleListing } from '../sources/smartfetch.js';
import { VALID_STATUSES } from '../constants.js';

const router = Router();

const APPLIED_STATUSES = new Set(['applied', 'interview', 'offer', 'rejected']);

// Auto-fill helper: she pastes a URL into "Add a role", we fetch + AI-extract
// the form fields. Always returns 200 with { extracted, ... } so the client
// can render an inline message either way (no need to handle HTTP errors for
// the common login-wall / blocked-by-bot-detection case).
router.post('/extract-from-url', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url required' });
  }
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }
  try {
    const result = await extractSingleListing(url);
    res.json(result);
  } catch (err) {
    // Network/HTTP failures (403 from LinkedIn, DNS, timeout) — still 200,
    // surface the reason so the UI shows "Couldn't fetch — try pasting manually".
    res.json({ extracted: false, reason: err.message });
  }
});

router.post('/', async (req, res) => {
  const {
    company, title, location, description, url,
    alreadyApplied, applicationStatus, appliedDate, applicationNote,
  } = req.body;
  if (!title || !description) {
    return res.status(400).json({ error: 'title and description required' });
  }
  if (alreadyApplied) {
    if (!APPLIED_STATUSES.has(applicationStatus)) {
      return res.status(400).json({
        error: `applicationStatus must be one of ${[...APPLIED_STATUSES].join(', ')}`,
      });
    }
    if (!VALID_STATUSES.includes(applicationStatus)) {
      return res.status(400).json({ error: `applicationStatus invalid` });
    }
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
    let score = null;
    let scoreError = null;
    try {
      score = await scoreOne(listing, prefs, examples);
    } catch (err) {
      // For an already-applied retrospective record, don't lose her data
      // when the API is unreachable / unkeyed / capped. For a fresh paste
      // (where the score is the whole point), surface the error.
      if (!alreadyApplied) throw err;
      scoreError = err.message;
    }

    const record = { ...listing, score, ingestedAt: new Date().toISOString() };
    await updateJson('listings.json', (all) => {
      all.listings.push(record);
      return all;
    }, { fallback: { listings: [] } });

    if (alreadyApplied) {
      const key = listing.dedupKey;
      await updateJson('feedback.json', (feedback) => {
        // Buckets may be absent on a fresh feedback.json.
        feedback.status ??= {};
        feedback.appliedDate ??= {};
        feedback.notes ??= {};
        feedback.ratings ??= {};
        feedback.status[key] = applicationStatus;
        // Applied date only meaningful for applied/interview/offer; rejected
        // tracks via rejectAt elsewhere, but we still record when she applied.
        feedback.appliedDate[key] = appliedDate || new Date().toISOString().slice(0, 10);
        if (applicationNote) {
          feedback.notes[key] = applicationNote.slice(0, 2000);
        }
        // Treat as a positive calibration example — she chose to apply.
        // loadRecentFeedback() reads feedback.ratings; this is what feeds
        // the scoring prompt's calibration block in src/prompts.js.
        feedback.ratings[key] = 'up';
        return feedback;
      }, { fallback: {} });
    }

    res.json({ listing, score, scoreError });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
