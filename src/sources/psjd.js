// src/sources/psjd.js
// PSJD — Public Service Jobs Directory. NALP's flagship public interest board.
// SCAFFOLD: requires login for full search. Public listings are scrapeable.
// URL: https://www.psjd.org/Job_Board

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createLogger } from '../log.js';

const log = createLogger('psjd');

const SEARCH_URL = 'https://www.psjd.org/Job_Board?Location=New+York';

const SELECTORS = {
  // TODO: inspect live HTML and update
  card: '.job-result',
  title: '.job-title a',
  company: '.organization',
  location: '.location',
  url: '.job-title a',
};

export async function fetchPSJD() {
  try {
    const res = await fetch(SEARCH_URL, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobTracker/0.1)' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const out = [];
    $(SELECTORS.card).each((_, el) => {
      const $el = $(el);
      const href = $el.find(SELECTORS.url).attr('href') || '';
      out.push({
        source: 'psjd',
        company: $el.find(SELECTORS.company).text().trim(),
        title: $el.find(SELECTORS.title).text().trim(),
        location: $el.find(SELECTORS.location).text().trim() || 'New York, NY',
        url: href.startsWith('http') ? href : `https://www.psjd.org${href}`,
        description: '', // PSJD requires clicking through; description fetched on demand
        postedAt: null,
      });
    });
    return out.filter((l) => l.title && l.company);
  } catch (err) {
    log.error({ err }, 'fetch error');
    return [];
  }
}
