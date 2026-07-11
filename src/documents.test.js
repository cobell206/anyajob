// src/documents.test.js
// Upload validation is PDF/TXT-only after the LibreOffice removal (M2). Word
// docs must be rejected at the door — there is no server-side conversion left.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUpload } from './documents.js';

const OK_SIZE = 1024;

test('validateUpload accepts .pdf', () => {
  const v = validateUpload('resume.pdf', OK_SIZE);
  assert.equal(v.ok, true);
  assert.equal(v.ext, '.pdf');
});

test('validateUpload accepts .txt', () => {
  assert.equal(validateUpload('notes.txt', OK_SIZE).ok, true);
});

test('validateUpload accepts uppercase extension (.PDF)', () => {
  assert.equal(validateUpload('RESUME.PDF', OK_SIZE).ok, true);
});

test('validateUpload rejects .docx', () => {
  const v = validateUpload('resume.docx', OK_SIZE);
  assert.equal(v.ok, false);
  assert.match(v.error, /allowed/i);
});

test('validateUpload rejects .doc', () => {
  assert.equal(validateUpload('resume.doc', OK_SIZE).ok, false);
});

test('validateUpload rejects a file over the 5MB cap', () => {
  const v = validateUpload('resume.pdf', 6 * 1024 * 1024);
  assert.equal(v.ok, false);
  assert.match(v.error, /5MB/i);
});
