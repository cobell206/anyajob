#!/usr/bin/env bash
# scripts/parity-m4.sh — M4 dark-parity gate (see SERVERLESS-TRANSITION.md).
#
# Boots a LOCAL reference server on STORAGE=s3 — the *same M4 code* as the
# Lambda, reading the *same prod S3 buckets* — and diffs it against the deployed
# API Gateway origin via scripts/smoke.mjs. "Same code, different host" is
# exactly what M4 proves. (EC2 is a worse reference here: it still runs pre-M4
# code and isn't directly reachable without a Cloudflare token / SSH tunnel.)
#
# The Lambda origin is SigV4-signed automatically by smoke.mjs (AWS_IAM route
# auth). All probes are GET, so the local server never writes to prod S3.
#
# Usage:  bash scripts/parity-m4.sh <API_GW_BASE_URL>
# Needs local AWS credentials that can read anyajob-data / anyajob-docs.

set -euo pipefail
API="${1:?usage: parity-m4.sh <API_GW_BASE_URL>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=3011

log(){ printf '\033[1;34m▸\033[0m %s\n' "$*"; }

log "Booting local reference server on :$PORT (STORAGE=s3 → prod buckets, GET-only probes)"
STORAGE=s3 S3_BUCKET=anyajob-data DOCS_BUCKET=anyajob-docs AWS_REGION=us-east-1 PORT=$PORT \
  node "$ROOT/src/server.js" > /tmp/parity-local.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/api/listings" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -sf "http://localhost:$PORT/api/listings" >/dev/null 2>&1; then
  echo "FAIL: local reference server never became healthy; see /tmp/parity-local.log" >&2
  tail -20 /tmp/parity-local.log >&2 || true
  exit 1
fi

log "Comparing  local-on-s3  vs  Lambda-on-s3"
node "$ROOT/scripts/smoke.mjs" --compare "http://localhost:$PORT" "$API"
