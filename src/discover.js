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
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSources } from './sources/registry.js';
import { DISCOVERY_SYSTEM } from './prompts.js';
import { findOverlap, smartfetchSources } from './discover-overlap.js';
import { getProfileResumeText } from './documents.js';
import { writeJsonAtomic } from './atomic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREFS_PATH = join(__dirname, '..', 'data', 'preferences.json');
const DISCOVERIES_PATH = join(__dirname, '..', 'data', 'discoveries.json');

const MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Discovery prompt lives in src/prompts.js (DISCOVERY_SYSTEM)

export async function discoverSources({ maxCandidates = 12 } = {}) {
  const prefs = JSON.parse(await readFile(PREFS_PATH, 'utf-8'));
  const existing = await loadSources();
  const resumeText = await getProfileResumeText();

  // Build a compact list of what she's already tracking so Claude doesn't suggest dupes
  const existingList = existing.sources
    .filter((s) => s.enabled)
    .map((s) => {
      if (s.config?.slug) return `${s.kind}:${s.config.slug}`;
      if (s.config?.url) return `${s.kind}:${s.config.url}`;
      return `${s.kind}:${s.name}`;
    })
    .join('\n');

  const targetSchools = prefs.profile?.targetSchools || [];
  const resumeBlock = resumeText
    ? `\n\nHER RESUME (verbatim — use to anchor the search to her actual background and seniority, not just stated interests):\n${resumeText.slice(0, 4000)}`
    : '';

  const userMsg = `Find new sources for her search. Return up to ${maxCandidates} carefully-chosen candidates.

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
${(prefs.companies?.alwaysShow || []).join(', ')}${resumeBlock}

Use the web_search tool to find candidates. Prioritize sources that:
1. align with her stated interest areas and geography
2. are realistic targets given the experience visible in her resume
3. recruit candidates who go on to ${targetSchools.length ? targetSchools.join(' / ') : 'top law schools'} (career pipelines, fellowship feeders, employer-of-record patterns matter)

Return JSON only.`;

  const response = await client().messages.create({
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
      const overlap = findOverlap(c, sfSources);
      return overlap ? { ...c, overlapsWith: overlap } : c;
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
  try {
    return JSON.parse(await readFile(DISCOVERIES_PATH, 'utf-8'));
  } catch {
    return { candidates: [], lastRunAt: null, history: [] };
  }
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
