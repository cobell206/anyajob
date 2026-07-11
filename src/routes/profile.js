// src/routes/profile.js
// Profile-scoped endpoints. The canonical "default resume" lives under a
// reserved fingerprint (_profile) so it can be reused by all of scoring,
// discovery, and the alignment tool — distinct from per-listing uploads.

import { Router } from 'express';
import multer from 'multer';
import {
  saveDocument,
  getDocStream,
  deleteDocument,
  validateUpload,
  getProfileResumeMeta,
  PROFILE_FINGERPRINT,
} from '../documents.js';
import { generateResumeFeedback, getResumeFeedback } from '../feedback.js';
import { RESUME_FEEDBACK_LENSES } from '../prompts.js';
import { createLogger } from '../log.js';

const log = createLogger('profile-route');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/resume', async (req, res) => {
  try {
    const meta = await getProfileResumeMeta();
    if (req.query.download === '1') {
      if (!meta) return res.status(404).json({ error: 'No resume uploaded' });
      const { body, contentType, contentLength } = await getDocStream(
        PROFILE_FINGERPRINT, meta.file,
      );
      res.setHeader('Content-Type', contentType);
      if (contentLength != null) res.setHeader('Content-Length', contentLength);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${meta.originalName || meta.file}"`,
      );
      return body.pipe(res);
    }
    res.json({ resume: meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/resume', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const v = validateUpload(req.file.originalname, req.file.size);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const result = await saveDocument({
      fingerprint: PROFILE_FINGERPRINT,
      slot: 'resume',
      originalName: req.file.originalname,
      buffer: req.file.buffer,
    });
    const meta = await getProfileResumeMeta();
    res.json({ ...result, resume: meta });
  } catch (err) {
    log.error({ err }, 'profile resume upload failed');
    res.status(500).json({ error: err.message });
  }
});

router.delete('/resume', async (req, res) => {
  try {
    await deleteDocument(PROFILE_FINGERPRINT, 'resume');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Résumé feedback (standalone, profile-page) ----------
// GET returns cached feedback (per-lens or all). POST runs a new evaluation.
// Cached entries are scoped to the current résumé file — replacing the
// résumé invalidates them automatically (see getResumeFeedback).

router.get('/resume/feedback', async (req, res) => {
  try {
    const lens = req.query.lens || undefined;
    if (lens && !RESUME_FEEDBACK_LENSES.includes(lens)) {
      return res.status(400).json({ error: `unknown lens: ${lens}` });
    }
    const result = await getResumeFeedback({ lens });
    res.json(result);
  } catch (err) {
    log.error({ err }, 'getResumeFeedback failed');
    res.status(500).json({ error: err.message });
  }
});

router.post('/resume/feedback', async (req, res) => {
  try {
    const lens = req.body?.lens || 'law-school';
    if (!RESUME_FEEDBACK_LENSES.includes(lens)) {
      return res.status(400).json({ error: `unknown lens: ${lens}` });
    }
    const result = await generateResumeFeedback({ lens });
    if (result.error) return res.status(422).json(result);
    res.json(result);
  } catch (err) {
    log.error({ err }, 'generateResumeFeedback failed');
    res.status(500).json({ error: err.message });
  }
});

export default router;
