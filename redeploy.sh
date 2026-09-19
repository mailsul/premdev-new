#!/usr/bin/env bash
#
# PremDev VPS redeploy helper.
#
# Safe defaults:
# - pulls the configured GitHub repository/branch
# - preserves VPS-only .env and compose files outside the Git worktree
# - never deletes data/
# - installs dev dependencies so TypeScript/tsx are available for build/dev
# - restarts an existing systemd, PM2, or Docker Compose deployment
#
# Optional overrides:
#   APP_DIR=/opt/premdev
#   REPO_URL=https://github.com/mailsul/premdev-new.git
#   BRANCH=main
#   SERVICE_NAME=premdev
#   PM2_APP=premdev
#   RESTART_CMD='systemctl restart my-service'
#   RESTART_MODE=none
#   HEALTH_URL=http://127.0.0.1:3001/api/health
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
REPO_URL="${REPO_URL:-https://github.com/mailsul/premdev-new.git}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-premdev}"
PM2_APP="${PM2_APP:-premdev}"
RESTART_MODE="${RESTART_MODE:-auto}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-3001}/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-2}"
RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_FILE:-/tmp/premdev-redeploy-${RUN_ID}.log}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/premdev-redeploy-backup-${RUN_ID}}"
STEP="startup"
STASH_CREATED=0

normalize_repo_url() {
  case "$REPO_URL" in
    http://*|https://*|ssh://*|git@*) ;;
    *) REPO_URL="https://${REPO_URL}" ;;
  esac
}

fail() {
  printf '\n[ERROR] %s\n' "$*" >&2
  printf '[ERROR] Step: %s\n' "$STEP" >&2
  printf '[ERROR] Log: %s\n' "$LOG_FILE" >&2
  printf '[ERROR] Tidak ada langkah berikutnya yang dijalankan.\n' >&2
  exit 1
}

on_error() {
  local code=$?
  printf '\n[ERROR] Command gagal pada step: %s (exit %s)\n' "$STEP" "$code" >&2
  printf '[ERROR] Direktori: %s\n' "$APP_DIR" >&2
  printf '[ERROR] Log lengkap: %s\n' "$LOG_FILE" >&2
  exit "$code"
}

run_step() {
  STEP="$1"
  shift
  printf '\n[STEP] %s\n' "$STEP"
  printf '[CMD] '
  printf '%q ' "$@"
  printf '\n'
  "$@"
}

restore_preserved_files() {
  local file
  for file in .env .env.production docker-compose.yml docker-compose.yaml; do
    if [[ -e "$BACKUP_DIR/$file" ]]; then
      cp -a -- "$BACKUP_DIR/$file" "$APP_DIR/$file"
      printf '[INFO] Restored VPS-local config: %s\n' "$file"
    fi
  done
}

restart_application() {
  STEP="restart application"
  local compose_file=""

  if [[ "$RESTART_MODE" == "none" ]]; then
    printf '[INFO] RESTART_MODE=none; aplikasi tidak direstart.\n'
    return 0
  fi

  if [[ -n "${RESTART_CMD:-}" ]]; then
    printf '[INFO] Menggunakan RESTART_CMD yang diberikan.\n'
    bash -lc "$RESTART_CMD"
    return 0
  fi

  if [[ "$RESTART_MODE" == "systemd" || "$RESTART_MODE" == "auto" ]] &&
     command -v systemctl >/dev/null 2>&1 &&
     systemctl cat "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    printf '[INFO] Restart systemd service: %s\n' "$SERVICE_NAME"
    systemctl restart "${SERVICE_NAME}.service"
    systemctl is-active --quiet "${SERVICE_NAME}.service"
    return 0
  fi

  if [[ "$RESTART_MODE" == "pm2" || "$RESTART_MODE" == "auto" ]] &&
     command -v pm2 >/dev/null 2>&1 &&
     pm2 describe "$PM2_APP" >/dev/null 2>&1; then
    printf '[INFO] Restart PM2 app: %s\n' "$PM2_APP"
    pm2 restart "$PM2_APP"
    pm2 save >/dev/null 2>&1 || true
    return 0
  fi

  if [[ "$RESTART_MODE" == "docker" || "$RESTART_MODE" == "auto" ]] &&
     command -v docker >/dev/null 2>&1 &&
     { [[ -f "$APP_DIR/docker-compose.yml" ]] || [[ -f "$APP_DIR/docker-compose.yaml" ]]; }; then
    if [[ -f "$APP_DIR/docker-compose.yml" ]]; then
      compose_file="$APP_DIR/docker-compose.yml"
    else
      compose_file="$APP_DIR/docker-compose.yaml"
    fi
    printf '[INFO] Rebuild/restart Docker Compose deployment.\n'
    docker compose -f "$compose_file" up -d --build
    return 0
  fi

  fail "Tidak menemukan service manager. Set RESTART_CMD, atau jalankan dengan RESTART_MODE=systemd|pm2|docker."
}

check_health() {
  if [[ "$RESTART_MODE" == "none" || "${HEALTHCHECK:-auto}" == "none" ]]; then
    printf '[INFO] Health check dilewati.\n'
    return 0
  fi

  STEP="health check"
  local attempt
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      printf '[OK] Health check berhasil: %s\n' "$HEALTH_URL"
      return 0
    fi
    printf '[WAIT] Health check belum siap (%s/%s): %s\n' "$attempt" "$HEALTH_RETRIES" "$HEALTH_URL"
    sleep "$HEALTH_DELAY_SECONDS"
  done

  fail "Aplikasi sudah direstart tetapi health check gagal: $HEALTH_URL"
}

trap on_error ERR

normalize_repo_url
mkdir -p "$(dirname -- "$LOG_FILE")" "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

printf '%s\n' '=== PremDev redeploy ==='
printf '[INFO] App directory: %s\n' "$APP_DIR"
printf '[INFO] Repository: %s\n' "$REPO_URL"
printf '[INFO] Branch: %s\n' "$BRANCH"
printf '[INFO] Log: %s\n' "$LOG_FILE"
printf '[INFO] Local config backup: %s\n' "$BACKUP_DIR"

STEP="preflight"
[[ -d "$APP_DIR/.git" ]] || fail "APP_DIR bukan checkout Git: $APP_DIR"
command -v git >/dev/null 2>&1 || fail "git tidak ditemukan."
command -v npm >/dev/null 2>&1 || fail "npm tidak ditemukan."
command -v curl >/dev/null 2>&1 || fail "curl tidak ditemukan."
cd "$APP_DIR"

for file in .env .env.production docker-compose.yml docker-compose.yaml; do
  if [[ -e "$file" ]]; then
    cp -a -- "$file" "$BACKUP_DIR/$file"
    printf '[INFO] Backed up VPS-local config: %s\n' "$file"
  fi
done

STEP="save local Git changes"
if [[ -n "$(git status --porcelain)" ]]; then
  git stash push -u -m "redeploy backup ${RUN_ID}"
  STASH_CREATED=1
  printf '[INFO] Perubahan lokal disimpan di Git stash; tidak di-apply otomatis.\n'
else
  printf '[INFO] Working tree bersih.\n'
fi

STEP="configure Git remote"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi
printf '[INFO] origin diarahkan ke repository baru.\n'

run_step "fetch repository" git fetch --prune origin "$BRANCH"
git show-ref --verify --quiet "refs/remotes/origin/$BRANCH" ||
  fail "Branch origin/$BRANCH tidak ditemukan di repository: $REPO_URL"

run_step "checkout target branch" git checkout -B "$BRANCH" "origin/$BRANCH"
run_step "reset ke remote commit" git reset --hard "origin/$BRANCH"
git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null

restore_preserved_files

run_step "install root dependencies" npm install --include=dev --no-audit --no-fund
if [[ -f apps/api/package.json ]]; then
  run_step "install API dependencies (including TypeScript/tsx)" \
    npm install --include=dev --no-audit --no-fund --prefix apps/api
fi
if [[ -f apps/web/package.json ]]; then
  run_step "install web dependencies" \
    npm install --include=dev --no-audit --no-fund --prefix apps/web
fi

[[ -x apps/api/node_modules/.bin/tsc ]] ||
  fail "apps/api/node_modules/.bin/tsc tidak tersedia setelah install. Cek NODE_ENV/npm config."
[[ -x apps/api/node_modules/.bin/tsx ]] ||
  fail "apps/api/node_modules/.bin/tsx tidak tersedia setelah install. Cek NODE_ENV/npm config."

run_step "build application" npm run build
restart_application
check_health

printf '\n[OK] Redeploy selesai.\n'
printf '[OK] Commit aktif: %s\n' "$(git rev-parse --short HEAD)"
printf '[OK] Branch aktif: %s\n' "$(git branch --show-current)"
printf '[OK] Backup config: %s\n' "$BACKUP_DIR"
printf '[OK] Log lengkap: %s\n' "$LOG_FILE"
if [[ "$STASH_CREATED" == "1" ]]; then
  printf '[WARN] Git stash lama tidak di-apply otomatis. Cek dengan: git stash list\n'
fi