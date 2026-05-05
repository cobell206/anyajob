// scripts/weekly.js
// Run via cron: 0 13 * * 0 (Sunday 9am ET)
// Sends weekly review email. Pulls the latest weekly reflection from
// summaries.json (regenerates if stale).

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sendWeeklyEmail } from '../src/notify.js';
import { generateWeeklyReflection } from '../src/summaries.js';
import { fbKey } from '../src/io.js';
import { createLogger } from '../src/log.js';

const log = createLogger('weekly-cron');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');

async function readJson(name) {
  try {
    return JSON.parse(await readFile(join(DATA, name), 'utf-8'));
  } catch {
    return null;
  }
}

function weekRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 6 * 86400000);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

async function main() {
  const prefs = await readJson('preferences.json');
  if (prefs.notifications?.weeklyEmail === false) {
    log.info('weekly emails disabled, exiting');
    return;
  }
  const { resolveRecipients } = await import('../src/notify.js');
  const recipients = resolveRecipients(prefs);
  if (recipients.length === 0) {
    log.info('no notification recipients in preferences.notifications.to, exiting');
    return;
  }

  // Generate or load the weekly reflection
  let weekly;
  const summaries = (await readJson('summaries.json')) || {};
  const today = new Date().toISOString().slice(0, 10);
  if (summaries.weekly && summaries.weekly.generatedAt?.startsWith(today)) {
    weekly = summaries.weekly;
  } else {
    log.info('generating fresh weekly reflection');
    weekly = await generateWeeklyReflection();
  }

  // Compute stats from the past 7 days
  const { listings } = (await readJson('listings.json')) || { listings: [] };
  const feedback = (await readJson('feedback.json')) || { ratings: {}, status: {}, appliedDate: {} };
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();

  const scanned = listings.filter((l) => (l.ingestedAt || '') >= cutoff).length;
  const saved = Object.entries(feedback.status).filter(([, s]) => s === 'saved').length;
  const applied = Object.values(feedback.appliedDate).filter(
    (d) => d && d >= cutoff.slice(0, 10),
  ).length;
  const spend = (await readJson('spend.json')) || { byDay: {} };
  const weekSpend = Object.entries(spend.byDay || {})
    .filter(([d]) => d >= cutoff.slice(0, 10))
    .reduce((sum, [, v]) => sum + v, 0);

  // Closing this week
  const now = Date.now();
  const weekEnd = now + 7 * 86400000;
  const closingThisWeek = listings
    .map((l) => ({
      ...l,
      status: feedback.status[fbKey(l)] || 'new',
      closesDate: feedback.closesDate[fbKey(l)] || l.score?.closesDate || null,
    }))
    .filter((l) => {
      if (!['saved', 'applied', 'interview'].includes(l.status)) return false;
      if (!l.closesDate) return false;
      const t = new Date(l.closesDate).getTime();
      return t >= now && t <= weekEnd;
    })
    .sort((a, b) => new Date(a.closesDate) - new Date(b.closesDate));

  const result = await sendWeeklyEmail(
    {
      weekRange: weekRange(),
      digest: weekly.text || weekly.summary || '',
      stats: { scanned, saved, applied, spend: weekSpend },
      closingThisWeek,
    },
    { to: recipients },
  );

  if (result.skipped) {
    log.info({ reason: result.skipped }, 'weekly email skipped');
  } else {
    log.info({ messageId: result.messageId }, 'weekly email sent');
  }
}

main().catch((err) => {
  log.fatal({ err }, 'weekly send failed');
  process.exit(1);
});
