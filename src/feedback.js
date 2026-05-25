// src/feedback.js
// Standalone résumé feedback — evaluates the profile résumé through a law-
// school admissions reader's eye. Distinct from src/documents.js's
// scoreResumeAgainstJd (which scores the résumé against a specific listing).
//
// Findings come back anchored to verbatim quotes from the résumé so the UI
// can highlight them inline. Feedback is persisted per-lens on the resume
// metadata so opening the page doesn't re-spend tokens; she can refresh
// any lens on demand.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildResumeFeedbackBlocks,
  buildResumeFeedbackUser,
  buildResumeFeedbackUserWithText,
  RESUME_FEEDBACK_LENSES,
} from './prompts.js';
import {
  PROFILE_FINGERPRINT,
  getProfileResumeMeta,
  getDocumentPath,
  extractResumeText,
} from './documents.js';
import { readJson } from './io.js';
import { writeJsonAtomic } from './atomic.js';
import { createLogger } from './log.js';

const log = createLogger('feedback');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_INDEX = join(__dirname, '..', 'data', 'documents.json');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Pull résumé text via the shared extractor (pdf-parse / mammoth / txt).
// Distinct from getProfileResumeText, which caps to 8000 chars for the
// scoring loop — feedback needs the full document so Claude's verbatim
// quotes can match anywhere in the résumé.
async function readFullResumeText(meta) {
  const path = await getDocumentPath(PROFILE_FINGERPRINT, meta.file);
  return await extractResumeText(path);
}

function parseFeedbackJson(text, stopReason) {
  if (stopReason === 'max_tokens') {
    return { error: 'response truncated at max_tokens', raw: text };
  }
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object found');
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { error: 'parse failed: ' + err.message, raw: text.slice(0, 500) };
  }
}

export async function generateResumeFeedback({ lens = 'law-school' } = {}) {
  if (!RESUME_FEEDBACK_LENSES.includes(lens)) {
    throw new Error(`unknown lens: ${lens}`);
  }

  const meta = await getProfileResumeMeta();
  if (!meta) {
    return { error: 'No résumé uploaded yet.' };
  }

  const prefs = await readJson('preferences.json');
  const profile = prefs?.profile || {};
  const interestAreas = profile.interestAreas || [];
  const targetSchools = profile.targetSchools || [];
  const system = buildResumeFeedbackBlocks();

  // PDF résumés go in as a document block with citations enabled — this
  // gives Claude visual PDF understanding (vs basic text extraction) and
  // returns cited_text spans we use to corroborate findings. Non-PDF
  // résumés (DOCX, TXT) fall back to extracted text in the user message;
  // Anthropic only accepts PDF for document blocks today.
  const isPdf = extname(meta.file).toLowerCase() === '.pdf';
  let userContent;
  let extractedChars = 0;
  if (isPdf) {
    const pdfPath = await getDocumentPath(PROFILE_FINGERPRINT, meta.file);
    const pdfBuf = await readFile(pdfPath);
    userContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdfBuf.toString('base64') },
        title: meta.originalName || meta.file,
        citations: { enabled: true },
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: buildResumeFeedbackUser({ profile, interestAreas, targetSchools, lens, hasPdfDocument: true }),
      },
    ];
  } else {
    const resumeText = (await readFullResumeText(meta)).trim();
    if (!resumeText) {
      return { error: 'Could not extract text from résumé.' };
    }
    extractedChars = resumeText.length;
    userContent = buildResumeFeedbackUserWithText({
      profile, interestAreas, targetSchools, lens, resumeText,
    });
  }

  log.info({ lens, isPdf, extractedChars, pdfBytes: isPdf ? meta.sizeBytes : null },
    'generating résumé feedback');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const textBlocks = response.content.filter((b) => b.type === 'text');
  const text = textBlocks.map((b) => b.text).join('\n').trim();
  const parsed = parseFeedbackJson(text, response.stop_reason);

  if (parsed.error) {
    log.error({ lens, parsed, stopReason: response.stop_reason }, 'feedback parse failed');
    return parsed;
  }

  // Collect citations from every text block in the response so the frontend
  // can corroborate / fall back when finding.quote doesn't match the PDF
  // text layer character-for-character. Each citation gives us the model's
  // own cited_text + the page range it came from.
  const rawCitations = [];
  for (const block of textBlocks) {
    for (const c of (block.citations || [])) {
      if (c.type !== 'page_location') continue;
      rawCitations.push({
        cited_text: c.cited_text,
        start_page: c.start_page_number,
        end_page: c.end_page_number,
      });
    }
  }

  const entry = {
    ...parsed,
    lens,
    model: MODEL,
    generatedAt: new Date().toISOString(),
    resumeFile: meta.file,
    inputMode: isPdf ? 'pdf' : 'text',
    citations: rawCitations,
  };

  await persistFeedback(lens, entry);
  return entry;
}

// Read cached feedback for a single lens, or all lenses if none specified.
// Returns the extracted résumé text alongside so the frontend can render
// the document and locate finding quotes in a single roundtrip.
// Cached feedback entries are invalidated when the underlying résumé file
// changes (resumeFile field on the entry doesn't match the current meta.file).
export async function getResumeFeedback({ lens } = {}) {
  const meta = await getProfileResumeMeta();
  if (!meta) return { resume: null, feedback: lens ? null : {}, text: null };

  const idx = await readIndex();
  const all = idx[PROFILE_FINGERPRINT]?.resume?.current?.feedback || {};

  const fresh = {};
  for (const [k, v] of Object.entries(all)) {
    if (v?.resumeFile === meta.file) fresh[k] = v;
  }

  // Pull text so the client can render the résumé + highlight quotes. We
  // intentionally extract on each GET (rather than persisting the text in
  // the index) because the index is meant for metadata, not document
  // contents — and extraction is fast for a 1-2 page résumé.
  let text = null;
  try {
    text = (await readFullResumeText(meta)).trim();
  } catch (err) {
    log.warn({ err: err.message }, 'failed to extract résumé text for feedback GET');
  }

  if (lens) return { resume: meta, feedback: fresh[lens] || null, text };
  return { resume: meta, feedback: fresh, text };
}

async function readIndex() {
  try {
    return JSON.parse(await readFile(DOCS_INDEX, 'utf-8'));
  } catch {
    return {};
  }
}

async function persistFeedback(lens, entry) {
  const idx = await readIndex();
  const current = idx[PROFILE_FINGERPRINT]?.resume?.current;
  if (!current) {
    log.warn({ lens }, 'tried to persist feedback but no current resume in index');
    return;
  }
  if (!current.feedback) current.feedback = {};
  current.feedback[lens] = entry;
  await writeJsonAtomic(DOCS_INDEX, idx);
}
