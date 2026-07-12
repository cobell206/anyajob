// src/routes/feedback.js
// Per-listing feedback writes. The `:fp` URL param carries the listing's
// dedupKey, which is what feedback.json keys on. (Documents key on the
// role fingerprint instead — see routes/documents.js.)

import { Router } from 'express';
import { updateJson } from '../io.js';
import { VALID_STATUSES } from '../constants.js';

const router = Router();

const VALID_REJECT_REASONS = [
  'wrong-location',
  'wrong-seniority',
  'not-interested',
  'already-applied',
  'other',
  'not-a-fit',
  'salary',
  'location',
  'too-senior',
  'too-junior',
  'degree',
];

function setRejectReason(feedback, fp, reason, note) {
  if (!feedback.rejectReasons) feedback.rejectReasons = {};
  feedback.rejectReasons[fp] = {
    reason,
    note: (note || '').slice(0, 500),
    at: new Date().toISOString(),
  };
}

// All writes go through updateJson so a browser feedback write and the daily
// cron can't clobber each other on S3 (ETag-guarded read-modify-write). The
// `??=` bucket guards keep a fresh/empty feedback.json from throwing.
router.post('/:fp/rating', async (req, res) => {
  const { fp } = req.params;
  const { rating } = req.body;
  await updateJson('feedback.json', (feedback) => {
    feedback.ratings ??= {};
    if (rating === null) delete feedback.ratings[fp];
    else feedback.ratings[fp] = rating;
    return feedback;
  }, { fallback: {} });
  res.json({ ok: true });
});

router.post('/:fp/note', async (req, res) => {
  const { fp } = req.params;
  const { note } = req.body;
  await updateJson('feedback.json', (feedback) => {
    feedback.notes ??= {};
    feedback.notes[fp] = (note || '').slice(0, 2000);
    return feedback;
  }, { fallback: {} });
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
  await updateJson('feedback.json', (feedback) => {
    feedback.status ??= {};
    feedback.appliedDate ??= {};
    feedback.status[fp] = status;
    // Auto-set applied date when transitioning to "applied" if not already set
    if (status === 'applied' && !feedback.appliedDate[fp]) {
      feedback.appliedDate[fp] = new Date().toISOString().slice(0, 10);
    }
    if (rejectReason && (status === 'rejected' || status === 'pass')) {
      setRejectReason(feedback, fp, rejectReason, rejectNote);
    }
    return feedback;
  }, { fallback: {} });
  res.json({ ok: true });
});

router.post('/:fp/reject-reason', async (req, res) => {
  const { fp } = req.params;
  const { reason, note } = req.body;
  if (reason && !VALID_REJECT_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of ${VALID_REJECT_REASONS.join(', ')}` });
  }
  await updateJson('feedback.json', (feedback) => {
    if (!reason) {
      if (feedback.rejectReasons) delete feedback.rejectReasons[fp];
    } else {
      setRejectReason(feedback, fp, reason, note);
    }
    return feedback;
  }, { fallback: {} });
  res.json({ ok: true });
});

router.post('/:fp/appliedDate', async (req, res) => {
  const { fp } = req.params;
  const { appliedDate } = req.body; // YYYY-MM-DD or null
  await updateJson('feedback.json', (feedback) => {
    feedback.appliedDate ??= {};
    if (appliedDate) feedback.appliedDate[fp] = appliedDate;
    else delete feedback.appliedDate[fp];
    return feedback;
  }, { fallback: {} });
  res.json({ ok: true });
});

router.post('/:fp/closesDate', async (req, res) => {
  const { fp } = req.params;
  const { closesDate } = req.body;
  await updateJson('feedback.json', (feedback) => {
    feedback.closesDate ??= {};
    if (closesDate) feedback.closesDate[fp] = closesDate;
    else delete feedback.closesDate[fp];
    return feedback;
  }, { fallback: {} });
  res.json({ ok: true });
});

export default router;
