#!/usr/bin/env bash
# scripts/restore.sh — restore data/ from latest S3 backup.
# Reads BACKUP_BUCKET from .env. Prompts before overwriting.
#
# Usage:
#   ./scripts/restore.sh                  # interactive — restore latest
#   ./scripts/restore.sh 2026-05-02       # restore a specific date
#   ./scripts/restore.sh --list           # list available backups
#   ./scripts/restore.sh --yes            # skip confirmation prompt

set -euo pipefail

# ---------- locate repo and .env ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

if [[ ! -f .env ]]; then
  echo "✗ .env not found in $REPO_DIR" >&2
  exit 1
fi

# Source only the BACKUP_BUCKET line (don't pollute env with other vars)
BACKUP_BUCKET="$(grep -E '^BACKUP_BUCKET=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [[ -z "$BACKUP_BUCKET" ]]; then
  echo "✗ BACKUP_BUCKET not set in .env" >&2
  exit 1
fi

# ---------- output helpers ----------
log()  { printf "\033[1;34m▸\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; }

# ---------- parse args ----------
DATE=""
LIST_ONLY=false
SKIP_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    --list) LIST_ONLY=true ;;
    --yes|-y) SKIP_CONFIRM=true ;;
    --help|-h)
      grep -E '^#' "$0" | head -10
      exit 0
      ;;
    *) DATE="$arg" ;;
  esac
done

# ---------- list available backups ----------
list_backups() {
  log "Listing backups in $BACKUP_BUCKET..."
  aws s3 ls "${BACKUP_BUCKET%/}/" 2>/dev/null \
    | awk '{print $2}' \
    | sed 's:/$::' \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
    | sort -r
}

if $LIST_ONLY; then
  list_backups
  exit 0
fi

# ---------- determine date to restore ----------
if [[ -z "$DATE" ]]; then
  log "Finding latest backup..."
  DATE="$(list_backups | head -1)"
  if [[ -z "$DATE" ]]; then
    err "No backups found at $BACKUP_BUCKET"
    exit 1
  fi
  ok "Latest backup: $DATE"
fi

SOURCE="${BACKUP_BUCKET%/}/${DATE}/"
TARGET="${REPO_DIR}/data/"

# ---------- preview ----------
log "Source: $SOURCE"
log "Target: $TARGET"

# Show how many files will be touched
log "Inventory:"
aws s3 ls "$SOURCE" --recursive 2>/dev/null \
  | awk '{print "    " $NF " (" $3 " bytes)"}' \
  | head -20

local_count=0
if [[ -d "$TARGET" ]]; then
  local_count="$(find "$TARGET" -type f | wc -l | tr -d ' ')"
fi
remote_count="$(aws s3 ls "$SOURCE" --recursive 2>/dev/null | wc -l | tr -d ' ')"
log "Local data/ has $local_count files. Backup has $remote_count files."

# ---------- safety confirmation ----------
if [[ $local_count -gt 0 ]] && ! $SKIP_CONFIRM; then
  warn "This will OVERWRITE files in $TARGET that exist in the backup."
  warn "Local files NOT in the backup will be left alone (sync, not delete-mode)."
  echo
  read -r -p "Type 'restore' to proceed: " confirm
  if [[ "$confirm" != "restore" ]]; then
    err "Aborted."
    exit 1
  fi
fi

# ---------- archive current data first ----------
if [[ $local_count -gt 0 ]]; then
  ARCHIVE_DIR="${REPO_DIR}/data.before-restore.$(date +%Y%m%d-%H%M%S)"
  log "Archiving current data/ → $ARCHIVE_DIR"
  cp -r "$TARGET" "$ARCHIVE_DIR"
  ok "Archived. (You can rm -rf this once you've verified the restore.)"
fi

# ---------- sync down ----------
log "Syncing $SOURCE → $TARGET ..."
mkdir -p "$TARGET"
aws s3 sync "$SOURCE" "$TARGET" --no-progress

ok "Restore complete from backup dated $DATE."
echo
echo "Verify with:"
echo "  ls -la data/"
echo "  cat data/preferences.json | head"
echo
echo "If something looks wrong, your previous data is safe in:"
[[ -n "${ARCHIVE_DIR:-}" ]] && echo "  $ARCHIVE_DIR"
