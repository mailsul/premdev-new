import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@/lib/api";
import { Eye, EyeOff, Plus, Trash2, X, Save, Lock, Loader2, FileJson, FileText, List as ListIcon, Database, ChevronDown, ChevronRight, Zap } from "lucide-react";
import { useConfirm } from "@/lib/useConfirm";

type ConfigResp = {
  filename: string;
  config: { run?: string; env?: Record<string, string> };
  resolvedRunCommand: string;
};

type Mode = "form" | "json" | "env";

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Per-workspace secrets manager. Stores entries as the `env` object inside
 * `.premdev`, the same place AI's `workspace:setEnv` writes to.
 *
 * Three editing modes (Replit-style):
 *   - Form  — one row per key, Add/Save/Delete buttons
 *   - JSON  — bulk edit as `{ "KEY": "value", ... }`
 *   - .env  — bulk edit as `KEY=value` lines (with quotes / `#` comments)
 *
 * On Save, the bulk modes diff against the current env and send a single
 * patch with explicit `null` for removed keys (the backend treats `null` as
 * delete). Need a workspace Restart to take effect inside running containers.
 */
export function SecretsPanel({
  workspaceId,
  onClose,
  onChanged,
  initialDbTemplate,
  embedded = false,
}: {
  workspaceId: string;
  onClose: () => void;
  onChanged?: () => void;
  initialDbTemplate?: boolean;
  embedded?: boolean;
}) {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["workspace", workspaceId, "config"],
    queryFn: () => API.get<ConfigResp>(`/workspaces/${workspaceId}/config`),
  });

  const { data: dbInfo } = useQuery({
    queryKey: ["workspace", workspaceId, "db-info"],
    queryFn: () => API.get<{ host: string; port: string; user: string; database: string; url: string; hasPassword: boolean }>(
      `/workspaces/${workspaceId}/db/info?showPassword=1`
    ),
  });

  // Real URL built from workspace data (password revealed)
  const realDbUrl = dbInfo?.url || "";

  const env = data?.config?.env ?? {};
  const keys = Object.keys(env).sort();

  const [mode, setMode] = useState<Mode>("form");
  const [showVals, setShowVals] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [showDbTemplate, setShowDbTemplate] = useState(!!initialDbTemplate);
  const [dbTemplateMode, setDbTemplateMode] = useState<"url" | "fields">("url");
  const [dbUrlDraft, setDbUrlDraft] = useState("");
  const [dbFields, setDbFields] = useState({ host: "", port: "3306", user: "", password: "", database: "" });
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  // Buffers for bulk editors. Re-seed whenever the underlying env changes
  // OR when the mode switches into one of the bulk views, so the textarea
  // reflects the latest server state without losing in-progress edits.
  const [jsonText, setJsonText] = useState("");
  const [envText, setEnvText] = useState("");
  const [jsonDirty, setJsonDirty] = useState(false);
  const [envDirty, setEnvDirty] = useState(false);

  useEffect(() => {
    setEdits({});
    if (!jsonDirty) setJsonText(toJsonText(env));
    if (!envDirty) setEnvText(toEnvText(env));
  }, [data]);

  useEffect(() => {
    setError(null);
    if (mode === "json" && !jsonDirty) setJsonText(toJsonText(env));
    if (mode === "env" && !envDirty) setEnvText(toEnvText(env));
  }, [mode]);

  const patch = useMutation({
    mutationFn: (envPatch: Record<string, string | null>) =>
      API.post(`/workspaces/${workspaceId}/config/patch`, { env: envPatch }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["workspace", workspaceId, "config"] });
      await refetch();
      onChanged?.();
    },
  });

  async function addNew() {
    setError(null);
    const k = newKey.trim();
    if (!k) return setError("Key cannot be empty");
    if (!VALID_KEY.test(k)) {
      return setError("Key must start with a letter or _, and contain only letters, digits, _.");
    }
    if (env[k] !== undefined) {
      return setError(`Key "${k}" already exists — edit it below instead.`);
    }
    try {
      await patch.mutateAsync({ [k]: newVal });
      setNewKey("");
      setNewVal("");
    } catch (e: any) {
      setError(e?.message ?? "Failed to add");
    }
  }

  async function saveOne(k: string) {
    const v = edits[k];
    if (v === undefined) return;
    try {
      await patch.mutateAsync({ [k]: v });
      setEdits((cur) => {
        const n = { ...cur };
        delete n[k];
        return n;
      });
    } catch (e: any) {
      setError(e?.message ?? "Failed to save");
    }
  }

  async function deleteOne(k: string) {
    const ok = await confirm({
      title: "Hapus secret?",
      message: `Secret "${k}" akan dihapus. Restart workspace agar perubahan masuk ke container yang lagi jalan.`,
      confirmLabel: "Hapus",
      cancelLabel: "Batal",
      danger: true,
    });
    if (!ok) return;
    try {
      await patch.mutateAsync({ [k]: null });
    } catch (e: any) {
      setError(e?.message ?? "Failed to delete");
    }
  }

  function toggleShow(k: string) {
    setShowVals((cur) => {
      const n = new Set(cur);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }

  // --- Bulk save ----------------------------------------------------------

  function diffPatch(next: Record<string, string>): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    // Adds + updates
    for (const [k, v] of Object.entries(next)) {
      if (env[k] !== v) out[k] = v;
    }
    // Deletes (present before, missing now)
    for (const k of Object.keys(env)) {
      if (!(k in next)) out[k] = null;
    }
    return out;
  }

  async function saveJson() {
    setError(null);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText || "{}");
    } catch (e: any) {
      return setError(`Invalid JSON: ${e?.message ?? "parse failed"}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return setError("JSON must be an object like { \"KEY\": \"value\" }");
    }
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!VALID_KEY.test(k)) return setError(`Invalid key "${k}". Keys must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
      if (typeof v !== "string") return setError(`Value for "${k}" must be a string (got ${typeof v}).`);
      next[k] = v;
    }
    const p = diffPatch(next);
    if (Object.keys(p).length === 0) {
      setJsonDirty(false);
      return;
    }
    try {
      await patch.mutateAsync(p);
      setJsonDirty(false);
    } catch (e: any) {
      setError(e?.message ?? "Failed to save");
    }
  }

  async function saveEnv() {
    setError(null);
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvText(envText);
    } catch (e: any) {
      return setError(e?.message ?? "Failed to parse .env");
    }
    for (const k of Object.keys(parsed)) {
      if (!VALID_KEY.test(k)) return setError(`Invalid key "${k}". Keys must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
    }
    const p = diffPatch(parsed);
    if (Object.keys(p).length === 0) {
      setEnvDirty(false);
      return;
    }
    try {
      await patch.mutateAsync(p);
      setEnvDirty(false);
    } catch (e: any) {
      setError(e?.message ?? "Failed to save");
    }
  }

  const dirtyCount = useMemo(() => {
    if (mode === "json") return jsonDirty ? 1 : 0;
    if (mode === "env") return envDirty ? 1 : 0;
    return Object.keys(edits).filter((k) => edits[k] !== env[k]).length;
  }, [mode, jsonDirty, envDirty, edits, env]);

  return (
    <div
      className={embedded ? "flex h-full min-h-0 flex-col bg-bg-base" : "fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4"}
      onClick={embedded ? undefined : onClose}
    >
      <div
        className={embedded
          ? "flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg-base"
          : "card flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden p-0"}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 border-b border-bg-border px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-accent/15 p-2 text-accent">
              <Lock size={16} />
            </div>
            <div>
              <div className="text-base font-semibold">Secrets</div>
              <p className="mt-0.5 text-xs text-text-muted">
                Stored in <code>.premdev</code> in your workspace (file mode 0600). Visible to anyone with shell access — don't paste production keys.
                Available inside the container as env vars: <code>getenv('KEY')</code>, <code>process.env.KEY</code>, <code>os.environ['KEY']</code>. Restart the workspace after changes.
              </p>
            </div>
          </div>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-bg-border px-5 py-2">
          <TabBtn active={mode === "form"} onClick={() => setMode("form")} icon={<ListIcon size={12} />}>
            Form
          </TabBtn>
          <TabBtn active={mode === "json"} onClick={() => setMode("json")} icon={<FileJson size={12} />}>
            Edit as JSON
          </TabBtn>
          <TabBtn active={mode === "env"} onClick={() => setMode("env")} icon={<FileText size={12} />}>
            Edit as .env
          </TabBtn>
          <span className="ml-auto text-[11px] text-text-muted">
            {keys.length} secret{keys.length === 1 ? "" : "s"}
            {dirtyCount > 0 && <span className="ml-2 text-warning">• unsaved</span>}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {mode === "form" && (
            <>
              {/* ─── External Database Template ─────────────────────────────── */}
              <div className="mb-4 rounded-md border border-bg-border bg-bg-subtle overflow-hidden">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-bg-border transition"
                  onClick={() => setShowDbTemplate((v) => !v)}
                >
                  <Database size={13} className="text-accent shrink-0" />
                  <span className="flex-1 text-xs font-semibold text-text">Koneksi Database Eksternal</span>
                  <span className="text-[10px] text-text-muted mr-1">cPanel / hosting / VPS luar</span>
                  {showDbTemplate ? <ChevronDown size={13} className="text-text-muted" /> : <ChevronRight size={13} className="text-text-muted" />}
                </button>
                {showDbTemplate && (
                  <div className="border-t border-bg-border px-3 pb-3 pt-2.5 space-y-3">
                    <p className="text-[11px] text-text-muted">
                      Isi salah satu: <strong>DATABASE_URL</strong> (satu baris) <em>atau</em> kolom individual di bawah. Setelah disimpan, klik <strong>Restart</strong> workspace.
                    </p>
                    {/* Toggle mode */}
                    <div className="flex rounded-md overflow-hidden border border-bg-border text-xs">
                      {(["url", "fields"] as const).map((m) => (
                        <button
                          key={m}
                          className={`flex-1 py-1 transition ${dbTemplateMode === m ? "bg-accent text-white" : "text-text-muted hover:bg-bg-border"}`}
                          onClick={() => setDbTemplateMode(m)}
                        >
                          {m === "url" ? "DATABASE_URL (1 baris)" : "Kolom terpisah"}
                        </button>
                      ))}
                    </div>

                    {dbTemplateMode === "url" ? (
                      <div className="space-y-1.5">
                        <label className="text-[11px] text-text-muted block">
                          DB internal workspace ini:{" "}
                          {realDbUrl ? (
                            <code
                              className="text-accent cursor-pointer hover:underline"
                              title="Klik untuk isi otomatis"
                              onClick={() => setDbUrlDraft(realDbUrl)}
                            >
                              {realDbUrl}
                            </code>
                          ) : (
                            <code className="text-accent">mysql://user:password@host:3306/nama_database</code>
                          )}
                        </label>
                        <div className="flex gap-2">
                          <input
                            className="input flex-1 font-mono text-xs"
                            placeholder={realDbUrl || "mysql://user:pass@db.example.com:3306/mydb"}
                            value={dbUrlDraft}
                            onChange={(e) => setDbUrlDraft(e.target.value)}
                          />
                          <button
                            className="btn-primary text-xs shrink-0"
                            disabled={patch.isPending || !dbUrlDraft.trim()}
                            onClick={async () => {
                              if (!dbUrlDraft.trim()) return;
                              try {
                                await patch.mutateAsync({ DATABASE_URL: dbUrlDraft.trim() });
                                setDbUrlDraft("");
                                setShowDbTemplate(false);
                              } catch (e: any) { setError(e?.message ?? "Gagal menyimpan"); }
                            }}
                          >
                            {patch.isPending ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                            Simpan
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {[
                          { key: "host" as const, label: "DB_HOST", hint: dbInfo?.host || "db.example.com" },
                          { key: "port" as const, label: "DB_PORT", hint: dbInfo?.port || "3306" },
                          { key: "user" as const, label: "DB_USER", hint: dbInfo?.user || "cpanel_user" },
                          { key: "password" as const, label: "DB_PASSWORD", hint: "••••••••" },
                          { key: "database" as const, label: "DATABASE_NAME", hint: dbInfo?.database || "cpanel_dbname" },
                        ].map(({ key, label, hint }) => (
                          <div key={key} className="flex items-center gap-2">
                            <code className="w-32 shrink-0 text-[11px] text-accent">{label}</code>
                            <input
                              className="input flex-1 font-mono text-xs"
                              placeholder={hint}
                              type={key === "password" ? "password" : "text"}
                              value={dbFields[key]}
                              onChange={(e) => setDbFields((f) => ({ ...f, [key]: e.target.value }))}
                            />
                          </div>
                        ))}
                        <button
                          className="btn-primary w-full text-xs mt-1"
                          disabled={patch.isPending || !dbFields.host.trim()}
                          onClick={async () => {
                            const p: Record<string, string> = {};
                            if (dbFields.host) p.DB_HOST = dbFields.host;
                            if (dbFields.port) p.DB_PORT = dbFields.port;
                            if (dbFields.user) p.DB_USER = dbFields.user;
                            if (dbFields.password) p.DB_PASSWORD = dbFields.password;
                            if (dbFields.database) p.DATABASE_NAME = dbFields.database;
                            if (Object.keys(p).length === 0) return;
                            try {
                              await patch.mutateAsync(p);
                              setDbFields({ host: "", port: "3306", user: "", password: "", database: "" });
                              setShowDbTemplate(false);
                            } catch (e: any) { setError(e?.message ?? "Gagal menyimpan"); }
                          }}
                        >
                          {patch.isPending ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                          Simpan semua ke Secrets
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ─── Add new secret ─────────────────────────────────────────── */}
              <div className="mb-4 rounded-md border border-bg-border bg-bg-subtle p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Add new secret
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    className="input min-w-[140px] flex-1 font-mono text-xs"
                    placeholder="DB_PASSWORD"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addNew(); }}
                  />
                  <input
                    className="input min-w-[180px] flex-[2] font-mono text-xs"
                    placeholder="value"
                    value={newVal}
                    onChange={(e) => setNewVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addNew(); }}
                  />
                  <button
                    className="btn-primary text-xs"
                    onClick={addNew}
                    disabled={patch.isPending || !newKey.trim()}
                  >
                    {patch.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    Add
                  </button>
                </div>
              </div>

              {isLoading ? (
                <div className="text-xs text-text-muted">Loading…</div>
              ) : keys.length === 0 ? (
                <div className="rounded-md border border-dashed border-bg-border px-3 py-6 text-center text-xs text-text-muted">
                  No secrets yet. Add one above, or switch to .env / JSON for bulk paste.
                </div>
              ) : (
                <ul className="space-y-2">
                  {keys.map((k) => {
                    const cur = edits[k] !== undefined ? edits[k] : env[k];
                    const dirty = edits[k] !== undefined && edits[k] !== env[k];
                    const visible = showVals.has(k);
                    return (
                      <li
                        key={k}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-bg-border bg-bg p-2"
                      >
                        <code
                          className="min-w-[120px] max-w-[200px] flex-shrink-0 truncate font-mono text-xs"
                          title={k}
                        >
                          {k}
                        </code>
                        <input
                          className={`input min-w-0 flex-1 font-mono text-xs ${
                            dirty ? "ring-1 ring-warning" : ""
                          }`}
                          type={visible ? "text" : "password"}
                          value={cur}
                          onChange={(e) =>
                            setEdits((c) => ({ ...c, [k]: e.target.value }))
                          }
                        />
                        <button
                          className="btn-ghost p-1 text-text-muted"
                          onClick={() => toggleShow(k)}
                          title={visible ? "Hide" : "Show"}
                        >
                          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        {dirty && (
                          <button
                            className="btn-secondary text-xs"
                            onClick={() => saveOne(k)}
                            disabled={patch.isPending}
                          >
                            <Save size={12} /> Save
                          </button>
                        )}
                        <button
                          className="btn-ghost p-1 text-text-muted hover:text-danger"
                          onClick={() => deleteOne(k)}
                          title="Delete secret"
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {mode === "json" && (
            <div className="flex h-full flex-col">
              <p className="mb-2 text-[11px] text-text-muted">
                Edit as a JSON object. Keys missing from this object will be <strong>deleted</strong>. Save replaces the entire env block.
              </p>
              <textarea
                className="input min-h-[280px] flex-1 resize-y font-mono text-xs leading-relaxed"
                spellCheck={false}
                placeholder='{\n  "DB_HOST": "localhost",\n  "DB_PASS": "secret"\n}'
                value={jsonText}
                onChange={(e) => { setJsonText(e.target.value); setJsonDirty(true); }}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="btn-primary text-xs"
                  onClick={saveJson}
                  disabled={patch.isPending || !jsonDirty}
                >
                  {patch.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Save JSON
                </button>
                <button
                  className="btn-secondary text-xs"
                  onClick={() => { setJsonText(toJsonText(env)); setJsonDirty(false); setError(null); }}
                  disabled={!jsonDirty}
                >
                  Reset
                </button>
              </div>
            </div>
          )}

          {mode === "env" && (
            <div className="flex h-full flex-col">
              <p className="mb-2 text-[11px] text-text-muted">
                Edit as <code>.env</code>. One <code>KEY=value</code> per line. <code>#</code> comments and blank lines are ignored. Quotes optional, <code>\n</code> in double quotes becomes a newline. Keys missing from this list will be <strong>deleted</strong>.
              </p>
              <textarea
                className="input min-h-[280px] flex-1 resize-y font-mono text-xs leading-relaxed"
                spellCheck={false}
                placeholder={`DB_HOST=localhost\nDB_PASS=secret\n# DB_PORT=3306\nAPI_KEY="sk-..."`}
                value={envText}
                onChange={(e) => { setEnvText(e.target.value); setEnvDirty(true); }}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="btn-primary text-xs"
                  onClick={saveEnv}
                  disabled={patch.isPending || !envDirty}
                >
                  {patch.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Save .env
                </button>
                <button
                  className="btn-secondary text-xs"
                  onClick={() => { setEnvText(toEnvText(env)); setEnvDirty(false); setError(null); }}
                  disabled={!envDirty}
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-bg-border bg-bg-subtle px-5 py-3 text-[11px] text-text-muted">
          <span>
            Tip: After saving, click <strong>Restart</strong> in the editor header so the running container picks up the new values.
          </span>
          <button className="btn-secondary text-xs" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}

function TabBtn({
  active, onClick, icon, children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
        active
          ? "bg-accent/15 text-accent"
          : "text-text-muted hover:bg-bg-subtle hover:text-text"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function toJsonText(env: Record<string, string>): string {
  // Stable, sorted-key serialisation so re-saving doesn't reorder lines.
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) sorted[k] = env[k];
  return JSON.stringify(sorted, null, 2);
}

function toEnvText(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const k of Object.keys(env).sort()) {
    lines.push(`${k}=${formatEnvValue(env[k])}`);
  }
  return lines.join("\n");
}

// Quote when value contains chars that would change meaning unquoted.
function formatEnvValue(v: string): string {
  if (v === "") return "";
  // Always quote if it contains whitespace, =, #, or starts/ends with quote.
  // Use double quotes and escape \ " and \n.
  if (/[\s="'#\\]/.test(v) || /^\s|\s$/.test(v)) {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return v;
}

/**
 * Minimal .env parser. Supports:
 *   KEY=value
 *   KEY="value with spaces and \"escaped\" quotes and \n newlines"
 *   KEY='single quoted, no escapes'
 *   # comment lines, blank lines, optional `export ` prefix.
 * Throws on malformed lines so users get a clear error message.
 */
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq < 1) {
      throw new Error(`Line ${i + 1}: expected KEY=value, got "${raw}"`);
    }
    const key = stripped.slice(0, eq).trim();
    let val = stripped.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1);
    } else {
      // Strip inline trailing comment only when preceded by whitespace.
      const m = val.match(/^([^#]*?)\s+#.*$/);
      if (m) val = m[1].trim();
    }
    out[key] = val;
  }
  return out;
}
