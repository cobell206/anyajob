// src/docstore.js
// Binary document store: uploaded résumés / cover letters / other files.
// Sibling of store.js (the JSON data seam) but separate because documents are
// binaries in their own bucket. Same STORAGE switch:
//   fs (default) — data/documents/{fingerprint}/{file}
//   s3           — DOCS_BUCKET, key {prefix}{fingerprint}/{file}
//
// Keys are {fingerprint}/{filename}. Callers pass fingerprint + filename and
// we sanitize (no traversal, no slashes) before building the key — the same
// guard the old getDocumentPath enforced.

import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(__dirname, '..', 'data', 'documents');
const BACKEND = process.env.STORAGE || 'fs';

const MIME = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};
export function mimeFor(filename) {
  return MIME[extname(filename).toLowerCase()] || 'application/octet-stream';
}

function safeSegment(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

// {sanitized-fingerprint}/{filename}, rejecting any traversal in the filename.
function docKey(fingerprint, filename) {
  const safeName = safeSegment(filename);
  if (safeName !== filename || filename.includes('..') || filename.includes('/')) {
    throw new Error('Invalid filename');
  }
  return `${safeSegment(fingerprint)}/${filename}`;
}

const notFound = () => Object.assign(new Error('File not found'), { code: 'ENOENT' });

// ---- fs backend
const fsBackend = {
  async put(key, buffer) {
    const path = join(DOCS_ROOT, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
  },
  async getBuffer(key) {
    const path = join(DOCS_ROOT, key);
    if (!existsSync(path)) throw notFound();
    return readFile(path);
  },
  async getStream(key) {
    const path = join(DOCS_ROOT, key);
    if (!existsSync(path)) throw notFound();
    const { size } = await stat(path);
    return { body: createReadStream(path), contentLength: size };
  },
  async exists(key) {
    return existsSync(join(DOCS_ROOT, key));
  },
  async remove(key) {
    try { await unlink(join(DOCS_ROOT, key)); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  },
};

// ---- s3 backend
function makeS3Backend() {
  const bucket = process.env.DOCS_BUCKET;
  if (!bucket) throw new Error('STORAGE=s3 requires DOCS_BUCKET to be set');
  const region = process.env.AWS_REGION || 'us-east-1';
  const prefix = process.env.DOCS_PREFIX || '';
  const client = new S3Client({ region });
  const k = (key) => prefix + key;
  const isMissing = (err) =>
    err?.name === 'NoSuchKey' || err?.name === 'NotFound' ||
    err?.$metadata?.httpStatusCode === 404;

  return {
    async put(key, buffer, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: k(key), Body: buffer, ContentType: contentType,
      }));
    },
    async getBuffer(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k(key) }));
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (isMissing(err)) throw notFound();
        throw err;
      }
    },
    async getStream(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k(key) }));
        return { body: res.Body, contentLength: res.ContentLength };
      } catch (err) {
        if (isMissing(err)) throw notFound();
        throw err;
      }
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: k(key) }));
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k(key) }));
    },
  };
}

function selectBackend(name) {
  if (name === 'fs') return fsBackend;
  if (name === 's3') return makeS3Backend();
  throw new Error(`Unknown STORAGE backend: ${name} (expected fs | s3)`);
}
const backend = selectBackend(BACKEND);

// ---- Public API (fingerprint + filename, not raw keys)
export async function putDoc(fingerprint, filename, buffer, contentType = mimeFor(filename)) {
  await backend.put(docKey(fingerprint, filename), buffer, contentType);
}

export async function getDocBuffer(fingerprint, filename) {
  return backend.getBuffer(docKey(fingerprint, filename));
}

// Returns { body: Readable, contentType, contentLength } for the route to pipe.
export async function getDocStream(fingerprint, filename) {
  const { body, contentLength } = await backend.getStream(docKey(fingerprint, filename));
  return { body, contentType: mimeFor(filename), contentLength };
}

export async function docExists(fingerprint, filename) {
  return backend.exists(docKey(fingerprint, filename));
}

// Delete a document blob. No-op if absent. Note: the app's deleteDocument only
// edits the index (blobs are left/retained); this is a lower-level primitive
// used by tests and available for future cleanup.
export async function removeDoc(fingerprint, filename) {
  await backend.remove(docKey(fingerprint, filename));
}
