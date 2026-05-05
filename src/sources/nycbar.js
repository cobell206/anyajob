// src/sources/nycbar.js
// NYC Bar Career Center — high-quality NYC legal listings.
// SCAFFOLD: same TODO pattern as idealist.js. URL is roughly:
// https://careers.nycbar.org/jobs/

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createLogger } from '../log.js';

const log = createLogger('nycbar');

const SEARCH_URL = 'https://careers.nycbar.org/jobs/';

const SELECTORS = {
  // TODO: inspect live HTML and update
  card: '.job-listing',
  title: '.job-title',
  company: '.company-name',
  location: '.job-location',
  url: 'a',
  description: '.job-description',
};

export async function fetchNYCBar() {
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
      out.push({
        source: 'nycbar',
        company: $el.find(SELECTORS.company).text().trim(),
        title: $el.find(SELECTORS.title).text().trim(),
        location: $el.find(SELECTORS.location).text().trim() || 'New York, NY',
        url: $el.find(SELECTORS.url).attr('href'),
        description: $el.find(SELECTORS.description).text().trim(),
        postedAt: null,
      });
    });
    return out.filter((l) => l.title && l.company);
  } catch (err) {
    log.error({ err }, 'fetch error');
    return [];
  }
}
