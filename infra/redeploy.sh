#!/usr/bin/env bash
# ============================================================================
# PremDev Redeploy
# Run on the VPS after `git push` finishes building the new app image.
# Pulls the latest images, regenerates the Caddyfile from Caddyfile.tmpl
# (so new domain matchers take effect), rebuilds the user runtime image,
# and restarts everything.
#
# Usage on VPS:
#   curl -fsSL https://raw.githubusercontent.com/mailsul/premdev-new/main/infra/redeploy.sh | bash
# ============================================================================
set -Eeuo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/premdev}"
REPO_PATH="${REPO_PATH:-mailsul/premdev-new}"
RAW="https://raw.githubusercontent.com/${REPO_PATH}/main"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"

cd "$INSTALL_DIR" || { echo "$INSTALL_DIR not found — run install.sh first"; exit 1; }
[[ -f .env ]] || { echo ".env missing — run install.sh first"; exit 1; }

echo "==> Loading env"
set -a; . .env; set +a
export PRIMARY_DOMAIN PREVIEW_DOMAIN DEPLOY_DOMAIN LE_EMAIL CF_API_TOKEN GITEA_SUBDOMAIN GITEA_CONTAINER_HOST GITEA_PORT

# Self-heal for older installs whose .env predates these variables.
# Without GHCR_IMAGE the compose file expands `image: ${GHCR_IMAGE}` to an
# empty string and `docker compose pull/up` aborts with
# "service \"app\" has neither an image nor a build context specified".
ensure_env_var() {
  local key="$1" default="$2"
  if ! grep -q "^${key}=" .env; then
    echo "  .env missing ${key} — appending default: ${default}"
    echo "${key}=${default}" >> .env
    export "${key}=${default}"
  fi
}
ensure_env_var GHCR_IMAGE "ghcr.io/maraazn069/premdev:latest"
# IMPORTANT: .env declares DATA_DIR=/var/lib/premdev which is the path the
# APP CONTAINER sees (via bind mount). On the host, the same files live at
# /opt/premdev/data. Sourcing .env overrides our DATA_DIR with the
# in-container path, which would cause us to write Caddyfile to the wrong
# location. Force the host path here, after sourcing .env.
HOST_DATA_DIR="/opt/premdev/data"

# fetch_repo_file: gunakan file lokal dulu (sudah ada setelah git pull),
# baru fallback ke GitHub kalau file lokal tidak ada.
# Ini menghindari GitHub API rate-limit / 404 untuk repo private.
fetch_repo_file() {
  local path="$1"; local out="$2"
  if [[ -f "$INSTALL_DIR/$path" ]]; then
    cp "$INSTALL_DIR/$path" "$out"
    return 0
  fi
  # Fallback: fetch dari GitHub (repo public atau punya token)
  local api="https://api.github.com/repos/${REPO_PATH}/contents/${path}?ref=main"
  if curl -fsSL -H "Accept: application/vnd.github.v3.raw" "$api" -o "$out" 2>/dev/null; then return 0; fi
  curl -fsSL "$RAW/${path}?nocache=$(date +%s)" -o "$out"
}

echo "==> Refreshing Caddyfile template ($HOST_DATA_DIR/caddy)"
mkdir -p "$HOST_DATA_DIR/caddy"
fetch_repo_file "infra/Caddyfile.tmpl" "$HOST_DATA_DIR/caddy/Caddyfile.tmpl"
# Sanity check: if the legacy *.preview block somehow survived, abort so the
# operator notices instead of silently rendering the old config. Anchored to
# beginning of line and excluding comment lines so it doesn't false-positive
# on the historical note about the removed block.
if grep -qE '^\*\.\$?\{?preview\.' "$HOST_DATA_DIR/caddy/Caddyfile.tmpl"; then
  echo "ERROR: downloaded Caddyfile.tmpl still has the legacy *.preview block."
  echo "  Wait ~5 min for GitHub's raw CDN to refresh, then run this again."
  exit 1
fi
# Docker bind-mounts Caddyfile as a file. Quarantine a stale directory left
# by an older failed deployment so the next start cannot fail at OCI mount
# creation before Caddy has a chance to validate its configuration.
if [[ -d "$HOST_DATA_DIR/caddy/Caddyfile" ]]; then
  INVALID_CADDYFILE="$HOST_DATA_DIR/caddy/Caddyfile.directory-$(date -u +%Y%m%d-%H%M%S)"
  mv "$HOST_DATA_DIR/caddy/Caddyfile" "$INVALID_CADDYFILE"
  echo "  Quarantined invalid Caddyfile directory: $INVALID_CADDYFILE"
fi
envsubst < "$HOST_DATA_DIR/caddy/Caddyfile.tmpl" > "$HOST_DATA_DIR/caddy/Caddyfile"
echo "  Wrote $HOST_DATA_DIR/caddy/Caddyfile ($(wc -l < "$HOST_DATA_DIR/caddy/Caddyfile") lines)"

echo "==> Refreshing docker-compose.yml"
fetch_repo_file "infra/docker-compose.prod.yml" "$COMPOSE_FILE"

# The production compose file builds Caddy from ./caddy. Older VPS installs
# may have the source only under infra/caddy because install.sh generated the
# root build context. Recreate that context on every redeploy before Compose
# parses/builds the stack; it is source code, not runtime domain data.
if [[ -d "$INSTALL_DIR/infra/caddy" ]]; then
  mkdir -p "$INSTALL_DIR/caddy"
  cp -a "$INSTALL_DIR/infra/caddy/." "$INSTALL_DIR/caddy/"
fi

echo "==> Updating app image (try GHCR pull, fall back to local build)"
if [[ -n "${GHCR_IMAGE:-}" ]] && docker compose -f "$COMPOSE_FILE" pull app 2>/dev/null; then
  echo "  Pulled from GHCR: $GHCR_IMAGE"
else
  echo "  GHCR pull skipped or failed — building locally from /opt/premdev"
  cd /opt/premdev && git pull --ff-only 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" build --no-cache app
  echo "  Local build complete"
fi

echo "==> Rebuilding user runtime image"
rm -rf /tmp/premdev-runtime && mkdir -p /tmp/premdev-runtime
fetch_repo_file "infra/runtime/Dockerfile" /tmp/premdev-runtime/Dockerfile
# Tag with the active runtime image name from .env so the rebuilt image is
# the one the app actually spawns (default: premdev/runtime:latest). Also
# tag the GHCR alias for backward compatibility.
RUNTIME_TAG="${RUNTIME_IMAGE:-premdev/runtime:latest}"
# --pull: refresh ubuntu:24.04 base layer.
# RUNTIME_NOCACHE=1 (default) forces apt/pip layers to rebuild so newly
# added system packages (python3-dev, libjpeg-dev, etc.) actually land in
# the image, instead of Docker silently reusing a stale CACHED layer that
# was built before those packages were added to the Dockerfile.
DOCKER_BUILD_ARGS=(--pull -t "$RUNTIME_TAG" -t ghcr.io/maraazn069/premdev-runtime:latest)
if [[ "${RUNTIME_NOCACHE:-1}" == "1" ]]; then
  DOCKER_BUILD_ARGS+=(--no-cache)
fi
docker build "${DOCKER_BUILD_ARGS[@]}" /tmp/premdev-runtime
echo "  Built: $RUNTIME_TAG (no-cache=${RUNTIME_NOCACHE:-1})"
# Sanity check: confirm python3-dev is actually inside the image so users
# can pip-install C-extension packages (tgcrypto, pillow, psycopg2…).
if ! docker run --rm "$RUNTIME_TAG" sh -c 'test -f /usr/include/python3.12/Python.h'; then
  echo "WARNING: Python.h missing in $RUNTIME_TAG — tgcrypto/pillow builds will fail."
  echo "  Re-run with: RUNTIME_NOCACHE=1 bash redeploy.sh"
fi

echo "==> Restarting services"
docker compose -f "$COMPOSE_FILE" up -d app caddy
docker compose -f "$COMPOSE_FILE" restart caddy   # force Caddyfile reload

echo "==> Validating Caddy config"
docker compose -f "$COMPOSE_FILE" exec -T caddy caddy validate --config /etc/caddy/Caddyfile && echo "  OK"

echo "==> Ensuring userhome bind-mount root exists (for shared pip/npm cache)"
mkdir -p "$HOST_DATA_DIR/userhome"
chown -R 1000:1000 "$HOST_DATA_DIR/userhome" 2>/dev/null || true
chmod 755 "$HOST_DATA_DIR/userhome" 2>/dev/null || true

echo "==> Cleaning stale workspace containers (forces re-spawn with new image)"
# Match BOTH workspace labels (premdev.workspace = run container, premdev.shell
# = terminal container) and BOTH name prefixes. Restart the app first so it
# stops holding refs to the dying containers and respawns them on demand.
remove_by() {
  local ids
  ids=$(docker ps -a "$@" -q 2>/dev/null || true)
  if [[ -n "$ids" ]]; then
    echo "  removing $(echo "$ids" | wc -l) container(s) matching $*"
    docker rm -f $ids >/dev/null 2>&1 || true
  fi
}
remove_by --filter name=pw_
remove_by --filter name=pwsh_
remove_by --filter name=pwx_
remove_by --filter label=premdev.workspace
remove_by --filter label=premdev.shell
# Drop any container still running an image OTHER than the freshly built
# runtime tag — catches stale images that no longer have the new system
# packages baked in (python3-dev, libjpeg-dev, …).
NEW_IMAGE_ID=$(docker image inspect "$RUNTIME_TAG" --format '{{.Id}}' 2>/dev/null || true)
if [[ -n "$NEW_IMAGE_ID" ]]; then
  for cid in $(docker ps -aq); do
    img=$(docker inspect "$cid" --format '{{.Image}}' 2>/dev/null || true)
    name=$(docker inspect "$cid" --format '{{.Name}}' 2>/dev/null | sed 's|^/||' || true)
    # Only touch our workspace/shell containers, never compose services.
    if [[ "$name" =~ ^pw(sh|x)?_ ]] && [[ -n "$img" ]] && [[ "$img" != "$NEW_IMAGE_ID" ]]; then
      echo "  removing $name (image=${img:7:12} != new=${NEW_IMAGE_ID:7:12})"
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  done
fi

# --- Refresh ops scripts so bug fixes ship without re-running install.sh ---
# These are tiny; safe to overwrite every redeploy. The bot service is only
# touched if it's already enabled (i.e. the admin opted in during install).
echo "==> Refreshing ops scripts (backup, monitor, bot, restore, trigger, cleanup)"
# Ensure the trigger dir exists for older installs that pre-date it.
mkdir -p /opt/premdev/data/triggers && chmod 770 /opt/premdev/data/triggers
chown 1000:1000 /opt/premdev/data/triggers 2>/dev/null || true
# Make sure the trigger cron is present (idempotent).
if [[ ! -f /etc/cron.d/premdev-trigger ]]; then
  cat > /etc/cron.d/premdev-trigger <<'CRON'
* * * * * root /usr/local/sbin/premdev-trigger >> /var/log/premdev-trigger.log 2>&1
17 * * * * root /usr/local/sbin/premdev-refresh-index >> /var/log/premdev-trigger.log 2>&1
CRON
  chmod 644 /etc/cron.d/premdev-trigger
fi
# Daily Docker cleanup at 03:00 — added in this version. Idempotent.
if [[ ! -f /etc/cron.d/premdev-docker-cleanup ]]; then
  cat > /etc/cron.d/premdev-docker-cleanup <<'CRON'
0 3 * * * root /usr/local/sbin/premdev-docker-cleanup --quiet >> /var/log/premdev-docker-cleanup.log 2>&1
CRON
  chmod 644 /etc/cron.d/premdev-docker-cleanup
  echo "  Installed /etc/cron.d/premdev-docker-cleanup (daily 03:00)"
fi
for pair in "infra/backup.sh:/usr/local/sbin/premdev-backup" \
            "infra/monitoring.sh:/usr/local/sbin/premdev-monitor" \
            "infra/telegram-bot.mjs:/usr/local/sbin/premdev-bot.mjs" \
            "infra/restore.sh:/usr/local/sbin/premdev-restore" \
            "infra/refresh-index.sh:/usr/local/sbin/premdev-refresh-index" \
            "infra/trigger-runner.sh:/usr/local/sbin/premdev-trigger" \
            "infra/docker-cleanup.sh:/usr/local/sbin/premdev-docker-cleanup" \
            "infra/redeploy.sh:/usr/local/sbin/premdev-redeploy"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  fetch_repo_file "$src" "$dst" && chmod 755 "$dst" || echo "  WARN: failed to refresh $dst"
done

# --- Static landing page (apex domain) ---
# Mounted into Caddy as /srv/landing. Refreshed every redeploy so design
# tweaks ship without an install.sh re-run.
echo "==> Refreshing landing page ($HOST_DATA_DIR/landing)"
mkdir -p "$HOST_DATA_DIR/landing"
fetch_repo_file "infra/landing/index.html" "$HOST_DATA_DIR/landing/index.html" \
  && chmod 644 "$HOST_DATA_DIR/landing/index.html" \
  || echo "  WARN: failed to refresh landing/index.html"
if systemctl is-enabled --quiet premdev-bot.service 2>/dev/null; then
  fetch_repo_file "infra/premdev-bot.service" /etc/systemd/system/premdev-bot.service || true
  systemctl daemon-reload
  systemctl restart premdev-bot.service && echo "  premdev-bot restarted" \
    || echo "  WARN: premdev-bot restart failed (journalctl -u premdev-bot -n 30)"
fi

echo
echo "Done. Open the app and Run a workspace — it will spawn fresh containers"
echo "from the rebuilt runtime image."
