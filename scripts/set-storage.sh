#!/usr/bin/env bash
# Flip the app's storage backend by upserting .env on the EC2 host. The caller
# restarts the service afterward. Usage: set-storage.sh <fs|s3>
#   s3 — write STORAGE=s3 + bucket/region envs (run production on S3)
#   fs — remove STORAGE (back to local disk; if writes happened on S3, sync
#        s3://anyajob-data + anyajob-docs back down to data/ first)
set -euo pipefail

BACKEND="${1:?usage: set-storage.sh <fs|s3>}"

upsert() {
  local k="$1" v="$2"
  if grep -q "^${k}=" .env 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" .env
  else
    echo "${k}=${v}" >> .env
  fi
}

case "$BACKEND" in
  s3)
    upsert STORAGE s3
    upsert S3_BUCKET anyajob-data
    upsert DOCS_BUCKET anyajob-docs
    upsert AWS_REGION us-east-1
    ;;
  fs)
    sed -i '/^STORAGE=/d' .env
    ;;
  *)
    echo "unknown backend: $BACKEND (expected fs|s3)"; exit 1
    ;;
esac

echo "storage env now:"
grep -E '^(STORAGE|S3_BUCKET|DOCS_BUCKET|AWS_REGION)=' .env || echo "(no STORAGE -> fs backend)"
