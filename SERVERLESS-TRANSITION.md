# Serverless Transition

Living doc for moving anyaJob off the always-on EC2 box (~$10/mo) to a
zip-Lambda + S3 architecture that rounds to ~$0/mo for a single user.
Sibling project `coffeeScale` (nyespresso) is the reference for the AWS/CDK
shape — but note it was *born* serverless as a static SPA; anyaJob is a
stateful Express monolith, so the pattern is adapted, not copied.

**Status:** M0–M5 complete. **Production traffic is now served by the Lambda +
API Gateway** — `jobs.anyalawgirly.com` (Cloudflare, Full-strict) → Access →
JWT authorizer → `anyajob-web` Lambda → S3. EC2 is idle (still on S3) as the
rollback path. CI deploys both EC2 and the Lambda/infra on push. Remaining:
**M6** (cron → EventBridge) and **M7** (decommission EC2 — the actual $10/mo
saving). Post-flip UX (esp. the async scoring modal) to confirm in-browser.

**Serverless env (set on EC2 to run on S3; becomes Lambda env at M4):**
`STORAGE=s3  S3_BUCKET=anyajob-data  DOCS_BUCKET=anyajob-docs  AWS_REGION=us-east-1`

**Buckets now hold real production data** (migrated 2026-07-11 from the live
EC2 box: 10 JSON + 97 documents, sizes byte-matched). EC2 is still the live
writer (fs), so S3 will drift again until the `STORAGE=s3` flip — re-run the
migration `execute` one final time immediately before flipping EC2 to S3
(M3.5). Mechanism: `.github/workflows/s3-migrate.yml` (OIDC role assumes
`anyajob-github-deploy`, runs `scripts/migrate-to-s3.mjs` on EC2 with injected
short-lived creds). Uses `PutObject` per file (not `sync` — dev-snapshot
timestamps would have caused skips).

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
| **M3.5** | **Migrate prod data + cut EC2 over to `STORAGE=s3` and soak** (added per review — validate the data layer on real data + real traffic before Lambda). Migrate: `s3-migrate.yml` execute. Then set `STORAGE=s3`+bucket envs on EC2, restart. | EC2 (now on S3) | Final `s3-migrate execute` right before flip; app healthy on S3; daily cron writes land in S3; doc upload lands in `anyajob-docs`; soak a few days | Set `STORAGE=fs`, `sync` S3→disk if writes occurred |
| **M4** | **Lambda + API Gateway in parallel** (`serverless-http` + CDK stack), reads the same S3. **No prod traffic.** | New infra, dark | **`smoke.mjs --compare <EC2-on-s3> <API-GW>`** identical, both on the same live S3 data | Delete stack; nothing user-facing touched |
| **M5** | **CI-managed CDK deploys + traffic cutover** — (A) move `cdk deploy` into GitHub Actions via the OIDC role so Lambda deploys from a push (not local); (B) resolve prod auth (Cloudflare can't SigV4-sign the IAM route); (C) flip Cloudflare origin EC2 → API Gateway. See the M5 runbook. | Cloudflare + CI | A: no-op push redeploys green + parity identical. C: smoke green vs prod hostname; browser scoring pass; flip-back rehearsed; logs clean over soak | Point Cloudflare back to EC2 |
| **M6** | **Cron → EventBridge** (daily/weekly Lambdas; disable EC2 crontab). | New infra | Manually invoke each scheduled Lambda → new listings/summary in S3 + notification fired; confirm no double-run (EC2 crons off) | Re-enable EC2 crons |
| **M7** | **Decommission EC2** — *stop* first, soak ~1 week, then terminate. | — | Site + crons healthy for a week with EC2 stopped | Start EC2 back up (until terminated) |

**Dependencies:** M0 → M1 → M3 → M3.5 → M4 → M5; M2 independent but before M4 (zip-ability); M6 needs M1; M7 last after M5+M6 soak.

## M4 runbook — Lambda + API Gateway in parallel (dark)

**Objective:** stand up the web app as a zip Lambda behind an API Gateway HTTP
API, reading the *same live S3* that EC2 already serves (M3.5). **Zero prod
traffic** — Cloudflare still points at EC2. Success = the Lambda origin is
byte-for-byte identical to the EC2 origin on the same data. This is a pure
compute-host swap; the data layer is already proven.

**Safety model:** additive-only. Nothing user-facing changes until M5. If
anything is wrong, `cdk destroy` the new constructs and prod is untouched.

### Pre-flight — confirmed against the code (not assumed)
- `src/server.js:36` builds `const app = express()`; `:145` calls
  `app.listen(port)` directly — **the app is not exported.** M4 must export
  `app` and guard the listen so importing the module (Lambda) doesn't bind a
  port. (`npm run dev` and the systemd unit both still run `server.js`
  directly, so they must keep listening.)
- Only shell-out in the request path is `src/routes/admin.js:36` — `spawn`ing
  `node scripts/daily.js` for the "run daily now" button. **This cannot work in
  Lambda** (no long child process, 15-min cap). It's cron territory → M6. For
  M4, that route is excluded from the parity gate and left to no-op/501 on
  Lambda (decision D2 below).
- No `pdftotext`/poppler/libreoffice/mammoth anywhere in `src/` — text
  extraction is pure-JS / Anthropic SDK. Zip Lambda is viable (M2 premise,
  re-confirmed).

### Known-fiddly bits (where a flop would come from — handle explicitly)
1. **Binary responses through API Gateway.** `docstore.getDocStream` pipes PDF
   bytes to `res`. HTTP API + Lambda proxy only returns binary via base64 +
   `isBase64Encoded: true`. `serverless-http` handles this **only** when the
   response content-type is in its `binary` allowlist — must configure
   `binary: ['application/pdf', 'application/octet-stream']` (or `binarySettings`
   by matching content-types). **The parity gate must fetch a real résumé PDF
   and byte-compare it**, not just diff `/api/listings` JSON. This is the single
   most likely silent break.
2. **Response payload cap.** API Gateway caps responses at ~6 MB (base64 inflates
   ~33%, so ~4.5 MB of real bytes). Current docs are small résumé/cover PDFs, so
   fine — but note it. If a doc ever exceeds it, switch that route to a
   `302 → presigned S3 URL` (already floated in workstream 4). Not needed now.
3. **Dark URL must not be openly hittable during soak.** Cloudflare Access only
   fronts the origin at M5. **Decision D1 = IAM auth on the API route**
   (`authorizationType: AWS_IAM`): only SigV4-signed callers with
   `execute-api:Invoke` get in — no secret to leak, nothing serves her résumé to
   an anonymous URL. Cost: `smoke.mjs --compare` must **SigV4-sign** its requests
   to the API-GW origin (plain requests to the EC2 origin). **M5 handoff wrinkle
   to resolve later, not now:** Cloudflare can't SigV4-sign, so at cutover the
   route auth must change (swap to `NONE` behind Cloudflare Access, or sign in a
   Cloudflare Worker). IAM auth is strictly the dark-soak guard; the M5 row
   revisits the production auth model.
4. **Lambda env + region.** The serverless env (`STORAGE=s3 S3_BUCKET=anyajob-data
   DOCS_BUCKET=anyajob-docs AWS_REGION=us-east-1`) plus `ANTHROPIC_API_KEY` and
   the SES/notify vars must be set as Lambda environment from CDK — pulled from
   the same source as EC2's `.env`. Secrets go via CDK context/SSM, not
   committed.

### Decisions to lock before coding
- **D1 — dark-soak auth:** **IAM auth on the API route** (`AWS_IAM`). Only
  SigV4-signed callers with `execute-api:Invoke` reach the Lambda; `smoke.mjs`
  signs. No app-level header/middleware needed. M5 must revisit the auth model
  (Cloudflare can't sign — see fiddly bit #3).
- **D2 — admin manual-daily route on Lambda:** return `501 Not Implemented`
  (the button belongs to M6/EventBridge). Excluded from the parity gate.
- **D3 — one Lambda vs many:** M4 ships the **web lambdalith only**. Daily/weekly
  handlers are M6. Keeps M4 to one deployable.

### Steps
1. **Export the app.** `src/server.js`: `export const app` (or move app assembly
   to `src/app.js` and have `server.js` import + listen). Guard the listen:
   only `app.listen` when run as the entrypoint, not when imported. Unit suite +
   `npm run dev` must stay green.
2. **Adapter.** New `src/lambda.js`: `import serverless from 'serverless-http'`;
   `export const handler = serverless(app, { binary: [...] })`. No app-level auth
   middleware — auth is the gateway's job (D1, IAM). `npm install serverless-http`
   (not yet installed).
3. **CDK — extend `AnyaJobStack`** (`infra/lib/anyajob-stack.ts`), additive:
   - `NodejsFunction` (or zip asset) `anyajob-web`, handler `src/lambda.handler`,
     `runtime nodejs20`, env from step-4 vars, `timeout ~30s`, `memory 512MB`.
   - `grantReadWrite` **both** buckets to the Lambda role (mirror `ec2Role`).
   - `HttpApi` with a default route → Lambda integration, **`AWS_IAM`
     authorization** (D1) on the route, a throttled stage.
   - Grant the signing principal (my/CI local creds during soak)
     `execute-api:Invoke` on the API.
   - Store `ANTHROPIC_API_KEY`/SES secrets via SSM SecureString param +
     `fromSecureString` (or CDK context) — **never** literal in code.
   - Output the invoke URL (`CfnOutput`).
4. **Deploy dark.** `cd infra && npx cdk deploy`, run **locally via `!`**
   (decision: not through the CI OIDC role — it has S3 only). No Cloudflare change.
5. **Parity gate.** `scripts/smoke.mjs --compare <EC2-on-s3 base> <API-GW base>` —
   **SigV4-signing requests to the API-GW origin** (add `@aws-sdk/signature-v4` +
   a hasher, or `aws4`; EC2 origin stays unsigned). Must assert, at minimum:
   - `GET /api/listings` — identical count + payload.
   - `GET /api/diagnostic` — identical redacted snapshot (the existing anchor).
   - **A real document fetch — byte-identical PDF** (extend smoke if it only
     checks status today; this is the #1 fiddly bit).
   - Admin manual-daily route excluded (D2).
6. **Green = M4 done.** Log it. Do **not** touch Cloudflare — that's M5.

### Validation gate (row M4)
`smoke.mjs --compare` **identical across all probes including a byte-equal PDF
download**, both origins on the same live S3, admin-spawn route excepted.

### Rollback
`cdk destroy` the M4 constructs (Lambda + HTTP API; buckets are RETAIN and
shared, so they stay). Nothing user-facing was ever pointed at the new origin,
so rollback is invisible to prod.

## M4.5 runbook — async scoring (unblocks M5)

**Why:** M4 dark-deploy proved the read/serve path (parity green, incl. binary
PDF). But résumé **scoring takes ~54 s** (a Claude call with the PDF as a
document block), and **API Gateway HTTP API hard-caps integration at 30 s** — so
scoring 503s through the gateway. Direct-invoke confirmed the Lambda itself
scores fine in 54 s (HTTP 200, real feedback), so it's purely the gateway
ceiling. Must be fixed before M5 (real traffic). **Decision (user): async +
poll**, keeping API Gateway for everything.

**Surface (only one flow is actually wired to the UI):**
- `POST /api/profile/resume/feedback {lens}` → `generateResumeFeedback` (54 s),
  persists to the documents index (`current.feedback[lens]`, has `generatedAt`);
  `GET /api/profile/resume/feedback?lens` reads it back. Frontend: `profile.js`.
- `POST /api/documents/:fp/score-resume|score-cover` are also >30 s but have **no
  frontend callers** (dormant) — deferred; left returning their current result
  (they'd 503 only if someone wired them up). Tracked, not fixed now.

**Design:**
- **POST** becomes fire-and-forget: mark the lens `status:'pending'` in the
  index, async-invoke the worker (`InvocationType:'Event'`), return `202
  {status:'pending'}`.
- **Worker Lambda** (`anyajob-scoring-worker`, same asset, `src/worker.handler`,
  300 s timeout): runs `generateResumeFeedback({lens})` — which persists the
  done entry — then on `{error}`/throw persists `status:'error'`.
- **Status model:** the persisted feedback entry carries `status`
  (`pending|done|error`) alongside the existing fields; a pending marker
  replaces the prior entry. `GET` already returns the entry, so the frontend
  reads status from it.
- **Frontend** (`profile.js`): POST → show "scoring…" → poll `GET` every ~3 s
  until `status==='done'` (render) or `'error'` (surface) or ~2 min timeout.

**Chunks:**
1. Backend: `status` field + `markPending`/`markError` helpers in `feedback.js`;
   POST → 202 + async-invoke; new `src/worker.js`; add `@aws-sdk/client-lambda`.
2. CDK: worker Lambda + `lambda:InvokeFunction` grant + `SCORING_WORKER_FN` env
   on the web fn; web timeout back to 30 s (reconcile the 120 s measurement
   drift); `npm run bundle:lambda` unchanged (worker shares the asset).
3. Frontend: `profile.js` polling + scoring/error UI states.
4. Deploy + validate: POST returns 202 fast; poll → done; worker CloudWatch shows
   completion; parity smoke still green.

**Rollback:** worker + async are additive; reverting the POST handler to the
synchronous path restores today's behavior (which only fails >30 s through the
gateway anyway).

**Progress:**
- 2026-07-11 — **M4.5 chunk 1 (backend async) done.** `feedback.js`: success
  entry now carries `status:'done'`; added `markResumeFeedbackPending/Error`
  (status-only markers, `resumeFile`-matched so GET surfaces them) and
  `startResumeFeedback` — the dual-mode entrypoint: **async 202 + worker invoke
  when `SCORING_WORKER_FN` is set (Lambda), synchronous inline otherwise (EC2/
  local, unchanged)**. New `src/worker.js` (off the same asset, `worker.handler`)
  runs `generateResumeFeedback` and records done/error. `routes/profile.js` POST
  → `startResumeFeedback`, 202 on pending. Added `@aws-sdk/client-lambda`.
  Validated: 89/89 suite; module graph imports; pending/error status round-trips
  through GET locally (index restored after). Next: CDK worker Lambda (chunk 2).
- 2026-07-11 — **M4.5 chunk 2 (CDK worker) done + synth-validated.** Factored a
  shared `appAsset` + `commonEnv`; added **`anyajob-scoring-worker`**
  (`src/worker.handler`, 300 s, S3 rw, no SES/invoke). Web fn gets
  `SCORING_WORKER_FN` = the worker's name and `grantInvoke` on it; web timeout
  reset to 30 s (reconciles the 120 s measurement drift). Rebuilt the asset
  (176 M) — `worker.js` + `@aws-sdk/client-lambda` included. Synth confirms both
  functions, the env flag, and the `lambda:InvokeFunction` grant. Deploy (via
  `!`) then validate the async path before the frontend chunk.
- 2026-07-11 — **M4.5 chunk 2 DEPLOYED + async path proven on real infra.**
  Stack `UPDATE_COMPLETE`; both fns Active (web 30 s w/ `SCORING_WORKER_FN`,
  worker 300 s). Signed POST → **202 `{status:pending}` instantly** (no 30 s
  gateway timeout); polled GET flipped `pending → done` at ~55 s with real
  feedback — the full web→worker→S3→poll loop works. Also confirmed the **web
  Lambda GET extracts résumé text (4596 chars)** → the linux `@napi-rs/canvas`
  binary loads and works there (it IS load-bearing, for the GET's quote-anchor
  extraction, even though PDF scoring skips it).
- 2026-07-11 — **M4.5 chunk 3 (frontend polling) done.** `public/profile.js`
  `runFeedback` is now dual-mode: **202 → `pollResumeFeedback` (GET every 3 s,
  150 s timeout)**, **200 → today's synchronous render** (EC2/local). Added a
  `displayEntry` guard so `pending`/`error` markers (and a page reload mid-
  scoring) don't render as feedback; legacy statusless entries count as done.
  Syntax-checked; `profile.js` is the only POST consumer (rest are GET); suite
  89/89. Contract already proven end-to-end, so the frontend is validated by
  proxy. Next: rebuild asset + redeploy so the Lambda serves the new frontend
  (chunk 4), optional local browser UX test.
- 2026-07-11 — **M4.5 chunk 4 (redeploy) done — M4 + M4.5 COMPLETE.** Rebuilt
  the asset (new `profile.js`) and redeployed (code-only, no IAM; 47 s,
  `UPDATE_COMPLETE`). Validated contract-only (backend unchanged since the proven
  chunk-2 deploy, so no extra scoring run): signed GET `/profile.js` from the
  Lambda serves the polling frontend (`pollResumeFeedback` + 202 handling, 200);
  parity re-check **green** across all probes incl. binary PDF. The dark Lambda
  is now feature-complete on the same live S3. **M5 remains** (Cloudflare origin
  flip + auth-at-cutover); a full browser UX pass can be done then behind
  Cloudflare, or locally against the real worker beforehand if desired.

## M5 runbook — CI-managed deploys + traffic cutover

Three parts, in this order. Part A lands **before** the flip so the soon-to-be-
production Lambda is deployed by CI from a git push, never hand-built locally.

### Part A — move CDK deploys into GitHub Actions (per lockstep review)
Today: push→main deploys **EC2 only** (`deploy.yml`); the **Lambda is deployed
by local `cdk deploy`** — decoupled from git, so it can silently drift. Fix:
- New workflow (e.g. `deploy-infra.yml`), `on: push: [main]`, `permissions:
  id-token: write`. Assume **`anyajob-github-deploy`** (the OIDC role already
  exists), then `npm ci` → `npm run bundle:lambda` → `cd infra && npm ci &&
  npx cdk deploy --require-approval never --parameters AnthropicApiKey=$(aws ssm
  get-parameter --name /anyajob/anthropic-api-key --with-decryption --query
  Parameter.Value --output text)`.
- **Expand the OIDC role** (currently S3-rw only): add `sts:AssumeRole` on the
  CDK bootstrap roles (`cdk-hnb659fds-{deploy,file-publishing,lookup}-role-
  <acct>-<region>`) — cdk assumes those, so the OIDC role needs nothing broad —
  plus `ssm:GetParameter` + `kms:Decrypt` (via `ssm.<region>.amazonaws.com`) for
  the Anthropic param. Codify this in `AnyaJobStack` (it defines the role).
- **Bundle build in CI is simpler:** the runner is linux-x64, so `npm ci`
  installs `@napi-rs/canvas-linux-x64-gnu` natively; the build script's tarball
  fetch becomes a redundant no-op (harmless) and the darwin binary is absent
  (smaller asset). No Docker.
- **Sequencing:** run after `npm test`; keep the EC2 `deploy.yml` for now (both
  fire on push — EC2 + Lambda stay in lockstep). Remove the EC2 deploy at M7.
- Gate: a no-op push redeploys the stack green; `parity-m4.sh` still identical.

### Part B — resolve the production auth model (Cloudflare can't SigV4-sign)
The dark route uses `AWS_IAM` (great for the soak — only signed callers). But at
cutover Cloudflare proxies user requests to the origin and **cannot SigV4-sign**,
so IAM auth can't stay as-is. Options (decision needed):
- **Route auth → `NONE`, rely on Cloudflare Access at the edge** (+ optionally a
  shared-secret header the app checks, so the raw `execute-api` URL isn't openly
  hittable). Simplest; matches "keep Cloudflare Access" (Key decisions table).
- **Cloudflare Worker signs** each request with SigV4 — keeps IAM on the route
  but adds a Worker + credential management. Heavier.
Recommendation: route `NONE` + Cloudflare Access, plus a shared-secret origin
header. Update the CDK route auth + the app's header check accordingly.

### Part C — the Cloudflare origin flip
- Point the Cloudflare hostname/tunnel from EC2 to the API Gateway URL.
- Gate: `smoke.mjs` green against the **production hostname**; a browser pass of
  the real scoring modal (now truly end-to-end behind Cloudflare); flip-back
  rehearsed once; error logs clean over a soak window.
- Rollback: point Cloudflare back to EC2 (still running, same S3).

### M5 Part A progress
- 2026-07-11 — **A1 (expand OIDC deploy role) written + synth-validated.** Added
  to `anyajob-github-deploy`: `sts:AssumeRole` on the CDK bootstrap roles
  (`cdk-hnb659fds-{deploy,file-publishing,lookup}-role-<acct>-us-east-1`, which
  exist) so CI's `cdk deploy` works through them without broad perms; plus
  `ssm:GetParameter` on `/anyajob/anthropic-api-key` and `kms:Decrypt` (via
  `ssm.us-east-1.amazonaws.com`) to read the key at deploy. Synth confirms.
  Applied by a **local `cdk deploy`** first (the role is defined in the stack it
  will later deploy — chicken-and-egg), then A2 adds the CI workflow.
- 2026-07-11 — **A1 applied** via local `cdk deploy` (26 s, deploy-role policy
  only). Role now carries the assume-role + SSM perms.
- 2026-07-11 — **A2 (`deploy-infra.yml`) written.** On push to main (non-doc):
  `test` job (node 20, `npm ci` + `npm test`) → `deploy` job (node **24** for
  `bin/infra.ts` type-stripping) that OIDC-assumes `anyajob-github-deploy`,
  `npm run bundle:lambda`, reads the SSM key (masked), `cd infra && npm ci &&
  npx cdk deploy --parameters AnthropicApiKey=…`. `aws-cdk` CLI is already an
  infra devDep; the linux runner installs canvas natively. Separate concurrency
  group from the EC2 deploy so both run in parallel; EC2 workflow retires at M7.
  Pushed together with A1 — this push is the first CI-driven `cdk deploy`.
- 2026-07-11 — **M5 Part A COMPLETE.** First CI-driven `cdk deploy` green
  (OIDC → `bundle:lambda` → `cdk deploy`, 1m12s); EC2 deploy ran green in
  parallel; stack `UPDATE_COMPLETE`; `parity-m4.sh` identical incl. binary PDF.
  **Lockstep closed:** one push to main now deploys EC2 (deploy.yml) AND the
  Lambda + infra (deploy-infra.yml) — no more local hand-deploys. Remaining M5:
  Part B (prod auth model — Cloudflare can't SigV4-sign the IAM route) then
  Part C (Cloudflare origin flip EC2 → API Gateway).

## M5 Part C runbook — coordinated auth-swap + origin flip

The production cutover. Put Cloudflare in front of the API Gateway and swap the
route auth IAM → JWT (Cloudflare Access) in one coordinated move. EC2 stays up on
S3 the whole time, so rollback is a Cloudflare route change.

**Locked config (Part B):** issuer `https://anyalawgirly.cloudflareaccess.com`,
audience `462fb46b785402e6f15358091d1087cee76b8c319132ccc85c2a58823e12f189`,
identity source `$request.header.Cf-Access-Jwt-Assertion`.

### Decision C1 — how Cloudflare reaches the API Gateway
The `execute-api` URL is public and API Gateway's default endpoint only answers to
its own host, so Cloudflare needs a way to forward `jobs.anyalawgirly.com` to it.
- **A. API Gateway custom domain + ACM cert + proxied CNAME.** Most standard,
  AWS side stays in CDK (`apigwv2.DomainName` + mapping). One-time manual bits:
  ACM cert DNS-validated via a Cloudflare CNAME, and the routing CNAME. Works on
  any Cloudflare plan.
- **B. Cloudflare Worker proxies to the `execute-api` URL.** ~10 lines
  (`fetch` with hostname rewritten, headers forwarded incl. the Access JWT). No
  ACM/custom-domain/Host-SNI fuss — lowest flop risk on the connection — but the
  Worker is Cloudflare-side code (version it in the repo).
- **C. Proxied CNAME + Cloudflare Origin Rule** overriding Host+SNI to the
  `execute-api` host. Simplest if available, but Host/SNI override may be
  plan-gated — confirm the account's Cloudflare plan first.
Cloudflare Access stays on `jobs.anyalawgirly.com` throughout (it injects the
`Cf-Access-Jwt-Assertion` header the JWT authorizer validates).

### Steps
1. **CDK — JWT authorizer** (`HttpJwtAuthorizer`): issuer/audience/identitySource
   above, replacing `HttpIamAuthorizer` as the route's default authorizer. Plus
   the custom domain if C1=A. (Verify the authorizer accepts the *raw* token from
   `Cf-Access-Jwt-Assertion` — Cloudflare sends no `Bearer` prefix.)
2. **Fix asset cache-stamping** (prereq): `deploy.yml` seds the commit SHA into
   `__CACHE_VERSION__` on EC2, but the Lambda bundle ships the placeholder
   unstamped → `server.js` falls into its dev-mode request-time substitution, so
   the Lambda serves assets `no-cache` (every asset = a Lambda hit). Stamp the
   SHA in `build-lambda-bundle.sh` so the Lambda serves immutable, Cloudflare-
   cacheable assets. Do this before real traffic.
3. **Validate on a staging hostname first** (e.g. `jobs-test.anyalawgirly.com`
   under the same Access app): full chain browser → Access login → JWT authorizer
   → Lambda → real listings + a scoring run. Proves the auth path before touching
   prod DNS.
4. **Flip:** deploy JWT auth (CI `cdk deploy`), then point Cloudflare
   `jobs.anyalawgirly.com` at the API Gateway. Order: JWT auth first (Lambda then
   requires the Access JWT — still dark/unreachable, fine), then the Cloudflare
   route (starts supplying JWTs → live).
5. **Validate prod:** browser through `jobs.anyalawgirly.com` (Access → app loads,
   listings, scoring end-to-end). `smoke.mjs` now needs an Access **service
   token** (or run via browser) since SigV4 no longer applies. Soak; watch
   Lambda + API Gateway logs.

### Rollback
Point Cloudflare `jobs.anyalawgirly.com` back to the EC2 tunnel (still live on
S3). Optionally revert the route auth JWT → IAM. No data moves.

### C1 = A (API Gateway custom domain + ACM), chosen. Chunking:
- **C-1:** CDK adds an **ACM cert** for `jobs.anyalawgirly.com` (DNS-validated).
  Deploy → CDK/ACM emits a validation CNAME → **add it to Cloudflare DNS by
  hand** → wait for `ISSUED`. (DNS is on Cloudflare, not Route53, so validation
  is manual. Do cert-first so the blocking wait isn't tangled with the domain.)
- **C-2:** CDK adds the **custom domain + API mapping** (needs the ISSUED cert) +
  the **JWT authorizer** (swap from IAM) + the **asset cache-stamp fix** in the
  bundle build. Deploy via CI. Lambda now requires an Access JWT (still dark).
- **C-3:** **The flip** — in Cloudflare DNS, point `jobs.anyalawgirly.com` at the
  custom domain's regional target (proxied, Access stays on). Validate in a
  browser end-to-end (Access → app → listings → scoring), soak, watch logs.
  Rollback = repoint the CNAME back to the EC2 tunnel.
- Ideally rehearse C-3 on `jobs-test.anyalawgirly.com` first (own cert/mapping)
  before flipping the real hostname.

### Open items to confirm at execution
- JWT authorizer accepts the raw `Cf-Access-Jwt-Assertion` value (no `Bearer`).
- A Cloudflare Access **service token** for automated `smoke.mjs` post-flip.
- Cloudflare SSL mode = **Full (strict)** so it trusts the ACM cert on origin.

### Part C progress
- 2026-07-11 — **C-1 done. ACM cert ISSUED.** Added `SiteCert`
  (`jobs.anyalawgirly.com`, DNS-validated) to the stack; local `cdk deploy`
  created it PENDING and blocked; added the ACM validation CNAME to Cloudflare
  DNS (grey-cloud) by hand → **ISSUED in ~80 s**, stack `UPDATE_COMPLETE`. Then
  pushed `9faa542` — CI `cdk deploy` saw the cert already issued and went green
  (no hang). Cert ARN
  `arn:aws:acm:us-east-1:378962034618:certificate/180feb7f-a742-4c80-ba95-4fa972974238`.
  Next: C-2 (custom domain + mapping + JWT authorizer swap + asset cache-stamp).
- 2026-07-11 — **C-2 built.** CDK: swapped the route authorizer IAM →
  `HttpJwtAuthorizer` (issuer = Access team domain, audience = the AUD,
  identitySource = `$request.header.Cf-Access-Jwt-Assertion`); added
  `ApiDomain` (custom domain `jobs.anyalawgirly.com` on the C-1 cert) +
  `ApiMapping` to the $default stage; output `WebApiRegionalDomain` (the
  `d-xxx.execute-api…` target Cloudflare will CNAME to at C-3).
  `build-lambda-bundle.sh` now stamps the commit SHA into `__CACHE_VERSION__`
  (perl, mac/linux-portable) so the Lambda serves production/immutable assets
  instead of dev-mode `no-cache`. Synth confirms JWT route auth + custom domain +
  mapping; rebuilt bundle has no `__CACHE_VERSION__` left. Deploying via CI; the
  dark Lambda now requires an Access JWT (SigV4 parity no longer applies — that's
  expected), validated by config + a negative (401) check, positive test at C-3.
- 2026-07-11 — **C-2 deployed (CI) + validated.** Custom domain
  `jobs.anyalawgirly.com` is **AVAILABLE** with the C-1 cert; regional target for
  the C-3 flip = **`d-qpq1b1ahih.execute-api.us-east-1.amazonaws.com`**.
  Unauthenticated `GET /api/listings` -> **401** (JWT authorizer live; was IAM
  403). Positive path (real Access JWT -> 200) needs Cloudflare in front -> C-3.
  **C-3 first check:** confirm the JWT authorizer accepts Cloudflare's *raw*
  `Cf-Access-Jwt-Assertion` (no `Bearer`) — a quick test with a real Access
  token, a `jobs-test` rehearsal, or flip-with-instant-rollback.
- 2026-07-11 — **Raw-token risk RETIRED (pre-flip test).** Sent a real
  `Cf-Access-Jwt-Assertion` (from the browser `CF_Authorization` cookie) to the
  execute-api URL → **HTTP 200**; token `aud`/`iss` match the authorizer. So the
  gateway accepts Cloudflare's raw token as-is (no `Bearer`) and the C-3 flip is
  safe. Remaining C-3 = the Cloudflare DNS change (`jobs.anyalawgirly.com` →
  `d-qpq1b1ahih…`, proxied, Access on, SSL Full-strict) + browser validation.
- 2026-07-11 — **C-3 DONE — production flipped to the Lambda. M5 COMPLETE.**
  Removed the `jobs.anyalawgirly.com` tunnel public hostname and pointed the
  proxied CNAME at the API Gateway custom-domain target
  `d-qpq1b1ahih.execute-api.us-east-1.amazonaws.com`. Validated end-to-end:
  no-auth = **302** (Access still guards it), authed (real `CF_Authorization`
  cookie) = **200 with 55 listings from S3** — the full Cloudflare / Access /
  JWT authorizer / Lambda / S3 chain, and Full-strict trusts the ACM cert (no
  526). **EC2 no longer serves traffic** (idle, still on S3 = instant rollback:
  re-add the tunnel public hostname). Next: browser-confirm the async scoring
  modal, then M6 (cron to EventBridge) and M7 (stop/terminate EC2).

## M6 runbook — cron → EventBridge (get EC2 to zero work)

Move the three EC2 cron jobs to scheduled Lambdas so nothing runs on EC2 (M7 can
then stop it). EC2 stays as rollback until validated.

**The jobs (all currently `node <file>` on EC2's crontab, writing to S3):**
- `src/daily.js` — 6am ET: scrape + score + morning email
- `scripts/discover.js` — Mon/Thu 7am ET: find new sources
- `scripts/weekly.js` — Sun 9am ET: digest email

### C-0 (do FIRST — the make-or-break unknown)
**Measure `daily.js` runtime.** Lambda's hard ceiling is **15 min**; the daily
scrape hits many sources + Claude. Check recent durations in EC2's `daily.log`.
- Comfortably < ~12 min → a plain scheduled Lambda works (the plan below).
- Near/over 15 min → this is M6's "30 s-cap moment": the scrape must be split
  (per-source fan-out via Step Functions / an SQS queue) or run on Fargate.
  Decide before building. (discover/weekly are short — not at risk.)

### Design (assuming C-0 is fine)
- **One `anyajob-cron` Lambda**, same code asset, handler `src/cron.js` that
  dispatches on the event: `{ job: 'daily' | 'discover' | 'weekly' }` →
  `import` + `main()` of the right file. Timeout 900 s (15 min), memory ~1024 MB.
  Env = common set **plus** the scraping vars; S3 rw + SES.
- **Three EventBridge Scheduler schedules** invoking it with the right `job`
  input, using **timezone `America/New_York`** (fixes the current UTC crons'
  DST drift): daily `cron(0 6 * * ? *)`, discover `cron(0 7 ? * MON,THU *)`,
  weekly `cron(0 9 ? * SUN *)`. A scheduler role grants `lambda:InvokeFunction`.

### Refactor / bundle work
- Each of the 3 files: `export async function main()` and guard the top-level
  `main().catch(process.exit)` behind a run-if-main check (so EC2/local
  `node <file>` still works during the transition, but importing doesn't
  auto-run or `process.exit` inside Lambda). Let `main` throw; the handler
  logs/rethrows.
- `build-lambda-bundle.sh`: also copy `scripts/` into the asset (currently only
  `src/` + `public/`) so `discover.js`/`weekly.js` ship.
- Env values from EC2 `.env`: `GREENHOUSE_BOARDS`, `LEVER_COMPANIES`,
  `USAJOBS_EMAIL` (non-secret → CDK env), `USAJOBS_API_KEY` (if set → SSM param
  like the Anthropic key; if empty, skip).

### Chunking
- **M6-1:** refactor the 3 jobs (export/guard) + `src/cron.js` dispatcher +
  bundle includes `scripts/`. Test each `main()` locally against S3. Push (CI).
- **M6-2:** CDK — `anyajob-cron` Lambda + 3 EventBridge schedules + scheduler
  role. Deploy (CI). **Manually invoke** each job (`aws lambda invoke` with the
  payload) → verify S3 writes + a morning/digest email actually arrives.
- **M6-3:** cutover — once manual invokes pass, disable the EC2 crontab (one-shot
  workflow like `disable-backup-cron.yml`) so jobs don't double-run. Confirm the
  next scheduled fire lands. EC2 now does nothing.

### Risks / rollback
- **Concurrency:** the daily Lambda + web Lambda can both read-modify-write
  `listings.json` (single user, low risk; add S3 `If-Match` later if wanted).
- **Double-run** during cutover: disable EC2 crons in the same step as enabling
  schedules (M6-3) — don't leave both live.
- **Rollback:** re-enable the EC2 crontab (setup.sh block) + disable the
  schedules. EC2 still fully capable on S3.

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
- 2026-07-11 — **M2 done.** Restricted uploads to `.pdf`/`.txt`
  (`ALLOWED_EXTENSIONS`); `validateUpload`/`saveDocument` now reject Word docs.
  Deleted `convertDocxToPdf` (the LibreOffice shell-out) and the `readDocxText`
  mammoth path; dropped the `mammoth` dep; removed the now-unused `spawn`/
  `basename` imports from documents.js. Frontend `accept` + help text narrowed
  to PDF/TXT. New `src/documents.test.js` (6 tests) covers `validateUpload`.
  Gate: full suite **82/82**; grep confirms no LibreOffice/convert/mammoth
  *code* (only explanatory comments); booted app lists the profile resume with
  a `previewFile` and streams it 200 `application/pdf`. The app is now a plain
  JS + pure-JS-libs bundle — no binary deps, so it fits a zip Lambda (M4).
- 2026-07-11 — **M3 done.** New `src/docstore.js` — the binary sibling of
  `store.js` (fs/s3 by the same `STORAGE` flag), keyed `{fingerprint}/{file}`,
  own `DOCS_BUCKET`. Refactored `documents.js` to drop *all* fs: `saveDocument`
  → `putDoc`; `getDocumentPath` (returned a path) replaced by `getDocBuffer`
  (bytes, for hashing/extraction/base64) and `getDocStream` (Readable, for the
  routes); `extractResumeText(path)` → `extractText(filename, buffer)`;
  `hashFileContents` → `hashBuffer`. Updated consumers: `feedback.js` (résumé
  text + PDF base64 block), `routes/documents.js` + `routes/profile.js` (now
  pipe a stream instead of `res.sendFile`). `documents.js` and `feedback.js`
  no longer import `node:fs` at all. CDK: added the `anyajob-docs` bucket
  (RETAIN/versioned/private/SSL), deployed; existing docs migrated via
  `aws s3 sync data/documents/ s3://anyajob-docs/`. New
  `src/docstore.contract.test.js` (7 tests, incl. path-traversal rejection).
  Gate: docstore contract **7/7 on fs and s3**; full suite **89/89**; booted
  app with `STORAGE=s3` + both buckets → general smoke green **and** the profile
  résumé streamed from the S3 docs bucket (200 `application/pdf`, valid header);
  fs doc-serving regression clean after the sendFile→pipe change.
- 2026-07-11 — **Production data migrated to S3** (authoritative). Discovery
  showed the earlier bucket contents were a ~June dev snapshot (~2% of prod:
  local `listings.json` 28 KB vs live 1.28 MB; 2 docs vs 97) — exactly the gap
  that made validating only against it insufficient. Also found EC2 has **no
  AWS creds** reachable by a process (no `.env` keys, no `~/.aws`, no instance
  role), so migration can't use EC2's identity. Fix: added a GitHub **OIDC
  deploy role** to the CDK stack (`anyajob-github-deploy`, S3 read/write on both
  buckets, assumable only by `repo:cobell206/anyajob`) — pulled forward from
  M4/M5, no stored keys. New `scripts/migrate-to-s3.mjs` (Node, authenticates
  like the app) + `.github/workflows/s3-migrate.yml` (OIDC → inject short-lived
  creds over SSH → run on EC2). Ran inspect (creds resolve, buckets reachable)
  then execute: **10 data files + 97 documents** uploaded; verified bucket
  sizes byte-match EC2's live inventory.
  **Re-sequencing (per review):** insert **M3.5 — cut EC2 over to `STORAGE=s3`
  and soak** BEFORE M4, so the data layer is proven on production data + real
  traffic on trusted infra before Lambda. M4 then becomes a pure compute-host
  swap (parity: EC2-on-s3 vs Lambda-on-s3, same live S3 data).
- 2026-07-11 — **M3.5 done: production cut over to S3.** The instance had no
  credentials, so added an EC2 app role in CDK (`anyajob-ec2-app`: S3 on both
  buckets + SES) and attached it to `i-0fb0c9e04b10c9993`
  (`associate-iam-instance-profile`). Then `cutover-to-s3.yml`: final data sync
  (10 JSON + 97 docs), `set-storage.sh s3` (STORAGE=s3 + bucket envs in .env),
  `systemctl restart anyajob`. Proof (`verify-live.yml`): the **running server
  process** env is `STORAGE=s3` and `GET /api/listings` returned 55 real
  listings — served from S3. EC2 now writes to S3 (source of truth is S3);
  local `data/` is frozen. **Soak:** watch daily cron writes land in S3 and a
  doc upload land in `anyajob-docs`. Rollback: `cutover-to-s3.yml` backend=fs
  (sync S3→disk first if writes occurred). Then M4 (Lambda) is a pure host swap.
- 2026-07-11 — **Post-cutover cleanup done.** Retired the S3-backup cron
  (removed from `setup.sh` + live crontab via `disable-backup-cron.yml`;
  redundant now that versioning is the backup, and it errored under the
  instance role). Added a **30-day noncurrent-version lifecycle rule** to both
  buckets (verified Enabled). Deleted the 2 orphan dev `_profile` docs — docs
  bucket now **97 objects**, matching prod exactly, no dev residue.
- 2026-07-11 — **M4 runbook drafted** (own section above), before any code — the
  discipline the S3 step lacked up front. Verified against the code, not
  assumed: `server.js` listens directly (needs `export`+guarded listen); the
  only request-path shell-out is `admin.js`'s daily-run `spawn` (→ M6, 501 on
  Lambda); no binary deps in `src/`. Flagged the four fiddly bits — **binary PDF
  responses via base64/`isBase64Encoded` (parity gate must byte-compare a real
  PDF, not just JSON)**, the ~6 MB payload cap, the unauthenticated dark
  `execute-api` URL, and Lambda env/secrets from CDK. **Decisions locked with
  the user:** D1 = **IAM auth** on the API route for the dark soak (smoke
  SigV4-signs; M5 revisits the model since Cloudflare can't sign); D2 = admin
  daily-run route → 501 on Lambda (it's M6); D3 = web lambdalith only. Deploy =
  local `cdk deploy` via `!` (CI OIDC role is S3-only). Verified prereqs:
  `smoke.mjs` does **not** yet byte-compare a PDF (probes are text/JSON only) and
  `serverless-http` isn't installed — both are M4 work. No code changed.
- 2026-07-11 — **M4 chunk 1 (adapter) done.** `src/server.js` now `export`s
  `app` and only calls `app.listen` under an `isMain` guard (so the Lambda
  import doesn't bind a port; dev/systemd still listen). New `src/lambda.js`
  wraps `app` with `serverless-http` (^4, prod dep), binary allowlist
  `application/pdf`+`application/octet-stream` for PDF downloads. Proven:
  direct `node src/server.js` still serves 200; a synthetic API Gateway v2 event
  through `handler` → 200 `application/json`; full suite **89/89**.
- 2026-07-11 — **M4 chunk 2 (parity harness) done.** Extended `scripts/smoke.mjs`:
  (a) a **binary PDF probe** `GET /api/profile/resume?download=1` that sha256
  **byte-compares** the download (soft-skips 404 in health; matched 404s still
  pass parity) — the #1 fiddly bit now has a real gate; (b) **auto SigV4
  signing** for any `.execute-api.` origin (service `execute-api`, region parsed
  from host, ambient credential chain, libs lazy-imported — no new deps, all
  present via `@aws-sdk/client-s3`), so `--compare <EC2> <API-GW>` works despite
  the gateway's `AWS_IAM` auth (D1). Proven: local health all ✔ incl. the PDF;
  self-parity byte-identical incl. the PDF hash; signer dry-run emits a valid
  `execute-api/aws4_request` signature. Next: CDK Lambda + HttpApi (chunk 3).
- 2026-07-11 — **M4 chunk 3 (CDK Lambda + HTTP API) written + synth-validated.**
  Extended `AnyaJobStack`: `anyajob-web` Lambda (nodejs20, **x86_64**,
  `src/lambda.handler`, 512 MB / 30 s, S3 rw on both buckets + SES), an
  `HttpApi` with **`AWS_IAM` auth on every route** (D1) and a throttled default
  stage (20 burst / 10 rate) to cap runaway Anthropic/S3 spend. Env mirrors the
  EC2 web path; `ANTHROPIC_API_KEY` via `{{resolve:ssm-secure:/anyajob/
  anthropic-api-key}}`; **`AWS_REGION` deliberately omitted** (reserved — the
  runtime sets it). `cdk synth` clean; template asserts every one of these.
  **Native-dep discovery + bundling decision (D4):** résumé/cover scoring's PDF
  text extraction (`pdf-parse` → pdfjs) hard-requires the **native
  `@napi-rs/canvas`** (`DOMMatrix`) — proven by extraction crashing when it's
  removed. The mac dev tree only has the darwin binary; Lambda is linux, and npm
  won't install the linux prebuilt on a mac. **Chosen (user): ship the linux
  prebuilt, plain zip, no Docker, scoring behavior unchanged.** New
  `scripts/build-lambda-bundle.sh` (`npm run bundle:lambda`) stages
  `infra/.app-bundle`: `npm ci --omit=dev`, then fetches
  `@napi-rs/canvas-linux-x64-gnu` at the **exact version of the installed
  wrapper (0.1.80, not npm-latest 1.0.2 — ABI must match)** and drops the
  client-vendored top-level `pdfjs-dist` (~60 MB, unused server-side). Result:
  **173 MB** unpacked, verified linux ELF binary present, well under the 250 MB
  cap. **Note the trap:** extraction is a POST path the M4 parity probes don't
  hit, so a broken native binary would NOT show in the dark gate — it must be
  validated at deploy by an actual scoring invoke, not just smoke.
  **Two deploy-time items to confirm (deploy is user-gated via `!`):** (1) stage
  the SSM SecureString `/anyajob/anthropic-api-key`; (2) verify `ssm-secure`
  resolves in a Lambda env var at deploy (fallback: `CfnParameter` noEcho or a
  Secrets Manager ref). Next: `npm run bundle:lambda` → `cdk deploy` dark →
  `smoke.mjs --compare` EC2-vs-Lambda + a scoring invoke.
- 2026-07-11 — **M4 chunk 4 (parity plumbing) done + reference side proven.**
  Chose the parity **reference = a local server on `STORAGE=s3`** (same M4 code,
  same prod buckets) rather than EC2 — EC2 runs pre-M4 code and isn't directly
  reachable without a CF token/SSH tunnel, so "same code, different host" is the
  truer M4 diff. New `scripts/parity-m4.sh <API_URL>`: boots the local s3 server,
  waits for health, runs `smoke.mjs --compare local↔Lambda` (Lambda auto-signed;
  all probes GET → no prod writes). New `scripts/invoke-scoring.mjs <API_URL>`:
  opt-in SigV4-signed **POST** to `/api/profile/resume/feedback` that exercises
  the native canvas/pdf-parse path the GET probes miss (costs one Anthropic call,
  refreshes cached feedback). Proven now: local-on-s3 served **55 real prod
  listings** (local creds read the buckets) and self-parity passed every probe
  **incl. the PDF bytes** — the whole reference/harness side is green; it just
  needs the deployed Lambda URL. **SSM secret `/anyajob/anthropic-api-key`
  staged** (pulled from `.env`). **Ready to deploy dark:** `npm run bundle:lambda`
  → `cd infra && npx cdk deploy` (via `!`) → `bash scripts/parity-m4.sh <WebApiUrl>`
  → `node scripts/invoke-scoring.mjs <WebApiUrl>`.
- 2026-07-11 — **First dark deploy hit the flagged `ssm-secure` limit** and was
  fixed on the spot. CloudFormation rejects `{{resolve:ssm-secure:…}}` in a
  Lambda env var (`SSM Secure reference is not supported in
  …/Environment/Variables/ANTHROPIC_API_KEY`) — exactly the item chunk 3 called
  out. Switched to a **`noEcho` CfnParameter `AnthropicApiKey`** whose value is
  passed from the SSM SecureString at deploy via command substitution — keeps the
  secret out of source/console, no app rebuild, no new dep, SecureString
  untouched. Deploy command:
  `npx cdk deploy --parameters AnthropicApiKey="$(aws ssm get-parameter --name
  /anyajob/anthropic-api-key --with-decryption --region us-east-1 --query
  Parameter.Value --output text)"`. Synth confirms env → `{"Ref":"AnthropicApiKey"}`.
- 2026-07-11 — **M4 dark deploy LIVE + read-path proven; scoring blocker found.**
  Stack deployed (11 resources, 67 s): `anyajob-web` Lambda + `WebApi` HTTP API
  (IAM auth, throttled) at `https://khtnbu5pbl.execute-api.us-east-1.amazonaws.com`.
  **Parity gate GREEN** — `parity-m4.sh` diffed local-on-s3 vs Lambda: all probes
  identical **including the binary PDF byte-compare**, proving base64/
  `isBase64Encoded` binary responses survive API Gateway and that IAM+SigV4 auth
  works. Then the scoring invoke 503'd: root-caused via CloudWatch + a
  **direct invoke** (bypasses the gateway) → scoring returns **HTTP 200 with real
  feedback in ~54 s**; the 503 is API Gateway's **30 s integration cap**, not the
  Lambda. Also confirmed `extractedChars:0` is **normal** (PDF résumés skip text
  extraction — Claude reads the PDF block), so **canvas was never the blocker**
  (the linux-binary work still correctly covers non-PDF extraction). → Added
  **M4.5 (async scoring + poll)**, user's chosen fix; see its runbook above.
  Temporarily set the web Lambda timeout to 120 s for measurement (drift from
  CDK's 30 s — reconciled in M4.5 chunk 2).
