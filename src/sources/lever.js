// src/sources/lever.js
// Lever exposes a JSON API: https://api.lever.co/v0/postings/<company>?mode=json

import fetch from 'node-fetch';
import { createLogger } from '../log.js';

const log = createLogger('lever');

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(decodeEntities(html))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchLever(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) {
      log.warn({ slug, status: res.status }, 'fetch failed');
      return [];
    }
    const jobs = await res.json();
    return jobs.map((j) => ({
      source: `lever:${slug}`,
      company: slug,
      title: j.text,
      location: j.categories?.location || '',
      url: j.hostedUrl,
      description: stripHtml(
        (j.descriptionPlain || j.description || '') +
          ' ' +
          (j.lists || []).map((l) => `${l.text}: ${stripHtml(l.content)}`).join(' '),
      ),
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      externalId: j.id,
    }));
  } catch (err) {
    log.error({ err, slug }, 'fetch error');
    return [];
  }
}

export async function fetchAllLever() {
  const slugs = (process.env.LEVER_COMPANIES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const results = await Promise.all(slugs.map(fetchLever));
  return results.flat();
}
