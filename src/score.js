// src/score.js
// Sends a listing to Claude Sonnet 4.6 for scoring. Tracks spend, enforces
// daily cap, returns parsed JSON. Uses prompt caching for the static blocks.

import 'dotenv/config';
import { getAnthropic } from './anthropic.js';
import { writeJsonAtomic } from './atomic.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSystemBlocks, buildUserMessage } from './prompts.js';
import { fbKey, readJson, readJsonSafe } from './io.js';
import { createLogger } from './log.js';

const log = createLogger('score');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEND_PATH = join(__dirname, '..', 'data', 'spend.json');

const MODEL = 'claude-sonnet-4-6';

// Sonnet 4.6 pricing per million tokens (verify at console.anthropic.com)
const PRICING = {
  input: 3.0 / 1_000_000,
  cacheWrite: 3.75 / 1_000_000,
  cacheRead: 0.3 / 1_000_000,
  output: 15.0 / 1_000_000,
};


async function loadSpend() {
  return readJsonSafe(SPEND_PATH, { fallback: { byDay: {} } });
}

async function saveSpend(spend) {
  await writeJsonAtomic(SPEND_PATH, spend);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Deterministic salary fallback. The LLM is inconsistent about extracting
// salary from longer descriptions where the number sits deep in the text.
// Run as a post-pass when the model returned null for both bounds.
//
// Looks for $XX,XXX(–$YY,YYY)? amounts within 200 chars of a salary keyword,
// caps at $20k–$500k to filter out deal sizes / award amounts / token grants.
export function extractSalaryFromDescription(desc) {
  if (!desc) return null;
  const SALARY_CTX = /salary|compensation|annual|hourly|pay\s+range|per\s+year|\bcomp\b/i;
  const re = /\$([\d,]{4,})(?:\s*(?:[-–—to]+|and)\s*\$?([\d,]{4,}))?/gi;
  const candidates = [];
  for (const m of desc.matchAll(re)) {
    const ctxStart = Math.max(0, m.index - 200);
    const ctxEnd = Math.min(desc.length, m.index + m[0].length + 200);
    if (!SALARY_CTX.test(desc.slice(ctxStart, ctxEnd))) continue;
    const min = parseInt(m[1].replace(/,/g, ''), 10);
    const max = m[2] ? parseInt(m[2].replace(/,/g, ''), 10) : min;
    if (!min || min < 20000 || min > 500000) continue;
    if (max < min || max > 500000) continue;
    candidates.push({ min, max });
  }
  if (!candidates.length) return null;
  return {
    salaryMin: Math.min(...candidates.map((c) => c.min)),
    salaryMax: Math.max(...candidates.map((c) => c.max)),
  };
}

function calcCost(usage) {
  const input = (usage.input_tokens || 0) * PRICING.input;
  const cacheW = (usage.cache_creation_input_tokens || 0) * PRICING.cacheWrite;
  const cacheR = (usage.cache_read_input_tokens || 0) * PRICING.cacheRead;
  const output = (usage.output_tokens || 0) * PRICING.output;
  return input + cacheW + cacheR + output;
}

async function loadFeedback() {
  try {
    return await readJson('feedback.json');
  } catch {
    return {};
  }
}

// Summarize the user's skip patterns as a short comma-separated string for the
// scoring prompt. Returns null when there's too little signal (< 3 ignores) so
// the prompt stays clean during cold-start.
export async function buildIgnoreContext() {
  const feedback = await loadFeedback();
  const reasons = Object.values(feedback.rejectReasons || {});
  if (reasons.length < 3) return null;

  const counts = {};
  for (const r of reasons) {
    if (r.reason) counts[r.reason] = (counts[r.reason] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.map(([r, n]) => `${r}: ${n}`).join(', ');
}

export async function scoreOne(listing, preferences, examples = [], resumeText = null, ignoreContext = null) {
  const cap = parseFloat(process.env.MAX_DAILY_SPEND || '2.00');
  const spend = await loadSpend();
  const todaySpend = spend.byDay[today()] || 0;
  if (todaySpend >= cap) {
    throw new Error(`Daily spend cap reached: $${todaySpend.toFixed(4)} >= $${cap}`);
  }

  const systemBlocks = buildSystemBlocks(preferences, resumeText);
  const userMsg = buildUserMessage(listing, examples, ignoreContext);

  const response = await (await getAnthropic()).messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: systemBlocks,
    messages: [{ role: 'user', content: userMsg }],
  });

  // Track spend
  const cost = calcCost(response.usage);
  spend.byDay[today()] = todaySpend + cost;
  await saveSpend(spend);

  // Parse the JSON response
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  let parsed;
  try {
    // Extract the first {...} block — tolerates code fences, leading/trailing
    // commentary, and stray prose around the JSON.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object found in response');
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    log.error({ err, response: text.slice(0, 500) }, 'failed to parse scoring response');
    parsed = {
      qualificationFit: 0,
      lawSchoolValue: 0,
      overallScore: 0,
      rationale: 'Failed to parse model output',
      strengths: [],
      concerns: ['scoring error'],
      applicationAngle: '',
      _rawOutput: text,
    };
  }

  if (parsed.salaryMin == null && parsed.salaryMax == null) {
    const fallback = extractSalaryFromDescription(listing.description);
    if (fallback) {
      parsed.salaryMin = fallback.salaryMin;
      parsed.salaryMax = fallback.salaryMax;
      parsed._salaryFromRegex = true;
    }
  }

  parsed._cost = cost;
  parsed._scoredAt = new Date().toISOString();
  return parsed;
}

// Pull recent feedback for prompt-caching examples
export async function loadRecentFeedback(maxExamples = 6) {
  try {
    const feedback = await readJson('feedback.json');
    const { listings } = await readJson('listings.json');
    // Feedback is keyed by dedupKey when available, fingerprint as fallback.
    const byKey = new Map(listings.map((l) => [fbKey(l), l]));

    const examples = [];
    for (const [key, rating] of Object.entries(feedback.ratings || {})) {
      const listing = byKey.get(key);
      if (!listing) continue;
      examples.push({
        rating,
        company: listing.company,
        title: listing.title,
        location: listing.location,
      });
    }
    // Most recent first (rating timestamps not tracked yet — TODO)
    return examples.slice(-maxExamples);
  } catch {
    return [];
  }
}

// CLI test mode: node src/score.js --test
if (process.argv.includes('--test')) {
  const prefs = await readJson('preferences.json');
  const fakeListing = {
    source: 'test',
    company: 'Davis Polk & Wardwell',
    title: 'Litigation Paralegal — 2 Year Program',
    location: 'New York, NY',
    description:
      'Davis Polk seeks recent college graduates for our 2-year paralegal program. Designed for candidates intending to attend law school. Responsibilities include legal research, document review, deposition prep, and client communication. Top firms recruit heavily from this program.',
    postedAt: new Date().toISOString(),
  };
  const result = await scoreOne(fakeListing, prefs, []);
  console.log(JSON.stringify(result, null, 2));
}
