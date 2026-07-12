# Improvements — tracking doc

Recommended changes from the 2026-07-12 review, across three areas: **page load
time**, **data model**, and **grading/search-goals UX**. Scope rule still
applies (single user, single deployment — bias toward the small, direct fix).

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` won't do

---

## 1. Page load time

### 1.1 Defer / lazy-load Sortable — `[x]`
- **Priority:** high (cheapest win)
- **Where:** `public/index.html`, `public/roles.js`
- **Problem:** `Sortable.min.js` is a synchronous `<script>` in `<head>`, so it
  blocks HTML parsing on *every* page load — but it's only used by the **kanban**
  view, which most visits never open.
- **Done:** removed the `<head>` script; vendored the Sortable **ESM** build to
  `public/vendor/sortable/sortable.esm.js`; `roles.js` lazy-`import()`s it (cached
  promise) on first kanban render. Also removes the cdnjs external dependency.

### 1.2 Self-host fonts — `[x]`
- **Priority:** high
- **Where:** all four `public/*.html`, `public/style.css`
- **Problem:** Google Fonts (Fraunces + Geist) is a render-blocking external
  stylesheet needing DNS + TLS to two Google hosts; ~11 weight/axis combos.
- **Done:** **Fraunces was already retired** in CSS but still requested in 3
  HTML files — dropped entirely. Vendored Geist (variable woff2, latin +
  latin-ext, 46 KB total) to `public/vendor/fonts/geist/`; `@font-face` now lives
  in `style.css` (one file per subset covers weights 400–700). Removed the Google
  `<link>` + preconnects from all four pages; added a `preload` for the latin
  file. No external font requests remain.

### 1.3 Lazy-import the Anthropic SDK in web paths — `[x]`
- **Priority:** medium (cold-start latency)
- **Problem:** single user ⇒ `anyajob-web` Lambda is usually cold; she pays init
  cost most visits. `server.js` statically wires every route, and seven modules
  (`score`, `feedback`, `documents`, `summaries`, `discover`, `repair`,
  `sources/smartfetch`) statically `import Anthropic` — so a plain listings
  request parsed the whole SDK at cold start (several even constructed a client
  at module scope).
- **Done:** added `src/anthropic.js` — a cached, lazy `getAnthropic()` that
  `import()`s the SDK on first real use. Converted all seven modules to
  `await getAnthropic()` and removed every module-scope client. Verified
  `server.js` imports in ~200ms with `ANTHROPIC_API_KEY` unset and the SDK
  unevaluated; only reference left is the one dynamic `import()`.
- **Note:** did NOT use provisioned concurrency — not free-tier-friendly.

### 1.4 Parallelize the initial S3 reads — `[x]`
- **Priority:** low
- **Where:** `src/routes/page.js`
- **Problem:** `summaries` was a separate `await` after the `Promise.all`.
- **Done:** folded `summaries` into the same `Promise.all`, so all four data
  reads (S3 GETs on Lambda) run concurrently on the HTML critical path.

---

## 2. Data model

**Decision:** stay on the S3-JSON model — it's appropriate for this scope
(listings.json ≈ 27 KB; full read/rewrite is fine). Do **not** migrate to a DB
without a concrete pain. The items below harden the current model.

### 2.1 Fix lost updates on shared JSON files — `[x]`
- **Priority:** high (correctness)
- **Decision:** S3 conditional writes (ETag CAS), not the per-key split.
- **Done:** added `updateJson(name, mutator, {fallback})` to `src/store.js` — a
  read-modify-write that, on S3, guards the `PutObject` with `If-Match` (the ETag
  from the read) / `If-None-Match:*` for creates, and retries on `412/409`. On fs
  it's a plain atomic write (single-process dev). Migrated the hot writers:
  `daily.js` listings append (cron), `routes/listings.js` re-score, `routes/paste.js`
  (listings + feedback), and all six `routes/feedback.js` writes. Re-score/paste
  do the paid scoring OUTSIDE the retry loop so a retry never re-spends. Contract
  tests cover the new helper on both backends.

### 2.2 If a real DB is ever needed — `[-]` (deferred, documented)
- **Recommendation:** DynamoDB on-demand — 25 GB perpetually free, no idle cost,
  serverless-native, stays in AWS.
- **Avoid:** RDS (free tier is 12 months only, then bills) and Aurora Serverless
  v2 (minimum-ACU floor cost) — both are always-on spend, against scope rule.
- **Status:** not planned; recorded so the choice is settled if the question
  returns.

---

## 3. Grading & search-goals UX

The grading rubric is hardcoded in `src/prompts.js`; she can only steer it
indirectly. Biggest opportunity area.

### 3.1 Editable "Search goals / what matters to me" field — `[x]`
- **Priority:** high (highest leverage)
- **Done:** `preferences.goals` (free text) injected into **both** scoring
  (`buildSystemBlocks`, as an authoritative override block) and discovery
  (`buildDiscoveryUserMessage`). Editable via a friendly textarea in Settings →
  Profile & preferences (syncs with the raw-JSON editor).

### 3.2 Score-weighting preset — `[x]`
- **Priority:** medium
- **Done:** `preferences.scoreWeighting` (law-school | balanced | qualification)
  drives a `WEIGHTING POLICY` sentence in the scoring prompt; the static
  `overallScore` rubric line now defers to it. Default `law-school` preserves the
  historical behavior. Exposed as a radio group in Settings.

### 3.3 Per-listing re-score action — `[x]`
- **Priority:** high (makes 3.1 / 3.2 actually visible)
- **Decision:** per-listing (not bulk) — cheapest, most controlled.
- **Done:** `POST /api/listings/:key/rescore` re-scores one listing via the same
  `scoreOne` path as the scrape. A `⟳ Re-score` button lives in the roles modal's
  score card, plus a "Scored under older goals" hint shown when the score's
  `_scoredAt` predates `preferences.scoringConfigUpdatedAt` (stamped only when
  goals/weighting actually change).

### 3.4 Template `targetSchools` into the scoring prompt — `[x]`
- **Priority:** low
- **Where:** `src/prompts.js` (`SCORING_SYSTEM` + `buildSystemBlocks`)
- **Problem:** hardcoded "Columbia, NYU" / "T14" even though
  `profile.targetSchools` exists and is editable.
- **Done:** made the static rubric school-agnostic and added a "HER TARGET
  SCHOOLS" line built from `profile.targetSchools` — editing them now steers
  LAW SCHOOL VALUE.

---

## Loose end to confirm

### Scoring model: doc vs code mismatch — `[x]`
- `ARCHITECTURE.md §Cost` said scoring runs on **Haiku 4.5**, but the code uses
  `claude-sonnet-4-6` for listing + résumé/cover scoring.
- **Decision:** Sonnet is intentional (better judgment). Fixed the docs, not the
  code: corrected `ARCHITECTURE.md §Cost` and two stale `// Model: Haiku 4.5`
  comments in `src/prompts.js` (SCORING, RESUME-vs-JD) to Sonnet 4.6.

---

## Follow-ups (post-review enhancements)

### F1 Shimmer the table while listings lazy-load — `[x]`
- **Where:** `public/roles.js` (`renderSkeleton`), `public/style.css`
- **Context:** the `__INITIAL` fast-path renders real rows synchronously (no
  loading state). The **network fallback** in `load()` (direct asset reload /
  when the server inline didn't happen) left the table empty during the fetch.
- **Done:** render `.skel` shimmer rows + card placeholders (mirroring the real
  geometry, so no layout shift) before the `await api('/api/listings')`; `render()`
  swaps in the real rows. Reuses the existing `.skel` keyframe; reduced-motion
  drops the animation. Skipped for kanban view. `reloadData()` intentionally
  keeps existing rows (no blank flash on refresh).
- **Note:** visual pass pending — Chrome extension wasn't connected to drive it.

## Status

All items complete as of 2026-07-12. **2.2** (DynamoDB) stays intentionally
not-done — recorded for if the data model ever outgrows S3-JSON.

Shipped across these commits on `main`:
1. Page load — self-host fonts + lazy Sortable; lazy Anthropic SDK; parallel reads.
2. Grading — goals + weighting into scoring & discovery; per-listing re-score;
   target-schools templating.
3. Data model — `updateJson` ETag CAS + hot-writer migration.
4. Docs — scoring-model mismatch corrected (Sonnet, intentional).
