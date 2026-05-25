# Outstanding issues

Things known to be broken or under-built, ordered by severity. Each entry has
the symptom, where it surfaced, the root cause as best we know it, and a fix
sketch. Cross off as resolved.

## P0 — production is silently degraded

### 1. AWS credentials missing on EC2

**Symptom:** Morning email isn't reaching Anya. Nightly S3 backups fail. Both
log `CredentialsProviderError: Could not load credentials from any providers`.

**Where it surfaced:** `/api/diagnostic` daily.log + backup.log show it on every
run since deploy.

**Root cause:** `aws configure` was never run on the EC2. The IAM keys that
were created in DEPLOY.md Part 9 are sitting in your AWS console unused.

**Fix:**
```bash
ssh ubuntu@3.88.136.221
aws configure
# paste access key id, secret, region us-east-1, output format json
aws sts get-caller-identity   # confirm
```

Also: `BACKUP_BUCKET` in `.env` still reads
`s3://lawbound-backup-yourname/job-tracker` — the placeholder from
`.env.example`. Replace with the actual bucket name you created in S3.

**Effort:** 5 min (assumes IAM keys are already in your password manager).

---

### 2. Daily run executed twice this morning

**Symptom:** Two "daily run done" log entries one second apart at
2026-05-06T10:00:35 and 10:00:36. Two morning emails attempted to send
back-to-back. The flock guard at `/tmp/anyajob.lock` should prevent this.

**Where it surfaced:** `/api/diagnostic` daily.log.

**Root cause hypothesis:** Crontab has duplicate entries — likely both
`lawbound managed entries` (from the original setup.sh run) AND
`anyajob managed entries` (after the rename). The lawbound-tagged block
was supposed to be cleaned up but might have lingered.

**Fix:** On the EC2:
```bash
crontab -l | grep -c daily.js   # should be 1
crontab -l                      # inspect; remove any stale lawbound block
```

If duplicates exist, edit with `crontab -e` and delete the old block, or
re-run `./setup.sh --skip-system --skip-app` after manually removing the
stale `# >>> lawbound managed entries >>>` markers.

**Effort:** 5 min.

---

### 3. Atomic write ENOENT errors

**Symptom:** Two smartfetch sources logged
`rename '[REDACTED-PATH]' -> '[REDACTED-PATH]'`.

**Where it surfaced:** `/api/diagnostic` source statuses.

**Root cause:** `src/atomic.js` writes `<file>.tmp` then renames. If two
processes hit the same file (see issue #2 above), the second rename fails
because `.tmp` already moved.

**Fix:** Likely resolves itself once #2 is fixed. If it persists after
crontab is clean, add a unique tmp suffix per process:
`<file>.<pid>.<rand>.tmp`. ~3 lines in `src/atomic.js`.

**Effort:** 0 if #2 fixes it; 10 min otherwise.

---

## P1 — features quietly broken or missing

### 4. Smartfetch JSON parser is brittle

**Symptom:** Six smartfetch sources errored with
`Unexpected non-whitespace character after JSON at position 21` this morning.
The model emits leading prose ("I'll extract the listings…") before the JSON;
the current parser strips code fences but doesn't tolerate any other prose.

**Where it surfaced:** `/api/diagnostic` source statuses, repeated across
Legal Services NYC, CCRB, Housing Works, NY Immigration Coalition (sometimes),
Immigration Advocates Network, and others.

**Root cause:** `src/sources/smartfetch.js` has the same fence-stripping
parser we already replaced in `src/score.js`. Score's parser was fixed to
do `text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)` which tolerates
arbitrary surrounding prose. Smartfetch never got the same fix.

**Fix:** Port the parser from `src/score.js:87-94` to `src/sources/smartfetch.js`.

**Effort:** ~5 min.

---

### 5. Anthropic rate limit hit during smartfetch fan-out

**Symptom:** Two sources errored with
`429 rate_limit_error: This request would exceed your organization's rate
limit of 50,000 input tokens per minute`.

**Where it surfaced:** `/api/diagnostic` source statuses
(NYC Mayor's Chief Counsel Office, National Women's Law Center).

**Root cause:** `src/sources/index.js` runs `fetchAll()` with
`Promise.all(...)` — every smartfetch source hits Claude in parallel. Each
call ships ~10–30k input tokens (the cleaned HTML). Five parallel calls
exceed 50k/min.

**Fix:** Two options:
- **A.** Serialize smartfetch calls (preserve parallelism for Greenhouse/Lever
  which don't hit Claude). Add a `for` loop instead of `Promise.all` for the
  smartfetch dispatcher.
- **B.** Add backoff retry on 429: catch the error, sleep `parseRetryAfter()` seconds,
  retry once.

**Recommended:** A is simpler and more predictable. Smartfetch is already
the slowest path; serializing adds ~30s to a daily run, well within budget.

**Effort:** ~15 min.

---

### 6. CLI env var prefix is stale (`LAWBOUND_*`)

**Symptom:** `bin/lawbound-logs` reads `LAWBOUND_HOST`,
`LAWBOUND_CF_CLIENT_ID`, `LAWBOUND_CF_CLIENT_SECRET`. Local `.env.local` uses
`ANYAJOB_URL`, `CF_CLIENT_ID`, `CF_CLIENT_SECRET`. Mismatch means the CLI
won't find the creds without manual env-var renaming.

**Where it surfaced:** Trying to use the CLI to fetch logs.

**Root cause:** The lawbound→anyajob rename touched deploy paths but skipped
the laptop-side CLI script.

**Fix:**
- Rename `bin/lawbound-logs` → `bin/anyajob-logs`.
- Replace `LAWBOUND_HOST` → `ANYAJOB_URL` (or `ANYAJOB_HOST` for consistency
  with cobell's `.env.local` choice).
- Replace `LAWBOUND_CF_CLIENT_ID` / `_SECRET` → `CF_CLIENT_ID` / `CF_CLIENT_SECRET`.
- Update DEPLOY.md references (Part 12-ish, near the end).

**Effort:** ~10 min.

---

## P2 — known fragile spots, no immediate user impact

### 7. Spend cap consumes seen.json without scoring

**Symptom:** When `MAX_DAILY_SPEND` is reached mid-loop in `src/daily.js`, the
listings that were dedupKey-added to `seen` but not yet scored stay in
`seen.json`. Next run skips them as "seen" forever.

**Where it surfaced:** Discussed during the ACLU end-to-end test earlier;
not exercised in production yet (we've only spent $0.29/day, cap is $2.00).

**Root cause:** `dedupeListings()` adds every fresh listing to `seen` up-front.
`saveSeen(seen)` runs unconditionally after the score loop, regardless of
whether the cap broke us out early.

**Fix:** Track which dedupKeys were actually scored. `saveSeen` writes only
those, plus the previously-seen set. Roughly:
```js
const scoredKeys = new Set(scored.map((s) => s.dedupKey));
const newSeen = new Set([...alreadySeen]);
for (const l of fresh) if (scoredKeys.has(l.dedupKey)) newSeen.add(l.dedupKey);
await saveSeen(newSeen);
```

**Effort:** ~10 min including the test that the existing pre-filter excluded
listings still get marked seen (we don't want to re-fetch known noise).

---

### 8. SSH security group is open to the world

**Symptom:** Port 22 inbound is `0.0.0.0/0`. We did this so GitHub Actions
could deploy. Brute-force attempts will hit the EC2's SSH; key-only auth
mitigates but the noise/exposure is real.

**Where it surfaced:** GitHub Actions setup — couldn't reach EC2 with the
"My IP only" rule.

**Root cause:** Trade-off accepted at the time to ship the deploy pipeline.

**Fix options (ranked):**
- **A.** Self-hosted GitHub Actions runner on the EC2. Polls outbound; no
  inbound SSH needed. Set security group back to "My IP only." ~20 min setup.
- **B.** Cloudflare Tunnel for SSH (`cloudflared access ssh`). GitHub Actions
  uses `cloudflared` to tunnel SSH through CF. ~30 min, more secure than A.
- **C.** GitHub IP allowlist. Brittle (GitHub changes IPs); skip.

**Recommended:** A. Single-deployment project, self-hosted runner is the
cleanest fit.

**Effort:** ~20 min.

---

### 9. Discovery cron may need rate-limit protection too

**Symptom:** Not yet observed. But discovery uses `web_search_20250305` with
`max_uses: 15`, and each search round can ship significant input tokens.
On a slow Cloudflare Tunnel + a tight Anthropic rate limit, partial
truncations are possible.

**Where it surfaced:** Hypothetical from issue #5 — same root cause shape.

**Fix:** None yet. Watch the discover.log on the next Mon/Thu run. If it
errors with 429 or truncation, add backoff retry to `src/discover.js`.

**Effort:** Triage only.

---

## P3 — feature debt, not bugs

### 10. Cover letter drafter

Modal button using stored resume + JD + notes to draft a cover letter via
Claude. Infrastructure mostly exists (resume in profile, JD in listing,
notes in feedback). Just needs a route + UI button + prompt.

**Effort:** ~90 min. High user value.

### 11. Snooze button for closing-soon alerts

Currently the morning email re-surfaces the same closing listings every day
until they actually close. Add a "Snooze for 3 days" / "Hide from email"
action on the closing-soon row. Stored in `feedback.json` as
`snoozedUntil[fp]: ISO date`.

**Effort:** ~30 min.

### 12. SES sandbox approval

Pending AWS request? Without production access, SES silently fails to send
to non-verified addresses. Even after #1 above is fixed, emails to Anya
won't go through unless her address is verified in SES OR the account is
out of sandbox.

**Status:** Need to confirm whether the request was submitted on deploy
day (DEPLOY.md Part 10 Stage 2). If not, submit now — 24-48h wait.

**Effort:** ~10 min to submit, then wait.

### 13. Feedback loop (richer than 👍/👎)

See [PLAN-FEEDBACK-LOOP.md](PLAN-FEEDBACK-LOOP.md). 3 phases, ~2 hours total.

---

## How to triage

If you have 30 minutes: do P0 items 1+2 (AWS creds + crontab dedup).
If you have an hour: add P1 item 4 (smartfetch parser). That fixes 6 sources.
If you have a Saturday morning: 1 → 2 → 4 → 5 → 6 → 8 in that order. By
lunch you'd have a clean production deployment with zero outstanding bugs.

Touch this file as you go — cross items off, add new ones as they surface
in `/api/diagnostic`.
