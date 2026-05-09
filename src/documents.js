// src/documents.js
// Per-listing application materials (resume, cover letter, other).
// Files stored on EBS at data/documents/{fingerprint}/{slot}-{timestamp}.{ext}
// Old versions kept (archived). DOCX converted to PDF on upload for preview.
// Backed up to S3 nightly via separate cron (see DEPLOY.md).

import 'dotenv/config';
import { readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { RESUME_ALIGNMENT_SYSTEM, COVER_LETTER_ALIGNMENT_SYSTEM } from './prompts.js';
import { writeJsonAtomic } from './atomic.js';
import { readJson, fbKey } from './io.js';
import { createLogger } from './log.js';

const log = createLogger('documents');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(__dirname, '..', 'data', 'documents');
const DOCS_INDEX = join(__dirname, '..', 'data', 'documents.json');

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.txt']);
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
  try {
    return JSON.parse(await readFile(DOCS_INDEX, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeIndex(idx) {
  await writeJsonAtomic(DOCS_INDEX, idx);
}

async function ensureDir(dir) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function safeFilename(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

// ---------- DOCX → PDF conversion ----------
// Uses LibreOffice headless. Falls back gracefully if not installed.
async function convertDocxToPdf(srcPath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('libreoffice', [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', destDir,
      srcPath,
    ], { timeout: 30000 });

    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      // libreoffice not installed; not fatal — just no preview
      log.warn({ err }, 'LibreOffice not available; skipping PDF conversion');
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        log.warn({ exitCode: code, stderr }, 'LibreOffice exited non-zero');
        return resolve(null);
      }
      const expected = join(
        destDir,
        basename(srcPath, extname(srcPath)) + '.pdf',
      );
      if (existsSync(expected)) {
        resolve(expected);
      } else {
        resolve(null);
      }
    });
  });
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

  const dir = join(DOCS_ROOT, safeFilename(fingerprint));
  await ensureDir(dir);

  const ts = timestamp();
  const fname = slot === 'other'
    ? `other-${safeFilename(otherName || 'doc')}-${ts}${ext}`
    : `${slot}-${ts}${ext}`;
  const destPath = join(dir, fname);
  await writeFile(destPath, buffer);

  // Convert DOCX → PDF for preview if applicable
  let previewFile = null;
  if (ext === '.docx' || ext === '.doc') {
    const pdfPath = await convertDocxToPdf(destPath, dir);
    if (pdfPath) previewFile = basename(pdfPath);
  } else if (ext === '.pdf') {
    previewFile = fname; // PDF is its own preview
  }
  // .txt files: no preview, will be rendered as text

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

export async function getDocumentPath(fingerprint, filename) {
  // Sanitize: only allow files in the listing's own folder
  const safe = safeFilename(filename);
  if (safe !== filename || filename.includes('..') || filename.includes('/')) {
    throw new Error('Invalid filename');
  }
  const path = join(DOCS_ROOT, safeFilename(fingerprint), filename);
  if (!existsSync(path)) {
    throw new Error('File not found');
  }
  return path;
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

async function hashFileContents(path) {
  const buf = await readFile(path);
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

async function readPdfText(pdfPath) {
  // Lightweight text extraction. Uses pdftotext if available, falls back to nothing.
  return new Promise((resolve) => {
    const proc = spawn('pdftotext', ['-layout', pdfPath, '-'], { timeout: 15000 });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.stderr?.on('data', (d) => { err += d.toString(); });
    proc.on('error', () => resolve(''));
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else resolve('');
    });
  });
}

async function readDocxText(docxPath) {
  // Try mammoth if available (it's already a dep elsewhere or can be added)
  try {
    const mammoth = (await import('mammoth')).default || (await import('mammoth'));
    const result = await mammoth.extractRawText({ path: docxPath });
    return result.value || '';
  } catch {
    return '';
  }
}

export async function extractResumeText(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return await readPdfText(filePath);
  if (ext === '.docx') return await readDocxText(filePath);
  if (ext === '.txt') return await readFile(filePath, 'utf-8');
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
  const path = await getDocumentPath(PROFILE_FINGERPRINT, meta.file);
  const text = await extractResumeText(path);
  return text ? text.slice(0, 8000) : null;
}

export async function scoreResumeAgainstJd({ fingerprint, listing }) {
  const docs = await listDocuments(fingerprint);
  const resume = docs.resume?.current;
  if (!resume) return null;

  const resumePath = await getDocumentPath(fingerprint, resume.file);
  const resumeHash = await hashFileContents(resumePath);
  const userNotes = (docs.resume?.userNotes || '').trim();
  const prior = resume.alignmentScore || null;

  const resumeText = (await extractResumeText(resumePath)).slice(0, 8000);
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

  const coverPath = await getDocumentPath(fingerprint, cover.file);
  const coverHash = await hashFileContents(coverPath);
  const userNotes = (docs.cover?.userNotes || '').trim();
  const prior = cover.alignmentScore || null;

  const coverText = (await extractResumeText(coverPath)).slice(0, 8000);
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
