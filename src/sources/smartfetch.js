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
import { SMARTFETCH_EXTRACTION_SYSTEM, SINGLE_LISTING_EXTRACTION_SYSTEM } from '../prompts.js';

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

// Parse Claude's extraction response. Tolerates leading/trailing prose
// (`indexOf('{')` / `lastIndexOf('}')`). Falls back to recovery if the slice
// is mid-JSON corrupt: when Haiku occasionally emits a truncated `]` partway
// through the listings array, find the last complete object before the array
// close, reconstruct `{"listings": [...valid entries...]}`, and retry. If
// recovery still fails, return whatever listings we extracted rather than
// throwing — partial data is more useful than an error to the caller.
function parseExtractionJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('Could not parse extraction response: no JSON object found in response');
  }
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (firstErr) {
    // Recovery: find the array, walk through it collecting top-level objects
    // (tracking string state and brace depth), stop on first malformed one.
    const arrStart = slice.indexOf('[');
    if (arrStart < 0) {
      try {
        return { listings: extractObjectsLoosely(slice) };
      } catch {
        return { listings: [] };
      }
    }
    const objects = extractObjectsLoosely(slice.slice(arrStart + 1));
    if (objects.length > 0) return { listings: objects };
    return { listings: [] };
  }
}

// Walk a string and pull out every JSON object literal that parses cleanly,
// stopping at the first malformed one. Tracks string state and escape
// characters so that braces inside strings don't throw off the depth count.
function extractObjectsLoosely(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '{') { i++; continue; }
    let depth = 0;
    let inString = false;
    let escape = false;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }
    if (depth !== 0) break; // truncated object — stop here
    const candidate = s.slice(i, j);
    try {
      out.push(JSON.parse(candidate));
      i = j;
    } catch {
      break; // first un-parseable object means we hit the corruption
    }
  }
  return out;
}

export async function fetchSmart(url, { name = 'Source' } = {}) {
  if (!url) throw new Error('smartfetch requires a url');

  // 1. Download
  const res = await fetch(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AnyaJobBot/0.1; +https://anyajob.local)',
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
  const parsed = parseExtractionJson(text);

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

// Single-listing extractor: she pastes ONE job URL on the "Add a role" page,
// we fetch, strip, and ask Claude for structured fields to prefill the form.
// Returns { extracted: bool, title, company, location, description, postedAt, reason }.
// Throws only on network/HTTP failures — login walls and 404s come back as
// extracted=false so the UI can show a helpful inline message.
export async function extractSingleListing(url) {
  if (!url) throw new Error('url required');

  const res = await fetch(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AnyaJobBot/0.1; +https://anyajob.local)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
    throw new Error(`Not HTML (${ct}); cannot extract`);
  }

  const html = await res.text();
  const stripped = stripPage(html, url);
  if (stripped.trim().length < 200) {
    return { extracted: false, reason: 'Page had no meaningful content (likely JavaScript-rendered or blocked)' };
  }

  const userMsg = `Source URL: ${url}\n\nCLEANED HTML:\n${stripped}\n\nReturn JSON only.`;

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: 'text', text: SINGLE_LISTING_EXTRACTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  });

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    return { extracted: false, reason: 'Could not parse extraction response' };
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      extracted: !!parsed.extracted,
      title: parsed.title || null,
      company: parsed.company || null,
      location: parsed.location || null,
      description: parsed.description || null,
      postedAt: parsed.postedAt || null,
      reason: parsed.reason || null,
    };
  } catch {
    return { extracted: false, reason: 'Malformed JSON from extraction model' };
  }
}

// CLI test: node src/sources/smartfetch.js https://example.com/careers
if (process.argv[1]?.endsWith('smartfetch.js') && process.argv[2]) {
  const out = await fetchSmart(process.argv[2], { name: 'Test' });
  console.log(JSON.stringify(out, null, 2));
  console.log(`\nExtracted ${out.length} listing(s).`);
}
