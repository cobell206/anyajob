# Serverless Transition

Living doc for moving anyaJob off the always-on EC2 box (~$10/mo) to a
zip-Lambda + S3 architecture that rounds to ~$0/mo for a single user.
Sibling project `coffeeScale` (nyespresso) is the reference for the AWS/CDK
shape — but note it was *born* serverless as a static SPA; anyaJob is a
stateful Express monolith, so the pattern is adapted, not copied.

**Status:** M0 + M1 complete (storage seam, S3 backend, CDK infra). M2 next.

**Infra is CDK, like espresso.** `infra/` holds the CDK app (`AnyaJobStack`).
No click-ops — every AWS resource is defined in code. Deploy: `cd infra &&
npx cdk deploy`. Account already CDK-bootstrapped (shared with espresso).

## Goal & guardrails

- Kill the ~$10/mo EC2 cost; land at ~$0/mo (Lambda + S3 + EventBridge free
  tiers cover single-user traffic).
- Single user, single deployment — stay proportionate to scope. No SaaS
  patterns, no per-user tiering, no auth rewrite.
- `npm run dev` must keep working unchanged against local `data/`.

## Target architecture

```
Cloudflare (Access auth + CDN — already ours; swap tunnel origin for the API GW)
        │
        ▼
API Gateway HTTP API ──► ONE zip Lambda running the existing Express app
   (throttling/stages)      via serverless-http (all routes unchanged)
        │                   │
        │                   ├──► S3 bucket: data/  (the JSON "database")
        │                   └──► S3 bucket: docs/  (uploaded resumes / covers)
        │
   No JWT authorizer for now — Cloudflare Access does auth at the edge. A
   Cognito HttpUserPoolAuthorizer can drop in later without touching compute.

EventBridge Scheduler ──► daily Lambda  (daily.js, same codebase)
                     └──► weekly Lambda (weekly.js, same codebase)
```

No API Gateway, no CloudFront, no containers, **no LibreOffice**.

### Lambda count: split by trigger, not by route
- 1 web Lambda — all 14 Express routers (a "lambdalith", like coffeeScale's
  `espresso-api`). Routing stays internal to Express.
- 1 daily Lambda, 1 weekly Lambda — separate only because EventBridge is a
  different trigger; same repo, different exported handler.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Compute | Single zip Lambda + `serverless-http` adapter | No route rewrites; fits 250MB zip once LibreOffice is gone |
| Storage | S3 objects (JSON blob per file) | App loads whole-file JSON and filters in memory — never queries by key, so DynamoDB buys nothing |
| Docs storage | S3 | Uploads + `documents.json` index |
| Uploads | **PDF only** (`.pdf` + `.txt`); reject docx at upload | Store confirmed 0 docx (all `.pdf`/`.txt`); PDFs already render client-side via `public/pdf-viewer.js` — nothing to build |
| Ingress | **API Gateway HTTP API** (mirrors coffeeScale) | Gateway protections — request throttling/stages cap runaway Anthropic/S3 spend; leaves a clean seam to add a Cognito authorizer later |
| Auth | **Keep Cloudflare Access** (for now) | Free, edge-side, zero app code; easy to swap to a Cognito authorizer on the gateway later without touching compute |
| Backup | S3 bucket versioning | Replaces today's `aws s3 sync` in `backup.js` |

## Why LibreOffice can go

`documents.js:convertDocxToPdf` shells out to LibreOffice **only** to render a
PDF preview of `.docx` uploads (browsers can't render docx inline). The
document store is confirmed **PDF-only** (0 docx), so this path is dead code:
restrict uploads to `.pdf`/`.txt` and delete `convertDocxToPdf`. PDFs already
render client-side via `public/pdf-viewer.js`, and PDF text extraction uses
pure-JS `pdf-parse` — both Lambda-safe today. `mammoth` (docx text) becomes an
unused dependency and can be dropped. Result: no container image, plain zip
Lambda.

## Workstreams

1. **Storage module (S3 + local-dev fallback).** Reimplement `atomic.js` +
   `io.js` against S3, keyed by basename. Redirect the stragglers that bypass
   them: direct `writeJsonAtomic(ABS_PATH, …)` callers (`daily.js`,
   `discover.js`, `summaries.js`, `score.js`, `dedupe.js`, `notify.js`,
   `sources/registry.js`, `feedback.js`) and the local readers in
   `discover.js` / `diagnostic.js`. Env flag `STORAGE=fs|s3`; no flag → local
   disk (dev unchanged). Delete the fsync-rename trick (S3 PUT is atomic).
   - **Concurrency caveat:** daily Lambda + web Lambda can both
     read-modify-write `listings.json`. Single-user, low risk. Add S3
     conditional writes (`If-Match` ETag) on hot files so a clobber retries.
2. **serverless-http adapter.** Add `src/lambda.js` wrapping `app`. API
   Gateway HTTP API (throttled stage) → this Lambda; no JWT authorizer yet.
   Shared-secret header check (Cloudflare injects; app rejects if absent) so
   the gateway URL isn't openly hittable.
3. **Restrict to PDF + drop LibreOffice.** Narrow `ALLOWED_EXTENSIONS` to
   `.pdf`/`.txt`, reject docx at upload with a clear message, delete
   `convertDocxToPdf` + the docx preview branch, drop the `mammoth` dep.
   (No client-side docx renderer needed — PDFs already render via
   `public/pdf-viewer.js`.)
4. **Documents → S3.** `saveDocument` writes buffer to S3; file endpoint
   streams from S3 (or 302 to presigned URL); `documents.json` index in S3.
5. **Cron + IaC + cutover.** Thin Lambda entrypoints for daily/weekly;
   EventBridge schedules; retire `backup.js`. CDK stack (`infra/`, copying
   coffeeScale's shape): buckets, Lambda(s), Fn URL, schedules, GitHub OIDC
   deploy role. One-time upload of current `data/` + `data/documents/`;
   repoint Cloudflare hostname; decommission EC2.

## Migration sequence

Strangler migration: make the **existing EC2 box** run the serverless-ready
app first (M0–M4), so the compute move (M5–M6) is a near-zero-risk hosting
swap. Once state lives in S3, EC2 and Lambda read the *same* data, so cutover
is a reversible Cloudflare origin flip with no data migration at the switch.
Each row is an independently mergeable/deployable PR with its own gate.

| # | Migration | Ships to | Validation gate | Rollback |
|---|-----------|----------|-----------------|----------|
| **M0** | **Storage seam + test harnesses.** Funnel all JSON access through one storage module (`fs` backend only) — pure refactor. Build the storage contract test + `scripts/smoke.mjs`. | EC2 (as today) | Unit suite green; **storage contract test green on `fs`**; smoke green vs local dev; a data file round-trips byte-identical | Revert commit |
| **M1** | **S3 storage backend** behind `STORAGE=fs\|s3` (default `fs`). | EC2, flag off | **Storage contract test green on `s3`** (same suite, both backends); run EC2 with `STORAGE=s3` on a seeded bucket → smoke green, writes land in S3 | Flip flag to `fs` |
| **M2** | **Restrict to PDF + delete LibreOffice** (drop `convertDocxToPdf`, `mammoth`). | EC2 | Unit test: `validateUpload` rejects `.docx`, accepts `.pdf`; grep confirms no `libreoffice`/`convertDocxToPdf` refs; browser: PDF previews, docx rejected with message | Revert commit |
| **M3** | **Documents → S3** (uploads + index; endpoint streams from S3). | EC2, `STORAGE=s3` | Smoke: upload via API → fetch back byte-equal; preview loads; index object in S3 | Flip flag to `fs` |
| **M4** | **Lambda + API Gateway in parallel** (`serverless-http` + CDK stack), reads the same S3. **No prod traffic.** | New infra, dark | **`smoke.mjs --compare <EC2> <API-GW>`** returns identical for key endpoints while both read shared S3 | Delete stack; nothing user-facing touched |
| **M5** | **Traffic cutover** — Cloudflare origin → API Gateway; add shared-secret header + Access verify. | Cloudflare | Smoke green vs production hostname; flip-back rehearsed once; error logs clean over a soak window | Point Cloudflare back to EC2 |
| **M6** | **Cron → EventBridge** (daily/weekly Lambdas; disable EC2 crontab). | New infra | Manually invoke each scheduled Lambda → new listings/summary in S3 + notification fired; confirm no double-run (EC2 crons off) | Re-enable EC2 crons |
| **M7** | **Decommission EC2** — *stop* first, soak ~1 week, then terminate. | — | Site + crons healthy for a week with EC2 stopped | Start EC2 back up (until terminated) |

**Dependencies:** M0 → M1 → M3 → M4 → M5; M2 independent but before M4 (zip-ability); M6 needs M1; M7 last after M5+M6 soak.

## Testing strategy

Every migration is gated by **(a) the unit suite green** (`npm test`) **plus
(b) its row-specific check** above. Two new harnesses, both built in M0, make
the later gates possible:

- **Storage contract test** — one parametrized suite run against *both*
  backends (`fs` and `s3`), asserting identical behavior: read/write
  round-trip, missing-file fallback, corrupt-JSON recovery (the
  `tryParseLeadingJson` path), atomic replace (no partial reads), and
  concurrent-write / `If-Match` retry. S3 runs against a scratch bucket. This
  is what lets M1 claim "s3 == fs" instead of hoping.
- **`scripts/smoke.mjs`** (mirrors coffeeScale) — hits a base URL's key
  endpoints (`GET /`, `/api/diagnostic`, `/api/listings`, a document fetch) and
  asserts status + response shape. Parameterized by base URL (localhost / EC2 /
  API Gateway). A `--compare A B` mode diffs two origins → the M4/M5 parity
  gate. `/api/diagnostic` is the anchor: a redacted state snapshot already
  exists to assert against.

Existing unit tests (`redact`, `discover`, `dedupe`, `resilience`, `location`)
stay as the regression guard and must pass on every PR (they already gate the
CI deploy).

## Open questions

- [x] Ingress: **API Gateway HTTP API** (for gateway throttling/stages;
      Cognito authorizer can be added later).
- [x] Auth: **Keep Cloudflare Access** for now; migrate to a gateway Cognito
      authorizer later if ever needed.
- [x] Upload formats: **PDF-only confirmed** (store has 0 docx) — docx preview
      workstream dropped.

## Progress log

- 2026-07-11 — Plan drafted; reference architecture (coffeeScale) reviewed;
  storage seam + LibreOffice role mapped in code. Nothing implemented yet.
- 2026-07-11 — Confirmed document store is PDF-only (0 docx). Dropped the
  client-side docx-preview workstream; LibreOffice removal is now pure dead-code
  deletion + PDF-only upload validation.
- 2026-07-11 — Decided ingress = API Gateway HTTP API (gateway throttling; room
  for a Cognito authorizer later); auth stays Cloudflare Access for now. All
  open questions resolved.
- 2026-07-11 — Added M0–M7 migration sequence with per-migration validation
  gates + testing strategy. Two harnesses (storage contract test, smoke/parity
  script) to be built in M0 — they underpin every later gate. Doc ready; no
  code changed yet.
- 2026-07-11 — **M0 done.** New `src/store.js` is the single storage seam
  (fs backend; `readJson/readJsonSafe/readJsonStrict/writeJson/readRaw/writeRaw/
  exists/removeFile`, keyed by basename). `io.js` + `atomic.js` reduced to thin
  re-exports, so all `readJson`/`writeJsonAtomic` callers are untouched.
  Converted the ~24 direct `JSON.parse(readFile(...))` sites across summaries,
  score, daily, discover, notify, sources/registry, dedupe, feedback,
  documents, page, diagnostic — nothing bypasses the seam now (binaries/logs
  still use raw fs, by design). Built `src/store.contract.test.js` (10 tests,
  runnable against either backend — M1 flips `STORAGE=s3`) and
  `scripts/smoke.mjs` (health + `--compare` parity; `npm run smoke`).
  Gate: `npm test` 76/76 green; smoke green vs a booted server; contract temp
  files cleaned. Left a NOTE in registry.js: first-run seed uses `existsSync` →
  M1 swaps to `store.exists`. `STORAGE` env selects backend; unset ⇒ fs, so
  dev is unchanged.
- 2026-07-11 — M0 merged to main (7137d73) and **deployed to EC2** via CI
  (tests green, SSH deploy 9s). Running in production on the fs backend, still
  reading the same data/ files. M1 (S3 backend behind STORAGE=s3) is next.
- 2026-07-11 — **M1 done.** Added the `s3` backend to `store.js` (Get/Put/Head/
  Delete via `@aws-sdk/client-s3`; missing objects mapped to ENOENT so
  `readJsonSafe` fallback matches fs). `STORAGE=s3` + `S3_BUCKET` selects it;
  unset ⇒ fs, so EC2/dev unchanged. Swapped `registry.js`'s `existsSync` for
  `store.exists`; exposed `exists/removeFile/readRaw/writeRaw` through the
  `io.js` facade.
  **Infra as CDK (decision B — no click-ops):** scaffolded `infra/` mirroring
  espresso (`node bin/infra.ts` type-stripping, `AnyaJobStack`). Deleted the
  imperative test bucket; `cdk deploy` now owns `anyajob-data` (RETAIN +
  versioned + block-public + enforce-SSL). `data/*.json` seeded via
  `aws s3 sync`.
  Gate: contract suite **10/10 on both fs and s3** (against the CDK bucket);
  the real Express app booted with `STORAGE=s3` → smoke green; `smoke --compare`
  fs-vs-s3 origins **identical** across all probes (also validates the M4/M5
  parity harness early). fs full suite still 76/76.
