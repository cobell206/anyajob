// src/store.contract.test.js
// The storage CONTRACT: behaviors every backend must satisfy identically.
// Runs against whatever STORAGE points at (fs by default). In M1 the same
// suite runs with STORAGE=s3 against a scratch bucket — if it's green on both,
// "s3 == fs" is proven, not hoped (see SERVERLESS-TRANSITION.md).
//
// Uses a unique temp key per run so it never touches real data/ files, and
// cleans up via the store's own removeFile so cleanup is backend-agnostic.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  readJson,
  readJsonSafe,
  readJsonStrict,
  writeJson,
  writeRaw,
  exists,
  removeFile,
} from './store.js';

const KEY = `__contract_${randomUUID()}.json`;
const MISSING = `__contract_missing_${randomUUID()}.json`;

after(async () => {
  await removeFile(KEY);
  await removeFile(MISSING);
});

test(`[${process.env.STORAGE || 'fs'}] write → read round-trips a value`, async () => {
  const value = { a: 1, nested: { b: [1, 2, 3] }, s: 'héllo' };
  await writeJson(KEY, value);
  assert.deepEqual(await readJson(KEY), value);
});

test(`[${process.env.STORAGE || 'fs'}] writeJson overwrites (atomic replace, no partial)`, async () => {
  await writeJson(KEY, { v: 1 });
  await writeJson(KEY, { v: 2 });
  // A reader sees the whole old or whole new value — never a merge or a
  // truncated file. After the second write it must be exactly v:2.
  assert.deepEqual(await readJson(KEY), { v: 2 });
});

test(`[${process.env.STORAGE || 'fs'}] exists reflects presence`, async () => {
  await writeJson(KEY, { ok: true });
  assert.equal(await exists(KEY), true);
  assert.equal(await exists(MISSING), false);
});

test(`[${process.env.STORAGE || 'fs'}] readJsonSafe returns fallback on missing`, async () => {
  const fallback = { fresh: true };
  assert.deepEqual(await readJsonSafe(MISSING, { fallback }), fallback);
});

test(`[${process.env.STORAGE || 'fs'}] readJson throws on missing`, async () => {
  await assert.rejects(() => readJson(MISSING));
});

test(`[${process.env.STORAGE || 'fs'}] readJsonStrict throws on missing`, async () => {
  await assert.rejects(() => readJsonStrict(MISSING));
});

test(`[${process.env.STORAGE || 'fs'}] readJson recovers a value with trailing garbage + rewrites clean`, async () => {
  // Botched write: a complete value followed by junk bytes.
  await writeRaw(KEY, '{"good":1}\n}}garbage');
  assert.deepEqual(await readJson(KEY), { good: 1 });
  // Self-heal: the recovered value is rewritten, so a second read is clean.
  assert.deepEqual(await readJson(KEY), { good: 1 });
});

test(`[${process.env.STORAGE || 'fs'}] readJsonSafe returns fallback on unrecoverable corruption`, async () => {
  await writeRaw(KEY, 'not json at all {{{');
  assert.deepEqual(await readJsonSafe(KEY, { fallback: { safe: true } }), { safe: true });
});

test(`[${process.env.STORAGE || 'fs'}] name and absolute-path keys resolve to the same file`, async () => {
  await writeJson(KEY, { via: 'name' });
  // An absolute-ish path with the same basename must hit the same key.
  const asPath = `/some/abs/data/${KEY}`;
  assert.deepEqual(await readJson(asPath), { via: 'name' });
  await writeJson(asPath, { via: 'path' });
  assert.deepEqual(await readJson(KEY), { via: 'path' });
});

test(`[${process.env.STORAGE || 'fs'}] removeFile deletes; is a no-op when absent`, async () => {
  await writeJson(KEY, { x: 1 });
  await removeFile(KEY);
  assert.equal(await exists(KEY), false);
  await removeFile(KEY); // second remove must not throw
});
