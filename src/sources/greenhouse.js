// src/sources/greenhouse.js
// Greenhouse exposes a public JSON API for every company's job board:
// https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true
// Major firms using Greenhouse: many BigLaw, fintech, public interest orgs.

import fetch from 'node-fetch';
import { createLogger } from '../log.js';

const log = createLogger('greenhouse');

// Greenhouse double-encodes HTML in its API content: literal '<' arrives as
// '&lt;' and '&nbsp;' as '&amp;nbsp;'. We must decode entities BEFORE stripping
// tags, and run two passes to unwind the double-encoding.
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

export async function fetchGreenhouse(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) {
      log.warn({ slug, status: res.status }, 'fetch failed');
      return [];
    }
    const data = await res.json();
    return (data.jobs || []).map((j) => ({
      source: `greenhouse:${slug}`,
      company: j.company_name || slug,
      title: j.title,
      location: j.location?.name || '',
      url: j.absolute_url,
      description: stripHtml(j.content || ''),
      postedAt: j.updated_at,
      externalId: String(j.id),
    }));
  } catch (err) {
    log.error({ err, slug }, 'fetch error');
    return [];
  }
}

export async function fetchAllGreenhouse() {
  const slugs = (process.env.GREENHOUSE_BOARDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const results = await Promise.all(slugs.map(fetchGreenhouse));
  return results.flat();
}
