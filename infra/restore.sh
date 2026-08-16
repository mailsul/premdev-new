#!/usr/bin/env bash
# ============================================================================
# PremDev Restore — pulls a snapshot from R2 and applies it.
#
# Usage:   premdev-restore <prefix>/<TS>     e.g. daily/20260428-031500
# Or env:  SNAPSHOT=<prefix>/<TS> premdev-restore
#
# DESTRUCTIVE. Stops the app, replaces:
#   1. SQLite at $DATA_DIR/premdev.sqlite           (from premdev-sqlite-*.sqlite.gz)
#   2. ALL MySQL DBs                                (from premdev-mysql-*.sql.gz)
#   3. $DATA_DIR/workspaces/                        (from premdev-workspaces-*.tar.gz)
#   4. .env                                         (from premdev-env-*.env)
#   5. Gitea PostgreSQL                             (from gitea-postgres-*.sql.gz, if present)
#   6. Gitea data volume                            (from gitea-data-*.tar.gz, if present)
#
# A *pre-restore* safety snapshot is dumped to /var/backups/premdev-pre-restore-<TS>/
# so a botched restore can still be rolled back manually.
# Pings Telegram on success / failure.
# ============================================================================
set -Eeuo pipefail

# Load env (tolerant — both files may exist)
for f in /etc/premdev/backup.env /opt/premdev/.env; do
  [[ -r "$f" ]] && set -a && . "$f" && set +a
done

DATA_DIR="${PREMDEV_DATA_DIR:-/opt/premdev/data}"
INSTALL_DIR="${PREMDEV_INSTALL_DIR:-/opt/premdev}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
RC_REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-}"
LOG_FILE="/var/log/premdev-restore.log"
SAFETY_DIR="/var/backups/premdev-pre-restore-$(date +%Y%m%d-%H%M%S)"

SNAPSHOT="${1:-${SNAPSHOT:-}}"
[[ -n "$SNAPSHOT" ]] || { echo "Usage: $0 <prefix>/<TS>  (e.g. daily/20260428-031500)"; exit 2; }
# Strict guard: only allow `daily/<TS>` or `weekly/<TS>` shapes — same as
# the on-disk regex in backup.sh's prune. Refuses path traversal.
if ! [[ "$SNAPSHOT" =~ ^(daily|weekly)/[0-9]{8}-[0-9]{6}/?$ ]]; then
  echo "Refusing: snapshot must match (daily|weekly)/YYYYMMDD-HHMMSS"
  exit 2
fi
SNAPSHOT="${SNAPSHOT%/}"   # strip trailing /
[[ -n "$BUCKET" ]] || { echo "R2_BUCKET not configured — abort"; exit 3; }

mkdir -p "$(dirname "$LOG_FILE")"
log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"; }

notify() {
  local level="$1" msg="$2"
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_ADMIN_CHAT_ID:-}" ]] || return 0
  local prefix; case "$level" in error) prefix="🛑 ";; warn) prefix="⚠️ ";; *) prefix="✅ ";; esac
  curl -fsS -o /dev/null -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=${prefix}${msg}" || true
}

trap 'rc=$?; if [[ $rc -ne 0 ]]; then notify error "Restore *FAILED* — snapshot \`$SNAPSHOT\` (exit $rc). Pre-restore safety dump at \`$SAFETY_DIR\`."; fi; rm -rf "${DL_DIR:-}"' EXIT

WORK_DIR="$(mktemp -d /tmp/premdev-restore-XXXXXX)"
DL_DIR="$WORK_DIR"

log "=== Restore start: snapshot=$SNAPSHOT ==="
notify info "Restore *starting* — snapshot \`$SNAPSHOT\`"

# --- 1. Download snapshot from R2 ---
log "Downloading from r2:${BUCKET}/${SNAPSHOT}/"
rclone copy "${RC_REMOTE}:${BUCKET}/${SNAPSHOT}/" "$DL_DIR/" --progress 2>&1 | tee -a "$LOG_FILE"

# Locate files by their backup.sh naming pattern (premdev-<type>-<TS>.<ext>)
SQLITE_GZ=$(ls   "$DL_DIR"/premdev-sqlite-*.sqlite.gz  2>/dev/null | head -1)
MYSQL_GZ=$(ls    "$DL_DIR"/premdev-mysql-*.sql.gz      2>/dev/null | head -1)
WS_TGZ=$(ls      "$DL_DIR"/premdev-workspaces-*.tar.gz 2>/dev/null | head -1)
ENV_FILE=$(ls    "$DL_DIR"/premdev-env-*.env            2>/dev/null | head -1)
GITEA_PG_GZ=$(ls "$DL_DIR"/gitea-postgres-*.sql.gz     2>/dev/null | head -1)
GITEA_DATA_TGZ=$(ls "$DL_DIR"/gitea-data-*.tar.gz      2>/dev/null | head -1)

[[ -n "$SQLITE_GZ" ]] || { log "ERROR: sqlite snapshot missing in $SNAPSHOT"; exit 4; }
[[ -n "$MYSQL_GZ"  ]] || { log "ERROR: mysql snapshot missing in $SNAPSHOT";  exit 4; }
[[ -n "$WS_TGZ"    ]] || log "WARN: workspaces snapshot missing — skipping"
[[ -n "$ENV_FILE"  ]] || log "WARN: .env snapshot missing — skipping"
[[ -n "$GITEA_PG_GZ"    ]] && log "Gitea PostgreSQL snapshot found: $GITEA_PG_GZ" || log "INFO: no Gitea PostgreSQL snapshot — skipping"
[[ -n "$GITEA_DATA_TGZ" ]] && log "Gitea data snapshot found: $GITEA_DATA_TGZ"    || log "INFO: no Gitea data snapshot — skipping"

# Decompress SQLite for later steps
gunzip -k "$SQLITE_GZ"
SQLITE_FILE="${SQLITE_GZ%.gz}"

# --- 2. Pre-restore safety dump (so a bad restore is still recoverable) ---
# Resolve SQLite path the same way backup.sh does — primary location is
# $DATA_DIR/sqlite/premdev.sqlite; fall back to legacy ./api/ for old installs.
SQLITE_DST="$DATA_DIR/sqlite/premdev.sqlite"
[[ -f "$SQLITE_DST" || -d "$DATA_DIR/sqlite" ]] || SQLITE_DST="$DATA_DIR/api/premdev.sqlite"
mkdir -p "$(dirname "$SQLITE_DST")"

log "Writing safety snapshot of CURRENT state to $SAFETY_DIR"
mkdir -p "$SAFETY_DIR"
cp -f "$SQLITE_DST" "$SAFETY_DIR/premdev.sqlite" 2>/dev/null || true
# Pass the password via MYSQL_PWD so it never appears on the command line and
# so a `"` inside the password can't break shell quoting. -p"$PASS" was both
# vulnerable and visible in `ps`.
[[ -n "${MYSQL_ROOT_PASSWORD:-}" ]] || { log "ERROR: MYSQL_ROOT_PASSWORD missing — cannot proceed"; exit 5; }
docker compose -f "$COMPOSE_FILE" exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql \
  mysqldump -uroot --all-databases --single-transaction --quick \
  | gzip > "$SAFETY_DIR/all-databases.sql.gz" 2>>"$LOG_FILE" || log "WARN: safety mysqldump failed"
# Workspaces are huge — only list, don't copy. Operator can rebuild from R2 if needed.
( cd "$DATA_DIR" && find workspaces -maxdepth 2 -type d > "$SAFETY_DIR/workspaces.list" 2>/dev/null || true )
log "Safety dump done: $SAFETY_DIR"

# --- 3. Stop app (do NOT stop mysql — we need it for the import) ---
log "Stopping app container"
docker compose -f "$COMPOSE_FILE" stop app 2>&1 | tee -a "$LOG_FILE"

# --- 4. Restore SQLite ---
# Use install(1) for an atomic clobber with the right ownership in one syscall —
# avoids the "Text file busy" hazard if anything still has the old file open.
log "Restoring SQLite to $SQLITE_DST"
install -m 644 -o 1000 -g 1000 "$SQLITE_FILE" "$SQLITE_DST" 2>/dev/null \
  || install -m 644 "$SQLITE_FILE" "$SQLITE_DST"

# --- 5. Restore MySQL ---
log "Restoring MySQL (dropping & re-importing all DBs)"
gunzip -c "$MYSQL_GZ" | \
  docker compose -f "$COMPOSE_FILE" exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql \
    mysql -uroot

# --- 6. Restore workspaces ---
# PENTING: backup.sh membuat tar dengan `-C $DATA_DIR workspaces` sehingga
# archive punya top-level folder "workspaces/". Extract ke $DATA_DIR (bukan
# ke $DATA_DIR/workspaces) supaya hasilnya $DATA_DIR/workspaces/... yang benar.
if [[ -n "$WS_TGZ" ]]; then
  log "Restoring workspaces (this can take a while)"
  if [[ -d "$DATA_DIR/workspaces" ]]; then
    mv "$DATA_DIR/workspaces" "$DATA_DIR/workspaces.old.$$"
  fi
  mkdir -p "$DATA_DIR"
  tar -xzf "$WS_TGZ" -C "$DATA_DIR" 2>&1 | tail -3 | tee -a "$LOG_FILE"
  chown -R 1000:1000 "$DATA_DIR/workspaces" 2>/dev/null || true
  rm -rf "$DATA_DIR/workspaces.old.$$" &
fi

# --- 7. Restore .env (restores all passwords/API keys to match the backup) ---
if [[ -n "$ENV_FILE" ]]; then
  log "Restoring .env to $INSTALL_DIR/.env"
  cp -f "$ENV_FILE" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  log "  .env restored — docker compose will pick it up on next up -d"
fi

# --- 8. Restore Gitea PostgreSQL ---
GITEA_DB_CTR="${GITEA_DB_CONTAINER:-gitea_db}"
GITEA_DB_USER_VAR="${GITEA_DB_USER:-gitea}"
if [[ -n "$GITEA_PG_GZ" ]]; then
  if docker inspect "$GITEA_DB_CTR" >/dev/null 2>&1 && \
     docker inspect -f '{{.State.Running}}' "$GITEA_DB_CTR" 2>/dev/null | grep -q "true"; then
    log "Stopping Gitea before DB restore"
    GITEA_CTR="${GITEA_CONTAINER:-gitea}"
    docker stop "$GITEA_CTR" 2>/dev/null || true
    log "Restoring Gitea PostgreSQL (drop+recreate gitea DB)"
    # Drop all existing connections, drop DB, recreate, then import.
    docker exec -i "$GITEA_DB_CTR" psql -U "$GITEA_DB_USER_VAR" -d postgres <<'PGSQL' 2>>"$LOG_FILE" || log "WARN: drop/create step failed (non-fatal)"
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'gitea' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS gitea;
CREATE DATABASE gitea OWNER gitea;
PGSQL
    gunzip -c "$GITEA_PG_GZ" | docker exec -i "$GITEA_DB_CTR" psql -U "$GITEA_DB_USER_VAR" -d gitea 2>>"$LOG_FILE" \
      && log "  -> Gitea PostgreSQL restore OK" \
      || log "WARN: Gitea PostgreSQL restore failed — Gitea may start empty"
    docker start "$GITEA_CTR" 2>/dev/null || true
  else
    log "WARN: Gitea DB container ($GITEA_DB_CTR) not running — cannot restore Gitea PostgreSQL"
  fi
else
  log "  No Gitea PostgreSQL snapshot — skipping"
fi

# --- 9. Restore Gitea data volume ---
GITEA_CTR="${GITEA_CONTAINER:-gitea}"
if [[ -n "$GITEA_DATA_TGZ" ]]; then
  if docker inspect "$GITEA_CTR" >/dev/null 2>&1; then
    log "Restoring Gitea data volume (this may take a while)"
    # Stop Gitea if still running, then stream tar into container.
    docker stop "$GITEA_CTR" 2>/dev/null || true
    # Clear existing /data first, then extract.
    docker run --rm \
      --volumes-from "$GITEA_CTR" \
      -i alpine:3 sh -c 'rm -rf /data/gitea /data/git && tar -xzf - -C /' < "$GITEA_DATA_TGZ" 2>>"$LOG_FILE" \
      && log "  -> Gitea data restore OK" \
      || log "WARN: Gitea data restore failed — Gitea may start with partial data"
    docker start "$GITEA_CTR" 2>/dev/null || true
  else
    log "WARN: Gitea container ($GITEA_CTR) not found — cannot restore Gitea data"
  fi
else
  log "  No Gitea data snapshot — skipping"
fi

# --- 10. Restart full stack so restored .env + DB take effect ---
log "Restarting stack"
docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tee -a "$LOG_FILE"

log "=== Restore complete: snapshot=$SNAPSHOT ==="
notify info "Restore *OK* — snapshot \`$SNAPSHOT\` applied. Safety dump kept at \`$SAFETY_DIR\` (delete when verified)."

# --- 11. Cleanup old pre-restore safety dumps (keep last 3, delete older than 14 days) ---
log "Cleaning up old safety dumps (older than 14 days, keep newest 3)"
find /var/backups -maxdepth 1 -name 'premdev-pre-restore-*' -type d \
  | sort -r | tail -n +4 \
  | xargs -r rm -rf 2>/dev/null || true
find /var/backups -maxdepth 1 -name 'premdev-pre-restore-*' -type d -mtime +14 \
  | xargs -r rm -rf 2>/dev/null || true
