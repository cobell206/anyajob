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

const DEFAULT_BASE = 'http://localhost:3000';
const HEADERS = JSON.parse(process.env.SMOKE_HEADERS || '{}');

// Each probe: path, the checks that must hold, and a `shape` fn returning a
// normalized projection used for --compare (so volatile fields like timestamps
// don't cause false diffs).
const PROBES = [
  {
    path: '/',
    contentType: 'text/html',
    check: (status, _ct, body) => status === 200 && /<html/i.test(body),
    shape: (body) => ({ hasApp: /<html/i.test(body) }),
  },
  {
    path: '/api/listings',
    contentType: 'application/json',
    check: (status, _ct, body) => status === 200 && Array.isArray(parse(body)?.listings),
    shape: (body) => ({ count: parse(body)?.listings?.length ?? null }),
  },
  {
    path: '/api/stats',
    contentType: 'application/json',
    check: (status) => status === 200,
    shape: (body) => {
      const s = parse(body) || {};
      // Project stable keys only; values may legitimately match across origins
      // reading the same S3 state.
      return Object.fromEntries(Object.keys(s).sort().map((k) => [k, typeof s[k]]));
    },
  },
  {
    path: '/api/diagnostic',
    contentType: 'application/json',
    check: (status, _ct, body) => status === 200 && typeof parse(body) === 'object',
    shape: (body) => Object.keys(parse(body) || {}).sort(),
  },
];

function parse(body) {
  try { return JSON.parse(body); } catch { return null; }
}

async function fetchProbe(base, path) {
  const url = base.replace(/\/$/, '') + path;
  const res = await fetch(url, { headers: HEADERS });
  const body = await res.text();
  return { status: res.status, ct: res.headers.get('content-type') || '', body };
}

async function health(base) {
  console.log(`\n▶ Smoke: ${base}`);
  let failed = 0;
  for (const probe of PROBES) {
    try {
      const { status, ct, body } = await fetchProbe(base, probe.path);
      const ok = probe.check(status, ct, body);
      console.log(`  ${ok ? '✔' : '✘'} ${probe.path} — ${status} ${ct.split(';')[0]}`);
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
      const [ra, rb] = await Promise.all([fetchProbe(a, probe.path), fetchProbe(b, probe.path)]);
      const sa = JSON.stringify(probe.shape(ra.body));
      const sb = JSON.stringify(probe.shape(rb.body));
      const same = ra.status === rb.status && sa === sb;
      console.log(`  ${same ? '✔' : '✘'} ${probe.path} — ${ra.status}/${rb.status} ${same ? '' : `\n      A=${sa}\n      B=${sb}`}`);
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
