// src/docstore.contract.test.js
// Contract for the binary document store — must hold identically on fs and s3.
// Runs against whatever STORAGE points at (fs default; s3 with DOCS_BUCKET set).
// Uses a unique fingerprint namespace so it never touches real documents, and
// cleans up via removeDoc.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  putDoc,
  getDocBuffer,
  getDocStream,
  docExists,
  removeDoc,
  mimeFor,
} from './docstore.js';

const BE = process.env.STORAGE || 'fs';
const FP = `__doctest_${randomUUID()}`;
const PDF = 'resume-x.pdf';
const TXT = 'notes-x.txt';

after(async () => {
  await removeDoc(FP, PDF);
  await removeDoc(FP, TXT);
});

async function streamToBuffer(body) {
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

test(`[${BE}] putDoc → getDocBuffer round-trips bytes`, async () => {
  const data = Buffer.from('%PDF-1.4 fake pdf bytes \x00\x01\x02', 'binary');
  await putDoc(FP, PDF, data);
  const got = await getDocBuffer(FP, PDF);
  assert.ok(got.equals(data));
});

test(`[${BE}] getDocStream yields the same bytes + contentType + length`, async () => {
  const data = Buffer.from('hello résumé text', 'utf-8');
  await putDoc(FP, TXT, data);
  const { body, contentType, contentLength } = await getDocStream(FP, TXT);
  const got = await streamToBuffer(body);
  assert.ok(got.equals(data));
  assert.equal(contentType, 'text/plain; charset=utf-8');
  assert.equal(contentLength, data.length);
});

test(`[${BE}] docExists reflects presence`, async () => {
  await putDoc(FP, PDF, Buffer.from('x'));
  assert.equal(await docExists(FP, PDF), true);
  assert.equal(await docExists(FP, 'nope.pdf'), false);
});

test(`[${BE}] getDocBuffer throws (ENOENT) on a missing file`, async () => {
  await assert.rejects(() => getDocBuffer(FP, 'missing.pdf'), (e) => e.code === 'ENOENT');
});

test(`[${BE}] rejects filename path traversal`, async () => {
  await assert.rejects(() => getDocBuffer(FP, '../secret.pdf'));
  await assert.rejects(() => putDoc(FP, 'a/b.pdf', Buffer.from('x')));
});

test(`[${BE}] mimeFor maps known extensions`, () => {
  assert.equal(mimeFor('a.pdf'), 'application/pdf');
  assert.equal(mimeFor('a.txt'), 'text/plain; charset=utf-8');
  assert.equal(mimeFor('a.bin'), 'application/octet-stream');
});

test(`[${BE}] removeDoc deletes; no-op when absent`, async () => {
  await putDoc(FP, PDF, Buffer.from('x'));
  await removeDoc(FP, PDF);
  assert.equal(await docExists(FP, PDF), false);
  await removeDoc(FP, PDF); // second remove must not throw
});
