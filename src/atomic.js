// src/atomic.js
//
// Atomic JSON writes. Used by anything that updates a file in `data/`.
//
// Why: a normal `writeFile` opens the file, truncates it to zero, then
// streams in new bytes. If the process dies mid-write (e.g. a deploy
// kicks the systemd service while the daily script is saving), the file
// is left empty or partially written. JSON parsing then fails on next
// read and the system can't recover without a restore.
//
// The atomic pattern: write to `<path>.tmp`, fsync the bytes to disk,
// then `rename()` over the real path. POSIX guarantees rename is atomic
// — readers always see either the old file or the complete new one,
// never a partial write.
//
// Usage:
//   import { writeJsonAtomic, readJsonSafe } from './atomic.js';
//   await writeJsonAtomic('/path/to/file.json', { foo: 'bar' });
//   const data = await readJsonSafe('/path/to/file.json', { fallback: {} });

import { open, rename, unlink } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createLogger } from './log.js';

const log = createLogger('atomic');

export async function writeJsonAtomic(path, value, { indent = 2 } = {}) {
  const tmp = path + '.tmp';
  const json = JSON.stringify(value, null, indent);

  let fh;
  try {
    fh = await open(tmp, 'w');
    await fh.writeFile(json, 'utf-8');
    await fh.sync(); // fsync — flush bytes to disk before rename
    await fh.close();
    fh = null;
    await rename(tmp, path);
  } catch (err) {
    // Cleanup on failure so we don't leave .tmp files lying around
    if (fh) {
      try { await fh.close(); } catch {}
    }
    if (existsSync(tmp)) {
      try { await unlink(tmp); } catch {}
    }
    throw err;
  }
}

// Read a JSON file with safe fallback. Returns `fallback` on missing or
// corrupt file rather than throwing — useful for files that may not exist
// on first run.
export async function readJsonSafe(path, { fallback = null } = {}) {
  try {
    const text = await readFile(path, 'utf-8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      log.warn({ path, err: err.message }, 'corrupt JSON, returning fallback');
      return fallback;
    }
    throw err;
  }
}

// Read JSON file with no fallback — throws on missing or corrupt.
// Use when the file MUST exist (e.g. preferences.json).
export async function readJsonStrict(path) {
  const text = await readFile(path, 'utf-8');
  return JSON.parse(text);
}
