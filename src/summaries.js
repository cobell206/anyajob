// src/summaries.js
// Generates the daily brief and weekly reflection using Claude Haiku.
// Daily brief: ~$0.001 per run, generated each morning by the cron.
// Weekly reflection: ~$0.003 per run, generated Sunday mornings.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './atomic.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DAILY_BRIEF_SYSTEM,
  buildDailyBriefUser,
  WEEKLY_REFLECTION_SYSTEM,
  buildWeeklyReflectionUser,
} from './prompts.js';
import { fbKey } from './io.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUMMARIES_PATH = join(__dirname, '..', 'data', 'summaries.json');
const LISTINGS_PATH = join(__dirname, '..', 'data', 'listings.json');
const FEEDBACK_PATH = join(__dirname, '..', 'data', 'feedback.json');
const PREFS_PATH = join(__dirname, '..', 'data', 'preferences.json');
const SPEND_PATH = join(__dirname, '..', 'data', 'spend.json');

const MODEL = 'claude-haiku-4-5-20251001';
const PRICING = {
  input: 1.0 / 1_000_000,
  output: 5.0 / 1_000_000,
};

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

async function loadSummaries() {
  try {
    return JSON.parse(await readFile(SUMMARIES_PATH, 'utf-8'));
  } catch {
    return { daily: {}, weekly: {} };
  }
}

async function saveSummaries(s) {
  await writeJsonAtomic(SUMMARIES_PATH, s);
}

async function trackSpend(usage) {
  const cost = (usage.input_tokens || 0) * PRICING.input +
               (usage.output_tokens || 0) * PRICING.output;
  let spend;
  try {
    spend = JSON.parse(await readFile(SPEND_PATH, 'utf-8'));
  } catch {
    spend = { byDay: {} };
  }
  spend.byDay[today()] = (spend.byDay[today()] || 0) + cost;
  await writeJsonAtomic(SPEND_PATH, spend);
  return cost;
}

// =====================================================================
// DAILY BRIEF
// =====================================================================
// One short paragraph (2-3 sentences, ~280 char target) summarizing today's
// new listings. Surfaces top opportunity, closing-soon urgency, and any
// notable pattern in one breath. Prompt lives in src/prompts.js.

export async function generateDailyBrief() {
  const { listings } = JSON.parse(await readFile(LISTINGS_PATH, 'utf-8'));
  const feedback = JSON.parse(await readFile(FEEDBACK_PATH, 'utf-8'));
  const prefs = JSON.parse(await readFile(PREFS_PATH, 'utf-8'));

  const td = today();
  const newToday = listings.filter((l) => (l.ingestedAt || '').startsWith(td));

  // Top 5 new listings by score
  const topNew = newToday
    .slice()
    .sort((a, b) => (b.score?.overallScore || 0) - (a.score?.overallScore || 0))
    .slice(0, 5)
    .map((l) => ({
      title: l.title,
      company: l.company,
      score: l.score?.overallScore,
      closes: feedback.closesDate[fbKey(l)] || l.score?.closesDate,
      salaryMax: l.score?.salaryMax,
    }));

  // Saved listings closing within 7 days
  const sevenDays = isoDaysAgo(-7);
  const closingSoon = listings
    .filter((l) => {
      const status = feedback.status[fbKey(l)];
      const closes = feedback.closesDate[fbKey(l)] || l.score?.closesDate;
      if (!closes) return false;
      if (!['saved', 'applied'].includes(status)) return false;
      return closes >= td && closes <= sevenDays;
    })
    .map((l) => ({
      title: l.title,
      company: l.company,
      closes: feedback.closesDate[fbKey(l)] || l.score?.closesDate,
      status: feedback.status[fbKey(l)],
    }));

  const context = {
    date: td,
    newCount: newToday.length,
    topNew,
    closingSoon,
    profile: {
      name: prefs.profile?.name,
      lsatStatus: prefs.profile?.lsatStatus,
      interests: prefs.profile?.interestAreas,
    },
  };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: DAILY_BRIEF_SYSTEM,
    messages: [{ role: 'user', content: buildDailyBriefUser(context) }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim()
    .replace(/^["']|["']$/g, '');

  await trackSpend(response.usage);

  const summaries = await loadSummaries();
  summaries.daily[td] = {
    text,
    generatedAt: new Date().toISOString(),
    newCount: newToday.length,
    topNewCount: topNew.length,
    closingSoonCount: closingSoon.length,
  };
  await saveSummaries(summaries);

  return summaries.daily[td];
}

// =====================================================================
// WEEKLY REFLECTION
// =====================================================================
// Sunday-morning reflection on the past 7 days. Prompt lives in src/prompts.js.

export async function generateWeeklyReflection() {
  const { listings } = JSON.parse(await readFile(LISTINGS_PATH, 'utf-8'));
  const feedback = JSON.parse(await readFile(FEEDBACK_PATH, 'utf-8'));
  const prefs = JSON.parse(await readFile(PREFS_PATH, 'utf-8'));

  const weekAgo = isoDaysAgo(7);

  const thisWeek = listings.filter((l) => (l.ingestedAt || '') >= weekAgo);

  const ratedThisWeek = Object.entries(feedback.ratings || {})
    .map(([fp, r]) => ({ fp, rating: r, listing: listings.find((l) => fbKey(l) === fp) }))
    .filter((x) => x.listing);

  const appliedThisWeek = Object.entries(feedback.appliedDate || {})
    .filter(([, d]) => d >= weekAgo)
    .map(([fp, d]) => ({ fp, date: d, listing: listings.find((l) => fbKey(l) === fp) }))
    .filter((x) => x.listing);

  const statusCounts = { new: 0, saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 };
  for (const l of listings) {
    const s = feedback.status[fbKey(l)] || 'new';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  // Saved listings closing in next 7 days
  const today_ = today();
  const sevenAhead = isoDaysAgo(-7);
  const closingNext = listings
    .filter((l) => {
      const status = feedback.status[fbKey(l)];
      const closes = feedback.closesDate[fbKey(l)] || l.score?.closesDate;
      return closes && closes >= today_ && closes <= sevenAhead && ['saved', 'applied'].includes(status);
    })
    .map((l) => ({ company: l.company, title: l.title, closes: l.score?.closesDate }));

  const context = {
    weekRange: `${weekAgo} to ${today_}`,
    newListings: thisWeek.length,
    avgScore: thisWeek.length
      ? +(thisWeek.reduce((s, l) => s + (l.score?.overallScore || 0), 0) / thisWeek.length).toFixed(1)
      : 0,
    likedThisWeek: ratedThisWeek.filter((x) => x.rating === 'up').map((x) => ({
      company: x.listing.company,
      title: x.listing.title,
    })),
    dislikedThisWeek: ratedThisWeek.filter((x) => x.rating === 'down').map((x) => ({
      company: x.listing.company,
      title: x.listing.title,
    })),
    appliedThisWeek: appliedThisWeek.map((x) => ({
      company: x.listing.company,
      title: x.listing.title,
      date: x.date,
    })),
    statusPipeline: statusCounts,
    closingNext7Days: closingNext,
    profile: {
      name: prefs.profile?.name,
      lsatStatus: prefs.profile?.lsatStatus,
      interests: prefs.profile?.interestAreas,
    },
  };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: WEEKLY_REFLECTION_SYSTEM,
    messages: [{ role: 'user', content: buildWeeklyReflectionUser(context) }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  await trackSpend(response.usage);

  const summaries = await loadSummaries();
  summaries.weekly[today_] = {
    text,
    generatedAt: new Date().toISOString(),
    weekRange: context.weekRange,
    stats: {
      newListings: thisWeek.length,
      applied: appliedThisWeek.length,
      liked: context.likedThisWeek.length,
    },
  };
  await saveSummaries(summaries);

  return summaries.weekly[today_];
}

export async function getCurrentSummaries() {
  const summaries = await loadSummaries();
  const td = today();
  // Find most recent daily within last 2 days (so morning before cron still shows yesterday's)
  const dailyDates = Object.keys(summaries.daily).sort().reverse();
  const recentDaily = dailyDates.find((d) => d >= isoDaysAgo(2));
  // Most recent weekly within last 7 days
  const weeklyDates = Object.keys(summaries.weekly).sort().reverse();
  const recentWeekly = weeklyDates.find((d) => d >= isoDaysAgo(7));
  return {
    daily: recentDaily ? { date: recentDaily, ...summaries.daily[recentDaily] } : null,
    weekly: recentWeekly ? { date: recentWeekly, ...summaries.weekly[recentWeekly] } : null,
  };
}

// CLI: generate today's summaries on demand
if (process.argv.includes('--daily')) {
  console.log(await generateDailyBrief());
}
if (process.argv.includes('--weekly')) {
  console.log(await generateWeeklyReflection());
}
