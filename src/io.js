// src/io.js
// Shared helpers for reading/writing JSON files in the data/ directory.
// Used by every route module so we don't duplicate path-resolution logic.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from './atomic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DATA = join(ROOT, 'data');

export async function readJson(name) {
  return JSON.parse(await readFile(join(DATA, name), 'utf-8'));
}

export async function writeJson(name, data) {
  await writeJsonAtomic(join(DATA, name), data);
}

// Same listing identity helper used in summaries.js / score.js / daily.js.
// Per-listing key for feedback lookups; falls back to fingerprint for legacy data.
export const fbKey = (l) => l.dedupKey || l.fingerprint;
