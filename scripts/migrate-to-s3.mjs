// scripts/migrate-to-s3.mjs
// One-shot prod -> S3 data migration, run ON the EC2 host (via
// .github/workflows/s3-migrate.yml). Authenticates via dotenv + the S3 SDK —
// exactly how the app loads AWS creds — so no shell-credential wrangling.
// See SERVERLESS-TRANSITION.md. This is the authoritative migration; the M1/M3
// dev snapshot in the buckets is stale.
//
// Usage: node scripts/migrate-to-s3.mjs [inspect|execute]
//   inspect — creds/identity check + counts, no writes (default)
//   execute — PutObject every data/*.json and data/documents/** into the buckets
//             (unconditional overwrite — versioning retains the old snapshot)

import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

const MODE = process.argv[2] || 'inspect';
const REGION = process.env.AWS_REGION || 'us-east-1';
const DATA_BUCKET = process.env.S3_BUCKET || 'anyajob-data';
const DOCS_BUCKET = process.env.DOCS_BUCKET || 'anyajob-docs';
const s3 = new S3Client({ region: REGION });

function contentType(f) {
  if (f.endsWith('.pdf')) return 'application/pdf';
  if (f.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (f.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function main() {
  console.log(`mode=${MODE} region=${REGION} data=${DATA_BUCKET} docs=${DOCS_BUCKET}`);
  console.log(
    'creds present:',
    !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE),
    '| keyId tail:', (process.env.AWS_ACCESS_KEY_ID || '').slice(-4) || '(none)',
  );

  const dataFiles = (await readdir('data')).filter((f) => f.endsWith('.json'));
  const docFiles = existsSync('data/documents') ? await walk('data/documents') : [];
  console.log(`local: ${dataFiles.length} data json, ${docFiles.length} document files`);

  // Reachability / auth probe — surfaces AccessDenied (with the principal ARN)
  // so we know exactly which identity to grant if writes are denied.
  for (const b of [DATA_BUCKET, DOCS_BUCKET]) {
    try {
      await s3.send(new ListObjectsV2Command({ Bucket: b, MaxKeys: 1 }));
      console.log(`read ${b}: OK`);
    } catch (e) {
      console.log(`read ${b}: ${e.name} — ${String(e.message).split('\n')[0]}`);
    }
  }

  if (MODE !== 'execute') {
    console.log('(inspect only — pass "execute" to copy)');
    return;
  }

  let n = 0;
  for (const f of dataFiles) {
    const Body = await readFile(join('data', f));
    await s3.send(new PutObjectCommand({
      Bucket: DATA_BUCKET, Key: f, Body, ContentType: 'application/json',
    }));
    n++;
  }
  console.log(`uploaded ${n} data files -> ${DATA_BUCKET}`);

  let m = 0;
  for (const p of docFiles) {
    const Key = relative('data/documents', p).split('\\').join('/');
    const Body = await readFile(p);
    await s3.send(new PutObjectCommand({
      Bucket: DOCS_BUCKET, Key, Body, ContentType: contentType(p),
    }));
    m++;
  }
  console.log(`uploaded ${m} document files -> ${DOCS_BUCKET}`);
  console.log('=== migration complete ===');
}

main().catch((e) => { console.error('MIGRATION FAILED:', e); process.exit(1); });
