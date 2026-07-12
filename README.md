# AnyaJob — Law School Job Tracker

Daily job-search pipeline for someone applying to Columbia or NYU Law. Scrapes legal-relevant roles from reliable sources, scores them with Claude on two axes (qualification fit + law school admissions value), and presents a sortable, filterable shortlist with status pipeline tracking.

## Operating this thing — start here

If you're a new contributor or AI agent picking this up, read this section first. It covers the load-bearing facts about how production runs and how to debug it without SSH'ing in.

### Production (serverless — since 2026-07)

- **URL:** <https://jobs.anyalawgirly.com>
- **Runtime:** the entire Express app runs as **AWS Lambda `anyajob-web`** (via `serverless-http`) behind an **API Gateway HTTP API**, in `us-east-1`. There is **no server to SSH into** — the EC2 box is retired.
- **Auth:** Cloudflare fronts the origin (DNS + Full-strict TLS) and enforces **Cloudflare Access** (zero-trust SSO). API Gateway validates the `Cf-Access-Jwt-Assertion` JWT; a request straight to the execute-api URL with no Access JWT gets a 401.
- **State:** all in **S3** (`anyajob-data` for the JSON "database", `anyajob-docs` for uploads) via the `src/store.js` seam. No local files in prod.
- **Crons:** **EventBridge → Lambda `anyajob-cron`** (daily 6am ET, discovery Mon/Thu 7am ET).
- **Deploy:** push to `main` → `.github/workflows/deploy-infra.yml` bundles the Lambda and `cdk deploy`s the stack.

**→ Full architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md). Agent operating guide: [`CLAUDE.md`](CLAUDE.md).**

### Logs & debugging

Lambda writes to **CloudWatch Logs**, one group per function:
`/aws/lambda/anyajob-web`, `/aws/lambda/anyajob-cron`,
`/aws/lambda/anyajob-scoring-worker`. That's the source of truth.

> The in-app `/api/logs/*` endpoints (and the `bin/anyajob-logs` CLI that wrapped them) tailed a `server.log` file on disk — an EC2-only pattern. Lambda's filesystem is ephemeral, so use CloudWatch in prod.

### Deploy quirks worth knowing

`scripts/build-lambda-bundle.sh` (run inside `deploy-infra.yml`) does two non-obvious things that matter when debugging cache issues:

1. **HTML cache-bust** — perl replaces every literal `__CACHE_VERSION__` in `public/*.html` with the current commit SHA, so `<script src="/foo.js?v=__CACHE_VERSION__">` becomes `?v=abc1234`. Static assets are served long-lived/immutable, so the commit-SHA query string is what forces browsers to refetch on every deploy.
2. **JS import cache-bust** — same idea for ES module imports inside `public/**/*.js`. The regex (`\.+/[^'?]*\.js`) rewrites `from './foo.js'` and `from '../app.js'` to include `?v=$COMMIT_SHA`. **Burned us on 2026-05-25:** an earlier regex only matched same-directory imports (`./`), so after the `components/` subdir refactor every `from '../app.js'` silently pinned to a year-old cached copy. Fixed in `169b7bf`. **If you add an import path the regex still doesn't match** (absolute paths, deep relatives, anything funky), check that file after deploy or the bug returns.

It also fetches the linux `@napi-rs/canvas` prebuilt (native dep `pdf-parse` needs for résumé PDF text extraction) — the reason the Lambda arch is pinned `x86_64` and there's a custom bundle step instead of a plain CDK asset.

### Codebase entry points

- **Web (Lambda):** `src/lambda.js` → wraps `src/server.js` (Express, mounts route files)
- **Scoring worker (Lambda):** `src/worker.js` — async résumé scoring (off the 30s API GW cap)
- **Cron (Lambda):** `src/cron.js` — dispatches `{job}` → `src/daily.js` / `scripts/discover.js` / `scripts/weekly.js`
- **Daily pipeline:** `src/daily.js` — scrape → score → summaries → cleanup
- **Routes:** `src/routes/{listings,sources,profile,documents,…}.js`
- **Storage seam:** `src/store.js` (+ `io.js`/`atomic.js` re-exports), `src/docstore.js` for uploads
- **AI prompts (centralized):** `src/prompts.js` — all of them in one file
- **Frontend pages:** `public/{index,profile,settings}.html` + matching `.js`
- **Shared frontend modules:** `public/components/`, `public/app.js`
- **Infra (CDK):** `infra/lib/anyajob-stack.ts` (`AnyaJobStack`)

### Where to look next

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — **current-state architecture (start here)**
- [`CLAUDE.md`](CLAUDE.md) — operating guide for AI agents
- `SERVERLESS-TRANSITION.md` — the migration history (how we got from EC2 to here)
- `data/preferences.example.json` — schema for `data/preferences.json` (gitignored, holds Anya's profile)
- `DEPLOY.md` / `HANDOFF.md` / `OUTSTANDING.md` / `GITHUB.md` — **pre-serverless**; historical context only (see banners at the top of each)

## What's in this version

**Scoring engine**
- Claude Haiku 4.5 with prompt caching for cost efficiency (~$1–5/month)
- Each listing scored on Qualification Fit (0-10) and Law School Value (0-10)
- Claude also extracts: salary range, application deadline, work mode
- Daily spend cap enforced before each call
- Last 6 rated listings injected as calibration examples — system learns her preferences over weeks

**Daily brief & weekly reflection**
- Auto-generated each morning by the cron — one short paragraph at the top of the page summarizing what's worth her attention
- Weekly reflection generated Sunday mornings — collapsible section with "this week's signal," "pattern noticed," and "one question"
- ~$0.005/day combined

**Sources**
- Greenhouse boards (any company — JSON API)
- Lever boards (any company — JSON API)
- USAJobs.gov (federal legal/policy roles, real API)
- Idealist, NYC Bar, PSJD (HTML scrapers, scaffolded — selectors TODO on laptop)
- Manual paste tool for LinkedIn/Indeed listings

**UI**
- Bright modern design, blue and green palette, light shadows
- Fraunces serif for headings, Geist for UI
- Sortable table on desktop, card view on mobile
- Filter pills by status (New/Saved/Applied/Interview/Offer/Rejected)
- Tap any row to open detail modal with rationale, strengths, concerns, application angle, sub-scores
- Modal includes status dropdown, applied-date and closes-date pickers, notes
- Auto-sets applied date when status moves to "Applied"
- Stats tiles: total roles, saved, applied, applied-this-week
- Score column shows number + dual progress bars (qual fit blue, law school value green)

**Data**
- Flat JSON files in `data/` (easy to back up, simple to migrate to SQLite later)
- Fingerprint dedupe across sources and days
- Feedback persists across deploys

## Quick preview

To see the design without setup, open `public/preview.html` directly in a browser. It uses static sample data and shows the main listings page.

## Project structure

```
anyajob/
├── README.md              ← this file
├── ARCHITECTURE.md        ← current-state serverless architecture (start here)
├── CLAUDE.md              ← operating guide for AI agents
├── SERVERLESS-TRANSITION.md ← migration history (EC2 → serverless)
├── package.json
├── .env.example
├── .github/workflows/
│   ├── deploy-infra.yml   ← THE deploy: bundle Lambda + cdk deploy (on push to main)
│   └── …                  ← other workflows are EC2-era / one-shot migrations (dead)
├── infra/                 ← AWS CDK app (TypeScript, ESM type-stripped)
│   ├── bin/infra.ts
│   └── lib/anyajob-stack.ts   ← AnyaJobStack: Lambdas, HTTP API, S3, schedules, alarms
├── data/                  ← LOCAL dev store only (STORAGE=fs); prod state is in S3
│   ├── preferences.example.json  ← committed template
│   ├── preferences.json          ← her actual profile (gitignored)
│   └── …                         ← listings.json, feedback.json, seen.json, spend.json
├── src/
│   ├── lambda.js          ← web Lambda entrypoint (serverless-http → server.js)
│   ├── worker.js          ← scoring-worker Lambda (async résumé scoring)
│   ├── cron.js            ← cron Lambda dispatcher (daily/discover/weekly)
│   ├── server.js          ← Express app (mounts routes)
│   ├── daily.js           ← daily pipeline: scrape → score → summaries
│   ├── discover.js        ← source discovery (Mon/Thu)
│   ├── store.js / io.js / atomic.js  ← storage seam (fs | s3)
│   ├── docstore.js        ← uploaded-doc binaries (S3 anyajob-docs)
│   ├── score.js · prompts.js · dedupe*.js · summaries.js · documents.js · notify.js
│   ├── routes/            ← listings, sources, profile, documents, …
│   └── sources/           ← greenhouse, lever, usajobs, idealist, nycbar, psjd
├── scripts/
│   ├── build-lambda-bundle.sh ← builds infra/.app-bundle (deps + canvas + cache-bust)
│   ├── weekly.js · discover.js · smoke.mjs · test-email.js · backup.js · restore.sh
└── public/
    ├── index.html · profile.html · settings.html
    ├── style.css · app.js
    └── components/
        ├── modal.js                    ← listing detail modal
        ├── documents.js                ← application-materials + PDF preview
        ├── feedback-modal.js           ← résumé/cover feedback modal
        ├── add-role-modal.js · review-candidates-modal.js · candidates.js
```

> `setup.sh` and `DEPLOY.md` provision the **old EC2 host** — kept for history,
> not used by the serverless deployment.

## Setup (on laptop)

```bash
# Extract
tar xzf job-tracker.tar.gz
cd job-tracker
npm install

# Configure
cp .env.example .env
# Edit .env with Anthropic API key (from console.anthropic.com)

# Edit her profile
nano data/preferences.json

# Optional: set Greenhouse boards in .env
# GREENHOUSE_BOARDS=cravath,davispolk,sullcrom,paulweiss

# Test the pipeline
npm run daily

# Run the server
npm start
# http://localhost:3000
```

## Personalization

Edit `data/preferences.json`:

```json
{
  "profile": {
    "name": "Her name",
    "currentRole": "Marketing Coordinator at XYZ",
    "yearsOutOfUndergrad": 2,
    "gpaRange": "3.7-3.9",
    "undergradSchool": "Cornell",
    "lsatStatus": "studying, target Sept 2026",
    "targetSchools": ["Columbia Law", "NYU Law"],
    "interestAreas": ["public interest", "litigation"],
    "geo": "NYC",
    "additionalContext": "Speaks Spanish, volunteer at Legal Aid"
  },
  "keywords": {
    "boost": ["paralegal", "judicial", "pro bono", "policy"],
    "exclude": ["unpaid", "commission only"],
    "minSalary": 55000
  },
  "companies": {
    "alwaysShow": ["Cravath", "Davis Polk", "Sullivan & Cromwell"],
    "neverShow": []
  }
}
```

## Deploy

**Push to `main`.** `.github/workflows/deploy-infra.yml` runs the tests, bundles
the Lambda (`npm run bundle:lambda`), and `cdk deploy`s `AnyaJobStack`. Doc-only
pushes (`*.md`) are skipped. That's the whole deploy path — see
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the stack detail and the manual
`cdk deploy` command (including the SSM-sourced Anthropic key parameter).

> The old `DEPLOY.md` / `GITHUB.md` / `setup.sh` describe the retired EC2 +
> Cloudflare Tunnel setup. Kept for history; not part of the serverless deploy.

## Cost

- Claude API: ~$1–5/month (Haiku 4.5 + prompt caching)
- AWS (Lambda + API Gateway + S3 + EventBridge): ≈ pennies/month at this volume
- Domain: ~$10/year via Cloudflare
- Cloudflare Access: free for personal use

(Was ~$8–10/month on the always-on EC2 t3.micro before the serverless migration.)

## Application status pipeline

```
New → Saved → Applied → Interview → Offer
                    ↘  Rejected
```

- **New**: default for any listing she hasn't touched
- **Saved**: bookmarked, intends to apply
- **Applied**: submitted (auto-sets applied date to today, editable)
- **Interview**: heard back, in process
- **Offer / Rejected**: terminal states

Status filter pills at the top of the listings page. Stats tile shows applied-this-week.

## Feedback loop in action

1. She rates listings 👍 / 👎 in the modal
2. Next daily run pulls her last 6 rated listings
3. Those get injected into the scoring prompt as "examples she liked / disliked"
4. Claude calibrates scores against her demonstrated preferences
5. Over ~2 weeks, scores reflect her actual taste, not just the original rubric

## Future additions

- Cover letter draft generator (using her notes + JD via API)
- Resume bullet rewriter tailored to top listings
- Weekly digest email
- Closing-soon alerts (email when a saved listing closes within 3 days)
- LSAT-prep mode (deprioritize intense roles in 4 weeks before her test date)
- SQLite migration once dedup volume grows
