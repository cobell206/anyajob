// src/notify.js
// Sends emails via AWS SES. Three notification types:
//   1. morning brief (daily)     — what the cron found, top scores, nudges
//   2. closing soon (daily noon) — saved roles closing within 3 days
//   3. weekly digest (Sundays)   — pattern review + LSAT countdown
//
// Each type can be turned off in preferences.json. Each tracks its own
// last-sent timestamps so re-runs of the cron don't double-send.

import 'dotenv/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './atomic.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTIFY_LOG = join(__dirname, '..', 'data', 'notifications.json');

const SES_REGION = process.env.AWS_REGION || 'us-east-1';
const FROM_ADDRESS = process.env.NOTIFY_FROM; // e.g. "AnyaJob <alerts@yourdomain.com>"

let sesClient = null;
function ses() {
  if (!sesClient) {
    sesClient = new SESClient({ region: SES_REGION });
  }
  return sesClient;
}

async function loadLog() {
  try {
    return JSON.parse(await readFile(NOTIFY_LOG, 'utf-8'));
  } catch {
    return { sent: [] };
  }
}

async function saveLog(log) {
  // Keep last 200 entries to avoid unbounded growth
  log.sent = log.sent.slice(-200);
  await writeJsonAtomic(NOTIFY_LOG, log);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function weekKey() {
  // ISO week-ish: year + week number
  const d = new Date();
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + yearStart.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${weekNum}`;
}

// ---------- Send ----------

// Resolve the notification recipient list from preferences. Backward-compatible
// with the old `notifications.recipient` (single string) field — if `to` is
// missing but `recipient` is present, it's used as a one-element list. Returns
// an array of trimmed, deduplicated, non-empty addresses (or [] if none set).
export function resolveRecipients(prefs) {
  const n = prefs?.notifications || {};
  const list = Array.isArray(n.to) && n.to.length
    ? n.to
    : (n.recipient ? [n.recipient] : []);
  const cleaned = list
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return [...new Set(cleaned)];
}

export async function sendEmail({ to, subject, html, text }) {
  if (!process.env.NOTIFY_FROM) {
    throw new Error('NOTIFY_FROM not set in .env (e.g., "AnyaJob <alerts@yourdomain.com>")');
  }
  const toList = Array.isArray(to) ? to : [to].filter(Boolean);
  if (toList.length === 0) throw new Error('No recipient');

  const command = new SendEmailCommand({
    Source: FROM_ADDRESS,
    Destination: { ToAddresses: toList },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: html, Charset: 'UTF-8' },
        Text: { Data: text || stripHtml(html), Charset: 'UTF-8' },
      },
    },
  });

  const result = await ses().send(command);
  return { messageId: result.MessageId };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Dedup helpers ----------

async function alreadySent(kind, key) {
  const log = await loadLog();
  return log.sent.some((e) => e.kind === kind && e.key === key);
}

async function recordSent(kind, key, subject, messageId) {
  const log = await loadLog();
  log.sent.push({
    kind, key, subject, messageId,
    sentAt: new Date().toISOString(),
  });
  await saveLog(log);
}

// ---------- Template builders (return {subject, html, text}) ----------

const baseStyle = `
  body { margin: 0; padding: 0; background: #f7faf9; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #0f1d2e; line-height: 1.5; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
  .mark { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #2563eb 0%, #059669 100%); color: white; font-weight: 700; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; }
  .name { font-family: Georgia, serif; font-weight: 600; font-size: 20px; letter-spacing: -0.02em; }
  .card { background: white; border: 1px solid #e3e8ec; border-radius: 14px; padding: 18px 20px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(15,29,46,0.06); }
  .brief { background: linear-gradient(135deg, #eff6ff 0%, #ecfdf5 100%); }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #1e40af; font-weight: 700; margin-bottom: 8px; }
  .copy { font-family: Georgia, serif; font-size: 16px; line-height: 1.55; color: #0f1d2e; }
  .nudge { margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(15,29,46,0.1); font-size: 14px; color: #3b4a5c; }
  h2 { font-family: Georgia, serif; font-weight: 600; font-size: 20px; letter-spacing: -0.02em; margin: 24px 0 8px; }
  .listing { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid #e3e8ec; }
  .listing:last-child { border-bottom: none; }
  .score { font-family: Georgia, serif; font-weight: 700; font-size: 22px; line-height: 1; min-width: 36px; }
  .score-high { color: #047857; } .score-mid { color: #1e40af; } .score-low { color: #6b7886; }
  .l-title { font-weight: 600; font-size: 14px; }
  .l-sub { font-size: 12px; color: #6b7886; margin-top: 2px; }
  .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; margin-left: 4px; }
  .badge-warn { color: #b45309; background: #fef3c7; }
  .cta { display: inline-block; background: #2563eb; color: white !important; text-decoration: none; padding: 10px 18px; border-radius: 10px; font-weight: 500; font-size: 14px; margin-top: 8px; }
  .footer { font-size: 11px; color: #9ba6b3; text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e3e8ec; }
  .footer a { color: #6b7886; text-decoration: underline; }
`;

function header() {
  return `
    <div class="brand">
      <span class="mark">L</span>
      <span class="name">AnyaJob</span>
    </div>
  `;
}

function footer() {
  const url = process.env.PUBLIC_URL || 'http://localhost:3000';
  return `
    <div class="footer">
      <a href="${url}">Open AnyaJob</a> · <a href="${url}/settings.html">Notification settings</a>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function scoreClass(n) { return n >= 8 ? 'score-high' : n >= 6 ? 'score-mid' : 'score-low'; }

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function listingRow(l, baseUrl) {
  const overall = l.score?.overallScore ?? 0;
  return `
    <div class="listing">
      <div class="score ${scoreClass(overall)}">${overall}</div>
      <div style="flex:1">
        <div class="l-title">${escapeHtml(l.title)}</div>
        <div class="l-sub">
          ${escapeHtml(l.company)}${l.location ? ' · ' + escapeHtml(l.location) : ''}
          ${l.closesDate ? ` · Closes ${fmtDate(l.closesDate)}` : ''}
        </div>
      </div>
    </div>
  `;
}

// Daily morning email — runs after the 6am scrape
// Includes a closing-soon section at top when applicable, then today's brief,
// then top roles. One email, urgency-ordered.
export function buildMorningEmail({ summary, topListings, nudge, date, closingListings = [], bookmarks = [], discoveryCount = 0, ignorePatterns = null }) {
  const url = process.env.PUBLIC_URL || 'http://localhost:3000';

  // Simple consistent subject — no urgency-based variations
  const subject = topListings.length
    ? `AnyaJob · ${topListings.length} new role${topListings.length === 1 ? '' : 's'} today`
    : `AnyaJob · daily brief · ${date}`;

  // Render closing-soon section (only if any)
  const closingHtml = closingListings.length ? `
    <div class="card">
      <div class="label" style="color:#b45309">⏰ Closing within 3 days</div>
      <div class="copy" style="margin-top:6px;font-size:14px">
        ${closingListings.length === 1
          ? 'One of your saved roles is closing soon.'
          : `${closingListings.length} of your saved roles are closing soon.`}
      </div>
      <div style="margin-top:10px">
        ${closingListings.map((l) => {
          const days = Math.max(0, Math.floor((new Date(l.closesDate) - Date.now()) / 86400000));
          const urgency = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
          return `
            <div class="listing">
              <div class="score ${scoreClass(l.score?.overallScore ?? 0)}">${l.score?.overallScore ?? 0}</div>
              <div style="flex:1">
                <div class="l-title">${escapeHtml(l.title)}</div>
                <div class="l-sub">
                  ${escapeHtml(l.company)} · Closes ${urgency}
                  <span class="badge badge-warn">${l.status || 'saved'}</span>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  ` : '';

  // Bookmarks: sites she added that aren't auto-scraped — gentle reminder to check
  const bookmarksHtml = bookmarks.length ? `
    <div class="card">
      <div class="label" style="color:#1e40af">🔖 Manual checks due</div>
      <div class="copy" style="margin-top:6px;font-size:14px">
        ${bookmarks.length === 1 ? 'One bookmark' : `${bookmarks.length} bookmarks`} due for a manual check.
      </div>
      <div style="margin-top:10px">
        ${bookmarks.map((b) => `
          <div class="listing">
            <div style="flex:1">
              <div class="l-title">
                <a href="${escapeHtml(b.url)}" style="color:#1e40af;text-decoration:none">${escapeHtml(b.name)} →</a>
              </div>
              <div class="l-sub">
                Every ${b.cadenceDays} day${b.cadenceDays === 1 ? '' : 's'}
                ${b.lastBriefedAt ? ` · last shown ${new Date(b.lastBriefedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  // Discovery: candidate sources Claude proposed for her review
  const discoveryHtml = discoveryCount > 0 ? `
    <div class="card" style="background:linear-gradient(135deg, #fdf4ff 0%, #fef3c7 100%); border-color: #fbcfe8;">
      <div class="label" style="color:#be185d">✨ New source candidates</div>
      <div class="copy" style="margin-top:6px;font-size:14px">
        Discovery found ${discoveryCount} candidate ${discoveryCount === 1 ? 'source' : 'sources'} matching your profile.
      </div>
      <a href="${url}/settings.html?from=email#section-sources" style="display:inline-block;margin-top:10px;color:#be185d;text-decoration:none;font-weight:500;font-size:13px">Review in settings →</a>
    </div>
  ` : '';

  // Patterns from her ignored listings — only when there's enough signal.
  // Helps her see her own preferences reflected back without judgment.
  const ignoreHtml = ignorePatterns && ignorePatterns.counts?.length ? `
    <div class="card">
      <div class="label" style="color:#6b7886">— What you've been skipping —</div>
      <div style="margin-top:10px;font-size:14px;color:#3b4a5c">
        ${ignorePatterns.counts.map((c) => `
          <div style="display:flex;justify-content:space-between;padding:4px 0">
            <span>${escapeHtml(c.label)}</span>
            <span style="color:#6b7886;font-variant-numeric:tabular-nums">${c.count}</span>
          </div>
        `).join('')}
      </div>
      ${ignorePatterns.otherNotes?.length ? `
        <div style="margin-top:12px;padding-top:10px;border-top:1px dashed rgba(15,29,46,0.1)">
          <div style="font-size:12px;color:#6b7886;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Other — your notes</div>
          <ul style="margin:0;padding-left:18px;font-size:13px;color:#3b4a5c">
            ${ignorePatterns.otherNotes.map((n) => `<li style="margin-bottom:4px">${escapeHtml(n)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
    </div>
  ` : '';

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>${baseStyle}</style></head><body><div class="wrap">
    ${header()}
    ${closingHtml}
    ${discoveryHtml}
    ${bookmarksHtml}
    <div class="card brief">
      <div class="label">Today's brief · ${date}</div>
      <div class="copy">${escapeHtml(summary)}</div>
      ${nudge ? `<div class="nudge">✦ ${escapeHtml(nudge)}</div>` : ''}
    </div>
    ${topListings.length ? `
      <h2>Top roles today</h2>
      <div class="card">
        ${topListings.slice(0, 5).map((l) => listingRow(l, url)).join('')}
      </div>
      <a class="cta" href="${url}">Open AnyaJob →</a>
    ` : '<p style="color:#6b7886;font-size:14px">No new roles today. The scraper runs again at 6am tomorrow.</p>'}
    ${ignoreHtml}
    ${footer()}
    </div></body></html>`;

  return { subject, html };
}

// Weekly Sunday digest
export function buildWeeklyEmail({ digest, weekRange, stats, closingThisWeek }) {
  const url = process.env.PUBLIC_URL || 'http://localhost:3000';
  const subject = `AnyaJob · weekly review · ${weekRange}`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>${baseStyle}</style></head><body><div class="wrap">
    ${header()}
    <div class="card">
      <div class="label">Weekly reflection · ${weekRange}</div>
      <div class="copy" style="margin-top:8px">${escapeHtml(digest)}</div>
    </div>
    <div class="card">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center">
        <div><div class="score score-mid" style="font-size:24px">${stats.scanned ?? 0}</div><div style="font-size:10px;color:#6b7886;text-transform:uppercase;letter-spacing:0.06em;margin-top:2px">Scanned</div></div>
        <div><div class="score score-mid" style="font-size:24px">${stats.saved ?? 0}</div><div style="font-size:10px;color:#6b7886;text-transform:uppercase;letter-spacing:0.06em;margin-top:2px">Saved</div></div>
        <div><div class="score score-high" style="font-size:24px">${stats.applied ?? 0}</div><div style="font-size:10px;color:#6b7886;text-transform:uppercase;letter-spacing:0.06em;margin-top:2px">Applied</div></div>
        <div><div class="score score-low" style="font-size:24px">$${(stats.spend ?? 0).toFixed(2)}</div><div style="font-size:10px;color:#6b7886;text-transform:uppercase;letter-spacing:0.06em;margin-top:2px">API spend</div></div>
      </div>
    </div>
    ${closingThisWeek?.length ? `
      <h2>Closing this week</h2>
      <div class="card">
        ${closingThisWeek.map((l) => listingRow(l, url)).join('')}
      </div>
    ` : ''}
    <a class="cta" href="${url}">Open AnyaJob →</a>
    ${footer()}
    </div></body></html>`;

  return { subject, html };
}

// ---------- High-level send functions (with dedup) ----------

export async function sendMorningEmail(payload, { to, dryRun = false }) {
  const key = `morning-${todayKey()}`;
  if (await alreadySent('morning', key)) return { skipped: 'already sent today' };

  const { subject, html } = buildMorningEmail(payload);
  if (dryRun) return { dryRun: true, subject, html };

  const result = await sendEmail({ to, subject, html });
  await recordSent('morning', key, subject, result.messageId);
  return result;
}

export async function sendWeeklyEmail(payload, { to, dryRun = false }) {
  const key = `weekly-${weekKey()}`;
  if (await alreadySent('weekly', key)) return { skipped: 'already sent this week' };

  const { subject, html } = buildWeeklyEmail(payload);
  if (dryRun) return { dryRun: true, subject, html };

  const result = await sendEmail({ to, subject, html });
  await recordSent('weekly', key, subject, result.messageId);
  return result;
}

// ---------- Template previews (for /notifications page) ----------
// Morning email with no closing-soon listings (nominal day)
export function previewMorning() {
  return buildMorningEmail({
    date: 'May 2',
    summary: "8 new roles today. Davis Polk's litigation paralegal program reopened — closes June 15, your top match. Cravath's corporate paralegal is also live. Two SDNY USAJobs postings worth a look; one closes Tuesday.",
    nudge: "You have 2 saved roles closing within 2 weeks and haven't applied to anything in 6 days. The Davis Polk slot tends to fill fast — worth drafting your cover letter today.",
    topListings: [
      { fingerprint: '1', title: 'Litigation Paralegal — 2 Year Program', company: 'Davis Polk & Wardwell', location: 'New York, NY', closesDate: '2026-06-15', score: { overallScore: 9 } },
      { fingerprint: '2', title: 'Corporate Paralegal', company: 'Cravath, Swaine & Moore', location: 'New York, NY', closesDate: '2026-07-01', score: { overallScore: 9 } },
      { fingerprint: '3', title: 'Legal Assistant', company: "U.S. Attorney's Office, SDNY", location: 'New York, NY', closesDate: '2026-05-20', score: { overallScore: 8 } },
    ],
    closingListings: [],
  });
}

// Morning email with closing-soon section (urgency state)
export function previewMorningUrgent() {
  return buildMorningEmail({
    date: 'May 2',
    summary: "8 new roles today. Davis Polk's litigation paralegal program reopened — closes June 15, your top match. Cravath's corporate paralegal is also live.",
    nudge: "Two of your saved roles close in the next 2 days. Worth setting aside an hour today.",
    topListings: [
      { fingerprint: '1', title: 'Litigation Paralegal — 2 Year Program', company: 'Davis Polk & Wardwell', location: 'New York, NY', closesDate: '2026-06-15', score: { overallScore: 9 } },
      { fingerprint: '2', title: 'Corporate Paralegal', company: 'Cravath, Swaine & Moore', location: 'New York, NY', closesDate: '2026-07-01', score: { overallScore: 9 } },
    ],
    closingListings: [
      { fingerprint: '3', title: 'Legal Assistant', company: "U.S. Attorney's Office, SDNY", closesDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), status: 'saved', score: { overallScore: 8 } },
      { fingerprint: '7', title: 'Paralegal', company: 'Skadden, Arps, Slate, Meagher & Flom', closesDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), status: 'saved', score: { overallScore: 7 } },
    ],
  });
}

export function previewWeekly() {
  return buildWeeklyEmail({
    weekRange: 'Apr 28 – May 4',
    digest: "This week you scanned 47 new roles, saved 6, and applied to 3. Your saving pattern leans heavily toward litigation at AmLaw 50 firms — you've skipped most corporate roles even when scored equally. 11 weeks until your LSAT; heavy-hours roles at Cravath/Skadden may conflict with peak prep weeks.",
    stats: { scanned: 47, saved: 6, applied: 3, spend: 1.84 },
    closingThisWeek: [
      { fingerprint: '1', title: 'Litigation Paralegal', company: 'Davis Polk', closesDate: '2026-05-06', score: { overallScore: 9 } },
      { fingerprint: '7', title: 'M&A Paralegal', company: 'Skadden', closesDate: '2026-05-08', score: { overallScore: 8 } },
    ],
  });
}
