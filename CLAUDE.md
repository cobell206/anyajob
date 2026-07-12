# CLAUDE.md — operating guide for AI agents

Repo-scoped instructions for Claude Code (or any agent) working on AnyaJob.
Read this and `ARCHITECTURE.md` before making changes.

## What this is

A daily job-search tracker for one law-school applicant (domain
`anyalawgirly.com`). **Single user, single deployment.** Keep solutions
**proportionate to that scope** — bias against SaaS/multi-tenant patterns,
config frameworks, and abstraction built for scale that will never come. Prefer
the small, direct fix.

## Architecture in 6 lines

- The Express app (`src/server.js`) runs as **Lambda `anyajob-web`** via
  `serverless-http` (`src/lambda.js`), behind an **API Gateway HTTP API**.
- Auth is the gateway's job: **Cloudflare Access JWT** authorizer. No app-level
  auth middleware.
- **All state is in S3** through the `src/store.js` seam (`STORAGE=s3` in prod,
  `fs` locally). Uploaded docs go through `src/docstore.js`.
- Résumé scoring is async on **`anyajob-scoring-worker`** (API GW has a 30s cap;
  the call takes ~54s) — POST returns 202, client polls GET.
- Crons run on **EventBridge → `anyajob-cron`** (`src/cron.handler`).
- Everything is CDK in `infra/` (`AnyaJobStack`). Full detail: `ARCHITECTURE.md`.

## How to deploy

**Push to `main`.** `.github/workflows/deploy-infra.yml` runs tests, bundles the
Lambda, and `cdk deploy`s. `paths-ignore: *.md` — doc-only pushes don't deploy.
You do **not** normally run `cdk deploy` by hand; let CI do it.

If you must deploy manually, see the command in `ARCHITECTURE.md` (§Deploy) —
note the Anthropic key is a **noEcho CfnParameter** sourced from SSM, not an env
var, because CloudFormation rejects `{{resolve:ssm-secure}}` in Lambda env.

## Working norms (these have bitten us — follow them)

- **Commit + push per chunk.** Never accumulate a large local diff or deploy
  uncommitted code. Each self-contained change → commit → push → verify. Do not
  build eight changes locally and push once.
- **Watch out for `node --watch` restart storms.** `npm run dev` runs
  `node --watch src/server.js`; batching many edits to files under the repo can
  wedge it. Check if a dev server is running before large batches, or warn.
- **Never write production S3 data or mutate the prod host in auto/unattended
  mode.** IAM changes, S3 mass-deletes, and writes to prod `data/` in S3 are
  destructive — surface them for the human to run. (Reads are fine.)
- End git commit messages with the `Co-Authored-By` trailer.

## Where things live

- Entry points: `src/{server,lambda,worker,cron,daily}.js`
- Routes: `src/routes/*.js` · AI prompts (all in one file): `src/prompts.js`
- Storage seam: `src/store.js` (+ `io.js`/`atomic.js` re-exports), `src/docstore.js`
- Sources (scrapers/APIs): `src/sources/*.js` · dedupe: `src/dedupe*.js`
- Frontend: `public/{index,profile,settings}.html` + `.js`, `public/components/*`,
  `public/app.js`, `public/style.css`
- Infra: `infra/lib/anyajob-stack.ts`
- Prod state: S3 `anyajob-data` (JSON) + `anyajob-docs` (uploads). Locally: `data/`.

## Testing

`npm test` (node's built-in runner over `src/*.test.js` + `test/*.test.js`).
`npm run smoke` hits the deployed app (incl. a binary-PDF probe). Contract tests
(`store.contract.test.js`, `docstore.contract.test.js`) pin the storage seam's
behavior across the fs and s3 backends — keep them green when touching storage.

## Debugging prod

Logs are in **CloudWatch** (`/aws/lambda/anyajob-{web,cron,scoring-worker}`),
not on any server and not in S3. There is no EC2 to SSH into anymore.
