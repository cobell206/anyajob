// src/routes/feedback.js
// Per-listing feedback writes. The `:fp` URL param carries the listing's
// dedupKey, which is what feedback.json keys on. (Documents key on the
// role fingerprint instead — see routes/documents.js.)

import { Router } from 'express';
import { readJson, writeJson } from '../io.js';
import { VALID_STATUSES } from '../constants.js';

const router = Router();

const VALID_REJECT_REASONS = [
  'wrong-location',
  'wrong-seniority',
  'not-interested',
  'already-applied',
  'other',
];

function setRejectReason(feedback, fp, reason, note) {
  if (!feedback.rejectReasons) feedback.rejectReasons = {};
  feedback.rejectReasons[fp] = {
    reason,
    note: (note || '').slice(0, 500),
    at: new Date().toISOString(),
  };
}

router.post('/:fp/rating', async (req, res) => {
  const { fp } = req.params;
  const { rating } = req.body;
  const feedback = await readJson('feedback.json');
  if (rating === null) {
    delete feedback.ratings[fp];
  } else {
    feedback.ratings[fp] = rating;
  }
  await writeJson('feedback.json', feedback);
  res.json({ ok: true });
});

router.post('/:fp/note', async (req, res) => {
  const { fp } = req.params;
  const { note } = req.body;
  const feedback = await readJson('feedback.json');
  feedback.notes[fp] = (note || '').slice(0, 2000);
  await writeJson('feedback.json', feedback);
  res.json({ ok: true });
});

router.post('/:fp/status', async (req, res) => {
  const { fp } = req.params;
  const { status, rejectReason, rejectNote } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${VALID_STATUSES.join(', ')}` });
  }
  if (rejectReason !== undefined && !VALID_REJECT_REASONS.includes(rejectReason)) {
    return res.status(400).json({ error: `rejectReason must be one of ${VALID_REJECT_REASONS.join(', ')}` });
  }
  const feedback = await readJson('feedback.json');
  feedback.status[fp] = status;
  // Auto-set applied date when transitioning to "applied" if not already set
  if (status === 'applied' && !feedback.appliedDate[fp]) {
    feedback.appliedDate[fp] = new Date().toISOString().slice(0, 10);
  }
  if (rejectReason && (status === 'rejected' || status === 'pass')) {
    setRejectReason(feedback, fp, rejectReason, rejectNote);
  }
  await writeJson('feedback.json', feedback);
  res.json({ ok: true });
});

router.post('/:fp/reject-reason', async (req, res) => {
  const { fp } = req.params;
  const { reason, note } = req.body;
  if (!VALID_REJECT_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of ${VALID_REJECT_REASONS.join(', ')}` });
  }
  const feedback = await readJson('feedback.json');
  setRejectReason(feedback, fp, reason, note);
  await writeJson('feedback.json', feedback);
  res.json({ ok: true });
});

router.post('/:fp/appliedDate', async (req, res) => {
  const { fp } = req.params;
  const { appliedDate } = req.body; // YYYY-MM-DD or null
  const feedback = await readJson('feedback.json');
  if (appliedDate) {
    feedback.appliedDate[fp] = appliedDate;
  } else {
    delete feedback.appliedDate[fp];
  }
  await writeJson('feedback.json', feedback);
  res.json({ ok: true });
});

router.post('/:fp/closesDate', async (req, res) => {
  const { fp } = req.params;
  const { closesDate } = req.body;
  const feedback = await readJson('feedback.json');
  if (closesDate) {
    feedback.closesDate[fp] = closesDate;
  } else {
    delete feedback.closesDate[fp];
  }
  await writeJson('feedback.json', feedback);
  res.json({ ok: true });
});

export default router;
