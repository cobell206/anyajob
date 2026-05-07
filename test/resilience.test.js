// test/resilience.test.js
//
// Regression coverage for the May 2026 outage: a single byte of trailing
// garbage in feedback.json took down /api/listings, /api/stats, and every
// other route that touched the file. The shipped fix has two parts:
//
//   1. readJson tolerates trailing garbage by parsing the leading balanced
//      value and rewriting the file in place (src/io.js).
//   2. The listings router treats every feedback bucket as optional via
//      `?.` chaining, so a partial or empty feedback.json doesn't crash
//      hydrate() (src/routes/listings.js).
//
// These tests pin both behaviors so a future refactor doesn't quietly
// undo the fix. Run via `npm test`.
//
// Setup notes:
//   readJson resolves paths against the real `data/` dir (no DI hook), so
//   tests snapshot data/listings.json and data/feedback.json on disk
//   before running and restore them after — both on success and on crash
//   via after()/afterEach. The readJson self-heal test uses a unique
//   throwaway filename so it never collides with real data files.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';

import { DATA, readJson } from '../src/io.js';
import listingsRouter from '../src/routes/listings.js';

const LISTINGS_PATH = join(DATA, 'listings.json');
const FEEDBACK_PATH = join(DATA, 'feedback.json');
const READJSON_TMP = '__resilience_readjson_tmp.json';
const READJSON_TMP_PATH = join(DATA, READJSON_TMP);

// Snapshot a file's contents so we can restore it later. Returns null if
// the file doesn't exist (so the restore step knows to delete instead).
async function snapshot(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function restore(path, snap) {
  if (snap === null) {
    try { await unlink(path); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  } else {
    await writeFile(path, snap, 'utf-8');
  }
}

let listingsSnap;
let feedbackSnap;

before(async () => {
  listingsSnap = await snapshot(LISTINGS_PATH);
  feedbackSnap = await snapshot(FEEDBACK_PATH);
});

after(async () => {
  await restore(LISTINGS_PATH, listingsSnap);
  await restore(FEEDBACK_PATH, feedbackSnap);
  try { await unlink(READJSON_TMP_PATH); } catch {}
});

// Minimal listings fixture — one entry is enough to exercise hydrate().
const FIXTURE_LISTINGS = {
  listings: [
    {
      dedupKey: 'k1',
      fingerprint: 'fp1',
      company: 'Davis Polk',
      title: 'Litigation Paralegal',
      location: 'New York, NY',
      ingestedAt: new Date().toISOString(),
      score: { overallScore: 80 },
    },
  ],
};

beforeEach(async () => {
  await writeFile(LISTINGS_PATH, JSON.stringify(FIXTURE_LISTINGS), 'utf-8');
});

// Spin up the listings router on a random port for HTTP-level smoke tests.
// Using a real socket (instead of mocking req/res) catches Express middleware
// bugs and the global error handler — the same path the outage took.
async function withServer(fn) {
  const app = express();
  app.use('/api', listingsRouter);
  // Mirror server.js's catch-all so unhandled throws return 500 (not hang).
  app.use('/api', (err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('readJson self-heal', () => {
  it('parses a file with trailing garbage and rewrites it clean', async () => {
    // The exact corruption that caused the outage: valid JSON with an extra
    // closing brace appended (likely from a partial concat or duplicate write).
    await writeFile(READJSON_TMP_PATH, '{"status":{},"rating":{}}}', 'utf-8');

    const result = await readJson(READJSON_TMP);
    assert.deepEqual(result, { status: {}, rating: {} });

    // The file must have been rewritten without the trailing `}`. We verify
    // by re-parsing — the rewritten file must be strict-parseable on its own.
    const rewritten = await readFile(READJSON_TMP_PATH, 'utf-8');
    assert.deepEqual(JSON.parse(rewritten), { status: {}, rating: {} });
    assert.ok(
      !rewritten.trimEnd().endsWith('}}}'),
      'trailing garbage should have been stripped from the file on disk',
    );
  });
});

describe('API smoke: corrupt feedback.json', () => {
  it('serves /api/listings and /api/stats despite trailing garbage', async () => {
    // Same shape as the outage: a full, valid feedback object plus one stray
    // closing brace. Pre-fix, this 500'd the entire API.
    await writeFile(
      FEEDBACK_PATH,
      '{"status":{},"ratings":{},"notes":{},"appliedDate":{},"closesDate":{},"rejectReasons":{}}}',
      'utf-8',
    );

    await withServer(async (base) => {
      const listingsRes = await fetch(`${base}/api/listings`);
      assert.equal(listingsRes.status, 200, 'listings should not 500 on corrupt feedback');
      const listingsBody = await listingsRes.json();
      assert.equal(listingsBody.count, 1);

      const statsRes = await fetch(`${base}/api/stats`);
      assert.equal(statsRes.status, 200, 'stats should not 500 on corrupt feedback');
      const statsBody = await statsRes.json();
      assert.equal(statsBody.total, 1);
    });
  });
});

describe('API resilience: empty feedback object', () => {
  it('serves /api/listings and /api/stats when feedback.json is just {}', async () => {
    // First-run / nuked-by-mistake case. Every bucket is missing.
    await writeFile(FEEDBACK_PATH, '{}', 'utf-8');

    await withServer(async (base) => {
      const listingsRes = await fetch(`${base}/api/listings`);
      assert.equal(listingsRes.status, 200);
      const listingsBody = await listingsRes.json();
      assert.equal(listingsBody.count, 1);
      assert.equal(listingsBody.listings[0].company, 'Davis Polk');
      // Defaults applied: status falls back to 'new', rating to null.
      assert.equal(listingsBody.listings[0].status, 'new');
      assert.equal(listingsBody.listings[0].rating, null);

      const statsRes = await fetch(`${base}/api/stats`);
      assert.equal(statsRes.status, 200);
      const statsBody = await statsRes.json();
      assert.equal(statsBody.total, 1);
      assert.equal(statsBody.byStatus.new, 1);
    });
  });
});

describe('API resilience: missing rejectReasons bucket', () => {
  it('returns rejectReason: null when the bucket key is absent', async () => {
    // rejectReasons is a newer bucket — older feedback.json files predate it.
    // The hydrate fallback must not crash when the key is missing.
    await writeFile(
      FEEDBACK_PATH,
      JSON.stringify({ status: {}, rating: {} }),
      'utf-8',
    );

    await withServer(async (base) => {
      const res = await fetch(`${base}/api/listings`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.count, 1);
      assert.equal(
        body.listings[0].rejectReason,
        null,
        'missing rejectReasons bucket should hydrate to null, not throw',
      );
    });
  });
});
