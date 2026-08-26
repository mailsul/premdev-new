/**
 * sql-safety.ts — quick AST-style SQL safety classifier for the AI's
 * autonomous `db:query` action. NOT a full parser; just deny-list scan
 * to catch destructive SQL the LLM can emit by accident.
 *
 * In autonomous mode only SELECT/WITH/EXPLAIN/SHOW/DESCRIBE are permitted.
 * Everything else (writes, DDL, admin commands) is blocked and the error
 * message is returned to the AI so it can adapt its strategy.
 */

const FORBIDDEN_VERBS = [
  "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME",
  "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT",
  "GRANT", "REVOKE",
  "LOCK", "UNLOCK",
  "FLUSH", "KILL", "SHUTDOWN", "RESTART", "STOP", "START", "RESET",
  "CALL", "EXEC", "EXECUTE", "DO", "HANDLER", "LOAD",
  "INTO\\s+OUTFILE", "INTO\\s+DUMPFILE", "INTO\\s+S3",
  "LOAD_FILE", "LOAD\\s+DATA",
];

const ALLOWED_LEADING = /^\s*(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC)\b/i;

/**
 * Returns null if the SQL is safe for autonomous mode.
 * Returns a human-readable reason string if it should be blocked.
 */
export function checkSqlReadOnly(rawSql: string): string | null {
  if (!rawSql || !rawSql.trim()) return "empty SQL";
  if (/--/.test(rawSql)) return "SQL contains '--' line comment (potential injection vector)";
  if (/#/.test(rawSql)) return "SQL contains '#' line comment";
  if (/\/\*/.test(rawSql)) return "SQL contains block comment";
  const trimmed = rawSql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) return "SQL contains multiple statements — only one statement per block";
  if (!ALLOWED_LEADING.test(rawSql)) {
    const firstWord = rawSql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "(empty)";
    return `only SELECT/WITH/EXPLAIN/SHOW/DESCRIBE is allowed in autonomous mode, got ${firstWord}`;
  }
  const stripped = stripStringsAndIdentifiers(rawSql).toUpperCase();
  for (const verb of FORBIDDEN_VERBS) {
    const re = new RegExp(`\\b${verb}\\b`, "i");
    if (re.test(stripped)) {
      return `forbidden keyword in autonomous mode: ${verb.replace(/\\s+/g, " ")}`;
    }
  }
  if (/@\w+\s*:=/.test(rawSql)) {
    return "user-defined variable assignment (@x := ...) is not allowed in autonomous mode";
  }
  return null;
}

/**
 * Strip string literals and backtick identifiers so FORBIDDEN_VERBS don't
 * match text inside quoted values (e.g. INSERT INTO t SET name = 'DELETE me').
 */
function stripStringsAndIdentifiers(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch; i++;
      while (i < sql.length) {
        const c = sql[i];
        if (c === "\\" && i + 1 < sql.length) { i += 2; continue; }
        if (c === quote) { out += ch; i++; break; }
        if (quote === "'" && c === "'" && sql[i + 1] === "'") { i += 2; continue; }
        i++;
      }
      continue;
    }
    if (ch === "`") {
      out += "``"; i++;
      while (i < sql.length && sql[i] !== "`") i++;
      if (i < sql.length) i++;
      continue;
    }
    out += ch; i++;
  }
  return out;
}
