#!/usr/bin/env bash
# scripts/build-lambda-bundle.sh
# Builds the web Lambda deployment asset into infra/.app-bundle/ (consumed by
# Code.fromAsset in infra/lib/anyajob-stack.ts). See SERVERLESS-TRANSITION.md M4.
#
# Why this exists rather than a plain zip of node_modules:
#   PDF text extraction (résumé/cover scoring) pulls @napi-rs/canvas, a NATIVE
#   module. On a mac dev box npm only installs the darwin binary; Lambda runs
#   linux. npm won't install the linux prebuilt on a mac (platform-gated), so we
#   fetch the matching-version linux tarball directly and drop it into the
#   bundle. napi loads the right binary by platform at runtime, so shipping both
#   arches is fine — Lambda uses the linux one.
#
# No Docker required. Deterministic: a clean `npm ci --omit=dev` + a pinned
# linux binary. Run before `cdk deploy` (npm run bundle:lambda).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/infra/.app-bundle"
CANVAS_BINPKG="@napi-rs/canvas-linux-x64-gnu"   # x86_64 Lambda (glibc)

log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }

log "Staging runtime files → $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$ROOT/src" "$ROOT/public" "$OUT/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$OUT/"

log "Installing production dependencies (npm ci --omit=dev)"
( cd "$OUT" && npm ci --omit=dev --no-audit --no-fund >/dev/null )

# The canvas wrapper that the extraction path actually resolves is the
# TOP-LEVEL one; its version dictates which linux binary is ABI-compatible.
CANVAS_VER="$(node -e "console.log(require('$OUT/node_modules/@napi-rs/canvas/package.json').version)")"
log "Fetching $CANVAS_BINPKG@$CANVAS_VER (linux prebuilt — npm skips it on mac)"
DEST="$OUT/node_modules/$CANVAS_BINPKG"
mkdir -p "$DEST"
TARBALL="$(npm view "$CANVAS_BINPKG@$CANVAS_VER" dist.tarball)"
curl -fsSL "$TARBALL" | tar -xz -C "$DEST" --strip-components=1
# Sanity: must be an ELF (linux) object, not Mach-O (mac).
if ! file "$DEST"/*.node | grep -q ELF; then
  echo "FATAL: fetched canvas binary is not an ELF/linux object" >&2
  exit 1
fi

# Drop the top-level pdfjs-dist: it's client-vendored (public/vendor/pdfjs),
# not imported server-side (src/ only uses pdf-parse, which carries its own
# pdfjs copy). ~60 MB saved, keeps the asset well under Lambda's 250 MB.
rm -rf "$OUT/node_modules/pdfjs-dist"

# Stamp the commit SHA into __CACHE_VERSION__ so the Lambda serves production
# (immutable, Cloudflare-cacheable) assets instead of falling into server.js's
# dev-mode request-time substitution (which serves everything no-cache — a
# Lambda hit per asset). Mirrors the EC2 deploy (deploy.yml). perl (not sed) for
# mac/linux portability.
COMMIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo lambda)"
log "Stamping cache version '$COMMIT_SHA' into public assets"
find "$OUT/public" -name '*.html' -print0 | xargs -0 perl -i -pe "s/__CACHE_VERSION__/${COMMIT_SHA}/g"
find "$OUT/public" -name '*.js' -print0 | xargs -0 perl -i -pe "s|from '(\.+/[^'?]*\.js)[^']*'|from '\${1}?v=${COMMIT_SHA}'|g"

SIZE="$(du -sh "$OUT" | cut -f1)"
log "Bundle ready: $OUT ($SIZE unpacked)"
