// src/sources/registry.js
// Source registry. Three source types:
//
//   integration  - built-in API/scraper modules (Greenhouse, Lever, USAJobs,
//                  Idealist, NYC Bar, PSJD). User can add new INSTANCES via
//                  configuration (e.g. a new Greenhouse slug), but cannot
//                  delete the integration types themselves.
//
//   smartfetch   - generic URL + AI extraction via Claude. Works for many
//                  career pages but not 100% reliable; tracks last-extracted
//                  count so the UI can flag suspect drops.
//
//   bookmark     - URL she wants to remember but is not auto-scraped (e.g.
//                  the mayor's office careers page that loads via JS).
//                  Surfaces in the morning brief on the configured cadence.
//
// Sources persist in data/sources.json. On first run, the file is seeded
// from DEFAULT_SOURCES below. After that, the file is the source of truth.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../atomic.js';
import { readJson, exists } from '../io.js';
import { createLogger } from '../log.js';

const log = createLogger('sources');

import { fetchGreenhouse } from './greenhouse.js';
import { fetchLever } from './lever.js';
import { fetchUSAJobs } from './usajobs.js';
import { fetchIdealist } from './idealist.js';
import { fetchNYCBar } from './nycbar.js';
import { fetchPSJD } from './psjd.js';
import { fetchSmart } from './smartfetch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dirname, '..', '..', 'data', 'sources.json');

// ---------- Default sources seeded on first run ----------

// Seeded only on first run (when data/sources.json doesn't yet exist). After
// that the file is the user's source of truth — we never auto-add or auto-
// remove based on this list. Add via Discovery or the Settings UI.
//
// Removed from earlier defaults: BigLaw Greenhouse slugs (davispolk, cravath,
// sullcrom, paulweiss) — all 404, BigLaw uses Workday. And the HTML scrapers
// (idealist, nycbar, psjd) — TODO selectors, never worked. Replace via
// smartfetch on the actual URLs if you want them.
const DEFAULT_SOURCES = [
  // Federal legal/policy roles. Needs USAJOBS_API_KEY in .env to fetch.
  { id: 'usajobs-ny', kind: 'usajobs', name: 'USAJobs (NYC area)', config: {}, enabled: true, builtIn: true },

  // ACLU national office — verified Greenhouse customer, ~40 active roles
  // including paralegals on Immigrants' Rights and Voting Rights projects.
  { id: 'gh-aclu', kind: 'greenhouse', name: 'ACLU', config: { slug: 'aclu' }, enabled: true, builtIn: true },
];

// ---------- Storage ----------

export async function loadSources() {
  if (!(await exists(SOURCES_PATH))) {
    // First run only: seed from defaults. Never auto-backfill on subsequent
    // reads — once the file exists, the user owns it. Otherwise deletions
    // wouldn't stick across restarts.
    const seeded = { sources: DEFAULT_SOURCES };
    await writeJsonAtomic(SOURCES_PATH, seeded);
    return seeded;
  }
  return readJson(SOURCES_PATH);
}

export async function saveSources(data) {
  await writeJsonAtomic(SOURCES_PATH, data);
}

export async function addSource({ kind, name, config, enabled = true }) {
  const data = await loadSources();
  const source = {
    id: kind + '-' + randomUUID().slice(0, 8),
    kind,
    name: name || kind,
    config: config || {},
    enabled,
    builtIn: false,
    createdAt: new Date().toISOString(),
  };
  data.sources.push(source);
  await saveSources(data);
  return source;
}

export async function updateSource(id, patch) {
  const data = await loadSources();
  const idx = data.sources.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error('Source not found: ' + id);
  // Built-in sources can be enabled/disabled but their kind/config is mostly fixed
  // (we still let the user edit them — rope to hang yourself with — but flag in UI)
  data.sources[idx] = { ...data.sources[idx], ...patch, id, kind: data.sources[idx].kind };
  await saveSources(data);
  return data.sources[idx];
}

export async function deleteSource(id) {
  const data = await loadSources();
  const before = data.sources.length;
  data.sources = data.sources.filter((s) => s.id !== id);
  if (data.sources.length === before) return false;
  await saveSources(data);
  return true;
}

export async function recordRunStats(id, { count, error, lastRunAt }) {
  const data = await loadSources();
  const idx = data.sources.findIndex((s) => s.id === id);
  if (idx < 0) return;
  data.sources[idx].lastRunAt = lastRunAt || new Date().toISOString();
  if (typeof count === 'number') {
    data.sources[idx].lastCount = count;
    // Track recent counts so the UI can flag a sudden drop
    const history = data.sources[idx].recentCounts || [];
    history.push({ at: data.sources[idx].lastRunAt, count });
    data.sources[idx].recentCounts = history.slice(-10);
  }
  if (error) data.sources[idx].lastError = error;
  else delete data.sources[idx].lastError;
  await saveSources(data);
}

// ---------- Dispatch ----------

const DISPATCH = {
  greenhouse: (config) => fetchGreenhouse(config.slug),
  lever: (config) => fetchLever(config.slug),
  usajobs: () => fetchUSAJobs(),
  idealist: () => fetchIdealist(),
  nycbar: () => fetchNYCBar(),
  psjd: () => fetchPSJD(),
  smartfetch: (config, source) => fetchSmart(config.url, { name: source.name }),
  // bookmarks don't fetch — they're surfaced separately in the daily brief
  bookmark: async () => [],
};

// Run a single source. Used by both the daily cron and the "Test" button in
// the source settings UI.
export async function runOne(source) {
  if (!source.enabled) {
    return { id: source.id, name: source.name, listings: [], skipped: 'disabled' };
  }
  if (source.kind === 'bookmark') {
    return { id: source.id, name: source.name, listings: [], skipped: 'bookmark' };
  }
  const fn = DISPATCH[source.kind];
  if (!fn) {
    return { id: source.id, name: source.name, listings: [], error: 'Unknown source kind: ' + source.kind };
  }
  const start = Date.now();
  try {
    const listings = await fn(source.config || {}, source);
    // Annotate with the source's display name + id so we can show provenance
    for (const l of listings) {
      l.sourceId = source.id;
      l.sourceName = source.name;
    }
    await recordRunStats(source.id, { count: listings.length });
    return {
      id: source.id, name: source.name,
      listings,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    await recordRunStats(source.id, { error: err.message });
    return {
      id: source.id, name: source.name, listings: [],
      error: err.message,
      durationMs: Date.now() - start,
    };
  }
}

// Run all enabled sources. Non-smartfetch sources run in parallel (they hit
// external APIs, not Claude). Smartfetch sources are serialized to stay under
// Anthropic's 50k input-tokens/min rate limit — each call ships ~10–30k tokens
// of cleaned HTML, so parallel fan-out reliably triggers 429s.
export async function fetchAll() {
  const data = await loadSources();
  const enabled = data.sources.filter((s) => s.enabled && s.kind !== 'bookmark');

  const fast = enabled.filter((s) => s.kind !== 'smartfetch');
  const smart = enabled.filter((s) => s.kind === 'smartfetch');

  // Run integrations in parallel
  const fastResults = await Promise.allSettled(fast.map(runOne));

  // Run smartfetch sources one at a time
  const smartResults = [];
  for (const source of smart) {
    smartResults.push(await runOne(source).then(
      (v) => ({ status: 'fulfilled', value: v }),
      (e) => ({ status: 'rejected', reason: e }),
    ));
  }

  const all = [];
  for (const r of [...fastResults, ...smartResults]) {
    if (r.status !== 'fulfilled') continue;
    const { id, name, listings, error, durationMs, skipped } = r.value;
    if (skipped) {
      log.info({ name, reason: skipped }, 'source skipped');
    } else if (error) {
      log.warn({ name, error }, 'source error');
    } else {
      log.info({ name, count: listings.length, durationMs }, 'source complete');
    }
    all.push(...listings);
  }
  return all;
}

// Get bookmarks that should appear in the morning brief.
// A bookmark "is due" if (now - lastBriefedAt) >= cadenceDays * 86400000.
export async function getDueBookmarks() {
  const data = await loadSources();
  const now = Date.now();
  return data.sources.filter((s) => {
    if (!s.enabled || s.kind !== 'bookmark') return false;
    const cadence = (s.config?.cadenceDays || 7) * 86400000;
    const last = s.lastBriefedAt ? new Date(s.lastBriefedAt).getTime() : 0;
    return now - last >= cadence;
  });
}

export async function markBookmarkBriefed(id) {
  const data = await loadSources();
  const s = data.sources.find((x) => x.id === id);
  if (!s) return;
  s.lastBriefedAt = new Date().toISOString();
  await saveSources(data);
}
