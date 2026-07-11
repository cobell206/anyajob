#!/usr/bin/env bash
# setup.sh — provisions a fresh Ubuntu 24.04 (or 26.04) instance to run AnyaJob.
# Idempotent: safe to re-run. Halts on errors.
#
# Usage:
#   ./setup.sh                 # install everything
#   ./setup.sh --skip-system   # skip apt installs (Node, LibreOffice, etc.)
#   ./setup.sh --skip-app      # skip npm install + systemd + cron
#   ./setup.sh --no-cron       # don't install cron entries
#
# Run from inside the cloned repo directory.

set -euo pipefail

# ---------- config ----------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${SUDO_USER:-$(whoami)}"
NODE_MAJOR=20
SERVICE_NAME="anyajob"

# ---------- flags ----------
SKIP_SYSTEM=false
SKIP_APP=false
NO_CRON=false
for arg in "$@"; do
  case $arg in
    --skip-system) SKIP_SYSTEM=true ;;
    --skip-app) SKIP_APP=true ;;
    --no-cron) NO_CRON=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ---------- output helpers ----------
log()  { printf "\033[1;34m▸\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; }

require_sudo() {
  if [[ $EUID -ne 0 ]] && ! sudo -n true 2>/dev/null; then
    err "This step needs sudo. Re-run with sudo or as a user with sudo access."
    exit 1
  fi
}

# ---------- system packages ----------
install_system() {
  log "Updating apt and installing system packages..."
  require_sudo

  sudo apt-get update -y
  sudo apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    poppler-utils

  # Node.js (NodeSource — pinned major version)
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
    log "Installing Node.js ${NODE_MAJOR}.x..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    ok "Node $(node -v) already installed"
  fi

  # LibreOffice (for DOCX → PDF conversion in the documents feature)
  if ! command -v libreoffice >/dev/null 2>&1; then
    log "Installing LibreOffice (headless)..."
    sudo apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer
  else
    ok "LibreOffice already installed"
  fi

  # AWS CLI v2 (for S3 backup + restore)
  if ! command -v aws >/dev/null 2>&1; then
    log "Installing AWS CLI v2..."
    local arch
    arch="$(uname -m)"
    local pkg="awscli-exe-linux-x86_64.zip"
    [[ "$arch" == "aarch64" ]] && pkg="awscli-exe-linux-aarch64.zip"
    cd /tmp
    curl -fsSL "https://awscli.amazonaws.com/${pkg}" -o awscliv2.zip
    sudo apt-get install -y unzip
    unzip -q -o awscliv2.zip
    sudo ./aws/install --update
    rm -rf aws awscliv2.zip
    cd "$REPO_DIR"
  else
    ok "AWS CLI already installed"
  fi

  # Cloudflared (for the tunnel — install but don't configure here)
  if ! command -v cloudflared >/dev/null 2>&1; then
    log "Installing cloudflared..."
    local arch
    arch="$(uname -m)"
    local deb="cloudflared-linux-amd64.deb"
    [[ "$arch" == "aarch64" ]] && deb="cloudflared-linux-arm64.deb"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${deb}" -o /tmp/cloudflared.deb
    sudo dpkg -i /tmp/cloudflared.deb
    rm /tmp/cloudflared.deb
  else
    ok "cloudflared already installed"
  fi

  ok "System packages installed."
}

# ---------- app setup ----------
install_app() {
  log "Installing app dependencies..."
  cd "$REPO_DIR"
  npm install --production

  # Create runtime files if missing (without overwriting existing data)
  log "Ensuring data files exist..."
  mkdir -p data data/documents
  for f in listings.json feedback.json seen.json; do
    if [[ ! -f "data/$f" ]]; then
      case "$f" in
        listings.json) echo '{"listings": []}' > "data/$f" ;;
        feedback.json) echo '{"ratings":{},"notes":{},"status":{},"appliedDate":{},"closesDate":{}}' > "data/$f" ;;
        seen.json) echo '{"fingerprints": []}' > "data/$f" ;;
      esac
      ok "Created data/$f"
    fi
  done

  if [[ ! -f "data/preferences.json" ]]; then
    cp data/preferences.example.json data/preferences.json 2>/dev/null \
      || warn "data/preferences.json missing — fill in before first run"
  fi

  if [[ ! -f ".env" ]]; then
    cp .env.example .env
    warn ".env created from .env.example — edit it before starting the service"
  fi

  ok "App dependencies installed."
}

# ---------- systemd service ----------
install_service() {
  log "Installing systemd service..."
  require_sudo

  local unit_file="/etc/systemd/system/${SERVICE_NAME}.service"
  sudo tee "$unit_file" > /dev/null <<EOF
[Unit]
Description=AnyaJob Job Tracker
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$REPO_DIR
ExecStart=$(which node) src/server.js
Restart=on-failure
RestartSec=10
EnvironmentFile=$REPO_DIR/.env
StandardOutput=append:$REPO_DIR/server.log
StandardError=append:$REPO_DIR/server.log

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME" >/dev/null
  ok "Systemd service installed at $unit_file"
  log "Start it with: sudo systemctl start $SERVICE_NAME"
}

# ---------- cron entries ----------
install_cron() {
  log "Installing cron entries..."

  local cron_marker="# >>> anyajob managed entries >>>"
  local cron_end="# <<< anyajob managed entries <<<"
  local node_bin
  node_bin="$(which node)"

  # Build the new block
  # The lock file (/tmp/anyajob.lock) is shared with the deploy workflow.
  # `flock -n` skips this run if a deploy is in progress, rather than queueing
  # — a missed daily is recoverable on the next day; a corrupted run is not.
  # The S3 backup also takes the lock so it never sees a partial mid-deploy state.
  local lock_file="/tmp/anyajob.lock"
  local new_block
  new_block=$(cat <<EOF
$cron_marker
# Scheduling moved to AWS EventBridge Scheduler -> the anyajob-cron Lambda
# (M6, see SERVERLESS-TRANSITION.md): daily 6am ET, discovery Mon/Thu 7am ET.
# No scheduled jobs run on this host anymore (and no S3 backup cron: state lives
# in S3 with bucket versioning). This block is intentionally empty.
$cron_end
EOF
)

  # Replace existing managed block, or append if absent
  local current_cron
  current_cron="$(crontab -l 2>/dev/null || true)"
  if echo "$current_cron" | grep -qF "$cron_marker"; then
    log "Replacing existing managed cron block..."
    echo "$current_cron" \
      | sed "/$cron_marker/,/$cron_end/d" \
      > /tmp/anyajob-cron.txt
    echo "" >> /tmp/anyajob-cron.txt
    echo "$new_block" >> /tmp/anyajob-cron.txt
    crontab /tmp/anyajob-cron.txt
    rm /tmp/anyajob-cron.txt
  else
    log "Appending managed cron block..."
    (echo "$current_cron"; echo ""; echo "$new_block") | crontab -
  fi

  ok "Cron entries installed. View with: crontab -l"
}

# ---------- main ----------
echo
echo "╔══════════════════════════════════════════╗"
echo "║      AnyaJob setup                      ║"
echo "╚══════════════════════════════════════════╝"
echo
log "Repo dir: $REPO_DIR"
log "App user: $APP_USER"
echo

if ! $SKIP_SYSTEM; then
  install_system
else
  warn "Skipping system packages (--skip-system)"
fi

if ! $SKIP_APP; then
  install_app
  install_service
else
  warn "Skipping app + service install (--skip-app)"
fi

if ! $NO_CRON; then
  install_cron
else
  warn "Skipping cron install (--no-cron)"
fi

echo
ok "Setup complete."
echo
echo "Next steps:"
echo "  1. Edit .env with your Anthropic API key, NOTIFY_FROM, etc."
echo "  2. Edit data/preferences.json with her profile"
echo "  3. (If restoring from backup) ./scripts/restore.sh"
echo "  4. Set up Cloudflare Tunnel — see DEPLOY.md Part 6"
echo "  5. Configure SES — see DEPLOY.md Part 11"
echo "  6. Start the service: sudo systemctl start $SERVICE_NAME"
echo "  7. Verify: sudo systemctl status $SERVICE_NAME"
echo
