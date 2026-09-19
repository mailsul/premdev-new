/**
 * action-executor.ts — run a parsed Action against the PremDev API.
 * Each Action kind maps to a single HTTP call. Plumbed `signal` for Stop.
 * Extracted from AIChat.tsx so it can be unit-tested independently.
 */

export type Action =
  | { kind: "bash"; command: string }
  | { kind: "file"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "mkdir"; path: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "patch"; path: string; find: string; replace: string; replaceAll: boolean }
  | { kind: "search"; pattern: string; pathGlob?: string; regex: boolean }
  | { kind: "diag" }
  | { kind: "test"; command?: string }
  | { kind: "web"; query: string }
  | { kind: "webFetch"; url: string; offset?: number }
  | { kind: "preview"; path?: string }
  | { kind: "memorySave"; content: string }
  | { kind: "setRun"; command: string }
  | { kind: "setEnv"; vars: Record<string, string> }
  | { kind: "setProcesses"; processes: Record<string, { run: string; port: number }> }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "restart" }
  | { kind: "checkpoint"; message: string }
  | { kind: "db"; sql: string }
  | { kind: "open"; path: string };

export type ActionResult = { ok: boolean; output: string };

export type ExecOptions = {
  signal?: AbortSignal;
  provider?: string;
  model?: string;
  /** True only when the user's current request explicitly asked to delete a database. */
  explicitDatabaseDeletion?: boolean;
};

export async function runAction(
  workspaceId: string,
  action: Action,
  opts: ExecOptions = {},
): Promise<ActionResult> {
  const { signal, provider, model, explicitDatabaseDeletion } = opts;

  async function fetchJson(method: string, path: string, body?: unknown) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      credentials: "include",
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = data?.error || text || res.statusText;
      throw new Error(typeof err === "string" ? err : JSON.stringify(err));
    }
    return data;
  }

  try {
    switch (action.kind) {
      case "bash": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/exec`, { command: action.command });
        return { ok: r.exitCode === 0, output: r.output ?? "" };
      }
      case "file": {
        await fetchJson("POST", `/workspaces/${workspaceId}/files/create`, { path: action.path, type: "file" });
        await fetchJson("PUT", `/workspaces/${workspaceId}/files`, { path: action.path, content: action.content });
        return { ok: true, output: `Wrote ${action.path}` };
      }
      case "setRun": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/config/patch`, { run: action.command });
        return { ok: true, output: `.premdev run set to:\n${r.config?.run ?? action.command}` };
      }
      case "setEnv": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/config/patch`, { env: action.vars });
        const keys = Object.keys(action.vars);
        const merged = r.config?.env ?? {};
        return { ok: true, output: `.premdev env merged (${keys.length} key${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}). Total now: ${Object.keys(merged).length}.` };
      }
      case "setProcesses": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/config/patch`, { processes: action.processes });
        const names = Object.keys(action.processes);
        return { ok: true, output: `.premdev processes set (${names.length}: ${names.join(", ")}).\n${JSON.stringify(r.config?.processes ?? action.processes, null, 2)}` };
      }
      case "restart":
        await fetchJson("POST", `/workspaces/${workspaceId}/restart`);
        return { ok: true, output: "Workspace restarted" };
      case "checkpoint":
        await fetchJson("POST", `/workspaces/${workspaceId}/checkpoints`, { message: action.message });
        return { ok: true, output: `Checkpoint saved: ${action.message}` };
      case "delete": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/files/delete`, { path: action.path });
        if (r.ok === false) {
          const failed = (r.results ?? []).filter((x: any) => !x.ok).map((x: any) => `${x.path}: ${x.error}`).join("; ");
          return { ok: false, output: failed || "Delete failed" };
        }
        return { ok: true, output: `Deleted ${action.path}` };
      }
      case "mkdir":
        await fetchJson("POST", `/workspaces/${workspaceId}/files/create`, { path: action.path, type: "dir" });
        return { ok: true, output: `Created directory ${action.path}` };
      case "rename":
        await fetchJson("POST", `/workspaces/${workspaceId}/files/rename`, { from: action.from, to: action.to });
        return { ok: true, output: `Renamed ${action.from} → ${action.to}` };
      case "patch": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/files/patch`, {
          path: action.path, find: action.find, replace: action.replace, replaceAll: action.replaceAll,
        });
        const occ = r.occurrences ?? 1;
        return { ok: true, output: `Patched ${action.path} (${occ} occurrence${occ === 1 ? "" : "s"} replaced)` };
      }
      case "search": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/files/search`, {
          pattern: action.pattern, regex: action.regex, pathGlob: action.pathGlob || undefined, maxHits: 100,
        });
        const hits = r.hits ?? [];
        if (hits.length === 0) return { ok: true, output: `No matches for "${action.pattern}" (scanned ${r.filesScanned ?? 0} files)` };
        const lines = hits.slice(0, 80).map((h: any) => `${h.path}:${h.line}: ${h.text}`);
        return { ok: true, output: [`Found ${hits.length}${r.truncated ? "+" : ""} matches in ${r.filesScanned} files:`, ...lines].join("\n") };
      }
      case "diag": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/files/diagnostics`, { tool: "auto" });
        return { ok: r.ok !== false, output: `Diagnostics (${r.tool}, exit=${r.exitCode}):\n${r.output || "(no output)"}` };
      }
      case "test": {
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/test`, { command: action.command });
        return { ok: r.ok !== false, output: `Tests (${r.tool}, exit=${r.exitCode}):\n${r.output || "(no output)"}` };
      }
      case "db": {
        const isDropDatabase = /^\s*DROP\s+(?:DATABASE|SCHEMA)\b/i.test(action.sql);
        let confirmDestructive = false;
        if (isDropDatabase) {
          // An explicit user instruction is sufficient. Otherwise require a
          // visible confirmation at the exact point of execution.
          const approved = explicitDatabaseDeletion ||
            (typeof window !== "undefined" && window.confirm(
              `Konfirmasi: jalankan "${action.sql.trim()}"? Database workspace akan dihapus permanen dan tidak dapat dipulihkan dari checkpoint.`,
            ));
          if (!approved) {
            return { ok: false, output: "DROP DATABASE dibatalkan oleh pengguna; database tidak diubah." };
          }
          confirmDestructive = true;
        }
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/db/query`, {
          sql: action.sql,
          autonomous: true,
          confirmDestructive,
          rowLimit: 50,
        });
        if (r.kind === "rows") {
          const lines: string[] = [];
          lines.push(`db: ${r.database} — ${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${r.truncated ? " (showing first " + r.rows.length + ")" : ""}`);
          if (r.columns?.length) lines.push(r.columns.join(" | "));
          for (const row of r.rows.slice(0, 50)) {
            lines.push(r.columns.map((c: string) => {
              const v = row[c];
              if (v === null || v === undefined) return "NULL";
              const s = typeof v === "object" ? JSON.stringify(v) : String(v);
              return s.length > 80 ? s.slice(0, 77) + "..." : s;
            }).join(" | "));
          }
          return { ok: true, output: lines.join("\n").slice(0, 12_000) };
        }
        if (r.kind === "info") {
          return { ok: true, output: `db: ${r.database} — affected=${r.affectedRows}, insertId=${r.insertId}, changed=${r.changedRows}` };
        }
        return { ok: true, output: JSON.stringify(r).slice(0, 4000) };
      }
      case "web": {
        const r = await fetchJson("POST", `/ai/web-search`, { query: action.query, maxResults: 8 });
        const results = r.results ?? [];
        if (results.length === 0) return { ok: true, output: `No web results for "${action.query}"` };
        const fmt = results.map((x: any, i: number) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n");
        return { ok: true, output: `Web search "${action.query}":\n\n${fmt}` };
      }
      case "webFetch": {
        const r = await fetchJson("POST", `/ai/web-fetch`, { url: action.url, offset: action.offset ?? 0 });
        if (!r.ok) return { ok: false, output: r.error || "Fetch failed" };
        const pageInfo = r.hasMore
          ? `\n\n[Page offset=${r.offset}, chars ${r.offset}–${(r.offset ?? 0) + (r.content?.length ?? 0)} of ${r.totalLength}. To read next page: web:fetch with offset=${r.nextOffset}]`
          : "";
        return { ok: true, output: `Content of ${action.url}:\n\n${r.content}${pageInfo}` };
      }
      case "preview": {
        const previewPath = action.path || "/";
        if (/[\r\n]/.test(previewPath)) {
          return { ok: false, output: "Preview path contains a newline and was rejected." };
        }
        const safePath = previewPath.startsWith("/") ? previewPath : `/${previewPath}`;
        const shellPath = safePath.replace(/(["\\$`])/g, "\\$1");
        const r = await fetchJson("POST", `/workspaces/${workspaceId}/exec`, {
          command: `curl -fsS --max-time 15 -D - "http://localhost:\${PORT:-5000}${shellPath}" | head -c 16000`,
        });
        return {
          ok: r.exitCode === 0,
          output: `Preview ${safePath} (exit=${r.exitCode}):\n${r.output ?? ""}`,
        };
      }
      case "memorySave": {
        const lines = action.content.split("\n").length;
        if (provider) {
          const r = await fetchJson("POST", `/ai/memory/compact`, {
            workspaceId, newNote: action.content, provider, model,
          });
          if (!r.ok) return { ok: false, output: r.error || "Memory compact failed" };
          return { ok: true, output: r.compacted ? `Memory compacted + saved (${lines} lines merged into .premdev-data/memory.md)` : `Memory saved (${lines} lines appended → .premdev-data/memory.md)` };
        }
        const r = await fetchJson("POST", `/ai/memory/append`, { workspaceId, content: action.content });
        if (!r.ok) return { ok: false, output: r.error || "Memory save failed" };
        return { ok: true, output: `Memory saved (${lines} lines → .premdev-data/memory.md)` };
      }
      case "start":
        await fetchJson("POST", `/workspaces/${workspaceId}/start`);
        return { ok: true, output: "Workspace started using the resolved .premdev run configuration" };
      case "stop":
        await fetchJson("POST", `/workspaces/${workspaceId}/stop`);
        return { ok: true, output: "Workspace stopped" };
      case "open":
        window.dispatchEvent(new CustomEvent("premdev:open-file", { detail: { path: action.path } }));
        return { ok: true, output: `Opened ${action.path}` };
      default:
        return { ok: false, output: "Unknown action" };
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return { ok: false, output: "Cancelled by user" };
    return { ok: false, output: e?.message ?? String(e) };
  }
}

// ── Risk classification ────────────────────────────────────────────────────

export type ActionRisk = "high" | "medium" | "low";

const _DESTRUCTIVE_SQL = /\b(DROP|DELETE|TRUNCATE|UPDATE|REPLACE|INSERT)\b/i;
const _SENSITIVE_ENV_KEYS = /(DATABASE_NAME|DATABASE_HOST|DB_HOST|DB_NAME|MYSQL_HOST|MYSQL_USER|MYSQL_PASSWORD|^AWS_|^GCP_|^GITHUB_|^GH_TOKEN|^API_KEY|^SECRET|^TOKEN)/i;
const _DESTRUCTIVE_BASH = /(^|[;&|]\s*)(rm\s+-[rRf]{2,}|rmdir|mkfs|dd\s+|curl\s+[^|]*\|\s*(bash|sh|zsh|fish)|wget\s+[^|]*\|\s*(bash|sh|zsh|fish)|:\(\)\s*\{|chmod\s+-R\s+777|chown\s+-R|>\s*\/dev\/sd[a-z]|shutdown|reboot|init\s+[06])/i;

export function getActionRisk(action: Action): ActionRisk {
  if (action.kind === "delete") return "high";
  if (action.kind === "bash") return _DESTRUCTIVE_BASH.test(action.command) ? "high" : "low";
  if (action.kind === "db") {
    const stripped = action.sql
      .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    return _DESTRUCTIVE_SQL.test(stripped) ? "high" : "low";
  }
  if (action.kind === "start" || action.kind === "stop") return "medium";
  if (action.kind === "setEnv") {
    const keys = Object.keys(action.vars ?? {});
    if (keys.some((k) => _SENSITIVE_ENV_KEYS.test(k))) return "high";
    return "medium";
  }
  if (action.kind === "setRun")       return "medium";
  if (action.kind === "setProcesses") return "medium";
  if (action.kind === "restart")      return "medium";
  return "low";
}

// ── Labels (for ActionCard display) ───────────────────────────────────────

export function actionLabel(a: Action): string {
  switch (a.kind) {
    case "bash":       return `bash:run \`${a.command.split("\n")[0].slice(0, 80)}\``;
    case "file":       return `file: ${a.path}`;
    case "delete":     return `delete: ${a.path}`;
    case "mkdir":      return `mkdir: ${a.path}`;
    case "rename":     return `rename: ${a.from} → ${a.to}`;
    case "patch":      return `patch: ${a.path}${a.replaceAll ? " (all)" : ""}`;
    case "search":     return `search: ${a.pattern.slice(0, 60)}${a.pathGlob ? ` in:${a.pathGlob}` : ""}`;
    case "diag":       return `diag:run`;
    case "test":       return `test:run${a.command ? ` \`${a.command.slice(0, 60)}\`` : ""}`;
    case "web":        return `web:search ${a.query.slice(0, 60)}`;
    case "webFetch":   return `web:fetch ${a.url.slice(0, 80)}`;
    case "preview":    return `preview:check ${a.path || "/"}`;
    case "memorySave": return `memory:save (${a.content.split("\n").length} baris)`;
    case "setRun":     return `workspace:setRun \`${a.command.slice(0, 80)}\``;
    case "setEnv": {
      const keys = Object.keys(a.vars);
      return `workspace:setEnv (${keys.length}: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""})`;
    }
    case "setProcesses": {
      const names = Object.keys(a.processes);
      return `workspace:setProcesses (${names.join(", ")})`;
    }
    case "start":      return "workspace:start";
    case "stop":       return "workspace:stop";
    case "restart":    return "workspace:restart";
    case "checkpoint": return `workspace:checkpoint "${a.message}"`;
    case "db":         return `db:query \`${a.sql.split("\n")[0].slice(0, 80)}\``;
    case "open":       return `open: ${a.path}`;
  }
}

// ── Fingerprinting (for loop detection) ──────────────────────────────────

function fnv1a32(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).slice(0, 6);
}

export function actionFingerprint(a: Action): string {
  switch (a.kind) {
    case "bash":       return `bash:${fnv1a32(a.command)}`;
    case "file":       return `file:${a.path}@${fnv1a32(a.content)}`;
    case "patch":      return `patch:${a.path}@${fnv1a32(a.find + "\0" + a.replace + "\0" + String(a.replaceAll))}`;
    case "delete":     return `delete:${a.path}`;
    case "mkdir":      return `mkdir:${a.path}`;
    case "rename":     return `rename:${a.from}→${a.to}`;
    case "restart":    return "restart:";
    case "diag":       return "diag:";
    case "test":       return `test:${fnv1a32(a.command ?? "")}`;
    case "search":     return `search:${fnv1a32(a.pattern + "\0" + (a.pathGlob ?? "") + "\0" + String(a.regex))}`;
    case "db":         return `db:${fnv1a32(a.sql)}`;
    case "web":        return `web:${fnv1a32(a.query)}`;
    case "webFetch":   return `webFetch:${fnv1a32(a.url)}`;
    case "preview":    return `preview:${fnv1a32(a.path ?? "/")}`;
    case "memorySave": return `memorySave:${fnv1a32(a.content)}`;
    case "setRun":        return `setRun:${fnv1a32(a.command)}`;
    case "setEnv":        return `setEnv:${fnv1a32(JSON.stringify(a.vars))}`;
    case "setProcesses":  return `setProcesses:${fnv1a32(JSON.stringify(a.processes))}`;
    case "start":         return "start:";
    case "stop":          return "stop:";
    case "checkpoint":    return `checkpoint:${fnv1a32(a.message)}`;
    case "open":       return `open:${a.path}`;
    default:           return `${(a as Action).kind}:`;
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────

function _actionTarget(a: Action): string {
  switch (a.kind) {
    case "bash":       return a.command.split("\n")[0].slice(0, 200);
    case "file":       return a.path;
    case "delete":     return a.path;
    case "mkdir":      return a.path;
    case "rename":     return `${a.from} => ${a.to}`;
    case "patch":      return a.path;
    case "search":     return a.pattern.slice(0, 200);
    case "diag":       return "";
    case "test":       return a.command?.slice(0, 200) ?? "";
    case "web":        return a.query.slice(0, 200);
    case "webFetch":   return a.url.slice(0, 200);
    case "preview":    return a.path ?? "/";
    case "memorySave": return a.content.split("\n")[0].slice(0, 200);
    case "setRun":        return a.command.slice(0, 200);
    case "setEnv":        return Object.keys(a.vars).join(",");
    case "setProcesses":  return Object.keys(a.processes).join(",");
    case "start":
    case "stop":
    case "restart":       return "";
    case "checkpoint": return a.message;
    case "db":         return a.sql.split("\n")[0].slice(0, 200);
    case "open":       return a.path;
  }
}

export async function logAudit(opts: {
  workspaceId: string;
  provider?: string;
  model?: string;
  action: Action;
  result: ActionResult;
}): Promise<void> {
  try {
    await fetch("/api/ai/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        workspaceId: opts.workspaceId,
        provider: opts.provider,
        model: opts.model,
        kind: opts.action.kind,
        target: _actionTarget(opts.action),
        ok: opts.result.ok,
        output: (opts.result.output ?? "").slice(0, 2000),
      }),
    });
  } catch {}
}
