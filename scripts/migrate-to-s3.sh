#!/usr/bin/env bash
# One-shot: copy the LIVE data/ (JSON) + data/documents/ into the S3 buckets.
# Run on the EC2 host (via .github/workflows/s3-migrate.yml). See
# SERVERLESS-TRANSITION.md — this is the authoritative prod->S3 migration.
#
# Usage: migrate-to-s3.sh [inspect|execute]   (default: inspect)
#   inspect — identity + a hash inventory, no writes
#   execute — unconditional `aws s3 cp` (NOT sync: the stale dev snapshot in S3
#             has a newer LastModified, so sync would skip live files)
set -uo pipefail

MODE="${1:-inspect}"
DATA_BUCKET="${DATA_BUCKET:-anyajob-data}"
DOCS_BUCKET="${DOCS_BUCKET:-anyajob-docs}"

echo "=== AWS identity (this is what needs bucket write access) ==="
aws sts get-caller-identity 2>&1 || echo "!! no working AWS creds on EC2"
echo "=== region ==="
aws configure get region 2>/dev/null || echo "(no default region configured)"

echo "=== data/*.json inventory (name  size  md5) ==="
for f in data/*.json; do
  [ -e "$f" ] || continue
  printf '%s\t%s\t%s\n' "$(basename "$f")" "$(stat -c%s "$f")" "$(md5sum "$f" | cut -d' ' -f1)"
done

echo "=== data/documents inventory (path  size) ==="
find data/documents -type f -printf '%P\t%s\n' 2>/dev/null | sort || echo "(no documents dir)"

echo "=== bucket reachability ==="
aws s3 ls "s3://$DATA_BUCKET/" >/dev/null 2>&1 && echo "read $DATA_BUCKET: OK" || echo "read $DATA_BUCKET: DENIED/err"
aws s3 ls "s3://$DOCS_BUCKET/" >/dev/null 2>&1 && echo "read $DOCS_BUCKET: OK" || echo "read $DOCS_BUCKET: DENIED/err"

if [ "$MODE" = "execute" ]; then
  echo "=== EXECUTE: unconditional cp of live data -> S3 ==="
  set -e
  aws s3 cp data/ "s3://$DATA_BUCKET/" --recursive \
    --exclude "*" --include "*.json" --exclude "documents/*"
  aws s3 cp data/documents/ "s3://$DOCS_BUCKET/" --recursive
  echo "=== EXECUTE complete ==="
else
  echo "(inspect only — pass 'execute' to copy; EC2 needs s3:PutObject on the buckets first)"
fi
