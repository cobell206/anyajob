# AnyaJob — Law School Job Tracker

Daily job-search pipeline for someone applying to Columbia or NYU Law. Scrapes legal-relevant roles from reliable sources, scores them with Claude on two axes (qualification fit + law school admissions value), and presents a sortable, filterable shortlist with status pipeline tracking.

## Operating this thing — start here

If you're a new contributor or AI agent picking this up, read this section first. It covers the load-bearing facts about how production runs and how to debug it without SSH'ing in.

### Production

- **URL:** <https://jobs.anyalawgirly.com>
- **Host:** EC2 (us-east-1) behind a Cloudflare Tunnel + **Cloudflare Access** (zero-trust SSO). Every endpoint redirects to an SSO login page unless authenticated.
- **Deploy:** GitHub Actions on push to `main` → SSH to EC2 → `git pull` → restart systemd. See `.github/workflows/deploy.yml`.

### Remote log access (no SSH required)

The server exposes redacted logs + a diagnostic bundle behind Cloudflare Access:
- `GET /api/logs/sources` — what log files exist
- `GET /api/logs/:source?since=1h&level=warn&limit=500` — one log, filtered + redacted
- `GET /api/diagnostic` — curated state bundle (sources, listings counts, spend, log tails)

To hit these from a laptop or from a Claude Code session, you need a **Cloudflare Access service token**:

1. **Create the token** — Cloudflare Zero Trust → Access → Service Auth → Create Service Token → name it `claude-debug` (or similar).
2. **Add the token to the Access policy** for `jobs.anyalawgirly.com` as an Include rule → Service Auth → your token.
3. **Save to `.env.local`** (gitignored, local-only — never commit):
   ```
   ANYAJOB_URL=https://jobs.anyalawgirly.com
   CF_CLIENT_ID=<token client id>
   CF_CLIENT_SECRET=<token client secret>
   ```
4. **Hit the endpoints** with the matching headers:
   ```bash
   set -a; source .env.local; set +a
   curl -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
        "$ANYAJOB_URL/api/logs/server?since=2h&level=warn"
   ```

The shell CLI `bin/anyajob-logs` wraps the same auth and reads the same three vars from `.env.local` (auto-sourced from the cwd or repo root). So `./bin/anyajob-logs daily 1h` or `./bin/anyajob-logs --copy diag` works without any further setup once `.env.local` is in place. Run `./bin/anyajob-logs --help` for the full flag list.

### Deploy quirks worth knowing

The deploy script (`.github/workflows/deploy.yml`) does two non-obvious things that matter when debugging cache issues:

1. **HTML cache-bust** — sed replaces every literal `__CACHE_VERSION__` in `public/*.html` with the current commit SHA. So `<script src="/foo.js?v=__CACHE_VERSION__">` becomes `?v=abc1234`. The non-HTML static files are served with `Cache-Control: public, max-age=31536000, immutable` from Cloudflare's CDN — the commit-SHA query string is what forces browsers to refetch on every deploy.
2. **JS import cache-bust** — same idea but for ES module imports inside `public/**/*.js`. The regex (`\.+/[^'?]*\.js`) rewrites `from './foo.js'` and `from '../app.js'` to include `?v=$COMMIT_SHA`. **Burned us on 2026-05-25:** the earlier version of the regex only matched same-directory imports (`./`), so after the `components/` subdir refactor every `from '../app.js'` import silently pinned to a year-old immutable-cached copy of `/app.js`. Latent bug — only surfaced when a downstream file actually referenced a new export. Fixed in `169b7bf`. **If you add a transitive import path the regex still doesn't match** (e.g. absolute paths, deep relatives, anything funky), check that file after deploy or the same class of bug returns.

### Codebase entry points

- **Server:** `src/server.js` (Express, mounts route files)
- **Daily pipeline (cron):** `src/daily.js` — scrape → score → email → cleanup
- **Routes:** `src/routes/{listings,sources,profile,documents,logs,diagnostic,…}.js`
- **AI prompts (centralized):** `src/prompts.js` — all of them in one file
- **Frontend pages:** `public/{index,profile,settings,ignored}.html` + matching `.js`
- **Shared frontend modules:** `public/components/`, `public/app.js`
- **Vendored libraries:** `public/vendor/pdfjs/` — pdfjs-dist for the résumé feedback PDF viewer

### Where to look next

- `DEPLOY.md` — EC2 + Cloudflare Tunnel + SES setup, deploy details
- `HANDOFF.md` — design rationale and the "ongoing concerns" file
- `OUTSTANDING.md` — known production issues by severity
- `GITHUB.md` — repo + push-to-deploy setup
- `data/preferences.example.json` — schema for `data/preferences.json` (gitignored, holds Anya's profile)

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
job-tracker/
├── README.md              ← this file
├── DEPLOY.md              ← EC2 + Cloudflare Tunnel + SES setup
├── GITHUB.md              ← GitHub repo setup + push-to-deploy
├── setup.sh               ← idempotent provisioning script
├── package.json
├── .env.example
├── .gitignore
├── .github/
│   └── workflows/
│       └── deploy.yml     ← push-to-deploy workflow
├── data/
│   ├── preferences.example.json  ← committed template
│   ├── preferences.json          ← her actual profile (gitignored)
│   ├── listings.json
│   ├── feedback.json
│   ├── seen.json
│   ├── spend.json
│   └── documents/                ← uploaded resumes/cover letters
├── src/
│   ├── daily.js
│   ├── server.js
│   ├── score.js
│   ├── prompts.js
│   ├── dedupe.js
│   ├── notify.js          ← SES email + templates
│   ├── summaries.js       ← daily brief + weekly reflection generators
│   ├── documents.js       ← resume/cover upload, DOCX→PDF, scoring
│   └── sources/
│       ├── index.js
│       ├── greenhouse.js
│       ├── lever.js
│       ├── usajobs.js
│       ├── idealist.js
│       ├── nycbar.js
│       └── psjd.js
├── scripts/
│   ├── backup.js          ← nightly S3 sync
│   ├── restore.sh         ← restore from S3
│   ├── weekly.js          ← Sunday digest cron
│   └── test-email.js      ← verify SES setup
└── public/
    ├── index.html         ← table view + modal (+ add-role modal trigger)
    ├── settings.html      ← preferences editor
    │                       (email previews + test send live in settings.html → Notifications section)
    ├── style.css
    ├── app.js
    └── components/
        ├── modal.js                    ← listing detail modal
        ├── add-role-modal.js           ← manual JD scorer modal (opens from roles page)
        ├── review-candidates-modal.js  ← pending source candidates (opens from roles page)
        ├── candidates.js               ← shared source-candidate card renderer
        └── documents.js                ← upload UI
```

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

See `DEPLOY.md` for full EC2 + Cloudflare Tunnel + SES setup. ~30 minutes (plus 24h SES approval wait).
See `GITHUB.md` for repo setup and optional push-to-deploy via GitHub Actions.

Quickstart:

```bash
# On a fresh Ubuntu 24.04 (or 26.04) EC2:
git clone git@github.com:<your-github-user>/anyajob.git
cd anyajob
./setup.sh                # installs Node, LibreOffice, AWS CLI, cloudflared, systemd, cron
nano .env                 # add Anthropic API key, AWS region, NOTIFY_FROM, BACKUP_BUCKET
nano data/preferences.json  # her actual profile
sudo systemctl start anyajob
```

## Cost

- Claude API: ~$1–5/month (Haiku 4.5 + prompt caching)
- EC2: free 12 months, then ~$8/month (or Hetzner CX11 €4/mo forever)
- Domain: ~$10/year via Cloudflare
- Cloudflare Tunnel + Access: free for personal use

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
