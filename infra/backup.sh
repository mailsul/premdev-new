#!/usr/bin/env bash
# PremDev backup — runs daily from /etc/cron.daily/premdev-backup.
#
# Dumps:
#   1. SQLite (apps/api/data/premdev.sqlite)  — uses VACUUM INTO for hot copy
#   2. MySQL (all DBs)                         — mysqldump via the mysql container
#   3. Workspaces (data/workspaces/)           — tar.gz, can be huge
#   4. .env                                    — stored as-is (R2 bucket is private)
#   5. Gitea PostgreSQL                        — pg_dumpall from gitea_db container
#   6. Gitea data volume                       — tar stream from gitea container /data
#
# Uploads to Cloudflare R2 via rclone (configured by install.sh).
# Retention: keep 7 daily + 4 weekly snapshots; older purged automatically.
# Pings Telegram at the end (success or failure).
#
# Required env (sourced from /opt/premdev/.env or /etc/premdev/backup.env):
#   PREMDEV_DATA_DIR (default /opt/premdev/data)
#   R2_BUCKET (required)
#   GITEA_CONTAINER      (default: gitea)
#   GITEA_DB_CONTAINER   (default: gitea_db)
#   GITEA_DB_USER        (default: gitea)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID (optional — sends alert on result)

set -euo pipefail

# Load env from common locations
for f in /etc/premdev/backup.env /opt/premdev/.env; do
  [[ -r "$f" ]] && set -a && . "$f" && set +a
done

DATA_DIR="${PREMDEV_DATA_DIR:-/opt/premdev/data}"
INSTALL_DIR="${PREMDEV_INSTALL_DIR:-/opt/premdev}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
WORK_DIR="$(mktemp -d /tmp/premdev-backup-XXXXXX)"
TS="$(date +%Y%m%d-%H%M%S)"
DOW="$(date +%u)"   # 1..7
LOG_FILE="/var/log/premdev-backup.log"
RC_REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-}"

trap 'rm -rf "$WORK_DIR"' EXIT

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"; }

notify() {
  local level="$1"; local msg="$2"
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_ADMIN_CHAT_ID:-}" ]] && return 0
  local icon="ℹ️"; [[ "$level" == "warn" ]] && icon="⚠️"; [[ "$level" == "error" ]] && icon="🚨"
  curl -sS --max-time 8 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
    -d "parse_mode=Markdown" \
    -d "disable_web_page_preview=true" \
    --data-urlencode "text=${icon} ${msg}" >/dev/null 2>&1 || true
}

if [[ -z "$BUCKET" ]]; then
  log "ERROR: R2_BUCKET not set — backup disabled. Configure R2 in /opt/premdev/.env then re-run install.sh."
  notify error "PremDev backup *skipped* — R2_BUCKET not configured"
  exit 0
fi

if ! command -v rclone >/dev/null 2>&1; then
  log "ERROR: rclone not installed"
  notify error "PremDev backup *failed* — rclone missing on host"
  exit 1
fi

log "=== Backup start (TS=$TS) ==="

# --- 1. SQLite ---
# Production layout (set by install.sh): SQLITE_PATH=/var/lib/premdev/sqlite/premdev.sqlite
# which maps to $DATA_DIR/sqlite/premdev.sqlite on the host. The legacy "api/"
# path was wrong and silently skipped SQLite from every backup — keep the
# fallback for any pre-Fase-2.2 install so a redeploy doesn't lose data.
SQLITE_SRC="$DATA_DIR/sqlite/premdev.sqlite"
[[ -f "$SQLITE_SRC" ]] || SQLITE_SRC="$DATA_DIR/api/premdev.sqlite"
SQLITE_OUT="$WORK_DIR/premdev-sqlite-${TS}.sqlite"
if [[ -f "$SQLITE_SRC" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    log "Dumping SQLite via VACUUM INTO"
    sqlite3 "$SQLITE_SRC" "VACUUM INTO '$SQLITE_OUT'" 2>&1 | tee -a "$LOG_FILE"
  else
    # Fallback for hosts without the sqlite3 CLI (older installs).
    # The auth DB is small and uses WAL mode — flush WAL into the main file
    # via a checkpoint then copy. We do this from inside the API container,
    # which already has better-sqlite3 in node_modules.
    log "sqlite3 CLI missing on host; falling back to WAL checkpoint + cp"
    if docker compose -f "$COMPOSE_FILE" ps app 2>/dev/null | grep -q "Up"; then
      docker compose -f "$COMPOSE_FILE" exec -T app node -e "
        const Database = require('better-sqlite3');
        const db = new Database(process.env.SQLITE_PATH || '/var/lib/premdev/sqlite/premdev.sqlite');
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      " 2>&1 | tee -a "$LOG_FILE" || log "WARN: WAL checkpoint failed (non-fatal)"
    fi
    cp "$SQLITE_SRC" "$SQLITE_OUT"
  fi
  gzip -9 "$SQLITE_OUT"
  gzip -t "${SQLITE_OUT}.gz" && log "  -> SQLite OK $(ls -lh "${SQLITE_OUT}.gz" | awk '{print $5}')" \
    || { log "ERROR: SQLite gzip corrupt — aborting"; exit 1; }
else
  log "WARN: SQLite not found at $SQLITE_SRC"
fi

# --- 2. MySQL (all DBs) ---
MYSQL_OUT="$WORK_DIR/premdev-mysql-${TS}.sql"
if [[ -f "$COMPOSE_FILE" ]] && docker compose -f "$COMPOSE_FILE" ps mysql 2>/dev/null | grep -q "Up"; then
  log "Dumping MySQL"
  if [[ -n "${MYSQL_ROOT_PASSWORD:-}" ]]; then
    docker compose -f "$COMPOSE_FILE" exec -T mysql \
      mysqldump --all-databases --single-transaction --quick --routines --triggers \
      -uroot -p"$MYSQL_ROOT_PASSWORD" 2>/dev/null > "$MYSQL_OUT" || log "WARN: mysqldump failed"
    if [[ -s "$MYSQL_OUT" ]]; then
      gzip -9 "$MYSQL_OUT"
      gzip -t "${MYSQL_OUT}.gz" && log "  -> MySQL OK $(ls -lh "${MYSQL_OUT}.gz" | awk '{print $5}')" \
        || { log "ERROR: MySQL gzip corrupt — aborting"; exit 1; }
    fi
  else
    log "WARN: MYSQL_ROOT_PASSWORD not in env — skipping MySQL dump"
  fi
else
  log "MySQL container not running — skipping"
fi

# --- 3. Workspaces tarball ---
WS_DIR="$DATA_DIR/workspaces"
WS_OUT="$WORK_DIR/premdev-workspaces-${TS}.tar.gz"
WS_SPEC_FILE="$DATA_DIR/backup-ws-spec.json"
TAR_EXCLUDES=(
  --exclude='node_modules' --exclude='.venv' --exclude='__pycache__'
  --exclude='.cache' --exclude='dist' --exclude='build' --exclude='target'
)
if [[ -d "$WS_DIR" ]]; then
  # Check for partial-backup spec written by POST /admin/backups/run.
  # If present, only tar the listed workspace IDs; delete spec after reading.
  PARTIAL_IDS=()
  if [[ -f "$WS_SPEC_FILE" ]]; then
    # Parse JSON array with python (available in most Docker images).
    if command -v python3 >/dev/null 2>&1; then
      mapfile -t PARTIAL_IDS < <(python3 -c "
import json, sys
d = json.load(open('$WS_SPEC_FILE'))
for i in d.get('workspaceIds', []):
    print(i)
" 2>/dev/null || true)
    fi
    log "Workspace spec loaded: ${#PARTIAL_IDS[@]} workspace IDs (file kept for future runs)"
  fi

  if [[ ${#PARTIAL_IDS[@]} -gt 0 ]]; then
    log "Tarring selected workspaces: ${PARTIAL_IDS[*]}"
    WS_ARGS=()
    for id in "${PARTIAL_IDS[@]}"; do
      id_clean="${id//[^a-zA-Z0-9_-]/}"  # sanitize
      [[ -d "$WS_DIR/$id_clean" ]] && WS_ARGS+=("workspaces/$id_clean")
    done
    if [[ ${#WS_ARGS[@]} -gt 0 ]]; then
      tar "${TAR_EXCLUDES[@]}" -czf "$WS_OUT" -C "$DATA_DIR" "${WS_ARGS[@]}" 2>>"$LOG_FILE" || log "WARN: tar reported errors"
      log "  -> $(ls -lh "$WS_OUT" | awk '{print $5}')"
    else
      log "WARN: specified workspace IDs have no directories — skipping workspace backup"
    fi
  else
    log "Tarring all workspaces (this may take a while)"
    tar "${TAR_EXCLUDES[@]}" -czf "$WS_OUT" -C "$(dirname "$WS_DIR")" "$(basename "$WS_DIR")" 2>>"$LOG_FILE" || log "WARN: tar reported errors"
    log "  -> $(ls -lh "$WS_OUT" | awk '{print $5}')"
  fi
fi

# --- 4. Env file (.env) — stored as-is; R2 bucket is already private (acl=private) ---
ENV_SRC="$INSTALL_DIR/.env"
if [[ -f "$ENV_SRC" ]]; then
  cp "$ENV_SRC" "$WORK_DIR/premdev-env-${TS}.env"
  log "  -> .env: $(ls -lh "$WORK_DIR/premdev-env-${TS}.env" | awk '{print $5}')"
else
  log "WARN: .env not found at $ENV_SRC — skipping"
fi

# --- 5. Gitea PostgreSQL dump ---
GITEA_DB_CTR="${GITEA_DB_CONTAINER:-gitea_db}"
GITEA_DB_USER_VAR="${GITEA_DB_USER:-gitea}"
GITEA_PG_OUT="$WORK_DIR/gitea-postgres-${TS}.sql"
if docker inspect "$GITEA_DB_CTR" >/dev/null 2>&1; then
  if docker inspect -f '{{.State.Running}}' "$GITEA_DB_CTR" 2>/dev/null | grep -q "true"; then
    log "Dumping Gitea PostgreSQL (container: $GITEA_DB_CTR)"
    if docker exec "$GITEA_DB_CTR" pg_dumpall -U "$GITEA_DB_USER_VAR" > "$GITEA_PG_OUT" 2>>"$LOG_FILE"; then
      if [[ -s "$GITEA_PG_OUT" ]]; then
        gzip -9 "$GITEA_PG_OUT"
        gzip -t "${GITEA_PG_OUT}.gz" \
          && log "  -> Gitea PostgreSQL OK $(ls -lh "${GITEA_PG_OUT}.gz" | awk '{print $5}')" \
          || log "WARN: Gitea PostgreSQL gzip corrupt — removing"
      else
        log "WARN: Gitea PostgreSQL dump empty — skipping"
        rm -f "$GITEA_PG_OUT"
      fi
    else
      log "WARN: Gitea PostgreSQL pg_dumpall failed (non-fatal)"
      rm -f "$GITEA_PG_OUT"
    fi
  else
    log "Gitea DB container not running — skipping PostgreSQL dump"
  fi
else
  log "Gitea DB container ($GITEA_DB_CTR) not found — skipping (Gitea not installed)"
fi

# --- 6. Gitea data volume (repos, config, attachments) ---
GITEA_CTR="${GITEA_CONTAINER:-gitea}"
GITEA_DATA_OUT="$WORK_DIR/gitea-data-${TS}.tar.gz"
if docker inspect "$GITEA_CTR" >/dev/null 2>&1; then
  if docker inspect -f '{{.State.Running}}' "$GITEA_CTR" 2>/dev/null | grep -q "true"; then
    log "Tarring Gitea data volume (container: $GITEA_CTR, path: /data)"
    if docker exec "$GITEA_CTR" tar \
        --exclude='/data/gitea/log' \
        --exclude='/data/gitea/tmp' \
        -czf - /data 2>>"$LOG_FILE" > "$GITEA_DATA_OUT"; then
      if [[ -s "$GITEA_DATA_OUT" ]]; then
        gzip -t "$GITEA_DATA_OUT" \
          && log "  -> Gitea data OK $(ls -lh "$GITEA_DATA_OUT" | awk '{print $5}')" \
          || { log "WARN: Gitea data tar corrupt — removing"; rm -f "$GITEA_DATA_OUT"; }
      else
        log "WARN: Gitea data tar empty — removing"
        rm -f "$GITEA_DATA_OUT"
      fi
    else
      log "WARN: Gitea data tar failed (non-fatal)"
      rm -f "$GITEA_DATA_OUT"
    fi
  else
    log "Gitea container not running — skipping data volume backup"
  fi
else
  log "Gitea container ($GITEA_CTR) not found — skipping (Gitea not installed)"
fi

# --- 7. Upload to R2 ---
DAILY_PATH="${RC_REMOTE}:${BUCKET}/daily/${TS}"
log "Uploading to ${DAILY_PATH}"
if rclone copy --transfers 2 --checkers 2 "$WORK_DIR/" "$DAILY_PATH/" 2>&1 | tee -a "$LOG_FILE"; then
  log "Upload OK"
else
  log "ERROR: rclone upload failed"
  notify error "PremDev backup *upload failed* — see /var/log/premdev-backup.log"
  exit 1
fi

# Promote to weekly snapshot on Sundays (DOW=7) — server-side copy, no re-upload.
if [[ "$DOW" == "7" ]]; then
  WEEKLY_PATH="${RC_REMOTE}:${BUCKET}/weekly/${TS}"
  log "Sunday → promoting to weekly snapshot ${WEEKLY_PATH}"
  rclone copy "$DAILY_PATH/" "$WEEKLY_PATH/" 2>&1 | tee -a "$LOG_FILE" || true
fi

# --- 5. Retention: 7 daily, 4 weekly (favorites are never pruned) ---
# Read favorites list from the JSON file written by POST /admin/backups/favorites.
FAVORITES_FILE="$DATA_DIR/backup-favorites.json"
FAVORITES_LIST=""
if [[ -f "$FAVORITES_FILE" ]] && command -v python3 >/dev/null 2>&1; then
  FAVORITES_LIST="$(python3 -c "
import json, sys
try:
    favs = json.load(open('$FAVORITES_FILE'))
    for f in favs:
        print(f)
except Exception:
    pass
" 2>/dev/null || true)"
  [[ -n "$FAVORITES_LIST" ]] && log "Favorites protected from pruning: $(echo "$FAVORITES_LIST" | wc -l) snapshots"
fi

# IMPORTANT: list once and reuse the same snapshot for both keep & purge
# decisions. If `rclone lsf` fails or returns empty, we abort *without*
# purging anything — losing one cycle's pruning beats catastrophic data loss.
prune() {
  local prefix="$1"; local keep="$2"
  local listing
  if ! listing="$(rclone lsf --dirs-only "${RC_REMOTE}:${BUCKET}/${prefix}/" 2>>"$LOG_FILE")"; then
    log "WARN: rclone lsf failed for ${prefix}/ — skipping prune (no data deleted)"
    return 0
  fi
  if [[ -z "$listing" ]]; then
    log "  (no ${prefix} snapshots yet — nothing to prune)"
    return 0
  fi
  # Build keep_list from non-favorited entries only, then add back favorites.
  local non_fav_listing=""
  while IFS= read -r d; do
    local snap_path="${prefix}/${d%/}"
    if echo "$FAVORITES_LIST" | grep -qxF "$snap_path"; then
      log "  Skipping prune for favorite: ${snap_path}"
    else
      non_fav_listing+="$d"$'\n'
    fi
  done <<< "$listing"

  local keep_list
  keep_list="$(echo "$non_fav_listing" | sort -r | head -n "$keep")"
  if [[ -z "$keep_list" && -z "$non_fav_listing" ]]; then
    log "  (all ${prefix} snapshots are favorites — nothing to prune)"
    return 0
  fi

  echo "$listing" | while read -r d; do
    # Defence-in-depth: refuse anything that doesn't look like our TS dirs
    # (YYYYMMDD-HHMMSS/) so a bad listing can never wipe the bucket root.
    if ! echo "$d" | grep -qE '^[0-9]{8}-[0-9]{6}/?$'; then continue; fi
    local snap_path="${prefix}/${d%/}"
    # Skip favorites.
    if echo "$FAVORITES_LIST" | grep -qxF "$snap_path"; then continue; fi
    if ! echo "$keep_list" | grep -qx "$d"; then
      log "Pruning ${prefix}/${d}"
      rclone purge "${RC_REMOTE}:${BUCKET}/${prefix}/${d}" 2>&1 | tee -a "$LOG_FILE" || true
    fi
  done
}
log "Retention: keeping last 7 daily, 4 weekly snapshots (favorites exempt)"
prune daily 7
prune weekly 4

TOTAL="$(du -sh "$WORK_DIR" | awk '{print $1}')"
log "=== Backup complete ($TOTAL uploaded) ==="

# Refresh the index so the /admin Backup tab and `premdev-bot /backup` reflect
# the new snapshot immediately. Best-effort — never let a refresh failure
# mask a successful backup.
if [[ -x /usr/local/sbin/premdev-refresh-index ]]; then
  /usr/local/sbin/premdev-refresh-index 2>>"$LOG_FILE" || log "WARN: index refresh failed"
fi

notify info "PremDev backup OK — *${TS}* (${TOTAL})"
