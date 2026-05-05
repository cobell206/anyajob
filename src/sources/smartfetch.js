// src/sources/smartfetch.js
// Generic URL → listings via AI extraction. Given a URL she points us at,
// we fetch the HTML, strip noise, and ask Claude Haiku to extract job
// listings as structured JSON.
//
// Honest limitations:
//   - Pages that load via JavaScript after fetch will return zero listings
//     (we only get the initial HTML, not the rendered DOM)
//   - Same page can yield slightly different counts on different days
//   - Extraction breaks silently when sites redesign — we mitigate with
//     "last extracted N" tracking in the registry so the UI can flag drops
//
// Cost: ~$0.005-0.02 per fetch depending on page size (most career pages
// are 30-100KB of stripped HTML, well under Haiku's input window).

import 'dotenv/config';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import { SMARTFETCH_EXTRACTION_SYSTEM } from '../prompts.js';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_HTML_CHARS = 60000; // ~15k tokens of stripped HTML

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Extraction prompt lives in src/prompts.js (SMARTFETCH_EXTRACTION_SYSTEM)

function stripPage(html, baseUrl) {
  const $ = cheerio.load(html);

  // Remove obvious noise
  $('script, style, noscript, iframe, svg, nav, footer, header, aside').remove();
  $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();

  // Resolve relative URLs in links so the model can return absolute URLs
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
    try {
      $(a).attr('href', new URL(href, baseUrl).toString());
    } catch {}
  });

  // Prefer main content if marked, else fall back to body
  let main = $('main').first();
  if (!main.length) main = $('[role="main"]').first();
  if (!main.length) main = $('body');

  // Get HTML; cap size
  let out = main.html() || '';
  if (out.length > MAX_HTML_CHARS) {
    out = out.slice(0, MAX_HTML_CHARS) + '\n<!-- truncated -->';
  }
  return out;
}

export async function fetchSmart(url, { name = 'Source' } = {}) {
  if (!url) throw new Error('smartfetch requires a url');

  // 1. Download
  const res = await fetch(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LawboundBot/0.1; +https://lawbound.local)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
    throw new Error(`Not HTML (${ct}); cannot extract`);
  }

  const html = await res.text();
  const stripped = stripPage(html, url);

  if (stripped.trim().length < 200) {
    return [];
  }

  // 2. Hand to Claude for extraction
  const userMsg = `Source name: ${name}
Base URL: ${url}

CLEANED HTML:
${stripped}

Return JSON only.`;

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: [{ type: 'text', text: SMARTFETCH_EXTRACTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  });

  const text = response.content
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Could not parse extraction response: ' + err.message);
  }

  const listings = (parsed.listings || []).map((l) => ({
    source: 'smartfetch',
    company: l.company || name,
    title: l.title || '',
    location: l.location || '',
    url: l.url || url,
    description: l.description || l.title || '',
    postedAt: l.postedAt || null,
  })).filter((l) => l.title); // drop entries with no title

  return listings;
}

// CLI test: node src/sources/smartfetch.js https://example.com/careers
if (process.argv[1]?.endsWith('smartfetch.js') && process.argv[2]) {
  const out = await fetchSmart(process.argv[2], { name: 'Test' });
  console.log(JSON.stringify(out, null, 2));
  console.log(`\nExtracted ${out.length} listing(s).`);
}
