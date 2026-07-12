// src/routes/listings.js
// Read-only listing endpoints. Hydrates listings with feedback fields
// (status, rating, note, dates) before returning.

import { Router } from 'express';
import { readJson, readJsonSafe, writeJson } from '../io.js';
import { scoreOne, loadRecentFeedback, buildIgnoreContext } from '../score.js';
import { getProfileResumeText } from '../documents.js';

const router = Router();

// Merge feedback fields into a listing. Feedback keys on dedupKey
// (per-listing identity) so two distinct openings under the same role
// fingerprint have independent state. Falls back to fingerprint for
// pre-dedupKey legacy data.
function hydrate(listing, feedback) {
  const key = listing.dedupKey || listing.fingerprint;
  const reject = feedback.rejectReasons?.[key];
  return {
    ...listing,
    rating: feedback.ratings?.[key] || null,
    note: feedback.notes?.[key] || '',
    status: feedback.status?.[key] || 'new',
    appliedDate: feedback.appliedDate?.[key] || null,
    closesDate: feedback.closesDate?.[key] || listing.score?.closesDate || null,
    rejectReason: reject?.reason || null,
    rejectNote: reject?.note || null,
    rejectAt: reject?.at || null,
  };
}

router.get('/today', async (req, res) => {
  const { listings } = await readJson('listings.json');
  const feedback = await readJson('feedback.json');
  const today = new Date().toISOString().slice(0, 10);

  const todays = listings
    .filter((l) => (l.ingestedAt || '').startsWith(today))
    .map((l) => hydrate(l, feedback))
    .sort((a, b) => (b.score?.overallScore || 0) - (a.score?.overallScore || 0));

  res.json({ date: today, count: todays.length, listings: todays });
});

router.get('/listings', async (req, res) => {
  const { listings } = await readJson('listings.json');
  const feedback = await readJson('feedback.json');
  const minScore = parseInt(req.query.minScore || '0', 10);
  const days = parseInt(req.query.days || '30', 10);
  const status = req.query.status;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  let out = listings
    .filter(
      (l) =>
        (l.ingestedAt || '') >= cutoff &&
        (l.score?.overallScore || 0) >= minScore,
    )
    .map((l) => hydrate(l, feedback));

  if (status) {
    out = out.filter((l) => l.status === status);
  }

  out.sort((a, b) => (b.score?.overallScore || 0) - (a.score?.overallScore || 0));

  res.json({ count: out.length, listings: out });
});

router.get('/listings/ignored', async (req, res) => {
  const { listings } = await readJson('listings.json');
  const feedback = await readJson('feedback.json');

  const out = listings
    .map((l) => hydrate(l, feedback))
    .filter((l) => l.status === 'rejected');

  // Most recently ignored first; fall back to ingestedAt for entries
  // ignored before we tracked the timestamp.
  out.sort((a, b) => {
    const at = a.rejectAt || a.ingestedAt || '';
    const bt = b.rejectAt || b.ingestedAt || '';
    return bt.localeCompare(at);
  });

  res.json({ count: out.length, listings: out });
});

router.get('/stats', async (req, res) => {
  const { listings } = await readJson('listings.json');
  const feedback = await readJson('feedback.json');
  const counts = { new: 0, saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
  for (const l of listings) {
    const key = l.dedupKey || l.fingerprint;
    const s = feedback.status?.[key] || 'new';
    counts[s] = (counts[s] || 0) + 1;
  }
  // Stats reflect the main-view roster — ignored listings live on a separate
  // page so they're excluded from `total` and `appliedThisWeek`. byStatus
  // still carries rejected so the header's ignored-link can render its count.
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let appliedThisWeek = 0;
  for (const l of listings) {
    const key = l.dedupKey || l.fingerprint;
    if ((feedback.status?.[key] || 'new') === 'rejected') continue;
    const d = feedback.appliedDate?.[key];
    if (d && d >= cutoff) appliedThisWeek++;
  }
  res.json({
    total: listings.length - counts.rejected,
    byStatus: counts,
    appliedThisWeek,
  });
});

// Re-score a single listing with the CURRENT preferences (goals + weighting +
// profile + feedback calibration). Offered from the roles modal when a listing
// was scored under an older scoring config. Uses the same scoreOne path as the
// daily scrape, so the result is identical to what a fresh scrape would produce.
router.post('/listings/:key/rescore', async (req, res) => {
  try {
    const { key } = req.params;
    const data = await readJson('listings.json');
    const idx = (data.listings || []).findIndex(
      (l) => (l.dedupKey || l.fingerprint) === key,
    );
    if (idx < 0) return res.status(404).json({ error: 'listing not found' });

    const prefs = await readJson('preferences.json');
    const [examples, resumeText, ignoreContext] = await Promise.all([
      loadRecentFeedback(6),
      getProfileResumeText(),
      buildIgnoreContext(),
    ]);

    const score = await scoreOne(data.listings[idx], prefs, examples, resumeText, ignoreContext);
    data.listings[idx] = { ...data.listings[idx], score };
    await writeJson('listings.json', data);

    const feedback = await readJsonSafe('feedback.json', { fallback: {} });
    res.json({ listing: hydrate(data.listings[idx], feedback) });
  } catch (err) {
    // scoreOne throws on the daily spend cap; surface it so the UI can explain.
    res.status(500).json({ error: err.message });
  }
});

router.get('/spend', async (req, res) => {
  try {
    const spend = await readJson('spend.json');
    res.json(spend);
  } catch {
    res.json({ byDay: {} });
  }
});

export default router;
