// src/routes/documents.js
// Document upload + retrieval. Documents are keyed by ROLE FINGERPRINT
// (not the per-listing dedupKey) because the same resume applies to all
// distinct openings of the same role at the same employer.

import { Router } from 'express';
import multer from 'multer';
import { readJson } from '../io.js';
import {
  saveDocument,
  listDocuments,
  getDocumentPath,
  deleteDocument,
  validateUpload,
  scoreResumeAgainstJd,
  scoreCoverLetterAgainstJd,
  setUserNotes,
} from '../documents.js';
import { createLogger } from '../log.js';

const log = createLogger('docs-route');

const router = Router();

// Multer in-memory storage — small files only, 5MB cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/:fp', async (req, res) => {
  try {
    const docs = await listDocuments(req.params.fp);
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload a document. multipart/form-data with field "file"
// Body: slot (resume|cover|other), otherName (when slot=other), autoScore
router.post('/:fp/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { slot, otherName, autoScore } = req.body;
    const v = validateUpload(req.file.originalname, req.file.size);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const result = await saveDocument({
      fingerprint: req.params.fp,
      slot: slot || 'other',
      originalName: req.file.originalname,
      buffer: req.file.buffer,
      otherName,
    });

    // Auto-score resume or cover letter against JD if requested
    let alignmentScore = null;
    if ((slot === 'resume' || slot === 'cover') && autoScore !== 'false') {
      try {
        const all = await readJson('listings.json');
        const listing = all.listings.find((l) => l.fingerprint === req.params.fp);
        if (listing) {
          alignmentScore = slot === 'resume'
            ? await scoreResumeAgainstJd({ fingerprint: req.params.fp, listing })
            : await scoreCoverLetterAgainstJd({ fingerprint: req.params.fp, listing });
        }
      } catch (err) {
        log.error({ err, fp: req.params.fp, slot }, 'auto-scoring failed');
      }
    }

    res.json({ ...result, alignmentScore });
  } catch (err) {
    log.error({ err, fp: req.params.fp }, 'upload failed');
    res.status(500).json({ error: err.message });
  }
});

// Serve a document file. ?inline=1 sets Content-Disposition: inline so the
// browser previews the file rather than downloading it.
router.get('/:fp/file/:filename', async (req, res) => {
  try {
    const path = await getDocumentPath(req.params.fp, req.params.filename);
    const inline = req.query.inline === '1';
    const ext = req.params.filename.split('.').pop().toLowerCase();
    const mime = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      txt: 'text/plain; charset=utf-8',
    }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${req.params.filename}"`,
    );
    res.sendFile(path);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Delete a document. Body: { slot: 'resume'|'cover'|'other', file?: string }
router.post('/:fp/delete', async (req, res) => {
  try {
    const { slot, file } = req.body;
    await deleteDocument(req.params.fp, slot, file);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseForce(req) {
  return req.query.force === '1' || req.query.force === 'true' || req.body?.force === true;
}

// Save scoring notes she wants Claude to respect (e.g. "don't suggest X").
// Notes live at the slot level (resume.userNotes / cover.userNotes) so they
// persist across resume re-uploads. POST { slot, notes }; pass notes:'' to clear.
router.post('/:fp/notes', async (req, res) => {
  try {
    const { slot, notes } = req.body || {};
    if (slot !== 'resume' && slot !== 'cover') {
      return res.status(400).json({ error: 'slot must be "resume" or "cover"' });
    }
    const saved = await setUserNotes({ fingerprint: req.params.fp, slot, notes });
    res.json({ ok: true, notes: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:fp/score-resume', async (req, res) => {
  try {
    const all = await readJson('listings.json');
    const listing = all.listings.find((l) => l.fingerprint === req.params.fp);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const score = await scoreResumeAgainstJd({
      fingerprint: req.params.fp,
      listing,
      force: parseForce(req),
    });
    res.json(score);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:fp/score-cover', async (req, res) => {
  try {
    const all = await readJson('listings.json');
    const listing = all.listings.find((l) => l.fingerprint === req.params.fp);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const score = await scoreCoverLetterAgainstJd({
      fingerprint: req.params.fp,
      listing,
      force: parseForce(req),
    });
    res.json(score);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
