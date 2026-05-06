// src/routes/listings.js
// Read-only listing endpoints. Hydrates listings with feedback fields
// (status, rating, note, dates) before returning.

import { Router } from 'express';
import { readJson } from '../io.js';

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
    rating: feedback.ratings[key] || null,
    note: feedback.notes[key] || '',
    status: feedback.status[key] || 'new',
    appliedDate: feedback.appliedDate[key] || null,
    closesDate: feedback.closesDate[key] || listing.score?.closesDate || null,
    rejectReason: reject?.reason || null,
    rejectNote: reject?.note || null,
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

router.get('/stats', async (req, res) => {
  const { listings } = await readJson('listings.json');
  const feedback = await readJson('feedback.json');
  const counts = { new: 0, saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
  for (const l of listings) {
    const key = l.dedupKey || l.fingerprint;
    const s = feedback.status[key] || 'new';
    counts[s] = (counts[s] || 0) + 1;
  }
  res.json({
    total: listings.length,
    byStatus: counts,
    appliedThisWeek: Object.values(feedback.appliedDate).filter(
      (d) => d && d >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
    ).length,
  });
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
