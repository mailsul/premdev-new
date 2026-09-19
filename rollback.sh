#!/usr/bin/env bash
#
# Emergency rollback for the last successfully healthy PremDev deployment.
#
# Usage:
#   sudo CONFIRM_ROLLBACK=YES ./rollback.sh
#   sudo CONFIRM_ROLLBACK=YES ROLLBACK_COMMIT=<commit-or-ref> ./rollback.sh
#
# This delegates to redeploy.sh so the same dependency install, build,
# Compose restart, and in-container health check are used. It never runs
# git clean and does not delete data/ or VPS-local .env files.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
DEPLOY_STATE_REF="${DEPLOY_STATE_REF:-refs/premdev/deploy-current}"
ROLLBACK_COMMIT="${ROLLBACK_COMMIT:-$DEPLOY_STATE_REF}"

if [[ "${CONFIRM_ROLLBACK:-}" != "YES" ]]; then
  printf '%s\n' \
    "Rollback dibatalkan untuk mencegah salah target." \
    "Jika web tidak bisa diakses, jalankan:" \
    "  sudo CONFIRM_ROLLBACK=YES ./rollback.sh" \
    "Atau target commit tertentu:" \
    "  sudo CONFIRM_ROLLBACK=YES ROLLBACK_COMMIT=<commit> ./rollback.sh" >&2
  exit 2
fi

[[ -d "$APP_DIR/.git" ]] ||
  { printf '[ERROR] APP_DIR bukan checkout Git: %s\n' "$APP_DIR" >&2; exit 1; }
[[ -x "$SCRIPT_DIR/redeploy.sh" ]] ||
  { printf '[ERROR] redeploy.sh tidak executable: %s\n' "$SCRIPT_DIR/redeploy.sh" >&2; exit 1; }

cd "$APP_DIR"
if ! git rev-parse --verify --quiet "$ROLLBACK_COMMIT^{commit}"; then
  if [[ "$ROLLBACK_COMMIT" == "$DEPLOY_STATE_REF" ]] &&
     git rev-parse --verify --quiet 'HEAD@{1}^{commit}'; then
    ROLLBACK_COMMIT='HEAD@{1}'
    printf '[WARN] Ref deployment sehat belum ada; memakai commit sebelumnya dari reflog: %s\n' \
      "$(git rev-parse "$ROLLBACK_COMMIT^{commit}")"
  else
    printf '[ERROR] Referensi rollback tidak ditemukan: %s\n' "$ROLLBACK_COMMIT" >&2
    printf '[ERROR] Cek kandidat manual dengan: git reflog --date=local\n' >&2
    exit 1
  fi
fi

TARGET_COMMIT="$(git rev-parse "$ROLLBACK_COMMIT^{commit}")"
printf '[WARN] Rollback target: %s (%s)\n' \
  "$TARGET_COMMIT" "$(git show -s --format=%s "$TARGET_COMMIT")"
printf '[INFO] .env dan data/ akan dipertahankan; git clean tidak dijalankan.\n'

env \
  APP_DIR="$APP_DIR" \
  ROLLBACK_COMMIT="$ROLLBACK_COMMIT" \
  "$SCRIPT_DIR/redeploy.sh"