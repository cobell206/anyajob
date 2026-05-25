# Feedback loop — plan

A richer signal than 👍/👎 on each listing, so scoring and source discovery
can both calibrate over time. The skeleton already exists (`loadRecentFeedback`
injects up/down examples into the score prompt) — this extends it from
"liked / disliked" to "liked / disliked because X" and lifts the data up to
the source level.

## Why bother

- Plain 👎 tells Claude "she didn't like this" but gives no actionable reason
  to penalize similar listings differently.
- Source quality drifts. ACLU might surface 40 perfect roles one month and
  mostly senior counsel postings the next; today there's no built-in way
  to learn that and re-weight without manually disabling the source.
- Discovery prompts use stated interests + resume but no behavioral data.
  After two weeks of usage, the behavioral signal is stronger than the
  static profile and should drive what new sources we propose.

## Current state

```
data/feedback.json
{
  "ratings":     { "<dedupKey>": "up" | "down" },
  "notes":       { "<dedupKey>": "free text" },
  "status":      { "<dedupKey>": "saved" | "applied" | ... },
  "appliedDate": { "<dedupKey>": "YYYY-MM-DD" },
  "closesDate":  { "<dedupKey>": "YYYY-MM-DD" }
}
```

`src/score.js` calls `loadRecentFeedback(6)` and gets the last 6 listings she
rated. The score prompt's user message includes them as positive/negative
examples. No reasons captured, no source aggregation, discovery doesn't see
any of it.

---

## Proposed design

### 1. Schema — feedback.ratings becomes structured

Migrate `ratings[dedupKey]` from a bare string to an object:

```jsonc
{
  "ratings": {
    "abc123def": {
      "rating": "down",
      "reasons": ["too-senior", "wrong-field"],
      "note": "Want IP litigation, not voting rights",
      "ratedAt": "2026-05-06T13:42:11Z"
    },
    "xyz789ghi": {
      "rating": "up",
      "reasons": [],
      "note": null,
      "ratedAt": "2026-05-06T13:45:02Z"
    }
  }
}
```

Reason vocabulary (one-tap chips, multi-select):

| Tag | Meaning |
|---|---|
| `too-senior` | Requires more years/credential than she has |
| `too-junior` | Below her level, won't differentiate her |
| `wrong-field` | Practice area / sector mismatch |
| `wrong-location` | Geography / remote-vs-on-site mismatch |
| `wrong-comp` | Salary too low or too senior for stated band |
| `bad-listing` | Listing itself is broken/spam/duplicate |
| `not-for-me` | Generic catch-all for unspecified disinterest |

Reasons only required on `rating === "down"` to keep the friction asymmetric
— positive feedback is one tap, rejection is two taps. Free-text note stays
optional on either.

**Backward compat:** add a small reader in `src/io.js`:

```js
function normalizeRating(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return { rating: raw, reasons: [], note: null, ratedAt: null };
  return raw;
}
```

Used everywhere we read `feedback.ratings[fp]`. Old string-format entries
keep working without a migration script. Writes always go in the new shape.

### 2. UI — reason picker in the modal

Replace the current `<button class="btn btn-vote down">👎</button>` with a
two-stage interaction:

- **Click 👎** — pill row appears below: `Too senior · Too junior · Wrong field · Wrong location · Wrong comp · Bad listing`. None preselected. Click to toggle (multi-select). Save as soon as the user picks anything OR clicks 👎 again to confirm "no specific reason."
- **Click 👍** — saves immediately. No reason picker. Reasons array stays empty.
- **Free-text "Why?" field** — collapsible, available on either rating. Auto-save like the existing notes textarea.

Visual: chips reuse the `.filter-mini-pill` style we already have. No new CSS primitives needed.

API stays close to today's:

```
POST /api/feedback/:fp/rating
body: { rating: "up" | "down" | null, reasons: ["too-senior", ...], note?: "..." }
```

Single endpoint accepts the full structure. Backend writes `{ rating, reasons, note, ratedAt }` to `feedback.ratings[fp]`. Old `rating`-only callers still work because reasons defaults to `[]`.

### 3. Score prompt — pass reasons in the calibration block

Today's `buildUserMessage` in `src/prompts.js`:

```
HER PAST FEEDBACK (use as calibration):
Listings she rated POSITIVELY:
  1. Davis Polk — Litigation Paralegal (NYC)

Listings she rated NEGATIVELY:
  1. Skadden — Senior Counsel (NYC)
```

After:

```
HER PAST FEEDBACK (use as calibration):

Liked:
  1. Davis Polk — Litigation Paralegal (NYC)

Rejected as TOO SENIOR (penalize listings requiring 4+ years):
  1. Skadden — Senior Counsel (NYC)
  2. ACLU — Senior Staff Attorney (NYC)

Rejected as WRONG FIELD (penalize patent/IP/M&A roles):
  1. Cravath — Corporate Paralegal (NYC)

Free-text rejection notes:
  - "Want IP litigation, not voting rights"
```

Same prompt-cache breakpoint structure (cache stable system blocks; user message rebuilds per call but inherits cached context). No model change, no new API surface.

### 4. Source aggregates — quiet feedback at the source level

Compute per-source rejection rates on demand (cheap; we read feedback.json
already). Stored as a derived view, not a separate file:

```js
// src/sources/aggregates.js (new module)
export async function sourceFeedbackRates() {
  const listings = (await readJson('listings.json')).listings;
  const feedback = await readJson('feedback.json');
  const bySource = new Map();
  for (const l of listings) {
    const fb = normalizeRating(feedback.ratings[fbKey(l)]);
    if (!fb) continue;
    const bucket = bySource.get(l.source) || { total: 0, up: 0, down: 0, reasons: {} };
    bucket.total++;
    if (fb.rating === 'up') bucket.up++;
    if (fb.rating === 'down') {
      bucket.down++;
      for (const r of fb.reasons) bucket.reasons[r] = (bucket.reasons[r] || 0) + 1;
    }
    bySource.set(l.source, bucket);
  }
  return Object.fromEntries(bySource);
}
```

Two consumers:

**Settings → Sources UI** — when a source has ≥3 ratings AND `down/total > 0.5`,
show a small badge: `⚠ 4 of 5 marked too senior`. One-click "Disable this source"
button beside it. No auto-disable — the user always confirms.

**Discovery prompt** — append a feedback-patterns block:

```
RECENT FEEDBACK PATTERNS:
- 4 of 5 listings from greenhouse:aclu were rejected as too senior.
  Propose sources with paralegal- or junior-level openings, not Senior Counsel.
- 3 of 4 listings from smartfetch:nycsdny were rejected as wrong-field
  (criminal vs civil). Propose civil-rights / public-interest civil litigation sources.
```

This is the highest-value piece long-term — discovery currently has no behavioral data, so it'll keep proposing the same kinds of sources. Pattern-aware discovery is a step-change.

---

## Implementation phases

### Phase 1 — Schema + reason picker (≈ 45 min, immediate visible value)

- [ ] Add `normalizeRating()` helper in `src/io.js`, export
- [ ] Update `POST /api/feedback/:fp/rating` to accept `{ rating, reasons, note }` and write the structured object
- [ ] Update `src/routes/feedback.js` to use `normalizeRating()` on read paths
- [ ] Replace the 👍/👎 buttons in `public/modal.js` with the two-stage interaction
- [ ] Reuse `.filter-mini-pill` styling for the reason chips (no new CSS)
- [ ] Verify backward-compat by reading existing `feedback.json` (currently has old string-format ratings)

### Phase 2 — Reasons in the score prompt (≈ 15 min, calibration improves on next daily run)

- [ ] Update `loadRecentFeedback(maxExamples)` to return reasons + notes alongside rating
- [ ] Update `buildUserMessage()` in `src/prompts.js` to group examples by reason and add the "penalize listings that..." instruction lines
- [ ] No test changes needed (pure-text generation; existing 28 tests still pass)

### Phase 3 — Source aggregates (≈ 60 min, pays off over weeks)

- [ ] New `src/sources/aggregates.js` with `sourceFeedbackRates()`
- [ ] `GET /api/sources` route response includes per-source `feedback` field
- [ ] Settings UI shows the badge + "Disable" button when threshold met
- [ ] Discovery prompt in `src/discover.js` appends the feedback-patterns block when any source has ≥3 ratings

---

## Edge cases / decisions to make before implementing

1. **Re-rating** — what happens if she changes her mind? (Today: overwrite.
   Future: keep `ratedAt` timeline so calibration weights more recent feedback heavier.)
   Phase 1 stays simple — overwrite. Phase 4+ can add history.

2. **What about "saved" with no rating?** The status pipeline (saved → applied)
   is already a strong positive signal. Should `status === "saved"` count as
   an implicit 👍 in calibration? Probably yes, but only after explicit ratings
   are exhausted. Out of scope for phase 1.

3. **Multi-listing same fingerprint.** Reposts at different sources share the
   role fingerprint but have distinct `dedupKey`s. Today rating is per dedupKey
   (per opening), which is correct. Source aggregates are per `source`, also
   correct. No change.

4. **Model attention budget.** The reason-grouped feedback block adds ~150
   tokens to each daily-run scoring call. At $5/M output and Haiku's input
   tier, this is ~$0.0001/listing. 50 listings/day = $0.005/day extra. Negligible.

5. **Threshold for source aggregates.** "≥3 ratings AND >50% down" is a guess.
   May need tuning. Make it config:
   ```js
   const SOURCE_DOWN_THRESHOLD = 0.5;
   const SOURCE_MIN_RATINGS = 3;
   ```
   in `src/sources/aggregates.js` so it's one-line tunable.

6. **Reason taxonomy lock-in.** Free-text notes capture anything the chips
   miss; we can introduce new reason codes later by adding chips and
   re-prompting. Old data with the old taxonomy stays valid (existing reason
   strings are just opaque tags).

7. **"Bad listing" routing.** A `bad-listing` rejection probably shouldn't
   penalize that source — it's a meta-issue (broken data, not a fit problem).
   Aggregates should split: "down because bad data" vs "down because mismatch."
   Treat `bad-listing` as a source-quality signal, not a fit signal.

---

## Testing

- **Unit test for `normalizeRating()`** in `src/io.test.js` — covers the
  string→object backward-compat path and the noop on already-structured input.
- **Unit test for `sourceFeedbackRates()`** in `src/sources/aggregates.test.js`
  — fixture with mixed up/down/no-rating listings; assert tallies + reason
  buckets. Should be a `-core` style pure-function module so it doesn't pull
  the IO graph in.
- **Manual smoke** — rate one listing 👎 with `too-senior`, run a single
  scoring call, verify the prompt's calibration block has the new shape
  (log it). Run discovery once, verify the feedback-patterns block appears
  when threshold is met.

No new test files needed for phase 1 if we keep `normalizeRating()` covered;
phase 3's aggregates module gets its own test file (matches the existing
pattern of `dedupe-core.test.js` / `discover-overlap.test.js`).

---

## Future extensions (explicitly out of scope)

These are tempting but aren't paying for themselves at one-user scope:

- **Confidence scoring** on calibration examples ("she was 80% confident on
  this 👎") — premature optimization.
- **ML-based reason inference** from notes — Claude already reads the free-text
  note. No need to extract structured reasons from prose.
- **Cross-user patterns** — only relevant if scope expands beyond one user.
- **Active learning** — proactively asking "rate this one to improve scoring"
  on a borderline listing. Useful but adds modal complexity. Defer until a
  clear win is visible.

---

## What this looks like end-to-end after all 3 phases

After 2 weeks of normal use:

- 30+ ratings with reasons.
- Score prompt is calibrated on her actual taste at the reason level. Listings
  that pattern-match her past rejections get scored lower; ones matching
  her likes get scored higher. Numerical improvement: likely 0.5–1.0 fewer
  borderline 6/7s, more clear-cut 8s and 4s.
- Settings UI flags 1–2 sources as "skewing senior" or "wrong field"; she
  disables or keeps them with one click.
- Discovery on Mon+Thu now proposes sources at the right level. The 7am email
  candidate count drops noise — fewer "ACLU Senior Counsel" suggestions, more
  "JustFutures Paralegal Fellowship" (or whatever fits the patterns).

The whole feature is still proportionate to scope: ~2 hours of work,
~$0.001/listing/day in extra prompt tokens, no new dependencies, no
schema migration script (backward-compat read), no UI overhaul.
