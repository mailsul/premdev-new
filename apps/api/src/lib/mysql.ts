import mysql from "mysql2/promise";
import { config } from "./config.js";

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool | null {
  if (!config.MYSQL_ROOT_PASSWORD) return null;
  if (!pool) {
    pool = mysql.createPool({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: "root",
      password: config.MYSQL_ROOT_PASSWORD,
      waitForConnections: true,
      connectionLimit: 5,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

/**
 * Warm up the server-side caching_sha2_password cache for a user by making
 * one SSL connection as that user. After this, any client (including Python
 * without get_server_public_key / SSL) can authenticate via the fast-path
 * cache without needing SSL or RSA key exchange.
 */
export async function warmupMysqlUserCache(username: string, password: string): Promise<void> {
  if (!config.MYSQL_HOST || !password) return;
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  if (!safeUser) return;
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: safeUser,
      password,
      ssl: { rejectUnauthorized: false },
      connectTimeout: 6_000,
    });
    await conn.query("SELECT 1");
  } catch {
    // Silently ignore — cache warmup is best-effort
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

export async function ensureMysqlUser(username: string, password: string) {
  const p = getPool();
  if (!p) return;
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  // CREATE keeps existing user if any. ALTER syncs the password so an old
  // account (created with a previous MYSQL_USER_PASSWORD or none at all)
  // accepts the credentials we now inject into workspace env vars.
  await p.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [safeUser, password]);
  await p.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [safeUser, password]);
  await p.query(`GRANT ALL PRIVILEGES ON \`${safeUser}\\_%\`.* TO ?@'%'`, [safeUser]);
  await p.query(`FLUSH PRIVILEGES`);
}

/**
 * Create / sync a dedicated workspace admin MySQL user that has ALL PRIVILEGES
 * on every database belonging to `ownerUsername` (pattern: `ownerUsername_%`).
 * This user is reachable from both inside Docker (mysql hostname) and outside
 * (VPS IP / domain on port 3306) and is injected into workspace containers so
 * user code never needs hardcoded credentials.
 */
export async function ensureWorkspaceAdminUser(
  wsUser: string,
  wsPassword: string,
  ownerUsername: string,
): Promise<void> {
  const p = getPool();
  if (!p) return;
  const safeWs    = wsUser.replace(/[^a-zA-Z0-9_]/g, "");
  const safeOwner = ownerUsername.replace(/[^a-zA-Z0-9_]/g, "");
  if (!safeWs || !safeOwner) return;
  await p.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [safeWs, wsPassword]);
  await p.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [safeWs, wsPassword]);
  await p.query(`GRANT ALL PRIVILEGES ON \`${safeOwner}\\_%\`.* TO ?@'%'`, [safeWs]);
  await p.query(`FLUSH PRIVILEGES`);
}

export async function createProjectDb(username: string, projectName: string) {
  const p = getPool();
  if (!p) return null;
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  const safeProj = projectName.replace(/[^a-zA-Z0-9_]/g, "_");
  const dbName = `${safeUser}_${safeProj}`;
  await p.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  return dbName;
}

export async function dropProjectDb(username: string, projectName: string) {
  const p = getPool();
  if (!p) return;
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  const safeProj = projectName.replace(/[^a-zA-Z0-9_]/g, "_");
  await p.query(`DROP DATABASE IF EXISTS \`${safeUser}_${safeProj}\``);
}

/**
 * Run a raw SQL string against the per-workspace MySQL database. The
 * caller MUST have validated the workspace ownership; this function only
 * enforces that the database name starts with `<safeUser>_` so an attacker
 * cannot smuggle a sibling user's db name. Connection is opened with the
 * workspace owner's MySQL user (created by `ensureMysqlUser`) so the
 * GRANTs we set up earlier are the actual access boundary.
 *
 * Returns at most `rowLimit` rows (default 200) and serialises BigInt to
 * string so the result is JSON-safe. SELECT, SHOW, DESCRIBE return rows;
 * INSERT/UPDATE/DELETE/DDL return an info object with affectedRows.
 */
type WorkspaceQueryRow = Record<string, unknown>;
type WorkspaceQueryResult =
  | { ok: true; kind: "rows"; columns: string[]; rows: WorkspaceQueryRow[]; rowCount: number; truncated: boolean }
  | { ok: true; kind: "info"; affectedRows: number; insertId: number; changedRows: number }
  | { ok: false; error: string };

export async function runWorkspaceQuery(opts: {
  username: string;
  dbName: string;
  sql: string;
  rowLimit?: number;
}): Promise<WorkspaceQueryResult> {
  if (!config.MYSQL_HOST) {
    return { ok: false, error: "MySQL is not configured on this server" };
  }
  const safeUser = opts.username.replace(/[^a-zA-Z0-9_]/g, "");
  if (!safeUser) return { ok: false, error: "Invalid workspace owner" };
  if (!opts.dbName.startsWith(`${safeUser}_`)) {
    return { ok: false, error: `Database "${opts.dbName}" is not owned by this workspace` };
  }
  const sql = opts.sql.trim();
  if (!sql) return { ok: false, error: "Empty SQL" };
  const rowLimit = Math.max(1, Math.min(opts.rowLimit ?? 200, 1000));

  // Prefer dedicated workspace admin user; fall back to per-user account.
  const connUser = config.MYSQL_WORKSPACE_USER || safeUser;
  const connPass = config.MYSQL_WORKSPACE_PASSWORD || config.MYSQL_USER_PASSWORD;
  if (!connPass) {
    return { ok: false, error: "MySQL credentials not configured on this server" };
  }

  let conn: mysql.Connection | null = null;
  try {
    // Connect WITHOUT specifying a database — this succeeds even when the
    // workspace DB doesn't exist yet. We then SELECT the database with USE.
    conn = await mysql.createConnection({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: connUser,
      password: connPass,
      multipleStatements: false,
      connectTimeout: 8_000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      ssl: { rejectUnauthorized: false },
    });

    // Try to select the workspace database. If it doesn't exist yet, auto-
    // provision it using root then retry — this covers the first-query case.
    try {
      await conn.query(`USE \`${opts.dbName}\``);
    } catch (useErr: any) {
      if (useErr?.code === "ER_BAD_DB_ERROR" || String(useErr?.message).includes("Unknown database")) {
        // Database doesn't exist → create it with root then retry
        const rootPool = getPool();
        if (rootPool) {
          await rootPool.query(
            `CREATE DATABASE IF NOT EXISTS \`${opts.dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
          );
          // Also ensure grants are in place
          await rootPool.query(
            `GRANT ALL PRIVILEGES ON \`${safeUser}\\_%\`.* TO ?@'%'`,
            [safeUser]
          );
          await rootPool.query(`FLUSH PRIVILEGES`);
          await conn.query(`USE \`${opts.dbName}\``);
        } else {
          // No root pool (MYSQL_ROOT_PASSWORD not set) — surface clear error
          return { ok: false, error: `Database "${opts.dbName}" does not exist. Set MYSQL_ROOT_PASSWORD in /opt/premdev/.env to enable auto-creation.` };
        }
      } else {
        throw useErr;
      }
    }

    const [result, fields] = await conn.query(sql);
    if (Array.isArray(result)) {
      const fieldList = (fields ?? []) as ReadonlyArray<{ name: string }>;
      const columns = fieldList.map((f) => f.name);
      const rowsAll = result as WorkspaceQueryRow[];
      const truncated = rowsAll.length > rowLimit;
      const rows = truncated ? rowsAll.slice(0, rowLimit) : rowsAll;
      return { ok: true, kind: "rows", columns, rows, rowCount: rowsAll.length, truncated };
    }
    const info = result as { affectedRows?: number; insertId?: number; changedRows?: number };
    return {
      ok: true,
      kind: "info",
      affectedRows: Number(info.affectedRows ?? 0),
      insertId: Number(info.insertId ?? 0),
      changedRows: Number(info.changedRows ?? 0),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}
