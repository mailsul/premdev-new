import "dotenv/config";

function env(key: string, def?: string): string {
  return process.env[key] ?? def ?? "";
}

export const config = {
  NODE_ENV: env("NODE_ENV", "development"),
  LOG_LEVEL: env("LOG_LEVEL", "info"),
  PORT: env("PORT", "3001"),
  HOST: env("HOST", "0.0.0.0"),

  JWT_SECRET: env("JWT_SECRET", "dev-secret-change-me-in-production"),
  COOKIE_DOMAIN: env("COOKIE_DOMAIN", ""),
  SECURE_COOKIES: env("SECURE_COOKIES", "false") === "true",

  DATA_DIR: env("DATA_DIR", "/var/lib/premdev"),
  WORKSPACES_DIR: env("WORKSPACES_DIR", "/var/lib/premdev/workspaces"),
  // Path on the HOST filesystem (not inside this container) where workspace
  // dirs actually live. Used for Docker bind mounts when this app talks to
  // the host docker socket — bind sources MUST be host paths, not paths
  // visible inside the API container. In dev this equals WORKSPACES_DIR.
  WORKSPACES_HOST_DIR: env("WORKSPACES_HOST_DIR", ""),
  SQLITE_PATH: env("SQLITE_PATH", "/var/lib/premdev/premdev.sqlite"),

  PRIMARY_DOMAIN: env("PRIMARY_DOMAIN", "localhost"),
  PREVIEW_DOMAIN: env("PREVIEW_DOMAIN", "preview.localhost"),
  DEPLOY_DOMAIN: env("DEPLOY_DOMAIN", "app.localhost"),

  ADMIN_USERNAME: env("ADMIN_USERNAME", "admin"),
  ADMIN_EMAIL: env("ADMIN_EMAIL", "admin@example.com"),
  ADMIN_PASSWORD: env("ADMIN_PASSWORD", "admin1234"),

  DOCKER_SOCKET: env("DOCKER_SOCKET", "/var/run/docker.sock"),
  DOCKER_NETWORK: env("DOCKER_NETWORK", "premdev_net"),
  RUNTIME_IMAGE: env("RUNTIME_IMAGE", "premdev/runtime:latest"),
  RUNTIME_DEFAULT_PORT: Number(env("RUNTIME_DEFAULT_PORT", "3000")),
  // Optional secondary IDE. It runs in its own workspace-scoped container
  // using the same runtime image, which must contain the `code-server` binary.
  CODE_SERVER_PORT: Number(env("CODE_SERVER_PORT", "8080")),
  CODE_SERVER_PREVIEW_PORT: Number(env("CODE_SERVER_PREVIEW_PORT", "4173")),

  MYSQL_HOST: env("MYSQL_HOST", "mysql"),
  MYSQL_PORT: Number(env("MYSQL_PORT", "3306")),
  // Public hostname injected into workspace containers so user code connects
  // via the VPS domain (like cPanel) rather than the internal Docker hostname.
  // Defaults to PRIMARY_DOMAIN; set MYSQL_PUBLIC_HOST in .env to override.
  MYSQL_PUBLIC_HOST: env("MYSQL_PUBLIC_HOST", ""),
  MYSQL_ROOT_PASSWORD: env("MYSQL_ROOT_PASSWORD", ""),
  MYSQL_USER_PASSWORD: env("MYSQL_USER_PASSWORD", ""),

  // Dedicated workspace admin MySQL user — has ALL PRIVILEGES on all
  // `<owner>_%` databases and is reachable both internally (via Docker
  // network) and externally (via VPS IP / domain on port 3306).
  // Set MYSQL_WORKSPACE_USER + MYSQL_WORKSPACE_PASSWORD in /opt/premdev/.env.
  MYSQL_WORKSPACE_USER: env("MYSQL_WORKSPACE_USER", ""),
  MYSQL_WORKSPACE_PASSWORD: env("MYSQL_WORKSPACE_PASSWORD", ""),

  PHPMYADMIN_URL: env("PHPMYADMIN_URL", "/phpmyadmin/"),
  ADMINER_URL: env("ADMINER_URL", ""),

  // AI provider keys
  OPENAI_API_KEY: env("OPENAI_API_KEY", ""),
  ANTHROPIC_API_KEY: env("ANTHROPIC_API_KEY", ""),
  GOOGLE_API_KEY: env("GOOGLE_API_KEY", ""),
  OPENROUTER_API_KEY: env("OPENROUTER_API_KEY", ""),
  GROQ_API_KEY: env("GROQ_API_KEY", ""),
  KONEKTIKA_API_KEY: env("KONEKTIKA_API_KEY", ""),
  // SnifoxAI Gateway — OpenAI-compatible aggregator at https://core.snifoxai.com/v1
  // Key format: snfx-... (see https://snifoxai.com/docs).
  SNIFOX_API_KEY: env("SNIFOX_API_KEY", ""),
  // Ollama — local LLM inference, no API key required.
  // Default: http://localhost:11434. Change if Ollama runs on a different host/port.
  OLLAMA_HOST: env("OLLAMA_HOST", "http://localhost:11434"),

  // Default per-user quotas
  DEFAULT_CPU: Number(env("DEFAULT_CPU", "1")),
  DEFAULT_MEM_MB: Number(env("DEFAULT_MEM_MB", "2048")),
  DEFAULT_DISK_MB: Number(env("DEFAULT_DISK_MB", "10240")),
  DEFAULT_MAX_WORKSPACES: Number(env("DEFAULT_MAX_WORKSPACES", "3")),

  IDLE_PAUSE_MINUTES: Number(env("IDLE_PAUSE_MINUTES", "30")),

  // Idle long-lived shell containers (`pwsh_*`) get auto-stopped after this
  // many minutes of no terminal input. 0 disables. Run containers (`pw_*`)
  // are NEVER reaped here — they pause/resume via IDLE_PAUSE_MINUTES instead.
  IDLE_SHELL_TIMEOUT_MIN: Number(env("IDLE_SHELL_TIMEOUT_MIN", "30")),

  // Central workspace scheduler. Jobs run in the existing pw_<workspace>
  // application container; they never use the browser terminal container.
  CRON_POLL_INTERVAL_MS: Number(env("CRON_POLL_INTERVAL_MS", "15000")),
  CRON_JOB_TIMEOUT_MS: Number(env("CRON_JOB_TIMEOUT_MS", "120000")),
  CRON_JOB_RETENTION: Number(env("CRON_JOB_RETENTION", "100")),

  // Telegram admin notifications (Fase 2). Both must be set or the lib
  // becomes a silent no-op (safe to leave empty in dev / single-user installs).
  TELEGRAM_BOT_TOKEN: env("TELEGRAM_BOT_TOKEN", ""),
  TELEGRAM_ADMIN_CHAT_ID: env("TELEGRAM_ADMIN_CHAT_ID", ""),
  // Numeric Telegram user ID allowed to command the admin bot. NOT used by
  // the API itself (the bot lives on the host) — kept here so any future
  // /admin endpoint can show "bot is configured" without re-parsing .env.
  ADMIN_TELEGRAM_ID: env("ADMIN_TELEGRAM_ID", ""),

  // Cloudflare R2 (S3-compatible) for nightly off-site backups (Fase 2).
  // Backup script is a no-op when these are empty.
  R2_ENDPOINT: env("R2_ENDPOINT", ""),
  R2_ACCESS_KEY: env("R2_ACCESS_KEY", ""),
  R2_SECRET_KEY: env("R2_SECRET_KEY", ""),
  R2_BUCKET: env("R2_BUCKET", ""),
  R2_REGION: env("R2_REGION", "auto"),

  // VPS filesystem browser (Task A).
  // Requires docker-compose.yml volume: - /:/vpsroot:rw on the `app` service.
  // Admin-only. Leave as default; override only if you mount at a different path.
  VFS_ROOT: env("VFS_ROOT", "/vpsroot"),

  // 9Router — self-hosted OpenAI-compatible AI gateway (https://9router.com).
  // Set NINE_ROUTER_BASE_URL to the internal Docker network address
  // (e.g. http://9router:20128/v1 when running in the same Compose stack).
  // NINE_ROUTER_API_KEY is the API key generated from the 9Router dashboard.
  // When these are set, 9Router becomes the sole AI backend for all workspaces.
  NINE_ROUTER_BASE_URL: env("NINE_ROUTER_BASE_URL", ""),
  NINE_ROUTER_API_KEY: env("NINE_ROUTER_API_KEY", ""),
};

export const IS_DEV = config.NODE_ENV === "development";

// In dev (running on Replit), use ./data instead of /var/lib
if (IS_DEV) {
  if (!process.env.DATA_DIR) config.DATA_DIR = "./data";
  if (!process.env.WORKSPACES_DIR) config.WORKSPACES_DIR = "./data/workspaces";
  if (!process.env.SQLITE_PATH) config.SQLITE_PATH = "./data/premdev.sqlite";
}

// In production: if WORKSPACES_HOST_DIR not explicitly set, fall back to
// WORKSPACES_DIR (correct only when this app is NOT itself containerised).
if (!config.WORKSPACES_HOST_DIR) config.WORKSPACES_HOST_DIR = config.WORKSPACES_DIR;
