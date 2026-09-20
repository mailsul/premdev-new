#!/usr/bin/env bash
#
# PremDev soft deploy.
#
# This updates only the app service. It never removes or recreates workspace
# containers (pw_*, pwsh_*, pwx_*), caddy, mysql, or other compose services.
#
# Usage on the VPS:
#   cd /opt/premdev
#   sudo bash infra/soft-deploy.sh
#
# Optional:
#   APP_DIR=/opt/premdev
#   BRANCH=main
#   LOG_FILE=/var/log/premdev-soft-deploy.log
#   FOLLOW_LOGS=1
#
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/premdev}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.yml}"
LOG_FILE="${LOG_FILE:-/var/log/premdev-soft-deploy-$(date -u +%Y%m%d-%H%M%S).log}"
FOLLOW_LOGS="${FOLLOW_LOGS:-0}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_DELAY_SECONDS="${HEALTH_DELAY_SECONDS:-2}"

mkdir -p "$(dirname -- "$LOG_FILE")" 2>/dev/null || {
  LOG_FILE="/tmp/premdev-soft-deploy-$(date -u +%Y%m%d-%H%M%S).log"
}
exec > >(tee -a "$LOG_FILE") 2>&1

STEP="startup"

fail() {
  printf '\n[ERROR] %s\n' "$*" >&2
  printf '[ERROR] Step: %s\n' "$STEP" >&2
  printf '[ERROR] Log: %s\n' "$LOG_FILE" >&2
  exit 1
}

run_step() {
  STEP="$1"
  shift
  printf '\n[STEP] %s\n[CMD] ' "$STEP"
  printf '%q ' "$@"
  printf '\n'
  "$@"
}

cd "$APP_DIR" || fail "Direktori aplikasi tidak ditemukan: $APP_DIR"
[[ -f "$APP_DIR/.env" ]] ||
  fail "File $APP_DIR/.env tidak ditemukan."
[[ -f "$COMPOSE_FILE" ]] ||
  fail "Compose runtime tidak ditemukan: $COMPOSE_FILE. Jalankan infra/redeploy.sh sekali saat maintenance untuk membuatnya."
command -v docker >/dev/null 2>&1 ||
  fail "Docker tidak ditemukan."
docker compose version >/dev/null 2>&1 ||
  fail "Docker Compose plugin tidak tersedia."

COMPOSE=(docker compose --env-file "$APP_DIR/.env" -f "$COMPOSE_FILE")

printf '[INFO] Soft deploy dimulai: %s\n' "$(date -u --iso-8601=seconds)"
printf '[INFO] App dir: %s\n' "$APP_DIR"
printf '[INFO] Compose: %s\n' "$COMPOSE_FILE"
printf '[INFO] Log: %s\n' "$LOG_FILE"
printf '[INFO] Workspace containers tidak akan disentuh.\n'

STEP="checking local git changes"
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "Ada perubahan tracked lokal di repository. Simpan/commit dulu agar soft deploy tidak menimpa perubahan."
fi

OLD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
run_step "fetching $BRANCH" git fetch origin "$BRANCH"
run_step "fast-forwarding source" git pull --ff-only origin "$BRANCH"
NEW_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
printf '[INFO] Commit: %s -> %s\n' "$OLD_COMMIT" "$NEW_COMMIT"

run_step "validating compose configuration" "${COMPOSE[@]}" config --quiet

STEP="updating app image"
if "${COMPOSE[@]}" pull app; then
  printf '[INFO] App image berhasil di-pull.\n'
else
  printf '[WARN] Pull app gagal; mencoba build app lokal dari source terbaru.\n'
  run_step "building app image locally" "${COMPOSE[@]}" build app
fi

# --no-deps is the critical safety flag: Compose will recreate only app and
# will not restart caddy, mysql, or any dependency/workspace service.
run_step "recreating app only" "${COMPOSE[@]}" up -d --no-deps app

STEP="waiting for app"
app_id=""
app_ready=0
for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
  app_id="$("${COMPOSE[@]}" ps -q app 2>/dev/null || true)"
  if [[ -n "$app_id" ]]; then
    status="$(docker inspect --format '{{.State.Status}}' "$app_id" 2>/dev/null || true)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$app_id" 2>/dev/null || true)"
    printf '[WAIT] app status=%s health=%s (%s/%s)\n' "${status:-unknown}" "${health:-unknown}" "$attempt" "$HEALTH_RETRIES"

    if [[ "$health" == "healthy" ]]; then
      app_ready=1
      break
    fi
    if [[ "$health" == "none" && "$status" == "running" ]]; then
      if docker exec "$app_id" sh -c \
        'command -v wget >/dev/null 2>&1 && wget -q -O - --timeout=3 http://127.0.0.1:3001/api/health >/dev/null || command -v curl >/dev/null 2>&1 && curl -fsS --max-time 3 http://127.0.0.1:3001/api/health >/dev/null'; then
        app_ready=1
        break
      fi
    fi
    [[ "$status" == "exited" || "$status" == "dead" ]] && break
  fi
  sleep "$HEALTH_DELAY_SECONDS"
done

run_step "showing app status" "${COMPOSE[@]}" ps app
run_step "showing recent app logs" "${COMPOSE[@]}" logs --tail=200 app

(( app_ready == 1 )) ||
  fail "App belum sehat setelah ${HEALTH_RETRIES} percobaan. Periksa log di atas atau: ${COMPOSE[*]} logs -f app"

printf '\n[OK] Soft deploy selesai tanpa restart workspace containers.\n'
printf '[OK] Commit aktif: %s\n' "$NEW_COMMIT"
printf '[OK] Log tersimpan: %s\n' "$LOG_FILE"

if [[ "$FOLLOW_LOGS" == "1" ]]; then
  printf '\n[INFO] Mengikuti log app. Tekan Ctrl+C untuk keluar; container tidak dihentikan.\n'
  exec "${COMPOSE[@]}" logs -f --tail=0 app
fi