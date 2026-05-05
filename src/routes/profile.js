// src/routes/profile.js
// Profile-scoped endpoints. The canonical "default resume" lives under a
// reserved fingerprint (_profile) so it can be reused by all of scoring,
// discovery, and the alignment tool — distinct from per-listing uploads.

import { Router } from 'express';
import multer from 'multer';
import {
  saveDocument,
  getDocumentPath,
  deleteDocument,
  validateUpload,
  getProfileResumeMeta,
  PROFILE_FINGERPRINT,
} from '../documents.js';
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
      const path = await getDocumentPath(PROFILE_FINGERPRINT, meta.file);
      const ext = meta.file.split('.').pop().toLowerCase();
      const mime = {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        doc: 'application/msword',
        txt: 'text/plain; charset=utf-8',
      }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${meta.originalName || meta.file}"`,
      );
      return res.sendFile(path);
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

export default router;
