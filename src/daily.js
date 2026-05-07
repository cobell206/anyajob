// src/daily.js
// Run via cron: 0 6 * * * cd /path/to/job-tracker && npm run daily
// Pipeline: fetch → dedupe → pre-filter → score → save → generate summaries.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './atomic.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchAll } from './sources/index.js';
import { dedupeListings, saveSeen } from './dedupe.js';
import { scoreOne, loadRecentFeedback, buildIgnoreContext } from './score.js';
import { generateDailyBrief, generateWeeklyReflection } from './summaries.js';
import { getProfileResumeText } from './documents.js';
import { fbKey } from './io.js';
import { createLogger } from './log.js';

const log = createLogger('daily');

const __dirname = dirname(fileURLToPath(import.meta.url));
const LISTINGS_PATH = join(__dirname, '..', 'data', 'listings.json');
const PREFS_PATH = join(__dirname, '..', 'data', 'preferences.json');

// Map raw reason codes (see VALID_REJECT_REASONS in routes/feedback.js) to
// human-readable labels for the email. Unknown codes fall through unchanged
// so new categories show up rather than vanish.
const REASON_LABELS = {
  salary: 'Salary too low',
  'not-a-fit': 'Not a fit',
  location: 'Location',
  'wrong-location': 'Wrong location',
  'too-senior': 'Too senior',
  'too-junior': 'Too junior',
  'wrong-seniority': 'Wrong seniority',
  'not-interested': 'Not interested',
  'already-applied': 'Already applied',
  other: 'Other',
};

function labelForReason(code) {
  return REASON_LABELS[code] || code;
}

// Build the payload the email needs from the rejectReasons map. Returns null
// when fewer than 3 ignored listings — too little data to surface a pattern.
// Returns { counts: [{label, code, count}], otherNotes: [string], total }.
function summarizeIgnorePatterns(rejectReasons) {
  const entries = Object.values(rejectReasons || {});
  if (entries.length < 3) return null;

  const counts = {};
  const otherNotes = [];
  for (const r of entries) {
    if (!r || !r.reason) continue;
    counts[r.reason] = (counts[r.reason] || 0) + 1;
    if (r.reason === 'other' && r.note) otherNotes.push(r.note);
  }
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, label: labelForReason(code), count }));
  return { counts: sorted, otherNotes, total: entries.length };
}

function applyPreFilters(listings, prefs) {
  const exclude = (prefs.keywords?.exclude || []).map((k) => k.toLowerCase());
  const neverShow = (prefs.companies?.neverShow || []).map((c) => c.toLowerCase());

  return listings.filter((l) => {
    const haystack = `${l.title} ${l.company} ${l.description}`.toLowerCase();
    if (exclude.some((kw) => haystack.includes(kw))) return false;
    if (neverShow.some((c) => l.company.toLowerCase().includes(c))) return false;
    return true;
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  log.info({ startedAt }, 'daily run starting');

  const prefs = JSON.parse(await readFile(PREFS_PATH, 'utf-8'));
  const existing = JSON.parse(await readFile(LISTINGS_PATH, 'utf-8'));

  // 1. Fetch
  log.info('fetching from all sources');
  const raw = await fetchAll();
  log.info({ count: raw.length }, 'fetched raw listings');

  // 2. Dedupe
  const { fresh, seen } = await dedupeListings(raw);
  log.info({ count: fresh.length }, 'after dedupe');

  // 3. Pre-filter
  const filtered = applyPreFilters(fresh, prefs);
  log.info({ count: filtered.length }, 'after pre-filters');

  // 4. Load examples + resume (resume is loaded once and reused across all
  // listings in this run — the prompt-cached system block makes this cheap)
  const examples = await loadRecentFeedback(6);
  if (examples.length > 0) {
    log.info({ count: examples.length }, 'using feedback examples for calibration');
  }
  const resumeText = await getProfileResumeText();
  if (resumeText) {
    log.info({ chars: resumeText.length }, 'using profile resume for scoring context');
  }
  const ignoreContext = await buildIgnoreContext();
  if (ignoreContext) {
    log.info({ patterns: ignoreContext }, 'using ignore patterns for scoring calibration');
  }

  // 5. Score
  const scored = [];
  let totalCost = 0;
  for (const listing of filtered) {
    try {
      const score = await scoreOne(listing, prefs, examples, resumeText, ignoreContext);
      totalCost += score._cost || 0;
      scored.push({ ...listing, score, ingestedAt: startedAt });
    } catch (err) {
      log.error({ err, company: listing.company, title: listing.title }, 'failed to score listing');
      if (err.message.includes('cap reached')) {
        log.error('STOPPING: daily spend cap hit');
        break;
      }
    }
  }
  log.info({ count: scored.length, cost: totalCost.toFixed(4) }, 'scoring complete');

  // 6. Persist
  existing.listings.push(...scored);
  await writeJsonAtomic(LISTINGS_PATH, existing);
  await saveSeen(seen);

  // 7. Generate daily brief
  log.info('generating daily brief');
  let briefData = null;
  try {
    briefData = await generateDailyBrief();
    log.info({ text: briefData.text }, 'brief generated');
  } catch (err) {
    log.error({ err }, 'daily brief failed');
  }

  // 7b. Send morning email if enabled
  if (briefData && prefs.notifications?.morningEmail !== false) {
    const { sendMorningEmail, resolveRecipients } = await import('./notify.js');
    const recipients = resolveRecipients(prefs);
    if (recipients.length === 0) {
      log.info('morning email skipped: no recipients in preferences.notifications.to');
    } else {
      log.info({ recipientCount: recipients.length }, 'sending morning email');
      try {
        const top = existing.listings
          .filter((l) => (l.ingestedAt || '').startsWith(startedAt.slice(0, 10)))
          .sort((a, b) => (b.score?.overallScore || 0) - (a.score?.overallScore || 0))
          .slice(0, 5);

        // Scan for saved/applied/interview-status listings closing within 3 days
        const feedback = JSON.parse(await readFile(join(__dirname, '..', 'data', 'feedback.json'), 'utf-8'));
        const now = Date.now();
        const cutoff = now + 3 * 86400000;
        const TRACKED = new Set(['saved', 'applied', 'interview', 'new']);
        const closingListings = existing.listings
          .map((l) => ({
            ...l,
            status: feedback.status?.[fbKey(l)] || 'new',
            closesDate: feedback.closesDate?.[fbKey(l)] || l.score?.closesDate || null,
          }))
          .filter((l) => {
            if (!TRACKED.has(l.status)) return false;
            if (!l.closesDate) return false;
            const t = new Date(l.closesDate).getTime();
            return !isNaN(t) && t <= cutoff && t >= now - 86400000;
          })
          .sort((a, b) => new Date(a.closesDate) - new Date(b.closesDate));

        if (closingListings.length) {
          log.info({ count: closingListings.length }, 'including closing-soon listings at top');
        }

        // Bookmarks due for a manual check
        const { getDueBookmarks, markBookmarkBriefed } = await import('./sources/registry.js');
        const dueBookmarks = await getDueBookmarks();
        if (dueBookmarks.length) {
          log.info({ count: dueBookmarks.length }, 'including bookmarks due for manual check');
        }

        // Aggregate ignore patterns from rejectReasons. Only surface when
        // there's enough signal (3+ ignored listings) so we don't draw
        // conclusions from a handful of skips.
        const ignorePatterns = summarizeIgnorePatterns(feedback.rejectReasons || {});

        // Pending discovery candidates — surface count, link to settings
        let discoveryCount = 0;
        try {
          const discPath = join(__dirname, '..', 'data', 'discoveries.json');
          const disc = JSON.parse(await readFile(discPath, 'utf-8'));
          discoveryCount = (disc.candidates || []).filter((c) => c.status === 'pending').length;
          if (discoveryCount) log.info({ count: discoveryCount }, 'pending discovery candidates');
        } catch {
          // No discoveries file yet; skip silently
        }

        const result = await sendMorningEmail({
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          summary: briefData.text || briefData.summary || '',
          nudge: briefData.nudge || null,
          topListings: top,
          closingListings,
          bookmarks: dueBookmarks.map((b) => ({
            name: b.name,
            url: b.config?.url,
            cadenceDays: b.config?.cadenceDays || 7,
            lastBriefedAt: b.lastBriefedAt,
          })),
          discoveryCount,
          ignorePatterns,
        }, { to: recipients });
        if (result.skipped) {
          log.info({ reason: result.skipped }, 'morning email skipped');
        } else {
          log.info({ messageId: result.messageId }, 'morning email sent');
        }

        // Mark bookmarks as briefed so they don't fire again until the cadence elapses
        if (!result.skipped) {
          for (const b of dueBookmarks) await markBookmarkBriefed(b.id);
        }
      } catch (err) {
        log.error({ err }, 'morning email failed');
      }
    }
  }

  // 8. Generate weekly reflection on Sundays (UTC day 0)
  const isSunday = new Date().getUTCDay() === 0;
  if (isSunday) {
    log.info('generating weekly reflection (Sunday)');
    try {
      await generateWeeklyReflection();
      log.info('weekly reflection generated');
    } catch (err) {
      log.error({ err }, 'weekly reflection failed');
    }
  }

  // Summary log
  const top = scored
    .filter((l) => l.score.overallScore >= 7)
    .sort((a, b) => b.score.overallScore - a.score.overallScore)
    .slice(0, 5);
  log.info(
    { topListings: top.map((l) => ({ score: l.score.overallScore, company: l.company, title: l.title })) },
    `top ${top.length} listings today`,
  );
  log.info({ finishedAt: new Date().toISOString() }, 'daily run done');
}

main().catch((err) => {
  log.fatal({ err }, 'daily run failed');
  process.exit(1);
});
