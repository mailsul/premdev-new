import { db, type DbWorkspace } from "./db.js";
import { config } from "./config.js";
import { readWorkspaceConfig } from "./workspace-config.js";

/**
 * Resolve the same environment used by a manually started workspace.
 * Keeping this outside the HTTP route is important: lifecycle recovery must
 * not silently lose database credentials after an API/redeploy restart.
 */
export function resolveWorkspaceEnv(workspace: DbWorkspace, workspaceDir: string): Record<string, string> {
  let stored: Record<string, string> = {};
  try { stored = JSON.parse(workspace.env_vars); } catch {}
  const workspaceConfig = readWorkspaceConfig(workspaceDir);
  const auto: Record<string, string> = {};
  const userRow = db.prepare("SELECT username FROM users WHERE id = ?").get(workspace.user_id) as { username?: string } | undefined;
  const username = userRow?.username?.replace(/[^a-zA-Z0-9_]/g, "") ?? "";
  const safeProject = workspace.name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 48);
  const databaseName = username && safeProject ? `${username}_${safeProject}` : "";

  if (databaseName) {
    auto.DATABASE_NAME = databaseName;
    auto.DB_NAME = databaseName;
    auto.MYSQL_DATABASE = databaseName;
  }
  if (config.MYSQL_HOST) {
    auto.DATABASE_HOST = config.MYSQL_HOST;
    auto.DATABASE_PORT = String(config.MYSQL_PORT);
    auto.DB_HOST = config.MYSQL_HOST;
    auto.DB_PORT = String(config.MYSQL_PORT);
    auto.MYSQL_HOST = config.MYSQL_HOST;
    auto.MYSQL_PORT = String(config.MYSQL_PORT);
    const externalHost = config.MYSQL_PUBLIC_HOST || config.PRIMARY_DOMAIN;
    if (externalHost) {
      auto.DB_EXTERNAL_HOST = externalHost;
      auto.MYSQL_EXTERNAL_HOST = externalHost;
    }
  }

  const dbUser = config.MYSQL_WORKSPACE_USER || username;
  const dbPassword = config.MYSQL_WORKSPACE_PASSWORD || config.MYSQL_USER_PASSWORD;
  if (dbUser && dbPassword) {
    auto.DATABASE_USER = dbUser;
    auto.DATABASE_PASSWORD = dbPassword;
    auto.DB_USER = dbUser;
    auto.DB_PASSWORD = dbPassword;
    auto.MYSQL_USER = dbUser;
    auto.MYSQL_PASSWORD = dbPassword;
  }

  const merged = { ...auto, ...stored, ...(workspaceConfig?.env ?? {}) };
  if (!merged.DATABASE_URL) {
    const host = merged.DB_HOST || merged.DATABASE_HOST || "";
    const port = merged.DB_PORT || merged.DATABASE_PORT || "3306";
    const user = merged.DB_USER || merged.DATABASE_USER || "";
    const password = merged.DB_PASSWORD || merged.DATABASE_PASSWORD || "";
    const name = merged.DATABASE_NAME || merged.DB_NAME || "";
    if (host && user && name) {
      const userInfo = password ? `${user}:${encodeURIComponent(password)}` : user;
      merged.DATABASE_URL = `mysql://${userInfo}@${host}:${port}/${name}`;
    }
  }
  return merged;
}