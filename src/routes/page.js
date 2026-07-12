// src/routes/page.js
// Serves every HTML page: substitutes the shared nav (see src/nav.js)
// into <!-- nav:header --> and <!-- nav:tab-bar --> markers, and for
// GET / also inlines initial data as window.__INITIAL so the boot
// script can render synchronously without a fetch round-trip.
//
// Mounted BEFORE express.static in src/server.js so it intercepts page
// requests; assets and /api/* fall through to static / API handlers
// untouched. If any handler throws (missing file, read error), it calls
// next() and express.static serves the raw HTML — the front-end is
// resilient to the nav markers staying un-substituted (they're HTML
// comments) and to a missing window.__INITIAL (a fetch fires anyway).

import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readJson, readJsonSafe, fbKey } from '../io.js';
import { createLogger } from '../log.js';
import { applyNav } from '../nav.js';

const router = Router();
const log = createLogger('page');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'public');
const SUMMARIES_PATH = join(__dirname, '..', '..', 'data', 'summaries.json');

// Mirror of the hydrate helper in routes/listings.js. Kept local rather
// than exported-and-shared to avoid coupling the page handler to the
// API route module (per scope discipline: small duplication beats a
// premature abstraction). If the shape drifts, the front-end will fall
// back to its own /api/listings fetch on next interaction anyway.
function hydrate(listing, feedback) {
  const key = listing.dedupKey || listing.fingerprint;
  const reject = feedback.rejectReasons?.[key];
  return {
    ...listing,
    rating: feedback.ratings?.[key] || null,
    note: feedback.notes?.[key] || '',
    status: feedback.status?.[key] || 'new',
    appliedDate: feedback.appliedDate?.[key] || null,
    closesDate: feedback.closesDate?.[key] || listing.score?.closesDate || null,
    rejectReason: reject?.reason || null,
    rejectNote: reject?.note || null,
    rejectAt: reject?.at || null,
  };
}

async function computeInitialData() {
  // All four data files are read concurrently — none depends on another, and
  // on Lambda each is a separate S3 GET, so serializing them would stack the
  // round-trips onto the HTML's critical path. summaries uses readJsonSafe
  // (missing file → null and the front-end skips the brief).
  const [{ listings = [] } = {}, feedback = {}, discoveries = {}, summaries] = await Promise.all([
    readJson('listings.json').catch(() => ({ listings: [] })),
    readJson('feedback.json').catch(() => ({})),
    // Best-effort: missing file → empty object → 0 pending, pill stays hidden.
    readJson('discoveries.json').catch(() => ({})),
    readJsonSafe(SUMMARIES_PATH, { fallback: null }),
  ]);

  // 60-day window matches what index.html requests via /api/listings?days=60.
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  const hydrated = listings
    .filter((l) => (l.ingestedAt || '') >= cutoff)
    .map((l) => hydrate(l, feedback))
    .sort((a, b) => (b.score?.overallScore || 0) - (a.score?.overallScore || 0));

  // Stats: matches /api/stats. Rejected is excluded from total but counted in
  // byStatus so the header's ignored-link can show its count.
  const counts = { new: 0, saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
  for (const l of listings) {
    const s = feedback.status?.[fbKey(l)] || 'new';
    counts[s] = (counts[s] || 0) + 1;
  }
  const weekCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let appliedThisWeek = 0;
  for (const l of listings) {
    if ((feedback.status?.[fbKey(l)] || 'new') === 'rejected') continue;
    const d = feedback.appliedDate?.[fbKey(l)];
    if (d && d >= weekCutoff) appliedThisWeek++;
  }

  // Pending source candidates: just the count + the run's summary copy so the
  // roles page can paint the pending-review pill without an extra fetch. The
  // full candidate list is fetched on demand when she opens the modal.
  const pendingCount = (discoveries.candidates || []).filter((c) => c.status === 'pending').length;

  return {
    listings: { count: hydrated.length, listings: hydrated },
    stats: {
      total: listings.length - counts.rejected,
      byStatus: counts,
      appliedThisWeek,
    },
    summaries,
    discoveries: {
      pendingCount,
      lastSummary: discoveries.lastSummary || null,
    },
  };
}

// Ignored-page fast path: matches /api/listings/ignored so the front-end can
// render synchronously instead of flashing "Loading…" on first paint.
async function computeIgnoredInitial() {
  const [{ listings = [] } = {}, feedback = {}] = await Promise.all([
    readJson('listings.json').catch(() => ({ listings: [] })),
    readJson('feedback.json').catch(() => ({})),
  ]);

  const out = listings
    .map((l) => hydrate(l, feedback))
    .filter((l) => l.status === 'rejected');

  out.sort((a, b) => {
    const at = a.rejectAt || a.ingestedAt || '';
    const bt = b.rejectAt || b.ingestedAt || '';
    return bt.localeCompare(at);
  });

  return { listings: { count: out.length, listings: out } };
}

// JSON-safe inline: escape </ so a stray "</script>" in any string field
// can't terminate our <script> tag prematurely.
function safeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

// Every page route runs through the same pipeline: read the HTML off
// disk, substitute the nav, and (when initial is defined) inject
// window.__INITIAL so the front-end can render before any fetch fires.
// The data-file reads in initial() are the only handlers that can fail
// in expected ways — pages without an initial just touch the public/ HTML.
// Notifications was consolidated into a Settings accordion (commit 407ef65)
// — public/notifications.html is gone, the page is no longer served.
const PAGES = [
  { path: '/',              file: 'index.html',    initial: computeInitialData    },
  { path: '/profile.html',  file: 'profile.html'                                  },
  { path: '/settings.html', file: 'settings.html'                                 },
  { path: '/ignored.html',  file: 'ignored.html',  initial: computeIgnoredInitial },
];

for (const page of PAGES) {
  router.get(page.path, async (req, res, next) => {
    try {
      let html = await readFile(join(PUBLIC_DIR, page.file), 'utf-8');
      html = applyNav(html, page.path);
      if (page.initial) {
        const initial = await page.initial();
        html = html.replace(
          '</body>',
          `<script>window.__INITIAL=${safeJsonForScript(initial)};</script>\n</body>`,
        );
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      log.warn({ err, path: page.path }, 'page render failed; falling through to static');
      next();
    }
  });
}

export default router;
