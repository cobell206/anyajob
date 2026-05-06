// src/repair.js
//
// Source URL repair via Claude web search. When a source has been failing
// with a 404 (page moved) or 403 (anti-bot block on a custom careers page),
// ask Claude to suggest a fix:
//   - 404 → find the org's current careers page
//   - 403 → check if they migrated to an ATS (Greenhouse/Lever/Workday).
//           If so, return that — we'd rather hit a structured ATS than
//           keep chasing a scrapable page.
//
// Triggered by a button on the Settings page next to a broken source.
// Costs ~$0.05–0.15 per call (web_search + Haiku tokens).

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM = `You help repair a broken job source in a personal job-tracking tool. The tool fetches careers pages and extracts listings. A source has stopped working (404 or 403). Your job: figure out the right replacement URL.

THE TOOL SUPPORTS THESE SOURCE KINDS:
- "greenhouse" — config.slug for boards on boards.greenhouse.io (e.g. "stripe")
- "lever" — config.slug for boards on jobs.lever.co (e.g. "someorg")
- "smartfetch" — any URL with a careers/jobs page; the tool fetches HTML and AI-extracts listings
- "bookmark" — URL the user checks manually (use when the page renders entirely via JavaScript)

RULES BY ERROR TYPE:

404 (page moved/deleted):
- Use web_search to find the organization's CURRENT careers page.
- Prefer ATS URLs over custom careers pages (Greenhouse/Lever boards are far more reliable than HTML scraping).
- If the org clearly moved to Workday or another JS-heavy ATS, return a "bookmark" rather than smartfetch.

403 (anti-bot block on the existing URL):
- First, check whether the org uses Greenhouse, Lever, or Workday by searching their careers page or checking the source HTML on results pages. If yes, return that ATS as the suggestion (kind: greenhouse/lever, or kind: bookmark for Workday).
- If they only have a custom careers page that returns 403, look for an alternate scrapable URL (sometimes orgs publish jobs at a different path that doesn't block bots) — return that as smartfetch.
- If nothing scrapable exists, return the best human-visit URL as a bookmark.

CONFIDENCE GUIDE:
- "high": you found a verifiable ATS slug or canonical careers URL with current job listings visible.
- "medium": you found a plausible URL but couldn't fully verify it has listings.
- "low": best guess only — the org may have shut down or made jobs private.

Return strict JSON only, no preamble:
{
  "suggestedUrl": "<full URL or for greenhouse/lever, the URL form like https://boards.greenhouse.io/<slug>>",
  "suggestedKind": "greenhouse|lever|smartfetch|bookmark",
  "rationale": "<1-2 sentences on what you found and why this is the right replacement>",
  "confidence": "high|medium|low"
}`;

export async function repairSourceUrl(source) {
  const brokenUrl = source.config?.url || (source.config?.slug ? `(${source.kind} slug: ${source.config.slug})` : '(unknown)');
  const errMsg = source.lastError || '(unknown error)';

  const userMsg = `Repair this broken job source.

NAME: ${source.name}
CURRENT KIND: ${source.kind}
BROKEN URL/CONFIG: ${brokenUrl}
ERROR: ${errMsg}

Use web_search to find the right replacement. Return JSON only.`;

  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['web-search-2025-03-05'],
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    }],
    system: SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  let parsed;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) {
      throw new Error('no JSON object found in response');
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error('Could not parse repair response: ' + err.message + '\nResponse was:\n' + text.slice(0, 500));
  }

  return {
    suggestedUrl: parsed.suggestedUrl || '',
    suggestedKind: parsed.suggestedKind || source.kind,
    rationale: parsed.rationale || '',
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    usage: response.usage,
  };
}
