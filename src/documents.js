// src/documents.js
// Per-listing application materials (resume, cover letter, other).
// Files stored on EBS at data/documents/{fingerprint}/{slot}-{timestamp}.{ext}
// Old versions kept (archived). Uploads are PDF/TXT only — PDFs are their own
// preview (rendered client-side by public/pdf-viewer.js), so there is no
// server-side conversion step. Backed up to S3 nightly via separate cron.

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { RESUME_ALIGNMENT_SYSTEM, COVER_LETTER_ALIGNMENT_SYSTEM } from './prompts.js';
import { writeJsonAtomic } from './atomic.js';
import { readJson, readJsonSafe, fbKey } from './io.js';
import { putDoc, getDocBuffer, getDocStream } from './docstore.js';
import { createLogger } from './log.js';

// Document files (binaries) live in docstore.js (fs or S3); this module owns
// the documents.json index (via the JSON store) and the scoring logic.
export { getDocStream, getDocBuffer } from './docstore.js';

const log = createLogger('documents');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_INDEX = join(__dirname, '..', 'data', 'documents.json');

// PDF/TXT only. Word docs were previously accepted and converted to PDF via
// LibreOffice for preview; that shell-out is gone (serverless migration), and
// the store is PDF-only in practice. Reject anything else at upload.
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.txt']);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

// ---------- Index management ----------
// documents.json:
// {
//   "<fingerprint>": {
//     "resume": { current: "resume-2026-05-02T13-12-04.pdf", versions: [...], score: {...} },
//     "cover": { ... },
//     "other": [{ name, file, uploadedAt }]
//   }
// }

async function readIndex() {
  return readJsonSafe(DOCS_INDEX, { fallback: {} });
}

async function writeIndex(idx) {
  await writeJsonAtomic(DOCS_INDEX, idx);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function safeFilename(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

// ---------- Public API ----------

export function validateUpload(filename, sizeBytes) {
  const ext = extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, error: `Only ${[...ALLOWED_EXTENSIONS].join(', ')} allowed` };
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    return { ok: false, error: `File exceeds 5MB limit` };
  }
  return { ok: true, ext };
}

// slot: 'resume' | 'cover' | 'other'
// otherName: human label when slot === 'other' (e.g. "Writing sample")
export async function saveDocument({
  fingerprint,
  slot,
  originalName,
  buffer,
  otherName = null,
}) {
  if (!['resume', 'cover', 'other'].includes(slot)) {
    throw new Error('Invalid slot');
  }
  const ext = extname(originalName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported extension: ${ext}`);
  }

  const ts = timestamp();
  const fname = slot === 'other'
    ? `other-${safeFilename(otherName || 'doc')}-${ts}${ext}`
    : `${slot}-${ts}${ext}`;
  await putDoc(fingerprint, fname, buffer);

  // PDF is its own preview (rendered client-side). .txt has no preview and is
  // rendered as text. No other types reach here (validated above).
  const previewFile = ext === '.pdf' ? fname : null;

  // Update index
  const idx = await readIndex();
  if (!idx[fingerprint]) idx[fingerprint] = {};
  const entry = {
    file: fname,
    previewFile,
    originalName,
    uploadedAt: new Date().toISOString(),
    sizeBytes: buffer.length,
  };
  if (slot === 'other') {
    entry.label = otherName || 'Document';
    if (!idx[fingerprint].other) idx[fingerprint].other = [];
    idx[fingerprint].other.push(entry);
  } else {
    if (!idx[fingerprint][slot]) idx[fingerprint][slot] = { versions: [] };
    // Archive previous current
    if (idx[fingerprint][slot].current) {
      idx[fingerprint][slot].versions.push(idx[fingerprint][slot].current);
    }
    idx[fingerprint][slot].current = entry;
  }
  await writeIndex(idx);

  return { fingerprint, slot, file: fname, previewFile };
}

export async function listDocuments(fingerprint) {
  const idx = await readIndex();
  return idx[fingerprint] || {};
}

export async function deleteDocument(fingerprint, slot, fileToDelete = null) {
  // For 'other', fileToDelete identifies which one
  // For 'resume'/'cover' without fileToDelete, removes the current
  const idx = await readIndex();
  if (!idx[fingerprint]) return false;

  if (slot === 'other') {
    if (!fileToDelete) throw new Error('fileToDelete required for other');
    idx[fingerprint].other = (idx[fingerprint].other || []).filter(
      (e) => e.file !== fileToDelete,
    );
  } else {
    if (!idx[fingerprint][slot]) return false;
    if (fileToDelete) {
      // Remove from versions
      idx[fingerprint][slot].versions = (idx[fingerprint][slot].versions || []).filter(
        (e) => e.file !== fileToDelete,
      );
    } else {
      // Promote latest version, or clear
      const versions = idx[fingerprint][slot].versions || [];
      idx[fingerprint][slot].current = versions.pop() || null;
      idx[fingerprint][slot].versions = versions;
    }
  }
  await writeIndex(idx);
  return true;
}

// ---------- Resume vs JD scoring ----------

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const MAX_USER_NOTES = 1500;

// Notes she pre-emptively attaches to the score request — e.g. "don't suggest
// litigation experience, I know I don't have it." Stored at the slot level so
// they survive resume re-uploads (only `.current` is swapped on upload).
export async function setUserNotes({ fingerprint, slot, notes }) {
  if (slot !== 'resume' && slot !== 'cover') {
    throw new Error('Invalid slot for notes');
  }
  const idx = await readIndex();
  if (!idx[fingerprint]) idx[fingerprint] = {};
  if (!idx[fingerprint][slot]) idx[fingerprint][slot] = { versions: [] };
  const trimmed = (notes || '').slice(0, MAX_USER_NOTES);
  if (trimmed) {
    idx[fingerprint][slot].userNotes = trimmed;
  } else {
    delete idx[fingerprint][slot].userNotes;
  }
  await writeIndex(idx);
  return idx[fingerprint][slot].userNotes || '';
}

function userNotesBlock(notes) {
  if (!notes) return '';
  return `\n\nCANDIDATE NOTES (respect these — pre-emptive guidance from her about what NOT to suggest. Do not recommend things she has flagged as not applicable, missing, or off-limits):\n${notes}`;
}

// Pulls the listing note from feedback.json so the scorer can pass it as
// extra context. Returns '' when no note (or when feedback can't be loaded).
async function getListingNote(listing) {
  if (listing && typeof listing.note === 'string' && listing.note.trim()) {
    return listing.note.trim();
  }
  try {
    const feedback = await readJson('feedback.json');
    return (feedback.notes?.[fbKey(listing)] || '').trim();
  } catch {
    return '';
  }
}

function priorFeedbackBlock(prior) {
  if (!prior || prior.error) return '';
  const lines = ['\n\nPRIOR ALIGNMENT FEEDBACK (from her previous resume — she has since uploaded a new version):'];
  if (Array.isArray(prior.topStrengths) && prior.topStrengths.length) {
    lines.push('\nPrevious topStrengths:');
    prior.topStrengths.forEach((s) => lines.push(`- ${s}`));
  }
  if (Array.isArray(prior.areasToStrengthen) && prior.areasToStrengthen.length) {
    lines.push('\nPrevious areasToStrengthen:');
    prior.areasToStrengthen.forEach((s) => lines.push(`- ${s}`));
  }
  if (Array.isArray(prior.suggestedBullets) && prior.suggestedBullets.length) {
    lines.push('\nPrevious suggestedBullets:');
    prior.suggestedBullets.forEach((s) => lines.push(`- ${s}`));
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function priorCoverBlock(prior) {
  if (!prior || prior.error) return '';
  const lines = ['\n\nPRIOR ALIGNMENT FEEDBACK (from her previous cover letter — she has since uploaded a new version):'];
  if (Array.isArray(prior.strengths) && prior.strengths.length) {
    lines.push('\nPrevious strengths:');
    prior.strengths.forEach((s) => lines.push(`- ${s}`));
  }
  if (Array.isArray(prior.suggestions) && prior.suggestions.length) {
    lines.push('\nPrevious suggestions:');
    prior.suggestions.forEach((s) => lines.push(`- ${s}`));
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

// Resume alignment prompt lives in src/prompts.js (RESUME_ALIGNMENT_SYSTEM)

async function readPdfText(buf) {
  // Pure-JS extraction via pdf-parse v2 (pdfjs-dist under the hood). Errors
  // resolve to '' so callers don't handle extraction failure separately from
  // "no résumé".
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    return result?.text || '';
  } catch (err) {
    log.warn({ err: err.message }, 'pdf-parse extraction failed');
    return '';
  }
}

// Extract text from a document buffer. `filename` only supplies the extension.
export async function extractText(filename, buffer) {
  const ext = extname(filename).toLowerCase();
  if (ext === '.pdf') return await readPdfText(buffer);
  if (ext === '.txt') return buffer.toString('utf-8');
  return '';
}

// Reserved fingerprint for the canonical profile resume — distinct from any
// listing's role fingerprint. Stored at data/documents/_profile/resume-*.{ext}
// alongside per-listing folders, so all existing helpers work unchanged.
export const PROFILE_FINGERPRINT = '_profile';

export async function getProfileResumeMeta() {
  const docs = await listDocuments(PROFILE_FINGERPRINT);
  return docs.resume?.current || null;
}

// Used by score.js and discover.js. Returns null when no resume is uploaded.
// Truncates to 8000 chars to match the per-listing alignment scorer.
export async function getProfileResumeText() {
  const meta = await getProfileResumeMeta();
  if (!meta) return null;
  const buf = await getDocBuffer(PROFILE_FINGERPRINT, meta.file);
  const text = await extractText(meta.file, buf);
  return text ? text.slice(0, 8000) : null;
}

export async function scoreResumeAgainstJd({ fingerprint, listing }) {
  const docs = await listDocuments(fingerprint);
  const resume = docs.resume?.current;
  if (!resume) return null;

  const resumeBuf = await getDocBuffer(fingerprint, resume.file);
  const resumeHash = hashBuffer(resumeBuf);
  const userNotes = (docs.resume?.userNotes || '').trim();
  const prior = resume.alignmentScore || null;

  const resumeText = (await extractText(resume.file, resumeBuf)).slice(0, 8000);
  if (!resumeText) {
    return { error: 'Could not extract text from resume' };
  }

  const jdText = (listing.description || '').slice(0, 4000);
  const note = await getListingNote(listing);
  const noteBlock = note ? `\n\nHER NOTES ON THIS LISTING:\n${note.slice(0, 1500)}` : '';
  const priorBlock = priorFeedbackBlock(prior);
  const candidateNotesBlock = userNotesBlock(userNotes);
  const userMsg = `Job: ${listing.title} at ${listing.company} (${listing.location || ''})

JOB DESCRIPTION:
${jdText}${noteBlock}

CANDIDATE RESUME:
${resumeText}${candidateNotesBlock}${priorBlock}

Return JSON only.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: [{ type: 'text', text: RESUME_ALIGNMENT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  });

  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const truncated = response.stop_reason === 'max_tokens';

  let parsed;
  try {
    if (truncated) throw new Error('response truncated at max_tokens');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object found in response');
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    log.error({ err, stopReason: response.stop_reason, response: text.slice(0, 500) },
      'failed to parse resume alignment response');
    parsed = { error: truncated ? 'response truncated' : 'parse failed', raw: text };
  }
  parsed._scoredAt = new Date().toISOString();
  parsed._resumeHash = resumeHash;
  if (userNotes) parsed._userNotes = userNotes;

  // Persist on the document entry
  const idx = await readIndex();
  if (idx[fingerprint]?.resume?.current) {
    idx[fingerprint].resume.current.alignmentScore = parsed;
    await writeIndex(idx);
  }
  return parsed;
}

export async function scoreCoverLetterAgainstJd({ fingerprint, listing }) {
  const docs = await listDocuments(fingerprint);
  const cover = docs.cover?.current;
  if (!cover) return null;

  const coverBuf = await getDocBuffer(fingerprint, cover.file);
  const coverHash = hashBuffer(coverBuf);
  const userNotes = (docs.cover?.userNotes || '').trim();
  const prior = cover.alignmentScore || null;

  const coverText = (await extractText(cover.file, coverBuf)).slice(0, 8000);
  if (!coverText) {
    return { error: 'Could not extract text from cover letter' };
  }

  const jdText = (listing.description || '').slice(0, 4000);
  const note = await getListingNote(listing);
  const noteBlock = note ? `\n\nHER NOTES ON THIS LISTING:\n${note.slice(0, 1500)}` : '';
  const priorBlock = priorCoverBlock(prior);
  const candidateNotesBlock = userNotesBlock(userNotes);
  const userMsg = `Job: ${listing.title} at ${listing.company} (${listing.location || ''})

JOB DESCRIPTION:
${jdText}${noteBlock}

CANDIDATE COVER LETTER:
${coverText}${candidateNotesBlock}${priorBlock}

Return JSON only.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: [{ type: 'text', text: COVER_LETTER_ALIGNMENT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  });

  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const truncated = response.stop_reason === 'max_tokens';

  let parsed;
  try {
    if (truncated) throw new Error('response truncated at max_tokens');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object found in response');
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    log.error({ err, stopReason: response.stop_reason, response: text.slice(0, 500) },
      'failed to parse cover letter alignment response');
    parsed = { error: truncated ? 'response truncated' : 'parse failed', raw: text };
  }
  parsed._scoredAt = new Date().toISOString();
  parsed._coverHash = coverHash;
  if (userNotes) parsed._userNotes = userNotes;

  const idx = await readIndex();
  if (idx[fingerprint]?.cover?.current) {
    idx[fingerprint].cover.current.alignmentScore = parsed;
    await writeIndex(idx);
  }
  return parsed;
}
