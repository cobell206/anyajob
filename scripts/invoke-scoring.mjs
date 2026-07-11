// scripts/invoke-scoring.mjs
// Opt-in M4 validation of the NATIVE @napi-rs/canvas / PDF-extraction path on
// the deployed Lambda — the one thing the GET parity probes can't exercise
// (scoring is a POST). SigV4-signs a POST to /api/profile/resume/feedback, which
// regenerates the résumé feedback: readFullResumeText → extractText → pdf-parse
// → pdfjs → @napi-rs/canvas. If the linux binary didn't load, this fails with a
// DOMMatrix/canvas error instead of returning feedback.
//
// COST/EFFECT: makes one real Anthropic call (~cents) and refreshes the cached
// résumé feedback in S3 (same as clicking "score" in the UI). Run once at deploy.
//
// Usage:  node scripts/invoke-scoring.mjs <API_GW_BASE_URL>

import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/invoke-scoring.mjs <API_GW_BASE_URL>');
  process.exit(2);
}

const u = new URL(base.replace(/\/$/, '') + '/api/profile/resume/feedback');
const region = u.host.includes('.execute-api.')
  ? u.host.split('.execute-api.')[1].split('.')[0]
  : (process.env.AWS_REGION || 'us-east-1');
const body = JSON.stringify({ lens: 'law-school' });

const signer = new SignatureV4({
  service: 'execute-api',
  region,
  credentials: defaultProvider(),
  sha256: Sha256,
});
const req = new HttpRequest({
  method: 'POST',
  protocol: u.protocol,
  hostname: u.hostname,
  path: u.pathname,
  headers: { host: u.hostname, 'content-type': 'application/json' },
  body,
});
const signed = await signer.sign(req);

console.log('▶ POST', u.pathname, '(SigV4) — regenerating résumé feedback on the Lambda…');
const res = await fetch(u, { method: 'POST', headers: signed.headers, body });
const text = await res.text();
let j;
try { j = JSON.parse(text); } catch { /* non-JSON */ }

console.log('status:', res.status);
if (res.status === 200 && j && !j.error) {
  const detail = Array.isArray(j.findings)
    ? `${j.findings.length} findings`
    : (j.score != null ? `score ${j.score}` : 'ok');
  console.log(`✔ scoring worked → native PDF extraction (canvas) loads on Lambda: ${detail}`);
} else {
  console.log('✘ scoring failed — response body:');
  console.log('  ' + text.slice(0, 500));
  console.log('  (a DOMMatrix / "@napi-rs/canvas" error here means the linux binary did not load)');
  process.exit(1);
}
