/**
 * sql-safety.ts — optional AST-style SQL safety classifier for callers that
 * want a deny-list scan before executing SQL. The autonomous workspace
 * database action now permits reads, writes, and DDL; this helper is retained
 * for future opt-in safeguards and is not the ownership boundary.
 *
 * The workspace database route enforces ownership server-side. This helper
 * can still be used by a caller that explicitly wants conservative SQL.
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
    return `conservative SQL mode allows only SELECT/WITH/EXPLAIN/SHOW/DESCRIBE, got ${firstWord}`;
  }
  const stripped = stripStringsAndIdentifiers(rawSql).toUpperCase();
  for (const verb of FORBIDDEN_VERBS) {
    const re = new RegExp(`\\b${verb}\\b`, "i");
    if (re.test(stripped)) {
    return `forbidden keyword in conservative SQL mode: ${verb.replace(/\\s+/g, " ")}`;
    }
  }
  if (/@\w+\s*:=/.test(rawSql)) {
    return "user-defined variable assignment (@x := ...) is not allowed in conservative SQL mode";
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
