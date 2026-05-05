// src/sources/idealist.js
// Idealist.org — strong source for public interest legal roles.
// SCAFFOLD: this needs the actual selectors, which require loading the live page.
//
// TODO when finishing on laptop with Claude Code:
// 1. curl 'https://www.idealist.org/en/jobs?q=paralegal&locationName=New%20York%2C%20NY'
//    and inspect the returned HTML
// 2. Update SELECTORS below with real CSS selectors for listing cards
// 3. If they use client-side rendering (likely), switch to their internal API
//    by inspecting the network tab in browser devtools — many sites have an
//    undocumented JSON endpoint behind their search page
// 4. Test with: node -e "import('./src/sources/idealist.js').then(m => m.fetchIdealist().then(console.log))"

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { createLogger } from '../log.js';

const log = createLogger('idealist');

const SEARCH_QUERIES = [
  'paralegal New York',
  'legal assistant New York',
  'policy New York',
  'research associate New York',
];

const SELECTORS = {
  // TODO: replace with actual selectors from live page inspection
  card: '[data-testid="job-card"]',
  title: 'h3 a',
  company: '[data-testid="organization-name"]',
  location: '[data-testid="location"]',
  url: 'h3 a',
  description: '[data-testid="description"]',
};

export async function fetchIdealist() {
  const all = [];
  for (const q of SEARCH_QUERIES) {
    const url = `https://www.idealist.org/en/jobs?q=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobTracker/0.1)' },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);
      $(SELECTORS.card).each((_, el) => {
        const $el = $(el);
        const title = $el.find(SELECTORS.title).text().trim();
        const company = $el.find(SELECTORS.company).text().trim();
        const location = $el.find(SELECTORS.location).text().trim();
        const href = $el.find(SELECTORS.url).attr('href') || '';
        const description = $el.find(SELECTORS.description).text().trim();
        if (!title || !company) return;
        all.push({
          source: 'idealist',
          company,
          title,
          location,
          url: href.startsWith('http') ? href : `https://www.idealist.org${href}`,
          description,
          postedAt: null,
        });
      });
    } catch (err) {
      log.error({ err }, 'fetch error');
    }
  }
  return all;
}
