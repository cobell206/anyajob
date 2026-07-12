// src/discover.js
//
// Source discovery: ask Claude (with web search) to suggest new sources
// matching her profile that aren't already being tracked. The output is
// a list of *candidate sources* she reviews and approves — nothing gets
// added to the registry automatically.
//
// Cost note: each run uses web_search, which costs more than a typical
// scoring call. Budget ~$0.20-0.50 per run. We cap with a single max-
// iteration on the agentic loop and limit max_tokens.

import 'dotenv/config';
import { getAnthropic } from './anthropic.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSources } from './sources/registry.js';
import { DISCOVERY_SYSTEM } from './prompts.js';
import { findOverlap, smartfetchSources } from './discover-overlap.js';
import { getProfileResumeText } from './documents.js';
import { writeJsonAtomic } from './atomic.js';
import { fbKey, readJson, readJsonSafe } from './io.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREFS_PATH = join(__dirname, '..', 'data', 'preferences.json');
const DISCOVERIES_PATH = join(__dirname, '..', 'data', 'discoveries.json');
const LISTINGS_PATH = join(__dirname, '..', 'data', 'listings.json');
const FEEDBACK_PATH = join(__dirname, '..', 'data', 'feedback.json');

const MODEL = 'claude-haiku-4-5-20251001';


// Discovery prompt lives in src/prompts.js (DISCOVERY_SYSTEM)

// Pull listings she has saved or applied to. These are the strongest positive
// signal we have about what kinds of employers/roles resonate. Cap at 15, most
// recent first.
export function formatPositiveSignal(listings, feedback) {
  const status = feedback?.status || {};
  const statusAt = feedback?.statusAt || {};
  const appliedDate = feedback?.appliedDate || {};

  const matches = [];
  for (const l of listings || []) {
    const key = fbKey(l);
    const s = status[key];
    if (s !== 'saved' && s !== 'applied') continue;
    const ts = statusAt[key] || appliedDate[key] || '';
    matches.push({ listing: l, ts });
  }
  if (matches.length === 0) return '';

  matches.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const top = matches.slice(0, 15);

  const lines = top.map(({ listing }) => {
    const title = listing.title || '(untitled)';
    const company = listing.company || '(unknown)';
    const location = listing.location || 'unspecified';
    const score = listing.score?.overallScore;
    const scorePart = typeof score === 'number' ? `, score ${score}` : '';
    return `- ${title}, ${company} (${location}${scorePart})`;
  });

  return `\n\nRoles she saved or applied to (positive signal — find sources like these):\n${lines.join('\n')}`;
}

// Aggregate her reject reasons into counts. Skip the block entirely unless the
// total ignored count is at least 3 — fewer than that is noise. Each value in
// feedback.rejectReasons is `{ reason, note, at }` (see routes/feedback.js).
export function formatNegativeSignal(feedback) {
  const reasons = feedback?.rejectReasons || {};
  const counts = {};
  let total = 0;
  for (const v of Object.values(reasons)) {
    const items = Array.isArray(v) ? v : [v];
    for (const r of items) {
      const reason = typeof r === 'string' ? r : r?.reason;
      if (!reason) continue;
      counts[reason] = (counts[reason] || 0) + 1;
      total++;
    }
  }
  if (total < 3) return '';
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const lines = sorted.map(([reason, count]) => `- ${reason}: ${count}`);
  return `\n\nWhat she's been ignoring (avoid sources heavy in these):\n${lines.join('\n')}`;
}

// List previously-dismissed candidate sources so Claude doesn't re-suggest
// them. Keyed identically to the dedup logic below: kind:slug or kind:url.
export function formatDismissedSignal(discoveries) {
  const candidates = discoveries?.candidates || [];
  const dismissed = candidates.filter((c) => c.status === 'dismissed');
  if (dismissed.length === 0) return '';
  const keys = dismissed
    .map((c) => {
      const id = c.config?.slug || c.config?.url;
      return id ? `${c.kind}:${id}` : null;
    })
    .filter(Boolean)
    .slice(0, 20);
  if (keys.length === 0) return '';
  return `\n\nPreviously dismissed sources (do not re-suggest):\n${keys.map((k) => `- ${k}`).join('\n')}`;
}

// One-shot steer the user typed into the Settings page for this run only.
// Trimmed + capped to keep prompt cost predictable and to defuse pathological
// inputs. Not persisted anywhere — lives for the duration of one request.
export const HINT_MAX_CHARS = 500;
export function formatHintBlock(hint) {
  if (typeof hint !== 'string') return '';
  const trimmed = hint.trim().slice(0, HINT_MAX_CHARS);
  if (!trimmed) return '';
  return `\n\nFOCUS FOR THIS RUN (her steer — weight this above the standing signals above):\n"""\n${trimmed}\n"""`;
}

export function buildDiscoveryUserMessage({
  prefs,
  existingList,
  resumeBlock = '',
  listings = [],
  feedback = {},
  discoveries = { candidates: [] },
  hint = '',
  maxCandidates = 12,
}) {
  const targetSchools = prefs.profile?.targetSchools || [];

  const positiveBlock = formatPositiveSignal(listings, feedback);
  const negativeBlock = formatNegativeSignal(feedback);
  const dismissedBlock = formatDismissedSignal(discoveries);
  const hintBlock = formatHintBlock(hint);

  return `Find new sources for her search. Return up to ${maxCandidates} carefully-chosen candidates.

HER PROFILE:
${JSON.stringify({
  geo: prefs.profile?.geo,
  interestAreas: prefs.profile?.interestAreas,
  targetSchools,
  currentRole: prefs.profile?.currentRole,
  yearsOutOfUndergrad: prefs.profile?.yearsOutOfUndergrad,
}, null, 2)}

KEYWORDS:
boost: ${(prefs.keywords?.boost || []).join(', ')}
exclude: ${(prefs.keywords?.exclude || []).join(', ')}

ALREADY TRACKING (do NOT suggest these):
${existingList || '(none)'}

ALREADY ON ALWAYS-SHOW LIST (good signal of types she likes):
${(prefs.companies?.alwaysShow || []).join(', ')}${resumeBlock}${positiveBlock}${negativeBlock}${dismissedBlock}${hintBlock}

Use the web_search tool to find candidates. Prioritize sources that:
1. align with her stated interest areas and geography
2. are realistic targets given the experience visible in her resume
3. recruit candidates who go on to ${targetSchools.length ? targetSchools.join(' / ') : 'top law schools'} (career pipelines, fellowship feeders, employer-of-record patterns matter)

Return JSON only.`;
}

// Derive a public-facing URL for a candidate when the model didn't include
// one. For greenhouse/lever the URL is structural; otherwise fall back to
// whatever's in config.url.
function deriveUrl(c) {
  if (c.kind === 'greenhouse' && c.config?.slug) {
    return `https://boards.greenhouse.io/${c.config.slug}`;
  }
  if (c.kind === 'lever' && c.config?.slug) {
    return `https://jobs.lever.co/${c.config.slug}`;
  }
  return c.config?.url || '';
}

async function readJsonOrDefault(path, fallback) {
  return readJsonSafe(path, { fallback });
}

export async function discoverSources({ maxCandidates = 12, hint = '' } = {}) {
  const prefs = await readJson(PREFS_PATH);
  const existing = await loadSources();
  const resumeText = await getProfileResumeText();
  const listingsData = await readJsonOrDefault(LISTINGS_PATH, { listings: [] });
  const feedback = await readJsonOrDefault(FEEDBACK_PATH, {});
  const discoveries = await readJsonOrDefault(DISCOVERIES_PATH, { candidates: [] });

  // Build a compact list of what she's already tracking so Claude doesn't suggest dupes
  const existingList = existing.sources
    .filter((s) => s.enabled)
    .map((s) => {
      if (s.config?.slug) return `${s.kind}:${s.config.slug}`;
      if (s.config?.url) return `${s.kind}:${s.config.url}`;
      return `${s.kind}:${s.name}`;
    })
    .join('\n');

  const resumeBlock = resumeText
    ? `\n\nHER RESUME (verbatim — use to anchor the search to her actual background and seniority, not just stated interests):\n${resumeText.slice(0, 4000)}`
    : '';

  const userMsg = buildDiscoveryUserMessage({
    prefs,
    existingList,
    resumeBlock,
    listings: listingsData.listings || [],
    feedback,
    discoveries,
    hint,
    maxCandidates,
  });

  const response = await (await getAnthropic()).messages.create({
    model: MODEL,
    // Web search adds tool-use commentary between rounds, then the final JSON
    // blob — needs more headroom than score.js. 8k is enough for 15 searches
    // worth of commentary plus 12 candidates of structured output.
    max_tokens: 8000,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 15, // hard cap on agentic search loop. ~$0.15 in search fees per run, plus tokens.
    }],
    system: DISCOVERY_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  });

  // Parse the final text response (after any tool use cycles)
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  // Extract the first {...} block — tolerates leading "I'll search..."
  // commentary the model emits between web_search rounds, plus any trailing
  // prose after the JSON.
  let parsed;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) {
      throw new Error('no JSON object found in response (likely truncated by max_tokens)');
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error('Could not parse discovery response: ' + err.message + '\nResponse was:\n' + text.slice(0, 500));
  }

  // Light validation + dedup against existing sources just in case Claude
  // missed it
  const existingKeys = new Set(
    existing.sources.map((s) => {
      if (s.config?.slug) return s.kind + ':' + s.config.slug.toLowerCase();
      if (s.config?.url) return s.kind + ':' + s.config.url.toLowerCase();
      return null;
    }).filter(Boolean)
  );

  // Extract smartfetch sources for overlap detection. If she already has
  // Skadden's careers page as smartfetch and Discovery proposes greenhouse:skadden,
  // we want to warn her so she can disable the smartfetch (avoiding double-fetch).
  const sfSources = smartfetchSources(existing.sources);

  const filtered = (parsed.candidates || [])
    .filter((c) => {
      if (!c.kind || !c.config) return false;
      const key = c.kind + ':' + (c.config.slug || c.config.url || '').toLowerCase();
      return !existingKeys.has(key);
    })
    .map((c) => {
      const url = c.url || deriveUrl(c);
      const overlap = findOverlap(c, sfSources);
      const out = { ...c, url };
      return overlap ? { ...out, overlapsWith: overlap } : out;
    });

  return {
    candidates: filtered,
    summary: parsed.summary || '',
    usage: response.usage,
  };
}

// =====================================================================
// PERSISTENCE — shared by the Mon+Thu cron and the on-demand button on
// the profile page. Single source of truth so the two paths can't drift.
// =====================================================================

export async function loadDiscoveries() {
  return readJsonSafe(DISCOVERIES_PATH, {
    fallback: { candidates: [], lastRunAt: null, history: [] },
  });
}

// Drop candidates that are stale (dismissed > 30 days, pending > 60 days,
// or already approved — approval moved them into sources.json).
function pruneCandidates(candidates) {
  const now = Date.now();
  return candidates.filter((c) => {
    if (c.status === 'approved') return false;
    const seen = c.firstSeenAt ? new Date(c.firstSeenAt).getTime() : now;
    const age = now - seen;
    if (c.status === 'dismissed') return age < 30 * 86400000;
    return age < 60 * 86400000;
  });
}

// Merge fresh candidates into the existing list. Dedup by kind+slug-or-url.
// Existing candidates keep their first-seen timestamp and review status —
// we never overwrite a "dismissed" with a "pending" just because the model
// re-suggested it.
function mergeCandidates(existing, fresh) {
  const key = (c) => c.kind + ':' + (c.config?.slug || c.config?.url || '').toLowerCase();
  const seen = new Map(existing.map((c) => [key(c), c]));
  const candidates = [...existing];
  let added = 0;
  for (const f of fresh) {
    if (seen.has(key(f))) continue;
    candidates.push({
      id: 'cand-' + randomUUID().slice(0, 8),
      ...f,
      firstSeenAt: new Date().toISOString(),
      status: 'pending',
    });
    added++;
  }
  return { candidates, added };
}

// Persist a discoverSources() result into data/discoveries.json. Returns
// counts so the caller can log/respond meaningfully.
export async function persistDiscoveryResult(result) {
  const existing = await loadDiscoveries();
  const pruned = pruneCandidates(existing.candidates || []);
  const { candidates: merged, added } = mergeCandidates(pruned, result.candidates);

  await writeJsonAtomic(DISCOVERIES_PATH, {
    candidates: merged,
    lastRunAt: new Date().toISOString(),
    lastSummary: result.summary,
    lastError: null,
    history: [
      ...(existing.history || []).slice(-9),
      {
        at: new Date().toISOString(),
        added,
        totalReturned: result.candidates.length,
        usage: result.usage,
      },
    ],
  });

  return {
    added,
    totalReturned: result.candidates.length,
    pendingTotal: merged.filter((c) => c.status === 'pending').length,
  };
}

// CLI test: node src/discover.js
if (process.argv[1]?.endsWith('discover.js')) {
  const result = await discoverSources();
  console.log('\n=== Summary ===');
  console.log(result.summary);
  console.log('\n=== Candidates ===');
  for (const c of result.candidates) {
    console.log(`\n[${c.kind}] ${c.name} (${c.confidence})`);
    console.log('  ' + JSON.stringify(c.config));
    console.log('  ' + c.rationale);
  }
  console.log(`\nUsage: ${result.usage.input_tokens} in, ${result.usage.output_tokens} out`);
}
