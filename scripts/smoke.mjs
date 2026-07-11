// scripts/smoke.mjs
// Endpoint health + parity check for a running instance. Parameterized by base
// URL so it runs against local dev, EC2, or the API Gateway origin — the same
// probe validates every migration (see SERVERLESS-TRANSITION.md).
//
// Usage:
//   node scripts/smoke.mjs [BASE_URL]           # health check one origin
//   node scripts/smoke.mjs --compare A B        # M4/M5 parity: diff two origins
//
// BASE_URL defaults to http://localhost:3000. Behind Cloudflare Access the
// endpoints require auth; pass a service-token header via SMOKE_HEADERS as a
// JSON object, e.g. SMOKE_HEADERS='{"CF-Access-Client-Id":"…","CF-Access-Client-Secret":"…"}'.
//
// Auth for the API Gateway origin (M4): its route uses AWS_IAM authorization,
// so any origin whose host contains `.execute-api.` is SigV4-signed
// automatically (service `execute-api`, region parsed from the host) using the
// ambient AWS credential chain. The EC2 origin is fetched unsigned. This is what
// lets `--compare <EC2> <API-GW>` diff the two despite the gateway requiring IAM.

import { createHash } from 'node:crypto';

const DEFAULT_BASE = 'http://localhost:3000';
const HEADERS = JSON.parse(process.env.SMOKE_HEADERS || '{}');

// Each probe: path, the check that must hold (health mode), and a `shape` fn
// returning a normalized projection used for --compare (so volatile fields like
// timestamps don't cause false diffs). Both receive the full result object
// `{ status, ct, body, buf, hash }`. `binary: true` probes compare the sha256
// of the raw bytes — a true byte-for-byte check (the PDF-download parity gate).
const PROBES = [
  {
    path: '/',
    check: (r) => r.status === 200 && /<html/i.test(r.body),
    shape: (r) => ({ hasApp: /<html/i.test(r.body) }),
  },
  {
    path: '/api/listings',
    check: (r) => r.status === 200 && Array.isArray(parse(r.body)?.listings),
    shape: (r) => ({ count: parse(r.body)?.listings?.length ?? null }),
  },
  {
    path: '/api/stats',
    check: (r) => r.status === 200,
    // Project stable keys only; values may legitimately match across origins
    // reading the same S3 state.
    shape: (r) => {
      const s = parse(r.body) || {};
      return Object.fromEntries(Object.keys(s).sort().map((k) => [k, typeof s[k]]));
    },
  },
  {
    path: '/api/diagnostic',
    check: (r) => r.status === 200 && typeof parse(r.body) === 'object',
    shape: (r) => Object.keys(parse(r.body) || {}).sort(),
  },
  {
    // The profile résumé PDF. Byte-for-byte parity is the M4 proof that binary
    // responses survive base64/isBase64Encoded through API Gateway. Soft-skips a
    // 404 in health mode (a fresh dev box may have no résumé); in --compare, a
    // matching 404/404 is still valid parity.
    path: '/api/profile/resume?download=1',
    binary: true,
    soft404: true,
    check: (r) =>
      r.status === 200 &&
      r.ct.includes('application/pdf') &&
      r.buf.subarray(0, 5).toString('latin1') === '%PDF-',
    shape: (r) => ({ status: r.status, ct: r.ct.split(';')[0], sha256: r.hash }),
  },
];

function parse(body) {
  try { return JSON.parse(body); } catch { return null; }
}

// ---- SigV4 signing for the API Gateway (execute-api) origin ----
function needsSigv4(url) {
  try { return new URL(url).host.includes('.execute-api.'); } catch { return false; }
}

const signerCache = new Map();
async function getSigner(region) {
  if (signerCache.has(region)) return signerCache.get(region);
  // Lazy-imported so the plain health path needs no AWS libs/creds. These are
  // already present transitively via @aws-sdk/client-s3.
  const { SignatureV4 } = await import('@smithy/signature-v4');
  const { Sha256 } = await import('@aws-crypto/sha256-js');
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
  const signer = new SignatureV4({
    service: 'execute-api',
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  signerCache.set(region, signer);
  return signer;
}

async function doFetch(url) {
  if (!needsSigv4(url)) return fetch(url, { headers: HEADERS });
  const { HttpRequest } = await import('@smithy/protocol-http');
  const u = new URL(url);
  const region = u.host.split('.execute-api.')[1].split('.')[0];
  const signer = await getSigner(region);
  const req = new HttpRequest({
    method: 'GET',
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers: { ...HEADERS, host: u.hostname },
  });
  const signed = await signer.sign(req);
  return fetch(url, { method: 'GET', headers: signed.headers });
}

async function fetchProbe(base, probe) {
  const url = base.replace(/\/$/, '') + probe.path;
  const res = await doFetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(buf).digest('hex');
  return {
    status: res.status,
    ct: res.headers.get('content-type') || '',
    body: probe.binary ? '' : buf.toString('utf8'),
    buf,
    hash,
  };
}

async function health(base) {
  console.log(`\n▶ Smoke: ${base}`);
  let failed = 0;
  for (const probe of PROBES) {
    try {
      const r = await fetchProbe(base, probe);
      if (probe.soft404 && r.status === 404) {
        console.log(`  ⚠ ${probe.path} — 404 (skipped: nothing uploaded)`);
        continue;
      }
      const ok = probe.check(r);
      const detail = probe.binary ? `${r.ct.split(';')[0]} ${r.hash.slice(0, 12)}` : r.ct.split(';')[0];
      console.log(`  ${ok ? '✔' : '✘'} ${probe.path} — ${r.status} ${detail}`);
      if (!ok) failed++;
    } catch (err) {
      console.log(`  ✘ ${probe.path} — ${err.message}`);
      failed++;
    }
  }
  return failed;
}

async function compare(a, b) {
  console.log(`\n▶ Parity: ${a}  vs  ${b}`);
  let diffs = 0;
  for (const probe of PROBES) {
    try {
      const [ra, rb] = await Promise.all([fetchProbe(a, probe), fetchProbe(b, probe)]);
      const sa = JSON.stringify(probe.shape(ra));
      const sb = JSON.stringify(probe.shape(rb));
      const same = ra.status === rb.status && sa === sb;
      const tag = probe.binary ? ' (bytes)' : '';
      console.log(`  ${same ? '✔' : '✘'} ${probe.path}${tag} — ${ra.status}/${rb.status} ${same ? '' : `\n      A=${sa}\n      B=${sb}`}`);
      if (!same) diffs++;
    } catch (err) {
      console.log(`  ✘ ${probe.path} — ${err.message}`);
      diffs++;
    }
  }
  return diffs;
}

const args = process.argv.slice(2);
let failures;
if (args[0] === '--compare') {
  if (!args[1] || !args[2]) {
    console.error('usage: node scripts/smoke.mjs --compare <A> <B>');
    process.exit(2);
  }
  failures = await compare(args[1], args[2]);
} else {
  failures = await health(args[0] || DEFAULT_BASE);
}

if (failures > 0) {
  console.log(`\n✘ ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n✔ all checks passed\n');
