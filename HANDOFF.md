# HANDOFF.md

Context document for Claude Code (or any future contributor) picking this up. Read this first.

## What this is

**AnyaJob** — a personal job-search tracker for one user (referred to as "the user" or "she" throughout). Targets Columbia/NYU Law admissions: she's looking for legal/policy roles in NYC for the 1-2 years before law school.

Single user, single deployment, behind Cloudflare Access. Not a SaaS, not multi-tenant. Architecture decisions reflect that scope — anything that looks under-engineered for a SaaS is probably correctly-scoped here.

## Stack

- Node 20+ with ES modules (`"type": "module"`)
- Express for the HTTP server, Anthropic SDK for scoring/discovery, AWS SES for email
- JSON files in `data/` for storage (no database)
- Cloudflare Tunnel + Cloudflare Access for ingress and auth
- AWS EC2 t3.micro free tier for hosting
- GitHub Actions for push-to-deploy
- pino for logging
- Node's built-in test runner (no jest/vitest)

## Repo layout

```
src/
  server.js              ← Express bootstrap (~60 lines, just mounts routers)
  log.js                 ← pino-based logger with component-scoped child loggers
  io.js                  ← shared readJson/writeJson/fbKey helpers
  constants.js           ← VALID_STATUSES, SOURCE_KINDS enums (single source of truth)
  atomic.js              ← atomic JSON writes via .tmp + rename
  redact.js              ← regex-based secret stripping for logs API
  dedupe-core.js         ← pure fingerprint/dedupKey logic (no IO)
  dedupe.js              ← IO wrapper around dedupe-core
  discover-overlap.js    ← pure overlap-detection (no SDK)
  discover.js            ← Anthropic web_search-driven source discovery
  score.js               ← per-listing scoring via Claude Haiku
  prompts.js             ← all system/user prompts (centralized)
  summaries.js           ← daily brief + weekly reflection generation
  notify.js              ← email composition + SES send
  documents.js           ← resume/cover letter storage + alignment scoring
  daily.js               ← cron entry: scrape → dedupe → score → email
  routes/
    listings.js          ← GET /api/{today,listings,stats,spend}
    feedback.js          ← POST /api/feedback/:fp/{rating,note,status,...}
    preferences.js       ← prefs CRUD
    summaries.js         ← daily/weekly brief refresh
    paste.js             ← manual paste-and-score endpoint
    documents.js         ← upload/download/score-resume
    notifications.js     ← email preview, send-test, log
    sources.js           ← source registry CRUD + live discover
    discoveries.js       ← pending-candidates approve/dismiss
    logs.js              ← redacted log file access
    diagnostic.js        ← curated state bundle for debugging
  sources/
    registry.js          ← source CRUD, dispatch, default seeding
    index.js             ← fetchAll() — runs all enabled sources
    {greenhouse,lever,usajobs}.js  ← API integrations (working)
    {idealist,nycbar,psjd}.js      ← HTML scrapers (SCAFFOLDS, see below)
    smartfetch.js        ← URL + AI extraction fallback
  *.test.js              ← co-located unit tests, run with `npm test`

scripts/
  daily.js               ← (deprecated, use src/daily.js)
  weekly.js              ← Sunday 9am ET cron
  discover.js            ← Mon + Thu 7am ET cron
  backup.js              ← Nightly S3 sync
  test-email.js          ← manual SES verification

public/
  index.html             ← main listings table/cards
  modal.js               ← listing detail modal
  app.js                 ← shared frontend utilities
  documents.js           ← document upload/score UI
  settings.html          ← settings page (markup only)
  settings.js            ← settings page logic (extracted from HTML)
  notifications.html     ← notifications config page
  paste.html             ← manual paste-and-score page
  style.css

bin/
  anyajob-logs          ← laptop CLI for fetching redacted logs over CF Access

data/                    ← runtime state, all gitignored except *.example.json
  preferences.example.json  ← committed template
  preferences.json       ← needs creation: cp from example, fill in
  listings.json          ← scored listings (grows over time)
  feedback.json          ← rating/note/status/dates per listing
  seen.json              ← dedupKeys seen, prevents re-scoring
  sources.json           ← source registry state
  discoveries.json       ← pending source candidates from cron Discovery
  spend.json             ← Anthropic API cost tracking
  summaries.json         ← latest daily brief + weekly reflection
  notifications.json     ← email send log
  documents/             ← uploaded resumes/covers, keyed by fingerprint

.github/workflows/deploy.yml  ← Test → Deploy on push to main
setup.sh                 ← idempotent EC2 provisioning
DEPLOY.md                ← 10-part deployment walkthrough
GITHUB.md                ← git workflow notes
README.md                ← project overview
```

## Key architectural decisions

### Two-part fingerprinting (read this carefully)

Every listing has BOTH:

- `fingerprint` = `hash(company + title + location)` — **role identity**. Stable across reposts, distinct openings of same role share this. Used for: documents folder paths, "show me other postings of this role" lookups.
- `dedupKey` = `hash(fingerprint + source + externalId)` when externalId is present, else falls back to `fingerprint`. **Per-listing identity**. Used for: `seen.json` (what we've already scored), `feedback.json` keys (rating/note/status/dates).

This means two distinct paralegal slots at Davis Polk (same title/location, different Greenhouse IDs) coexist as separate listings she can apply to independently. Reposts at the same source get a new ID → new dedupKey → re-surfaced as new listings (intentional, per user choice — reposts signal "still hiring").

Backward compat: every lookup uses `l.dedupKey || l.fingerprint`. Older listings without `dedupKey` fall through to single-key behavior.

Tests in `src/dedupe.test.js` verify the four key cases.

### Source registry pattern

Sources are data, not code. `data/sources.json` stores `{kind, name, config, enabled}` records. Adding a new source instance is a UI action; adding a new source *kind* requires:

1. Add to `SOURCE_KINDS` in `src/constants.js`
2. Wire handler into the dispatch map in `src/sources/registry.js`
3. Add UI tab to `public/settings.html`

Three kind categories:
- **integration**: built-in API/scraper modules (`greenhouse`, `lever`, `usajobs`, `idealist`, `nycbar`, `psjd`)
- **smartfetch**: generic URL + AI extraction (~70% reliable)
- **bookmark**: URL surfaced for manual checks on a cadence (no auto-fetch)

### Discovery is cron-driven

`scripts/discover.js` runs Mon + Thu at 7am ET, calls Claude with `web_search_20250305` (max_uses 15), proposes new sources matching her profile. Persists to `data/discoveries.json`. Morning email surfaces a "✨ N pending candidates" link to settings, where she approves/dismisses.

Cross-source overlap detection: when Discovery proposes `greenhouse:skadden` but she already has Skadden's careers page as smartfetch, the candidate is annotated with `overlapsWith: { id, name, url }` so the UI shows an amber warning at approval time.

Cost: ~$0.50/run × 2/week ≈ **$4/month worst case**.

### Logging

pino-based. Every module gets a component-scoped child logger:

```javascript
import { createLogger } from './log.js';
const log = createLogger('daily');
log.info({ count: 7 }, 'scrape complete');
```

Structured JSON in production (so `journalctl -u anyajob | grep '"component":"daily"'` works). Pretty-printed in dev. CLI test blocks (gated by `if (process.argv[1]?.endsWith('xxx.js'))`) intentionally still use `console.log` — they're for human debugging, not log aggregation.

Configure via env: `LOG_LEVEL` (info default), `LOG_FORMAT` (pretty/json), `NODE_ENV`.

### Logs API + laptop CLI

Two endpoints expose redacted state for debugging:

- `GET /api/logs/:source?since=1h&level=warn&limit=500` — recent log lines, filtered, redacted
- `GET /api/diagnostic` — curated bundle (sources state, listings counts, spend, log tails)
- `GET /api/diagnostic?format=text` — paste-friendly text format

Both gated by Cloudflare Access. Output passes through `src/redact.js` which strips API keys, AWS keys, JWTs, GitHub tokens, emails, file paths, and 40+ char opaque tokens.

Laptop CLI in `bin/anyajob-logs` uses Cloudflare Access service token auth. `anyajob-logs --copy daily 1h` fetches an hour of logs and pipes to clipboard. Setup steps in DEPLOY.md.

### Email triggers

Two triggers, consolidated from an earlier design:

1. **Morning email** (daily 6am ET via `src/daily.js`) — top listings, closing-soon section, manual-check bookmarks, pending discovery count
2. **Weekly digest** (Sunday 9am ET via `scripts/weekly.js`) — applied-this-week, closing-this-week, reflection

No "urgent" trigger — closing-soon listings ride along on the morning email. Multi-recipient `to[]` array (no CC, no BCC).

### Storage

JSON files via `src/atomic.js` (writes via `.tmp` + rename for atomicity). Will be fine until `listings.json` reaches ~50MB (probably 6+ months). When that happens, swap to SQLite via `better-sqlite3` — about 30 lines of changes, all behind `src/io.js`.

### Tests

Node's built-in test runner. Co-located `*.test.js` files. Run via `npm test`. 28 tests covering:

- Fingerprint normalization, dedupKey behavior (`src/dedupe.test.js`)
- Discovery overlap detection (`src/discover-overlap.test.js`)
- Redaction patterns (`src/redact.test.js`)

Pure-logic refactors (`dedupe-core.js`, `discover-overlap.js`) exist *because* the test files can't import the full module graph (which transitively requires pino + Anthropic SDK). When you write new tests for pure logic, prefer importing from `-core` modules.

GitHub Actions runs `npm test` before any deploy. PRs to main run tests but don't deploy.

### Frontend conventions

- ES modules served as static files
- One module per page logic file (`app.js`, `modal.js`, `settings.js`, `documents.js`)
- HTML files contain markup + minimal styles + a single `<script type="module" src="...">` reference
- No build step, no bundler, no React. Vanilla JS with module imports.
- Mobile-first; the user is mostly on her phone

## Pre-deploy checklist (in priority order)

1. **Personalize `data/preferences.json`** — copy from `preferences.example.json`, fill in placeholder fields (`name`, `currentRole`, `yearsOutOfUndergrad`, `gpaRange`, `undergradSchool`, `lsatStatus`, `interestAreas`, `additionalContext`, `notifications.to[]`). Without this the scoring rubric is generic and the morning email goes nowhere. **This is a sit-down-with-her task, not a coding task.**

2. **Disable the HTML scrapers** in `data/sources.json`'s default seed (idealist, nycbar, psjd are scaffolds with TODO comments — selectors are guesses, almost certainly broken against live sites). Replace with smartfetch entries pointing to the same URLs. Iterate to native scrapers later if smartfetch quality is poor.

3. **Start AWS SES sandbox approval request** (24-48h wait). Without it, morning emails silently fail to non-verified addresses. Steps in DEPLOY.md Part 10 Stage 2.

4. **Write a smoke test** (`npm run smoke`) that runs the full pipeline end-to-end against one mocked Greenhouse listing: dedupe → score (real $0.005 Anthropic call) → brief generation → email composition (no send). Catches "deployed and nothing works" before deploy day. ~30 min.

5. **Cover letter drafter** — modal button using stored resume + JD + notes. Infrastructure mostly exists; just needs a route + UI button + prompt. ~90 min, high user value.

6. **Snooze button for closing-soon alerts** — currently the morning email re-surfaces the same closing listings every day. ~30 min.

## Things deliberately NOT built (with rationale)

- **No auth code** — Cloudflare Access fronts everything. Don't add app-level auth.
- **No rate limiting beyond global 60/min and discovery 6/hr** — single user, no abuse concern.
- **No health check / uptime monitoring** — Cloudflare shows downtime, missing morning emails surface issues within 24h.
- **No SQLite yet** — JSON is fine until listings.json hits ~50MB.
- **No staging environment** — single user, push-to-main is acceptable.
- **No request signing on deploy webhook** — SSH keys are sufficient.
- **No LSAT prep integration** — interesting idea, but the marginal value over "she uses judgment" is low until clearly painful.
- **No structured PII redaction (Presidio etc.)** — regex redaction in `src/redact.js` is proportionate to the threat model (one user, behind CF Access). Could revisit if expanding scope.
- **No TypeScript** — single-developer project, JSDoc comments cover the parts that matter.

## Cost expectations

Estimated monthly: **~$13-15 all-in**.

- Daily scoring: ~50 listings × $0.005 = $0.25/day = $7.50/mo
- Daily brief: ~$0.02/day = $0.60/mo
- Discovery (Mon+Thu): 2 × $0.50 = $4/mo
- Weekly reflection: $0.40/mo
- AWS: t3.micro free tier, SES free up to 62k/mo, S3 ~$0.05/mo

Tracked in `data/spend.json`. If first-week costs exceed 3x estimate, something is wrong (probably listings volume — check `data/listings.json` count vs sources).

## Working with this codebase in Claude Code

A few patterns the previous session used that work well:

**When asked to add a new source kind**: update `src/constants.js`, add handler module, register in `src/sources/registry.js`, add UI tab. Don't forget the registry's DISPATCH map.

**When asked to add a new endpoint**: create a route module under `src/routes/`, mount in `src/server.js`. Don't put logic in server.js itself — it's intentionally a 60-line bootstrap.

**When asked to add a feedback field**: it's keyed by `dedupKey`, not `fingerprint`. Use `fbKey(listing)` from `src/io.js`.

**When asked to handle reposts differently**: re-read the dedupe section. The current behavior (treat reposts as new) was an explicit user choice. Don't silently change it.

**When tests fail because of missing pino/SDK**: the test imports from a non-`-core` module. Refactor the pure logic into a `-core` file (see `dedupe-core.js`, `discover-overlap.js` as templates).

**When tempted to add a logging library other than pino**: don't. The migration from console.log was real work. Stick with pino.

## Things to ask before changing

- Anything that touches the morning email schedule or content structure
- Anything that changes `seen.json` or `feedback.json` schema
- Anything that adds an external service dependency (Datadog, Sentry, etc.)
- Anything that adds a build step

## Useful commands

```bash
npm install              # first-time deps
npm test                 # run all unit tests
npm start                # boot the server locally on :3000
npm run daily            # run the daily pipeline once (scrape → score → email)
npm run weekly           # generate weekly digest
npm run discover         # run discovery once
npm run test-email       # send a test email via SES
npm run test-score       # test scoring against a mock listing
```

For deploy: see DEPLOY.md.
For git workflow: see GITHUB.md.

## Original conversation summary

This codebase was built across multiple Claude conversations covering: stack selection (Node + JSON > Python + DB for one-user scope), source abstraction design, two-part fingerprinting (after the user pointed out same-title-different-IDs was a real case), structured logging migration, server route splitting (server.js was 615 lines, now 60), settings page split (935 → 365 lines), test suite addition, redacted logs API, and laptop CLI for remote debugging.

The key personality of the codebase: **proportionate to scope.** Every piece was sized for a single user with one deployment. Extensions should follow that principle — don't add multi-tenant patterns, don't pre-optimize for scale that isn't coming.
