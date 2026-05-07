// src/io.js
// Shared helpers for reading/writing JSON files in the data/ directory.
// Used by every route module so we don't duplicate path-resolution logic.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from './atomic.js';
import { createLogger } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DATA = join(ROOT, 'data');
const log = createLogger('io');

// Try to recover a value from JSON text that has trailing garbage past the
// first complete value (e.g. an extra "}" appended by a botched write).
// Returns the parsed value or null if no balanced prefix can be parsed.
function tryParseLeadingJson(text) {
  const open = text.search(/[\[{]/);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(open, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export async function readJson(name) {
  const path = join(DATA, name);
  const text = await readFile(path, 'utf-8');
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const recovered = tryParseLeadingJson(text);
    if (recovered === null) throw err;
    log.warn({ name, err: err.message }, 'corrupt JSON: recovered leading value and rewriting');
    try { await writeJsonAtomic(path, recovered); } catch (e) {
      log.warn({ name, err: e.message }, 'failed to rewrite recovered JSON');
    }
    return recovered;
  }
}

export async function writeJson(name, data) {
  await writeJsonAtomic(join(DATA, name), data);
}

// Same listing identity helper used in summaries.js / score.js / daily.js.
// Per-listing key for feedback lookups; falls back to fingerprint for legacy data.
export const fbKey = (l) => l.dedupKey || l.fingerprint;
