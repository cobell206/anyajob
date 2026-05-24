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
import { readJson, fbKey } from '../io.js';
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
  const [{ listings = [] } = {}, feedback = {}] = await Promise.all([
    readJson('listings.json').catch(() => ({ listings: [] })),
    readJson('feedback.json').catch(() => ({})),
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

  // Summaries: best-effort. Missing file → null and front-end skips the brief.
  let summaries = null;
  try {
    summaries = JSON.parse(await readFile(SUMMARIES_PATH, 'utf-8'));
  } catch { /* leave null */ }

  return {
    listings: { count: hydrated.length, listings: hydrated },
    stats: {
      total: listings.length - counts.rejected,
      byStatus: counts,
      appliedThisWeek,
    },
    summaries,
  };
}

// JSON-safe inline: escape </ so a stray "</script>" in any string field
// can't terminate our <script> tag prematurely.
function safeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

// Every page route runs through the same pipeline: read the HTML off
// disk, substitute the nav, and (for / only) inject window.__INITIAL.
// The data-file read for / is the only handler that can fail in
// expected ways — all the others just touch the public/ HTML.
const PAGES = [
  { path: '/',                   file: 'index.html'         },
  { path: '/profile.html',       file: 'profile.html'       },
  { path: '/paste.html',         file: 'paste.html'         },
  { path: '/notifications.html', file: 'notifications.html' },
  { path: '/settings.html',      file: 'settings.html'      },
  { path: '/ignored.html',       file: 'ignored.html'       },
];

for (const page of PAGES) {
  router.get(page.path, async (req, res, next) => {
    try {
      let html = await readFile(join(PUBLIC_DIR, page.file), 'utf-8');
      html = applyNav(html, page.path);
      if (page.path === '/') {
        const initial = await computeInitialData();
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
