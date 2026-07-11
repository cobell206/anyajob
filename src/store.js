// src/store.js
// THE storage seam. Every read/write of a data/*.json file funnels through
// here so the backing store can be swapped (local disk now; S3 in the
// serverless migration — see SERVERLESS-TRANSITION.md) without touching any
// caller. `io.js` and `atomic.js` are thin re-exports of this module, kept so
// existing imports (readJson / writeJson / writeJsonAtomic / readJsonSafe /
// readJsonStrict) keep working unchanged.
//
// Backend is chosen by env: STORAGE=fs (default) | s3 (added in M1).
//
// Keys: data files live flat in data/ (listings.json, feedback.json, …), so a
// file's *basename* is its stable key. Callers may pass either a bare name
// ("listings.json") or an absolute path (…/data/listings.json) — both resolve
// to the same key. Binaries (uploaded docs, logs) do NOT go through here.

import { open, rename, unlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createLogger } from './log.js';

const log = createLogger('store');

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DATA = join(ROOT, 'data');

const BACKEND = process.env.STORAGE || 'fs';

// A file's key is its basename — data files are flat in data/.
const keyFor = (nameOrPath) => basename(String(nameOrPath));

// ---- fs backend: the original on-disk behavior, unchanged semantics.
// Atomic write = tmp + fsync + rename (POSIX rename is atomic, so a reader
// sees either the whole old file or the whole new one, never a partial).
const fsBackend = {
  async readText(key) {
    return readFile(join(DATA, key), 'utf-8');
  },
  async writeText(key, text) {
    const path = join(DATA, key);
    const tmp = path + '.tmp';
    let fh;
    try {
      fh = await open(tmp, 'w');
      await fh.writeFile(text, 'utf-8');
      await fh.sync(); // flush bytes to disk before rename
      await fh.close();
      fh = null;
      await rename(tmp, path);
    } catch (err) {
      if (fh) { try { await fh.close(); } catch {} }
      if (existsSync(tmp)) { try { await unlink(tmp); } catch {} }
      throw err;
    }
  },
  async exists(key) {
    return existsSync(join(DATA, key));
  },
  async remove(key) {
    try { await unlink(join(DATA, key)); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  },
};

// ---- s3 backend: same interface as fs, backed by one object per key.
// PutObject is atomic (readers see the whole old or new object, never a
// partial), so no tmp+rename dance is needed. Missing objects are mapped to an
// ENOENT-coded error so readJsonSafe's fallback path works identically to fs.
function makeS3Backend() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('STORAGE=s3 requires S3_BUCKET to be set');
  const region = process.env.AWS_REGION || 'us-east-1';
  const prefix = process.env.S3_PREFIX || ''; // e.g. "data/"; empty = bucket root
  const client = new S3Client({ region });
  const s3key = (key) => prefix + key;

  const isMissing = (err) =>
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.$metadata?.httpStatusCode === 404;

  return {
    async readText(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: s3key(key) }));
        return await res.Body.transformToString('utf-8');
      } catch (err) {
        if (isMissing(err)) {
          const e = new Error(`no such object: ${s3key(key)}`);
          e.code = 'ENOENT'; // match fs so readJsonSafe returns its fallback
          throw e;
        }
        throw err;
      }
    },
    async writeText(key, text) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: s3key(key),
        Body: text,
        ContentType: 'application/json',
      }));
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3key(key) }));
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
    async remove(key) {
      // DeleteObject is idempotent — no error if the key is already absent.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3key(key) }));
    },
  };
}

// Guarded so a misconfigured env fails loudly rather than silently falling
// back to disk (which would read stale data).
function selectBackend(name) {
  if (name === 'fs') return fsBackend;
  if (name === 's3') return makeS3Backend();
  throw new Error(`Unknown STORAGE backend: ${name} (expected fs | s3)`);
}
const backend = selectBackend(BACKEND);

// Recover a value from JSON text that has trailing garbage past the first
// complete value (e.g. an extra "}" from a botched write). Returns the parsed
// value or null if no balanced prefix parses.
function tryParseLeadingJson(text) {
  const open = text.search(/[[{]/);
  if (open < 0) return null;
  let depth = 0, inStr = false, esc = false;
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

// ---- Public API ---------------------------------------------------------

// Read + parse. On corrupt JSON, recover the leading value and rewrite it
// (self-healing). Throws on missing file.
export async function readJson(nameOrPath) {
  const key = keyFor(nameOrPath);
  const text = await backend.readText(key);
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const recovered = tryParseLeadingJson(text);
    if (recovered === null) throw err;
    log.warn({ key, err: err.message }, 'corrupt JSON: recovered leading value and rewriting');
    try { await writeJson(key, recovered); } catch (e) {
      log.warn({ key, err: e.message }, 'failed to rewrite recovered JSON');
    }
    return recovered;
  }
}

// Read + parse with a fallback on missing OR corrupt (no throw). Use for files
// that may not exist on first run.
export async function readJsonSafe(nameOrPath, { fallback = null } = {}) {
  const key = keyFor(nameOrPath);
  let text;
  try {
    text = await backend.readText(key);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) {
      log.warn({ key, err: err.message }, 'corrupt JSON, returning fallback');
      return fallback;
    }
    throw err;
  }
}

// Read + parse with NO recovery and NO fallback — throws on missing or corrupt.
// Use when the file MUST exist and be valid (e.g. preferences.json).
export async function readJsonStrict(nameOrPath) {
  const text = await backend.readText(keyFor(nameOrPath));
  return JSON.parse(text);
}

// Low-level raw text access. JSON helpers build on these; tests use writeRaw
// to inject malformed bytes. The S3 backend implements these as plain
// Get/PutObject.
export async function readRaw(nameOrPath) {
  return backend.readText(keyFor(nameOrPath));
}
export async function writeRaw(nameOrPath, text) {
  await backend.writeText(keyFor(nameOrPath), text);
}

// Atomic write of a JSON value.
export async function writeJson(nameOrPath, value, { indent = 2 } = {}) {
  await writeRaw(nameOrPath, JSON.stringify(value, null, indent));
}

// Does a data file exist? (First-run seed checks used fs.existsSync directly;
// route them through here so the S3 backend can answer too.)
export async function exists(nameOrPath) {
  return backend.exists(keyFor(nameOrPath));
}

// Delete a data file. No-op if absent.
export async function removeFile(nameOrPath) {
  await backend.remove(keyFor(nameOrPath));
}

// Same listing-identity helper used across summaries/score/daily. Per-listing
// key for feedback lookups; falls back to fingerprint for legacy data.
export const fbKey = (l) => l.dedupKey || l.fingerprint;
