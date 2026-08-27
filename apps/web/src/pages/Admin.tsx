import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { API } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { Plus, Trash2, Loader2, Activity, Users, HardDrive, Cpu, Key, Eye, EyeOff, Save, Shield, ScrollText, LogIn, Cloud, RefreshCw, Play, Download, AlertTriangle, Sparkles, Search, Database, Zap, Server, Folder, FileText, ChevronRight, Home, FolderPlus, FilePen, X, Globe, ToggleLeft, ToggleRight, Star, ExternalLink, BookOpen, Clock, Check } from "lucide-react";
import { useConfirm } from "@/lib/useConfirm";

type Tab = "users" | "audit" | "logins" | "backup" | "semantic" | "vpsfiles" | "ai-runtime" | "domains" | "custom-providers" | "metrics";

type AdminUser = {
  id: string;
  username: string;
  email: string;
  role: "admin" | "user";
  quotaCpu: number;
  quotaMemMb: number;
  quotaDiskMb: number;
  maxWorkspaces: number;
  createdAt: string;
  workspaceCount?: number;
};

type SystemStats = {
  totalUsers: number;
  totalWorkspaces: number;
  runningWorkspaces: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskUsedMb: number;
  diskTotalMb: number;
};

type AIKeyRow = {
  provider: "openai" | "anthropic" | "google" | "openrouter" | "groq" | "konektika" | "snifox";
  configured: boolean;
  source: "db" | "env" | "none";
  masked: string;
  // Multi-key failover: a single configured value may contain several
  // keys separated by `,` / `;` / newline. The backend already parses
  // them and rotates on rate-limit / 401 errors. Surface the count and
  // per-key masked previews here so admins can verify their failover
  // chain is set up correctly without revealing the secret bodies.
  keyCount: number;
  maskedAll: string[];
};

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  konektika: "Konektika (kimi-pro)",
  snifox: "SnifoxAI (snfx-…)",
};

const PROVIDER_DOCS: Record<string, { url: string; label: string; keyHint: string }> = {
  openai:     { url: "https://platform.openai.com/api-keys",                         label: "platform.openai.com",          keyHint: "sk-…" },
  anthropic:  { url: "https://console.anthropic.com/settings/keys",                  label: "console.anthropic.com",        keyHint: "sk-ant-…" },
  google:     { url: "https://aistudio.google.com/app/apikey",                       label: "aistudio.google.com",          keyHint: "AIza…" },
  openrouter: { url: "https://openrouter.ai/settings/keys",                          label: "openrouter.ai",                keyHint: "sk-or-v1-…" },
  groq:       { url: "https://console.groq.com/keys",                                label: "console.groq.com",             keyHint: "gsk_…" },
  konektika:  { url: "https://konektika.id",                                          label: "konektika.id",                 keyHint: "kimi-…" },
  snifox:     { url: "https://snifox.ai",                                             label: "snifox.ai",                    keyHint: "snfx-…" },
};

export default function AdminPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState<Tab>("users");

  const { data: users, isLoading: lu } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => API.get<{ users: AdminUser[] }>("/admin/users"),
  });
  const { data: stats } = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: () => API.get<SystemStats>("/admin/stats"),
    refetchInterval: 5000,
  });

  const del = useMutation({
    mutationFn: (id: string) => API.delete(`/admin/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  const diskPct = stats?.diskTotalMb
    ? Math.round(((stats.diskUsedMb ?? 0) / stats.diskTotalMb) * 100)
    : 0;

  return (
    <Layout>
      <div className="mx-auto max-w-6xl p-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Admin</h1>
            <p className="text-sm text-text-muted">Manage users, quotas, and system resources</p>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon={<Users size={16} />} label="Users" value={stats?.totalUsers ?? "-"} />
          <StatCard icon={<Activity size={16} />} label="Workspaces" value={`${stats?.runningWorkspaces ?? 0}/${stats?.totalWorkspaces ?? 0}`} sub="running / total" />
          <StatCard icon={<Cpu size={16} />} label="CPU" value={`${stats?.cpuPercent?.toFixed(0) ?? 0}%`} />
          <StatCard
            icon={<HardDrive size={16} />}
            label={stats?.diskTotalMb ? `Disk ${diskPct}%` : "Memory"}
            value={
              stats?.diskTotalMb
                ? `${((stats.diskUsedMb ?? 0) / 1024).toFixed(1)}G`
                : `${((stats?.memUsedMb ?? 0) / 1024).toFixed(1)}G`
            }
            sub={
              stats?.diskTotalMb
                ? `/ ${((stats.diskTotalMb ?? 0) / 1024).toFixed(0)}G`
                : `/ ${((stats?.memTotalMb ?? 0) / 1024).toFixed(0)}G`
            }
          />
        </div>

        {/* Tabs row — keeps the existing Users + AI keys panes available
            and adds two read-only audit views without restructuring the page. */}
        <div className="mb-4 flex items-center gap-1 border-b border-bg-border">
          <TabButton active={tab === "users"} onClick={() => setTab("users")} icon={<Users size={14} />}>Users</TabButton>
          <TabButton active={tab === "audit"} onClick={() => setTab("audit")} icon={<ScrollText size={14} />}>Audit log</TabButton>
          <TabButton active={tab === "logins"} onClick={() => setTab("logins")} icon={<LogIn size={14} />}>Login attempts</TabButton>
          <TabButton active={tab === "backup"} onClick={() => setTab("backup")} icon={<Cloud size={14} />}>Backup</TabButton>
          <TabButton active={tab === "semantic"} onClick={() => setTab("semantic")} icon={<Search size={14} />}>AI Search</TabButton>
          <TabButton active={tab === "vpsfiles"} onClick={() => setTab("vpsfiles")} icon={<Server size={14} />}>VPS Files</TabButton>
          <TabButton active={tab === "ai-runtime"} onClick={() => setTab("ai-runtime")} icon={<Zap size={14} />}>Pengaturan AI</TabButton>
          <TabButton active={tab === "domains"} onClick={() => setTab("domains")} icon={<Globe size={14} />}>Domains</TabButton>
          <TabButton active={tab === "custom-providers"} onClick={() => setTab("custom-providers")} icon={<Sparkles size={14} />}>Custom Providers</TabButton>
          <TabButton active={tab === "metrics"} onClick={() => setTab("metrics")} icon={<Activity size={14} />}>Metrics</TabButton>
        </div>

        {tab === "metrics" && <MetricsDashboard />}
        {tab === "audit" && <AuditLogSection />}
        {tab === "logins" && <LoginAttemptsSection />}
        {tab === "backup" && <BackupSection />}
        {tab === "semantic" && <SemanticSearchSection />}
        {tab === "vpsfiles" && <VFSSection />}
        {tab === "ai-runtime" && <AIRuntimeSettingsSection />}
        {tab === "domains" && <DomainsSection />}
        {tab === "custom-providers" && <CustomProvidersSection onGoToAIRuntime={() => setTab("ai-runtime")} />}

        {tab === "users" && (
        <>
        <section className="card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Users</h2>
            <button className="btn-primary" onClick={() => setShowAdd(true)}>
              <Plus size={14} /> Add user
            </button>
          </div>

          {lu ? (
            <div className="flex items-center gap-2 text-text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="py-2">User</th>
                    <th>Role</th>
                    <th>Workspaces</th>
                    <th>RAM</th>
                    <th>Disk</th>
                    <th>CPU</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users?.users.map((u) => (
                    <tr key={u.id} className="border-t border-bg-border">
                      <td className="py-3">
                        <div className="font-medium">{u.username}</div>
                        <div className="text-xs text-text-muted">{u.email}</div>
                      </td>
                      <td>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${u.role === "admin" ? "bg-accent/20 text-accent" : "bg-bg-hover text-text-muted"}`}>
                          {u.role}
                        </span>
                      </td>
                      <td>{u.workspaceCount ?? 0} / {u.maxWorkspaces}</td>
                      <td>{u.quotaMemMb} MB</td>
                      <td>{u.quotaDiskMb} MB</td>
                      <td>{u.quotaCpu}</td>
                      <td className="text-right">
                        {u.role !== "admin" && (
                          <button
                            className="btn-ghost text-danger hover:text-danger"
                            onClick={async () => {
                              const ok = await confirm({
                                title: "Delete user?",
                                message: `User ${u.username} and all their workspaces will be removed.`,
                                confirmLabel: "Delete",
                                danger: true,
                              });
                              if (ok) del.mutate(u.id);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card mt-6 p-6">
          <div className="mb-4 flex items-center gap-2">
            <Key size={16} className="text-accent" />
            <h2 className="font-semibold">AI provider keys</h2>
            <span className="ml-auto text-xs text-text-muted">
              Stored encrypted in DB. Empty value falls back to environment.
            </span>
          </div>
          <AIKeysSection />
        </section>
        </>
        )}
      </div>

      {showAdd && <AddUserModal onClose={() => setShowAdd(false)} />}
      {dialog}
    </Layout>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm transition ${
        active
          ? "border-b-2 border-accent bg-bg-subtle/50 font-medium text-accent"
          : "text-text-muted hover:text-text-default"
      }`}
    >
      {icon} {children}
    </button>
  );
}

type AuditRow = {
  id: string;
  actor_username: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  meta: string | null;
  created_at: number;
};

function MetricsDashboard() {
  const { data: users, isLoading } = useQuery<{ users: AdminUser[] }>({
    queryKey: ["admin-users"],
    queryFn: () => apiFetch("/admin/users"),
    refetchInterval: 30000,
  });

  const allUsers = users?.users ?? [];
  const totalWorkspaces = allUsers.reduce((s, u) => s + (u.workspaceCount ?? 0), 0);
  const totalMaxWs = allUsers.reduce((s, u) => s + u.maxWorkspaces, 0);
  const totalRam = allUsers.reduce((s, u) => s + u.quotaMemMb, 0);
  const totalDisk = allUsers.reduce((s, u) => s + u.quotaDiskMb, 0);

  function pct(a: number, b: number) {
    if (!b) return 0;
    return Math.round((a / b) * 100);
  }

  if (isLoading) return (
    <div className="flex items-center gap-2 p-6 text-text-muted">
      <Loader2 size={14} className="animate-spin" /> Memuat metrics…
    </div>
  );

  return (
    <section className="space-y-6 p-2">
      <div>
        <h2 className="mb-3 font-semibold">Ringkasan Platform</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={<Users size={14} />} label="Total Users" value={allUsers.length} sub="akun terdaftar" />
          <StatCard icon={<HardDrive size={14} />} label="Workspaces Aktif" value={totalWorkspaces} sub={`dari ${totalMaxWs} slot`} />
          <StatCard icon={<Cpu size={14} />} label="Total RAM Quota" value={`${(totalRam / 1024).toFixed(1)} GB`} sub="dijumlahkan per-user" />
          <StatCard icon={<HardDrive size={14} />} label="Total Disk Quota" value={`${(totalDisk / 1024).toFixed(1)} GB`} sub="dijumlahkan per-user" />
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-semibold">Per-User Resource Usage</h2>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-bg-border bg-bg-subtle text-left uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Workspaces</th>
                  <th className="px-4 py-2">RAM Quota</th>
                  <th className="px-4 py-2">Disk Quota</th>
                  <th className="px-4 py-2">CPU Quota</th>
                </tr>
              </thead>
              <tbody>
                {allUsers.map((u) => {
                  const wsUsed = u.workspaceCount ?? 0;
                  const wsPct = pct(wsUsed, u.maxWorkspaces);
                  return (
                    <tr key={u.id} className="border-b border-bg-border hover:bg-bg-hover transition">
                      <td className="px-4 py-3">
                        <div className="font-medium">{u.username}</div>
                        <div className="text-text-muted">{u.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${u.role === "admin" ? "bg-accent/20 text-accent" : "bg-bg-hover text-text-muted"}`}>
                          {u.role}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-hover">
                            <div
                              className={`h-full rounded-full transition-all ${wsPct > 80 ? "bg-danger" : wsPct > 60 ? "bg-warning" : "bg-success"}`}
                              style={{ width: `${wsPct}%` }}
                            />
                          </div>
                          <span className="font-mono">{wsUsed} / {u.maxWorkspaces}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono">{u.quotaMemMb} MB</td>
                      <td className="px-4 py-3 font-mono">{u.quotaDiskMb} MB</td>
                      <td className="px-4 py-3 font-mono">{u.quotaCpu} core</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-semibold">Distribusi Workspace Usage</h2>
        <div className="card p-4 space-y-3">
          {allUsers.map((u) => {
            const wsUsed = u.workspaceCount ?? 0;
            const wsPct = pct(wsUsed, u.maxWorkspaces);
            return (
              <div key={u.id} className="flex items-center gap-3 text-xs">
                <span className="w-28 truncate font-medium">{u.username}</span>
                <div className="flex-1 h-2 overflow-hidden rounded-full bg-bg-hover">
                  <div
                    className={`h-full rounded-full transition-all ${wsPct > 80 ? "bg-danger" : wsPct > 60 ? "bg-warning" : "bg-accent"}`}
                    style={{ width: `${wsPct}%` }}
                  />
                </div>
                <span className="w-12 text-right font-mono text-text-muted">{wsPct}%</span>
                <span className="w-14 text-right font-mono">{wsUsed}/{u.maxWorkspaces}</span>
              </div>
            );
          })}
          {allUsers.length === 0 && <div className="text-text-muted">Tidak ada data.</div>}
        </div>
      </div>
    </section>
  );
}

function AuditLogSection() {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "audit-log", action, actor],
    queryFn: () => API.get<{ rows: AuditRow[] }>(
      `/admin/audit-log?limit=200${action ? `&action=${encodeURIComponent(action)}` : ""}${actor ? `&actor=${encodeURIComponent(actor)}` : ""}`,
    ),
    refetchInterval: 15000,
  });
  return (
    <section className="card p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Shield size={16} className="text-accent" />
        <h2 className="font-semibold">Security audit log</h2>
        <span className="ml-auto flex gap-2">
          <input
            className="input h-8 text-xs"
            placeholder="filter action…"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
          <input
            className="input h-8 text-xs"
            placeholder="filter actor…"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </span>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : !data?.rows.length ? (
        <div className="text-sm text-text-muted">No events.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left uppercase tracking-wide text-text-muted">
              <tr>
                <th className="py-2">When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
                <th>IP</th>
                <th>Meta</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-bg-border">
                  <td className="py-2 text-text-muted">{new Date(r.created_at).toLocaleString()}</td>
                  <td><span className="rounded-full bg-bg-hover px-2 py-0.5 font-mono">{r.action}</span></td>
                  <td>{r.actor_username ?? <span className="text-text-muted">—</span>}</td>
                  <td className="font-mono">{r.target ?? "—"}</td>
                  <td className="font-mono text-text-muted">{r.ip ?? "—"}</td>
                  <td className="max-w-xs truncate font-mono text-[10px] text-text-muted" title={r.meta ?? ""}>{r.meta ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type LoginAttempt = {
  id: number;
  ip: string;
  username: string | null;
  ok: number;
  reason: string | null;
  ua: string | null;
  created_at: number;
};

function LoginAttemptsSection() {
  const [onlyFails, setOnlyFails] = useState(true);
  const [ip, setIp] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "login-attempts", onlyFails, ip],
    queryFn: () => API.get<{ rows: LoginAttempt[]; topFails: { ip: string; fails: number }[] }>(
      `/admin/login-attempts?limit=200${onlyFails ? "&onlyFails=1" : ""}${ip ? `&ip=${encodeURIComponent(ip)}` : ""}`,
    ),
    refetchInterval: 15000,
  });
  return (
    <section className="card p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <LogIn size={16} className="text-accent" />
        <h2 className="font-semibold">Login attempts</h2>
        <label className="ml-4 flex items-center gap-1.5 text-xs text-text-muted">
          <input type="checkbox" checked={onlyFails} onChange={(e) => setOnlyFails(e.target.checked)} />
          Failures only
        </label>
        <input
          className="input ml-auto h-8 w-44 text-xs"
          placeholder="filter IP…"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
        />
      </div>
      {data?.topFails && data.topFails.length > 0 && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3">
          <div className="mb-1 text-xs font-semibold text-warning">Top failed-login IPs (24h)</div>
          <div className="flex flex-wrap gap-2 text-xs">
            {data.topFails.map((t) => (
              <span key={t.ip} className="rounded-full bg-bg-hover px-2 py-0.5 font-mono">
                {t.ip} <span className="text-warning">×{t.fails}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {isLoading ? (
        <div className="flex items-center gap-2 text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : !data?.rows.length ? (
        <div className="text-sm text-text-muted">No attempts.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left uppercase tracking-wide text-text-muted">
              <tr>
                <th className="py-2">When</th>
                <th>Result</th>
                <th>IP</th>
                <th>Username</th>
                <th>Reason</th>
                <th>UA</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-bg-border">
                  <td className="py-2 text-text-muted">{new Date(r.created_at).toLocaleString()}</td>
                  <td>
                    {r.ok ? (
                      <span className="rounded-full bg-success/15 px-2 py-0.5 font-semibold text-success">OK</span>
                    ) : (
                      <span className="rounded-full bg-danger/15 px-2 py-0.5 font-semibold text-danger">FAIL</span>
                    )}
                  </td>
                  <td className="font-mono">{r.ip}</td>
                  <td>{r.username ?? <span className="text-text-muted">—</span>}</td>
                  <td className="text-text-muted">{r.reason ?? "—"}</td>
                  <td className="max-w-xs truncate font-mono text-[10px] text-text-muted" title={r.ua ?? ""}>{r.ua ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AIKeysSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "ai-keys"],
    queryFn: () => API.get<{ keys: AIKeyRow[]; encryptionWeak: boolean }>("/admin/ai-keys"),
  });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  return (
    <div className="space-y-2">
      {data?.encryptionWeak && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Warning: JWT_SECRET uses a default/weak value. AI keys stored in the DB can be decrypted by anyone with the database file. Set a strong JWT_SECRET (32+ random chars) in your environment and restart the server.
        </div>
      )}
      {data?.keys.map((k) => (
        <AIKeyRowEditor
          key={k.provider}
          row={k}
          onSaved={() => qc.invalidateQueries({ queryKey: ["admin", "ai-keys"] })}
        />
      ))}
    </div>
  );
}

function AIKeyRowEditor({ row, onSaved }: { row: AIKeyRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await API.put("/admin/ai-keys", { provider: row.provider, value });
      setValue("");
      setEditing(false);
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    setBusy(true);
    setErr("");
    try {
      await API.put("/admin/ai-keys", { provider: row.provider, value: "" });
      setValue("");
      setEditing(false);
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-bg-border bg-bg-subtle/40 p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-[120px] font-medium">{PROVIDER_LABEL[row.provider]}</div>
        <div className="flex-1 font-mono text-xs text-text-muted">
          {row.configured ? row.masked : <span className="italic">not set</span>}
        </div>
        {row.keyCount > 1 && (
          <span
            className="rounded-full bg-info/15 px-2 py-0.5 text-[10px] uppercase text-info"
            title={`Failover chain — ${row.keyCount} keys. AI will try Key #1 first; on rate-limit / 401, automatically rotate to #2, #3, etc.`}
          >
            {row.keyCount} keys
          </span>
        )}
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
            row.source === "db"
              ? "bg-success/15 text-success"
              : row.source === "env"
              ? "bg-warning/15 text-warning"
              : "bg-bg-hover text-text-muted"
          }`}
        >
          {row.source}
        </span>
        {!editing && (
          <button className="btn-secondary text-xs" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {row.keyCount > 1 && !editing && (
        <div className="mt-2 ml-[132px] space-y-0.5 font-mono text-[10px] text-text-muted">
          {row.maskedAll.map((m, i) => (
            <div key={i}>
              <span className="opacity-60">Key #{i + 1}:</span> {m}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <div className="mt-3 space-y-2">
          {/* Docs link + key format hint */}
          {PROVIDER_DOCS[row.provider] && (
            <div className="flex items-center justify-between rounded border border-bg-border bg-bg-subtle px-3 py-2 text-[11px]">
              <div className="flex items-center gap-2 text-text-muted">
                <BookOpen size={11} />
                <span>Format key: <code className="rounded bg-bg-hover px-1 font-mono">{PROVIDER_DOCS[row.provider].keyHint}</code></span>
              </div>
              <a
                href={PROVIDER_DOCS[row.provider].url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-accent hover:underline"
              >
                Buka dashboard API key
                <ExternalLink size={10} />
              </a>
            </div>
          )}
          <div className="flex gap-2">
            <input
              type={show ? "text" : "password"}
              className="input flex-1 font-mono text-sm"
              placeholder={`Paste ${PROVIDER_LABEL[row.provider]} API key — pisahkan dengan koma untuk failover (apikey1,apikey2,apikey3)`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShow((s) => !s)}
              title={show ? "Hide" : "Show"}
            >
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="text-[11px] text-text-muted">
            <span className="font-medium">Multi-key failover:</span> tempel beberapa API key dipisah <code className="rounded bg-bg-hover px-1 font-mono">,</code> (atau <code className="rounded bg-bg-hover px-1 font-mono">;</code> / newline). AI coba Key #1 dulu; kalau kena rate-limit (429) atau auth error (401/403), otomatis rotate ke Key #2, #3, dst. Hemat saat free-tier kuota habis.
          </div>
          {err && <div className="text-xs text-danger">{err}</div>}
          <div className="flex gap-2">
            <button
              className="btn-primary text-xs"
              disabled={busy || !value}
              onClick={save}
            >
              <Save size={12} /> Save
            </button>
            <button
              className="btn-ghost text-xs text-danger"
              disabled={busy}
              onClick={clearKey}
            >
              <Trash2 size={12} /> Remove
            </button>
            <button
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={() => { setEditing(false); setValue(""); setErr(""); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, sub }: any) {
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-text-muted">
        {icon} {label}
      </div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-1 text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

function AddUserModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    username: "",
    email: "",
    password: "",
    role: "user",
    quotaCpu: 1,
    quotaMemMb: 2048,
    quotaDiskMb: 10240,
    maxWorkspaces: 3,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await API.post("/admin/users", form);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      onClose();
    } catch (e: any) {
      setErr(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form className="card w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="mb-4 text-lg font-semibold">Add user</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Username</label>
            <input className="input" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label">Email</label>
            <input type="email" className="input" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label">Password</label>
            <input type="password" className="input" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div>
            <label className="label">Max workspaces</label>
            <input type="number" min={1} className="input" value={form.maxWorkspaces} onChange={(e) => setForm({ ...form, maxWorkspaces: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">CPU cores</label>
            <input type="number" min={0.25} step={0.25} className="input" value={form.quotaCpu} onChange={(e) => setForm({ ...form, quotaCpu: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">RAM (MB)</label>
            <input type="number" min={128} className="input" value={form.quotaMemMb} onChange={(e) => setForm({ ...form, quotaMemMb: Number(e.target.value) })} />
          </div>
          <div className="col-span-2">
            <label className="label">Disk (MB)</label>
            <input type="number" min={512} className="input" value={form.quotaDiskMb} onChange={(e) => setForm({ ...form, quotaDiskMb: Number(e.target.value) })} />
          </div>
        </div>
        {err && <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</div>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create
          </button>
        </div>
      </form>
    </div>
  );
}

// ===========================================================================
// BackupSection — /admin → Backup tab.
//
// Lists snapshots in R2, lets the operator trigger a backup, refresh the
// index, or restore a snapshot. All long-running operations execute on the
// HOST (the API container has no docker/mysql/rclone), so we use a "trigger
// file" bridge: API drops a file in /var/lib/premdev/triggers/, a host cron
// picks it up, writes a result file, we poll for it.
//
// Restore is destructive — guarded by a typed-confirmation modal that
// requires the operator to type the snapshot path verbatim.
// ===========================================================================
type Snapshot = {
  prefix: "daily" | "weekly";
  name: string;
  path: string;
  modTime: string;
  sizeBytes: number;
  fileCount: number;
};
type BackupJob = {
  action: "backup" | "restore" | "refresh-index" | "refresh" | "delete";
  jobId: string;
  state: "queued" | "running" | "done";
  status?: "ok" | "error";
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  durationSec?: number;
  output?: string;
};
type BackupIndex = {
  configured: boolean;
  snapshots: Snapshot[];
  updatedAt?: number;
  jobs?: BackupJob[];
  reason?: string;
  errors?: string[];
  favorites?: string[];
};
type BackupWorkspace = { id: string; name: string; username: string };

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function snapTime(name: string): string {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return "—";
  const [, y, mo, d, h, min, s] = m;
  return `${y}-${mo}-${d} ${h}:${min}:${s}`;
}

function BackupSection() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [restoreTarget, setRestoreTarget] = useState<Snapshot | null>(null);
  const [showWsSelector, setShowWsSelector] = useState(false);

  const { data, isLoading } = useQuery<BackupIndex>({
    queryKey: ["admin", "backups"],
    queryFn: () => API.get<BackupIndex>("/admin/backups"),
    refetchInterval: (q) => {
      const d = q.state.data;
      const live = d?.jobs?.some((j) => j.state === "queued" || j.state === "running");
      return live ? 3000 : 30000;
    },
  });
  // Load persistent workspace selection (always, not just when panel is open).
  const { data: wsSpecData, refetch: refetchWsSpec } = useQuery<{ workspaceIds: string[] }>({
    queryKey: ["admin", "backups", "ws-spec"],
    queryFn: () => API.get<{ workspaceIds: string[] }>("/admin/backups/ws-spec"),
  });
  const { data: wsListData } = useQuery<{ workspaces: BackupWorkspace[] }>({
    queryKey: ["admin", "backups", "workspaces"],
    queryFn: () => API.get<{ workspaces: BackupWorkspace[] }>("/admin/backups/workspaces"),
    enabled: showWsSelector,
  });

  const savedIds = new Set<string>(wsSpecData?.workspaceIds ?? []);

  const saveWsSpec = useMutation({
    mutationFn: (ids: string[]) => API.post("/admin/backups/ws-spec", { workspaceIds: ids }),
    onSuccess: () => { refetchWsSpec(); },
  });
  const runBackup = useMutation({
    mutationFn: () => API.post("/admin/backups/run", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "backups"] }),
  });
  const refreshIdx = useMutation({
    mutationFn: () => API.post("/admin/backups/refresh", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "backups"] }),
  });
  const deleteSnap = useMutation({
    mutationFn: (s: Snapshot) => API.delete(`/admin/backups/${s.prefix}/${s.name}`),
    onSuccess: () => { setTimeout(() => qc.invalidateQueries({ queryKey: ["admin", "backups"] }), 3000); },
  });
  const toggleFav = useMutation({
    mutationFn: (s: Snapshot) => {
      const isFav = data?.favorites?.includes(s.path);
      return isFav
        ? API.delete(`/admin/backups/favorites/${s.prefix}/${s.name}`)
        : API.post("/admin/backups/favorites", { snapshot: s.path });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "backups"] }),
  });

  function toggleWs(id: string) {
    const next = new Set(savedIds);
    next.has(id) ? next.delete(id) : next.add(id);
    saveWsSpec.mutate([...next]);
  }

  async function handleDelete(s: Snapshot) {
    const ok = await confirm(`Hapus snapshot ${s.path} dari R2? Tidak bisa dibatalkan.`);
    if (ok) deleteSnap.mutate(s);
  }

  if (isLoading) {
    return <section className="card p-6"><Loader2 className="animate-spin inline mr-2" size={14} />Loading backups…</section>;
  }

  const snaps = data?.snapshots ?? [];
  const jobs = data?.jobs ?? [];
  const favorites = data?.favorites ?? [];
  const favSnaps = snaps.filter((s) => favorites.includes(s.path));
  const daily  = snaps.filter((s) => s.prefix === "daily" && !favorites.includes(s.path));
  const weekly = snaps.filter((s) => s.prefix === "weekly" && !favorites.includes(s.path));
  const allWs  = wsListData?.workspaces ?? [];

  return (
    <>
      <section className="card p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold flex items-center gap-2"><Cloud size={16} /> R2 Backups</h2>
            <p className="text-xs text-text-muted mt-1">
              Snapshots dari <code>backup.sh</code> di host. Index{" "}
              {data?.updatedAt ? <>diupdate <strong>{fmtAgo(data.updatedAt * 1000)}</strong></> : "belum ada"}.
              Retensi: <strong>7 daily</strong> + <strong>4 weekly</strong> (favorit tidak dihapus).
              {savedIds.size > 0 && <> · Backup rutin: <strong>{savedIds.size} workspace terpilih</strong>.</>}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn-secondary" disabled={refreshIdx.isPending} onClick={() => refreshIdx.mutate()}>
              {refreshIdx.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
            <button
              className={`btn-secondary ${savedIds.size > 0 ? "border-accent/40 text-accent" : ""}`}
              onClick={() => setShowWsSelector((v) => !v)}
              title="Pilih workspace tertentu untuk dibackup setiap hari"
            >
              <Folder size={14} />
              {savedIds.size > 0 ? `${savedIds.size} workspace` : "Pilih workspace"}
            </button>
            <button
              className="btn-primary"
              disabled={runBackup.isPending || !data?.configured}
              onClick={() => runBackup.mutate()}
              title={data?.configured
                ? savedIds.size > 0 ? `Backup ${savedIds.size} workspace terpilih sekarang` : "Backup semua workspace sekarang"
                : "R2 belum dikonfigurasi"}
            >
              {runBackup.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Run backup now
            </button>
          </div>
        </div>

        {/* Workspace selector — persistent, auto-saved on every checkbox change */}
        {showWsSelector && (
          <div className="mb-4 rounded border border-bg-border bg-bg-soft p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium">
                Workspace yang akan dibackup setiap hari:
                {saveWsSpec.isPending && <span className="ml-2 text-text-muted italic">menyimpan…</span>}
              </span>
              <div className="flex gap-2">
                <button className="text-xs text-accent hover:underline" onClick={() => saveWsSpec.mutate(allWs.map((w) => w.id))}>Pilih semua</button>
                <button className="text-xs text-text-muted hover:underline" onClick={() => saveWsSpec.mutate([])}>Backup semua (hapus filter)</button>
              </div>
            </div>
            {allWs.length === 0 ? (
              <p className="text-xs text-text-muted italic">Loading…</p>
            ) : (
              <div className="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto">
                {allWs.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-bg-hover rounded p-1">
                    <input
                      type="checkbox"
                      checked={savedIds.has(w.id)}
                      onChange={() => toggleWs(w.id)}
                    />
                    <span className="font-mono truncate">{w.name}</span>
                    <span className="text-text-muted">({w.username})</span>
                  </label>
                ))}
              </div>
            )}
            {savedIds.size === 0 ? (
              <p className="mt-2 text-xs text-text-muted">Tidak ada filter — backup harian mencakup <strong>semua</strong> workspace.</p>
            ) : (
              <p className="mt-2 text-xs text-green-400">✓ Tersimpan — backup harian & manual hanya akan backup {savedIds.size} workspace terpilih.</p>
            )}
          </div>
        )}

        {!data?.configured && (
          <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <strong>R2 belum dikonfigurasi.</strong> {data?.reason ?? "Set R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY di /etc/premdev/backup.env di host."}
          </div>
        )}
        {!!data?.errors?.length && (
          <div className="mb-4 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
            <strong>Index errors:</strong>
            <ul className="mt-1 list-disc pl-5">{data.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}

        {favSnaps.length > 0 && (
          <SnapshotTable
            title={`⭐ Favorit (${favSnaps.length}) — tidak akan dihapus otomatis`}
            rows={favSnaps}
            favorites={favorites}
            onRestore={setRestoreTarget}
            onDelete={handleDelete}
            onToggleFav={(s) => toggleFav.mutate(s)}
          />
        )}
        <SnapshotTable
          title={`Daily (${daily.length}/7)`}
          rows={daily}
          favorites={favorites}
          onRestore={setRestoreTarget}
          onDelete={handleDelete}
          onToggleFav={(s) => toggleFav.mutate(s)}
        />
        <SnapshotTable
          title={`Weekly (${weekly.length}/4)`}
          rows={weekly}
          favorites={favorites}
          onRestore={setRestoreTarget}
          onDelete={handleDelete}
          onToggleFav={(s) => toggleFav.mutate(s)}
        />
      </section>

      <SystemMaintenanceSection />

      <section className="card p-6 mt-4">
        <h3 className="font-semibold flex items-center gap-2 mb-3"><ScrollText size={14} /> Recent jobs</h3>
        {jobs.length === 0 ? (
          <p className="text-xs text-text-muted">Belum ada backup/restore jobs.</p>
        ) : (
          <div className="space-y-2">{jobs.map((j) => <JobRow key={j.jobId} job={j} />)}</div>
        )}
      </section>

      {restoreTarget && (
        <RestoreModal
          snapshot={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onDone={() => { setRestoreTarget(null); qc.invalidateQueries({ queryKey: ["admin", "backups"] }); }}
        />
      )}
      {dialog}
    </>
  );
}

function SnapshotTable({ title, rows, favorites, onRestore, onDelete, onToggleFav }: {
  title: string;
  rows: Snapshot[];
  favorites: string[];
  onRestore: (s: Snapshot) => void;
  onDelete: (s: Snapshot) => void;
  onToggleFav: (s: Snapshot) => void;
}) {
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-2 text-xs uppercase tracking-wide text-text-muted">{title}</div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted italic">— none —</p>
      ) : (
        <div className="overflow-x-auto rounded border border-bg-border">
          <table className="w-full text-xs">
            <thead className="bg-bg-soft text-text-muted">
              <tr>
                <th className="w-6 p-2"></th>
                <th className="text-left p-2">Snapshot</th>
                <th className="text-left p-2">Waktu</th>
                <th className="text-right p-2">Size</th>
                <th className="text-right p-2">Files</th>
                <th className="text-right p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const isFav = favorites.includes(s.path);
                return (
                  <tr key={s.path} className={`border-t border-bg-border ${isFav ? "bg-amber-500/5" : ""}`}>
                    <td className="p-2">
                      <button
                        onClick={() => onToggleFav(s)}
                        title={isFav ? "Hapus dari favorit" : "Tandai favorit — tidak akan dihapus otomatis"}
                        className={`hover:scale-110 transition-transform ${isFav ? "text-amber-400" : "text-text-muted hover:text-amber-400"}`}
                      >
                        <Star size={12} fill={isFav ? "currentColor" : "none"} />
                      </button>
                    </td>
                    <td className="p-2 font-mono">{s.path}</td>
                    <td className="p-2">{snapTime(s.name)}</td>
                    <td className="p-2 text-right">{fmtBytes(s.sizeBytes)}</td>
                    <td className="p-2 text-right">{s.fileCount}</td>
                    <td className="p-2 text-right flex justify-end gap-1">
                      <button
                        className="btn-secondary !py-1 !px-2 text-rose-300 hover:!bg-rose-500/10"
                        onClick={() => onRestore(s)}
                        title="Restore snapshot ini — DESTRUCTIVE"
                      >
                        <Download size={12} /> Restore
                      </button>
                      <button
                        className="btn-secondary !py-1 !px-2 text-text-muted hover:!bg-rose-500/10 hover:text-rose-300"
                        onClick={() => onDelete(s)}
                        title="Hapus snapshot dari R2"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// System maintenance — manual Docker cleanup trigger. Daily cron on the host
// runs the same script automatically; this button lets the admin force a run
// (e.g. when /admin shows disk pressure on the topbar gauge).
function SystemMaintenanceSection() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const cleanup = useMutation({
    mutationFn: () => API.post<{ ok: boolean; jobId: string }>("/admin/system/cleanup", {}),
    onSettled: () => {
      // Refresh the backups query so the new job shows up in "Recent jobs".
      qc.invalidateQueries({ queryKey: ["admin", "backups"] });
    },
  });
  return (
    <section className="card p-6 mt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <Sparkles size={16} /> System maintenance
          </h3>
          <p className="text-xs text-text-muted mt-1">
            Bersihin Docker images, build cache, container mati, dan volume nganggur.
            Cron harian jam 03:00 WIB juga otomatis menjalankan ini.
            Container PremDev yang aktif tidak terganggu.
          </p>
        </div>
        <button
          className="btn-primary"
          disabled={cleanup.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: "Bersihkan Docker sekarang?",
              message:
                "Akan menghapus image yang tidak dipakai, build cache, dan volume nganggur. Container yang sedang jalan tetap aman. Hasil muncul di 'Recent jobs' di bawah.",
              confirmLabel: "Bersihkan",
            });
            if (ok) cleanup.mutate();
          }}
          title="Run /usr/local/sbin/premdev-docker-cleanup on the host now"
        >
          {cleanup.isPending
            ? <Loader2 size={14} className="animate-spin" />
            : <Trash2 size={14} />}
          Clear Docker cache
        </button>
      </div>
      {cleanup.isSuccess && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200">
          Cleanup queued (job <code>{cleanup.data?.jobId}</code>). Hasil ada di Recent jobs di bawah.
        </div>
      )}
      {cleanup.isError && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
          {(cleanup.error as any)?.message ?? "Cleanup failed to queue"}
        </div>
      )}
      {dialog}
    </section>
  );
}

function JobRow({ job }: { job: BackupJob }) {
  const colour = job.state === "done"
    ? (job.status === "ok" ? "text-emerald-400" : "text-rose-400")
    : "text-amber-300";
  return (
    <details className="rounded border border-bg-border bg-bg-soft text-xs">
      <summary className="cursor-pointer p-2 flex items-center gap-2">
        <span className={`font-mono ${colour}`}>
          {job.state === "running" && <Loader2 size={12} className="inline animate-spin mr-1" />}
          {job.action}
        </span>
        <span className="text-text-muted">#{job.jobId}</span>
        <span className="ml-auto text-text-muted">
          {job.state === "done"
            ? `${job.status} · ${job.durationSec ?? 0}s · ${job.finishedAt ? fmtAgo(job.finishedAt * 1000) : ""}`
            : job.state}
        </span>
      </summary>
      {job.output && (
        <pre className="px-3 pb-3 text-[11px] whitespace-pre-wrap text-text-muted max-h-60 overflow-auto">
          {job.output}
        </pre>
      )}
    </details>
  );
}

function RestoreModal({ snapshot, onClose, onDone }: {
  snapshot: Snapshot; onClose: () => void; onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: () => API.post("/admin/backups/restore", { snapshot: snapshot.path, confirm: typed }),
    onSuccess: onDone,
    onError: (e: any) => setErr(e?.message ?? "Restore failed"),
  });
  const matches = typed === snapshot.path;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="card w-full max-w-lg p-5">
        <div className="mb-3 flex items-center gap-2 text-rose-300">
          <AlertTriangle size={18} />
          <h3 className="font-semibold">Restore snapshot — DESTRUCTIVE</h3>
        </div>
        <p className="text-sm text-text-muted">
          This will <strong>stop the app</strong>, replace the SQLite database,
          drop & re-import all MySQL databases, and overwrite{" "}
          <code>workspaces/</code> with the snapshot contents.
          A pre-restore safety dump is written to{" "}
          <code className="text-xs">/var/backups/premdev-pre-restore-…</code> on
          the host.
        </p>
        <div className="my-4 rounded border border-bg-border bg-bg-soft p-3 text-xs">
          <div><strong>Snapshot:</strong> <span className="font-mono">{snapshot.path}</span></div>
          <div><strong>Size:</strong> {fmtBytes(snapshot.sizeBytes)} ({snapshot.fileCount} files)</div>
          <div><strong>Created:</strong> {snapTime(snapshot.name)}</div>
        </div>
        <label className="block text-xs">
          To confirm, type the snapshot path exactly:{" "}
          <code className="text-rose-300">{snapshot.path}</code>
          <input
            autoFocus
            className="input mt-1 w-full font-mono"
            value={typed}
            onChange={(e) => { setTyped(e.target.value); setErr(null); }}
            placeholder={snapshot.path}
          />
        </label>
        {err && <div className="mt-2 text-xs text-rose-300">{err}</div>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={restore.isPending}>Cancel</button>
          <button
            className="btn-primary !bg-rose-500 hover:!bg-rose-600"
            disabled={!matches || restore.isPending}
            onClick={() => restore.mutate()}
          >
            {restore.isPending && <Loader2 size={14} className="animate-spin" />}
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SemanticSearchSection — admin tab for the lumen-style code search feature.
//
// Shows: model load status, RAM, totals across workspaces, and a per-workspace
// table with manual reindex / clear controls. Polls /admin/semantic-search/status
// every 5s so "loading" → "ready" transitions are visible without refresh.
// ---------------------------------------------------------------------------

type EmbeddingStatus = {
  enabled: boolean;
  status: "idle" | "loading" | "ready" | "error";
  model: string;
  dim: number;
  loadedAt: number | null;
  error: string | null;
  rssBytes: number | null;
};

type WorkspaceIndexRow = {
  id: string;
  name: string;
  username: string | null;
  exists: boolean;
  chunks: number;
  files: number;
  lastIndexedMs: number | null;
  dbBytes: number;
};

type SemanticStatusResponse = {
  model: EmbeddingStatus;
  workspaces: WorkspaceIndexRow[];
  totals: { chunks: number; files: number; dbBytes: number; indexed: number; totalWorkspaces: number };
};

function SemanticSearchSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "semantic-search"],
    queryFn: () => API.get<SemanticStatusResponse>("/admin/semantic-search/status"),
    // 3s poll while loading is fast enough to feel responsive but not
    // hammer the API; bump to 10s once ready (status rarely changes).
    refetchInterval: (q) => (q.state.data?.model.status === "loading" ? 3000 : 10000),
  });

  const preload = useMutation({
    mutationFn: () => API.post("/admin/semantic-search/preload", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "semantic-search"] }),
  });

  const reindex = useMutation({
    mutationFn: (workspaceId: string) =>
      API.post<{ ok: boolean; scanned: number; indexed: number; reused: number; chunks: number; durationMs: number }>(
        `/admin/semantic-search/reindex/${workspaceId}`, {}
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "semantic-search"] }),
  });

  const clearIndex = useMutation({
    mutationFn: (workspaceId: string) => API.delete(`/admin/semantic-search/index/${workspaceId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "semantic-search"] }),
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading semantic search status…
      </div>
    );
  }

  const { model, workspaces, totals } = data;

  // Status pill — colour by state.
  const statusPill = (() => {
    if (!model.enabled) return { label: "DISABLED", cls: "bg-bg-subtle text-text-muted border-bg-border" };
    if (model.status === "ready") return { label: "READY", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" };
    if (model.status === "loading") return { label: "LOADING", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" };
    if (model.status === "error") return { label: "ERROR", cls: "bg-rose-500/15 text-rose-300 border-rose-500/40" };
    return { label: "IDLE", cls: "bg-bg-subtle text-text-muted border-bg-border" };
  })();

  return (
    <div className="space-y-4">
      {/* Header card: model state + global totals */}
      <section className="card p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 font-semibold">
              <Sparkles size={16} /> AI semantic search
              <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusPill.cls}`}>
                {statusPill.label}
              </span>
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              Index lokal kode user pakai embedding model untuk kurangin token AI sampai ~70%. Otomatis index pas user
              chat pertama kali di workspace; di-re-index kalau file mtime berubah.
            </p>
          </div>
          {model.enabled && model.status !== "ready" && model.status !== "loading" && (
            <button
              className="btn-secondary"
              onClick={() => preload.mutate()}
              disabled={preload.isPending}
              title="Load model sekarang biar chat pertama gak nunggu ~30s download"
            >
              {preload.isPending ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              Preload model
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs lg:grid-cols-4">
          <SemStat label="Model" value={model.model.split("/").pop() || model.model} sub={`${model.dim}-dim`} />
          <SemStat
            label="API process RAM"
            value={model.rssBytes ? `${(model.rssBytes / (1024 * 1024)).toFixed(0)} MB` : "—"}
            sub={model.loadedAt ? `model loaded ${fmtAgo(model.loadedAt)}` : "model not loaded"}
          />
          <SemStat
            label="Workspaces indexed"
            value={`${totals.indexed} / ${totals.totalWorkspaces}`}
            sub={totals.totalWorkspaces ? `${Math.round((totals.indexed / totals.totalWorkspaces) * 100)}% covered` : "no workspaces"}
          />
          <SemStat
            label="Total chunks"
            value={totals.chunks.toLocaleString()}
            sub={`${totals.files.toLocaleString()} files · ${(totals.dbBytes / (1024 * 1024)).toFixed(1)} MB on disk`}
          />
        </div>

        {model.error && (
          <div className="mt-3 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
            <div className="flex items-center gap-1 font-semibold">
              <AlertTriangle size={12} /> Model error
            </div>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{model.error}</pre>
          </div>
        )}
      </section>

      {/* Per-workspace table */}
      <section className="card p-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Per-workspace index</h3>
          <button
            className="btn-secondary"
            onClick={() => qc.invalidateQueries({ queryKey: ["admin", "semantic-search"] })}
            title="Refresh stats"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {workspaces.length === 0 ? (
          <div className="text-sm text-text-muted">Belum ada workspace.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-text-muted">
                <tr className="border-b border-bg-border">
                  <th className="py-2 pr-3">User / Workspace</th>
                  <th className="py-2 pr-3">Files</th>
                  <th className="py-2 pr-3">Chunks</th>
                  <th className="py-2 pr-3">Size</th>
                  <th className="py-2 pr-3">Last indexed</th>
                  <th className="py-2 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w) => {
                  const isReindexing = reindex.isPending && reindex.variables === w.id;
                  const isClearing = clearIndex.isPending && clearIndex.variables === w.id;
                  return (
                    <tr key={w.id} className="border-b border-bg-border/50 last:border-0">
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1">
                          <span className="text-text-muted">{w.username || "?"}</span>
                          <span className="text-text-muted">/</span>
                          <span className="font-medium">{w.name}</span>
                        </div>
                        <div className="font-mono text-[10px] text-text-muted">{w.id}</div>
                      </td>
                      <td className="py-2 pr-3">{w.files || (w.exists ? <span className="text-text-muted">0</span> : <span className="text-text-muted">—</span>)}</td>
                      <td className="py-2 pr-3">{w.chunks || (w.exists ? <span className="text-text-muted">0</span> : <span className="text-text-muted">—</span>)}</td>
                      <td className="py-2 pr-3">
                        {w.dbBytes > 0
                          ? w.dbBytes < 1024
                            ? `${w.dbBytes} B`
                            : w.dbBytes < 1024 * 1024
                              ? `${(w.dbBytes / 1024).toFixed(0)} KB`
                              : `${(w.dbBytes / (1024 * 1024)).toFixed(1)} MB`
                          : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-text-muted">
                        {w.lastIndexedMs ? fmtAgo(w.lastIndexedMs) : <span className="italic">never</span>}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <div className="inline-flex gap-1">
                          <button
                            className="btn-secondary !px-2 !py-1 text-xs"
                            onClick={() => reindex.mutate(w.id)}
                            disabled={isReindexing || !model.enabled}
                            title="Scan files & rebuild stale chunks (gak ngulang yg mtime-nya sama)"
                          >
                            {isReindexing ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />}
                            {isReindexing ? "Indexing…" : "Reindex"}
                          </button>
                          {w.exists && (
                            <button
                              className="btn-secondary !px-2 !py-1 text-xs !text-rose-300"
                              onClick={() => clearIndex.mutate(w.id)}
                              disabled={isClearing}
                              title="Hapus index workspace ini sepenuhnya — chat berikutnya bakal trigger reindex full"
                            >
                              {isClearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                              Clear
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {reindex.isError && (
          <div className="mt-3 text-xs text-rose-300">
            Reindex gagal: {(reindex.error as any)?.message || "unknown error"}
          </div>
        )}
      </section>
    </div>
  );
}

function SemStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-bg-border bg-bg-subtle p-3">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-text-muted">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VFS Section — VPS Filesystem Browser
// ---------------------------------------------------------------------------

type VfsItem = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

type VfsListResponse = { path: string; items: VfsItem[] };
type VfsReadResponse = {
  path: string;
  size: number;
  binary: boolean;
  content: string | null;
  error?: string;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function VFSSection() {
  const [currentPath, setCurrentPath] = useState("/");
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>(["/"]);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);

  const listQ = useQuery<VfsListResponse>({
    queryKey: ["vfs", "list", currentPath],
    queryFn: () => API.get(`/vfs/list?path=${encodeURIComponent(currentPath)}`),
    retry: false,
  });

  function navigate(path: string) {
    setCurrentPath(path);
    // Rebuild breadcrumbs from path
    const parts = path.split("/").filter(Boolean);
    setBreadcrumbs(["/" , ...parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"))]);
    setOpenFile(null);
  }

  async function openFileAt(path: string) {
    setOpenFile(null);
    setEditContent("");
    setSaveError(null);
    setSaveOk(false);
    try {
      const res: VfsReadResponse = await API.get(`/vfs/read?path=${encodeURIComponent(path)}`);
      if (res.binary) {
        setOpenFile({ path, content: "[Binary file — tidak bisa diedit di browser]" });
        setEditContent("[Binary file — tidak bisa diedit di browser]");
      } else if (res.error) {
        setOpenFile({ path, content: `[Error: ${res.error}]` });
        setEditContent(`[Error: ${res.error}]`);
      } else {
        setOpenFile({ path, content: res.content ?? "" });
        setEditContent(res.content ?? "");
      }
    } catch (e: any) {
      setOpenFile({ path, content: `[Error membaca file: ${e.message}]` });
      setEditContent(`[Error membaca file: ${e.message}]`);
    }
  }

  async function saveFile() {
    if (!openFile) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      await API.post("/vfs/write", { path: openFile.path, content: editContent });
      setSaveOk(true);
      setOpenFile({ ...openFile, content: editContent });
      setTimeout(() => setSaveOk(false), 3000);
    } catch (e: any) {
      setSaveError(e.message ?? "Gagal menyimpan");
    } finally {
      setSaving(false);
    }
  }

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setCreatingFolder(true);
    try {
      const newPath = currentPath.replace(/\/$/, "") + "/" + name;
      await API.post("/vfs/mkdir", { path: newPath });
      setNewFolderName("");
      setShowNewFolder(false);
      listQ.refetch();
    } catch (e: any) {
      alert(`Gagal buat folder: ${e.message}`);
    } finally {
      setCreatingFolder(false);
    }
  }

  const isBinaryOrError =
    openFile &&
    (openFile.content?.startsWith("[Binary") || openFile.content?.startsWith("[Error"));

  // Breadcrumb labels: "/" = Home, others = folder name
  const breadcrumbLabels = breadcrumbs.map((p, i) =>
    i === 0 ? "/" : p.split("/").filter(Boolean).pop() ?? p,
  );

  return (
    <div className="space-y-4">
      {/* Warning banner */}
      <div className="flex items-start gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>
          <strong>⚠ Akses langsung ke filesystem VPS.</strong> Hati-hati saat mengedit file sistem
          — salah edit <code>/etc</code> bisa bikin VPS tidak bisa boot.
          <br />
          <span className="text-rose-400/80 text-xs mt-1 block">
            Fitur ini butuh volume mount di docker-compose.yml:{" "}
            <code className="bg-rose-900/30 px-1 rounded">- /:/vpsroot:rw</code> pada service{" "}
            <code className="bg-rose-900/30 px-1 rounded">app</code>.
          </span>
        </span>
      </div>

      <section className="card p-0 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b border-bg-border px-4 py-2">
          <button
            className="btn-ghost !p-1"
            onClick={() => navigate("/")}
            title="Root"
          >
            <Home size={14} />
          </button>
          {/* Breadcrumbs */}
          <div className="flex items-center gap-0.5 text-sm overflow-x-auto flex-1">
            {breadcrumbs.map((p, i) => (
              <span key={p} className="flex items-center gap-0.5 shrink-0">
                {i > 0 && <ChevronRight size={12} className="text-text-muted" />}
                <button
                  className={`rounded px-1 py-0.5 hover:bg-bg-hover ${i === breadcrumbs.length - 1 ? "font-medium" : "text-text-muted"}`}
                  onClick={() => navigate(p)}
                >
                  {breadcrumbLabels[i]}
                </button>
              </span>
            ))}
          </div>
          <button
            className="btn-ghost !p-1 shrink-0"
            onClick={() => listQ.refetch()}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="btn-ghost !p-1 shrink-0"
            onClick={() => setShowNewFolder(!showNewFolder)}
            title="Buat folder baru"
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {/* New folder input */}
        {showNewFolder && (
          <div className="flex items-center gap-2 border-b border-bg-border px-4 py-2 bg-bg-subtle">
            <FolderPlus size={14} className="text-text-muted shrink-0" />
            <input
              className="input flex-1 text-sm !py-1"
              placeholder="Nama folder baru…"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
              autoFocus
            />
            <button className="btn-primary !py-1 !px-3 text-xs" onClick={createFolder} disabled={creatingFolder}>
              {creatingFolder ? <Loader2 size={12} className="animate-spin" /> : "Buat"}
            </button>
            <button className="btn-ghost !p-1" onClick={() => setShowNewFolder(false)}><X size={14} /></button>
          </div>
        )}

        <div className="flex divide-x divide-bg-border" style={{ minHeight: "420px" }}>
          {/* File list panel */}
          <div className="w-80 shrink-0 overflow-y-auto">
            {listQ.isLoading && (
              <div className="flex items-center gap-2 p-4 text-text-muted text-sm">
                <Loader2 size={14} className="animate-spin" /> Memuat…
              </div>
            )}
            {listQ.isError && (
              <div className="p-4 text-sm text-rose-300">
                {(listQ.error as any)?.message ?? "Gagal memuat direktori"}
              </div>
            )}
            {listQ.data?.items.length === 0 && (
              <div className="p-4 text-sm text-text-muted italic">Directory kosong</div>
            )}
            {listQ.data?.items.map((item) => (
              <button
                key={item.path}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-hover text-left ${openFile?.path === item.path ? "bg-bg-hover" : ""}`}
                onClick={() => {
                  if (item.type === "dir") {
                    navigate(item.path);
                  } else {
                    openFileAt(item.path);
                  }
                }}
              >
                {item.type === "dir" ? (
                  <Folder size={14} className="shrink-0 text-accent" />
                ) : (
                  <FileText size={14} className="shrink-0 text-text-muted" />
                )}
                <span className="flex-1 truncate">{item.name}</span>
                {item.type === "file" && (
                  <span className="text-[10px] text-text-muted shrink-0">{fmtSize(item.size)}</span>
                )}
                {item.type === "dir" && (
                  <ChevronRight size={12} className="shrink-0 text-text-muted" />
                )}
              </button>
            ))}
          </div>

          {/* Editor panel */}
          <div className="flex-1 flex flex-col">
            {!openFile && (
              <div className="flex flex-1 items-center justify-center text-text-muted text-sm">
                <div className="text-center">
                  <FilePen size={32} className="mx-auto mb-2 opacity-30" />
                  Pilih file untuk diedit
                </div>
              </div>
            )}
            {openFile && (
              <>
                {/* File header */}
                <div className="flex items-center gap-2 border-b border-bg-border px-4 py-2 text-sm">
                  <FileText size={14} className="shrink-0 text-text-muted" />
                  <span className="flex-1 font-mono text-xs truncate">{openFile.path}</span>
                  {!isBinaryOrError && (
                    <button
                      className="btn-primary !py-1 !px-3 text-xs"
                      onClick={saveFile}
                      disabled={saving}
                    >
                      {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                      {saving ? "Menyimpan…" : "Simpan"}
                    </button>
                  )}
                </div>
                {saveError && (
                  <div className="px-4 py-1.5 text-xs text-rose-300 border-b border-bg-border bg-rose-500/10">
                    ✖ {saveError}
                  </div>
                )}
                {saveOk && (
                  <div className="px-4 py-1.5 text-xs text-emerald-400 border-b border-bg-border bg-emerald-500/10">
                    ✔ File berhasil disimpan
                  </div>
                )}
                <textarea
                  className="flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed outline-none"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  readOnly={!!isBinaryOrError}
                  spellCheck={false}
                />
              </>
            )}
          </div>
        </div>
      </section>

      {/* Bookmarks */}
      <section className="card p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Shortcut path yang sering dipakai
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            "/opt/premdev/.env",
            "/opt/premdev/docker-compose.yml",
            "/etc/caddy/Caddyfile",
            "/opt/premdev/infra/Caddyfile.tmpl",
            "/etc/hostname",
            "/etc/hosts",
          ].map((p) => (
            <button
              key={p}
              className="btn-secondary !py-1 !px-2 text-xs font-mono"
              onClick={() => openFileAt(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AIRuntimeSettingsSection — admin tab to tune token budgets and rate limiters
// without restarting the server. Settings are persisted to SQLite.
// ---------------------------------------------------------------------------

type RtSettings = Record<string, number>;
type RtResponse = { settings: RtSettings; defaults: RtSettings };

type SettingField = { key: string; label: string; hint: string; min: number; max: number; step: number; unlimitedAllowed?: boolean };

const BUDGET_FIELDS: SettingField[] = [
  { key: "ai.budget.maxHistoryChars",        label: "Max chars riwayat",           hint: "Total karakter riwayat chat yang dikirim ke AI setiap request (makin besar = lebih mahal)", min: 2000,  max: 80000, step: 1000 },
  { key: "ai.budget.maxHistoryMessages",     label: "Max pesan riwayat",           hint: "Maksimum jumlah pesan (user+assistant) yang masuk ke konteks AI",                           min: 4,     max: 100,   step: 1    },
  { key: "ai.budget.maxSingleMessageChars",  label: "Max chars per pesan",         hint: "Pesan lebih panjang dari ini dipotong head+tail — cegah 1 paste besar menghabiskan kuota",  min: 500,   max: 32000, step: 500  },
  { key: "ai.budget.maxTokensDefault",       label: "Max token output (normal)",   hint: "Batas token output AI per giliran di mode chat biasa. 0 = tidak dibatasi (model tentukan sendiri)", min: 512, max: 32768, step: 256, unlimitedAllowed: true },
  { key: "ai.budget.maxTokensAutopilot",     label: "Max token output (autopilot)",hint: "Batas token output AI per giliran di mode Otonom. 0 = tidak dibatasi",               min: 1024,  max: 65536, step: 512, unlimitedAllowed: true },
];

const RATE_FIELDS: SettingField[] = [
  { key: "ai.rate.aiCapacity",        label: "AI limiter — burst",         hint: "Request AI per IP sekaligus. 0 = tidak ada rate limit AI",             min: 1,  max: 500, step: 1, unlimitedAllowed: true },
  { key: "ai.rate.aiRefillPerSec",    label: "AI limiter — isi ulang/detik",hint: "Seberapa cepat token AI diisi ulang. 0.2 = 1 token per 5 detik. (Abaikan jika burst = 0)", min: 0.01, max: 10, step: 0.01 },
  { key: "ai.rate.apiCapacity",       label: "API limiter — burst",        hint: "Burst cap untuk semua endpoint /api/ non-AI. 0 = tidak ada rate limit",  min: 10, max: 2000, step: 10, unlimitedAllowed: true },
  { key: "ai.rate.apiRefillPerSec",   label: "API limiter — isi ulang/detik",hint: "Isi ulang token API per detik. 2 = 2 request/detik sustained",         min: 0.1, max: 100, step: 0.1 },
  { key: "ai.rate.loginCapacity",     label: "Login limiter — burst",      hint: "Maksimum percobaan login per IP (jangan di-unlimited — anti brute-force)", min: 1,  max: 100, step: 1   },
  { key: "ai.rate.loginRefillPerSec", label: "Login limiter — isi ulang/detik",hint: "0.1 = 1 percobaan per 10 detik (anti-brute-force)",                  min: 0.01, max: 5, step: 0.01 },
];

function AIRuntimeSettingsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "ai-runtime-settings"],
    queryFn: () => API.get<RtResponse>("/admin/ai-runtime-settings"),
  });

  const [draft, setDraft] = useState<RtSettings>({});
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  // Initialise draft when data first loads
  const settings = data?.settings ?? {};
  const defaults = data?.defaults ?? {};

  function get(key: string): number {
    return draft[key] ?? settings[key] ?? defaults[key] ?? 0;
  }

  function set(key: string, val: number) {
    setDraft((d) => ({ ...d, [key]: val }));
    setSaved(false);
    setErr("");
  }

  const saveMut = useMutation({
    mutationFn: () => API.put<{ ok: boolean; settings: RtSettings }>("/admin/ai-runtime-settings", draft),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["admin", "ai-runtime-settings"] });
      setDraft({});
      setSaved(true);
      setErr("");
    },
    onError: (e: any) => setErr(e.message ?? "Gagal menyimpan"),
  });

  function resetToDefaults() {
    setDraft(defaults);
    setSaved(false);
  }

  if (isLoading) {
    return <div className="flex items-center gap-2 text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>;
  }

  const hasDraft = Object.keys(draft).length > 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <section className="card p-6">
        <div className="mb-1 flex items-center gap-2">
          <Zap size={16} className="text-accent" />
          <h2 className="font-semibold">Pengaturan AI runtime</h2>
          <span className="ml-auto text-xs text-text-muted">Langsung berlaku tanpa restart server</span>
        </div>
        <p className="text-xs text-text-muted">
          Kontrol penggunaan token dan rate limiter. Perubahan disimpan ke database dan berlaku seketika — tidak perlu rebuild atau restart Docker.
        </p>
      </section>

      {/* Token budgets */}
      <section className="card p-6">
        <h3 className="mb-4 flex items-center gap-2 font-semibold text-sm">
          <Database size={14} className="text-accent" /> Token &amp; Riwayat Chat
        </h3>
        <div className="space-y-4">
          {BUDGET_FIELDS.map((f) => (
            <SettingRow
              key={f.key}
              field={f}
              value={get(f.key)}
              defaultValue={defaults[f.key]}
              onChange={(v) => set(f.key, v)}
            />
          ))}
        </div>
      </section>

      {/* Rate limiters */}
      <section className="card p-6">
        <h3 className="mb-1 flex items-center gap-2 font-semibold text-sm">
          <Activity size={14} className="text-accent" /> Rate Limiter
        </h3>
        <p className="mb-4 text-xs text-text-muted">
          Rate limiter pakai <span className="font-mono">token bucket</span>: setiap IP punya &quot;ember&quot; yang terisi ulang otomatis. Burst = ukuran ember. Isi ulang/detik = kecepatan isi.
        </p>
        <div className="space-y-4">
          {RATE_FIELDS.map((f) => (
            <SettingRow
              key={f.key}
              field={f}
              value={get(f.key)}
              defaultValue={defaults[f.key]}
              onChange={(v) => set(f.key, v)}
            />
          ))}
        </div>
      </section>

      {/* Auto-sleep info */}
      <section className="card p-6">
        <h3 className="mb-1 flex items-center gap-2 font-semibold text-sm">
          <Clock size={14} className="text-accent" /> Auto-sleep Workspace
        </h3>
        <p className="mb-3 text-xs text-text-muted">
          Workspace yang tidak aktif dapat dihentikan otomatis untuk menghemat resource VPS. Konfigurasi ini dilakukan di level Docker / sistemd pada VPS.
        </p>
        <div className="rounded-lg border border-bg-border bg-bg-subtle p-4 space-y-2 text-xs">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 rounded-full bg-info/20 px-1.5 py-0.5 text-[10px] font-semibold text-info">INFO</span>
            <div className="text-text-muted">
              Tambahkan cron job di VPS untuk stop workspace idle:
              <pre className="mt-2 rounded bg-bg px-3 py-2 font-mono text-[10px] text-text overflow-x-auto">
{`# Stop workspace containers idle >1 jam
*/15 * * * * docker ps --filter label=premdev.workspace \\
  --format '{{.ID}} {{.Status}}' | \\
  awk '$2~/Up/ && $3>60 {print $1}' | \\
  xargs -r docker stop`}
              </pre>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 rounded-full bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold text-warning">TIP</span>
            <div className="text-text-muted">
              Workspace akan otomatis start ulang saat user membuka editor (restart via API).
            </div>
          </div>
        </div>
      </section>

      {/* Save bar */}
      <div className="flex items-center gap-3">
        <button
          className="btn-primary"
          disabled={!hasDraft || saveMut.isPending}
          onClick={() => saveMut.mutate()}
        >
          {saveMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Simpan perubahan
        </button>
        <button
          className="btn-ghost text-xs text-text-muted"
          onClick={resetToDefaults}
          title="Reset semua ke nilai default"
        >
          <RefreshCw size={12} /> Reset ke default
        </button>
        {saved && !hasDraft && (
          <span className="text-xs text-success">Tersimpan dan berlaku sekarang.</span>
        )}
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DomainsSection — admin can register extra base domains pointing to this
// PremDev instance. Users then pick one when setting a custom subdomain.
// After adding a domain, admin must create a wildcard DNS record in Cloudflare:
//   *.newdomain.com  →  A  →  <VPS IP>
// ---------------------------------------------------------------------------

type DomainRow = { id: string; name: string; active: number; added_at: number };
type DomainsData = { primary: string; domains: DomainRow[] };

function DomainsSection() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [newDomain, setNewDomain] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);

  const { data, isLoading } = useQuery<DomainsData>({
    queryKey: ["admin", "domains"],
    queryFn: () => API.get("/admin/domains"),
  });

  const addMut = useMutation({
    mutationFn: (name: string) => API.post("/admin/domains", { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "domains"] });
      setNewDomain("");
      setAddErr(null);
    },
    onError: (e: any) => setAddErr(e?.message ?? "Gagal menambah domain"),
  });

  const toggleMut = useMutation({
    mutationFn: (name: string) => API.patch(`/admin/domains/${encodeURIComponent(name)}/toggle`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "domains"] }),
  });

  const delMut = useMutation({
    mutationFn: (name: string) => API.delete(`/admin/domains/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "domains"] }),
  });

  async function handleDelete(name: string) {
    const ok = await confirm(`Hapus domain "${name}"? Workspace yang pakai domain ini tidak akan bisa diakses via URL kustom.`);
    if (ok) delMut.mutate(name);
  }

  return (
    <div className="space-y-6">
      {dialog}
      {/* Primary domain — always active, shown for reference */}
      <section className="card p-6">
        <h3 className="mb-1 flex items-center gap-2 font-semibold text-sm">
          <Globe size={14} className="text-accent" /> Domain Aktif
        </h3>
        <p className="mb-4 text-xs text-text-muted">
          Domain yang bisa dipilih user saat atur custom subdomain workspace. Tambahkan domain baru lalu buat record DNS wildcard di Cloudflare:
          <code className="ml-1 rounded bg-bg-subtle px-1 text-[11px]">*.domain.com → A → IP VPS</code>
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-text-muted text-sm"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : (
          <div className="space-y-2">
            {/* PRIMARY_DOMAIN — always shown, can't be deleted */}
            <div className="flex items-center justify-between rounded-md border border-bg-border bg-bg-subtle px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Globe size={13} className="text-text-muted" />
                <span className="font-mono">{data?.primary}</span>
                <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent flex items-center gap-1">
                  <Star size={9} /> Utama
                </span>
              </div>
              <span className="text-[11px] text-success">Selalu aktif</span>
            </div>

            {/* Additional custom domains */}
            {(data?.domains ?? []).map((d) => (
              <div key={d.id} className={`flex items-center justify-between rounded-md border px-3 py-2 ${d.active ? "border-bg-border bg-bg" : "border-bg-border bg-bg-subtle opacity-60"}`}>
                <div className="flex items-center gap-2 text-sm">
                  <Globe size={13} className="text-text-muted" />
                  <span className="font-mono">{d.name}</span>
                  {!d.active && <span className="text-[10px] text-text-muted">(nonaktif)</span>}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    className="btn-ghost text-[11px] gap-1"
                    onClick={() => toggleMut.mutate(d.name)}
                    title={d.active ? "Nonaktifkan domain" : "Aktifkan domain"}
                  >
                    {d.active ? <ToggleRight size={14} className="text-success" /> : <ToggleLeft size={14} className="text-text-muted" />}
                    {d.active ? "Aktif" : "Nonaktif"}
                  </button>
                  <button
                    className="btn-ghost text-[11px] text-danger"
                    onClick={() => handleDelete(d.name)}
                    title="Hapus domain"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}

            {(data?.domains ?? []).length === 0 && (
              <p className="text-xs text-text-muted">Belum ada domain tambahan.</p>
            )}
          </div>
        )}
      </section>

      {/* Add new domain */}
      <section className="card p-6">
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-sm">
          <Plus size={14} className="text-accent" /> Tambah Domain Baru
        </h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">Nama domain</label>
            <input
              className="input w-full max-w-sm font-mono text-sm"
              placeholder="premdev.xyz"
              value={newDomain}
              onChange={(e) => { setNewDomain(e.target.value); setAddErr(null); }}
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter" && newDomain.trim()) addMut.mutate(newDomain.trim()); }}
            />
          </div>
          {addErr && <p className="text-xs text-danger">{addErr}</p>}
          <div className="rounded border border-info/30 bg-info/5 p-3 text-xs text-info space-y-1">
            <p className="font-semibold">Setelah tambah domain, buat record ini di Cloudflare:</p>
            <p><code className="rounded bg-bg-subtle px-1">Type: A</code> <code className="rounded bg-bg-subtle px-1">Name: *</code> <code className="rounded bg-bg-subtle px-1">Content: &lt;IP VPS&gt;</code> <code className="rounded bg-bg-subtle px-1">Proxy: DNS only</code></p>
            <p className="text-text-muted">Record wildcard (<code>*</code>) membuat semua subdomain mengarah ke VPS. Contoh: <code>myapp.premdev.xyz</code> → VPS → PremDev → workspace.</p>
          </div>
          <button
            className="btn-primary"
            onClick={() => newDomain.trim() && addMut.mutate(newDomain.trim())}
            disabled={!newDomain.trim() || addMut.isPending}
          >
            {addMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Tambah domain
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom Providers Section — admin dapat tambah provider AI custom
// yang kompatibel OpenAI API (Ollama, Together AI, LM Studio, dsb)
// ---------------------------------------------------------------------------

type CustomProviderRow = {
  id: string;
  name: string;
  base_url: string;
  models: string[];
  default_model: string;
  docs_url: string;
  enabled: boolean;
  configured: boolean;
  key_count: number;
  created_at: number;
};

// Base URLs for built-in providers (shown as informational in the panel)
const BUILTIN_BASE_URL: Record<string, string> = {
  openai:     "https://api.openai.com/v1",
  anthropic:  "https://api.anthropic.com/v1",
  google:     "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
  groq:       "https://api.groq.com/openai/v1",
  konektika:  "https://api.konektika.id/v1",
  snifox:     "https://core.snifoxai.com/v1",
};

function CustomProvidersSection({ onGoToAIRuntime }: { onGoToAIRuntime: () => void }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProviderRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "custom-providers"],
    queryFn: () => API.get<{ providers: CustomProviderRow[] }>("/admin/custom-providers"),
  });

  // Also fetch built-in providers' key status so we can show them here.
  const { data: aiKeys, isLoading: keysLoading } = useQuery({
    queryKey: ["admin", "ai-keys"],
    queryFn: () => API.get<{ keys: AIKeyRow[]; encryptionWeak: boolean }>("/admin/ai-keys"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => API.delete(`/admin/custom-providers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "custom-providers"] }),
  });

  const handleDelete = async (p: CustomProviderRow) => {
    const ok = await confirm({
      title: `Hapus ${p.name}?`,
      message: "Provider ini akan dihapus permanen. API key juga dihapus.",
      confirmLabel: "Hapus",
      cancelLabel: "Batal",
      danger: true,
    });
    if (ok) deleteMut.mutate(p.id);
  };

  const loading = isLoading || keysLoading;

  return (
    <div className="space-y-4">
      {dialog}

      {/* ── Built-in providers (read-only) ─────────────────────────────── */}
      <section className="card p-6">
        <div className="mb-4">
          <h2 className="font-semibold flex items-center gap-2">
            <Key size={16} className="text-text-muted" />
            Provider Bawaan
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Provider resmi yang sudah terintegrasi. API key diatur di tab{" "}
            <button
              className="text-accent underline-offset-2 hover:underline"
              onClick={onGoToAIRuntime}
            >
              Pengaturan AI
            </button>. Provider ini tidak bisa dihapus.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : (
          <div className="space-y-2">
            {(aiKeys?.keys ?? []).map((k) => {
              const docs = PROVIDER_DOCS[k.provider];
              const baseUrl = BUILTIN_BASE_URL[k.provider] ?? "";
              return (
                <div key={k.provider} className="rounded-md border border-bg-border bg-bg-subtle/40 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{PROVIDER_LABEL[k.provider] ?? k.provider}</span>
                        <span className="rounded-full bg-bg-hover px-2 py-0.5 text-[10px] text-text-muted">Bawaan</span>
                        {k.configured ? (
                          <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">
                            {k.keyCount > 1 ? `${k.keyCount} keys (rotasi)` : "key tersimpan"}
                          </span>
                        ) : (
                          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">key belum diset</span>
                        )}
                        {k.source === "env" && (
                          <span className="rounded-full bg-info/15 px-2 py-0.5 text-[10px] text-info" title="Key dibaca dari environment variable, bukan database">ENV</span>
                        )}
                      </div>
                      {/* Masked key(s) */}
                      {k.configured && (
                        <div className="mt-1.5 space-y-0.5">
                          {k.maskedAll.map((m, i) => (
                            <div key={i} className="flex items-center gap-1.5">
                              {k.maskedAll.length > 1 && (
                                <span className="text-[10px] text-text-muted w-4 shrink-0">#{i+1}</span>
                              )}
                              <code className="font-mono text-xs text-text-muted">{m}</code>
                            </div>
                          ))}
                        </div>
                      )}
                      {baseUrl && (
                        <div className="mt-1 font-mono text-[11px] text-text-muted truncate" title={baseUrl}>{baseUrl}</div>
                      )}
                      {docs && (
                        <a
                          href={docs.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline"
                        >
                          <BookOpen size={10} /> {docs.label}
                          <ExternalLink size={10} />
                        </a>
                      )}
                    </div>
                    {/* Lock icon — not deletable */}
                    <div className="shrink-0 text-text-muted opacity-40" title="Provider bawaan tidak bisa dihapus">
                      <Shield size={14} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Custom providers ───────────────────────────────────────────── */}
      <section className="card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <Sparkles size={16} className="text-accent" />
              Custom AI Providers
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              Tambah provider AI custom kompatibel OpenAI API (Ollama, Together AI, LM Studio, dsb).
              Admin isi nama + Base URL + link docs — user tinggal isi API key mereka saat ingin memakai.
            </p>
          </div>
          <button
            className="btn-primary"
            onClick={() => { setEditingProvider(null); setShowForm(true); }}
          >
            <Plus size={14} /> Tambah Provider
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : !data?.providers.length ? (
          <div className="rounded-md border border-bg-border bg-bg-subtle p-8 text-center text-sm text-text-muted">
            Belum ada custom provider. Klik <strong>"Tambah Provider"</strong> untuk menambahkan.
          </div>
        ) : (
          <div className="space-y-3">
            {data.providers.map((p) => (
              <div
                key={p.id}
                className={`rounded-md border p-4 ${p.enabled ? "border-bg-border bg-bg" : "border-bg-border bg-bg-subtle opacity-60"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{p.name}</span>
                      {p.configured ? (
                        <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">
                          {p.key_count > 1 ? `${p.key_count} API keys (rotasi)` : "API key tersimpan"}
                        </span>
                      ) : (
                        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">API key belum diset</span>
                      )}
                      {!p.enabled && (
                        <span className="rounded-full bg-bg-hover px-2 py-0.5 text-[10px] text-text-muted">Nonaktif</span>
                      )}
                    </div>
                    <div className="mt-1 font-mono text-xs text-text-muted truncate" title={p.base_url}>
                      {p.base_url}
                    </div>
                    {p.docs_url && (
                      <a
                        href={p.docs_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline"
                      >
                        <BookOpen size={10} /> Dokumentasi / Dashboard API Key
                        <ExternalLink size={10} />
                      </a>
                    )}
                    {p.models.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {p.models.slice(0, 6).map((m) => (
                          <span key={m} className="rounded bg-bg-subtle border border-bg-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{m}</span>
                        ))}
                        {p.models.length > 6 && <span className="text-[10px] text-text-muted">+{p.models.length - 6} lagi</span>}
                      </div>
                    )}
                    <div className="mt-1 text-[10px] text-text-muted">
                      ID streaming: <code className="rounded bg-bg-subtle px-1 font-mono">custom:{p.id}</code>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className="btn-secondary text-xs"
                      onClick={() => { setEditingProvider(p); setShowForm(true); }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn-ghost text-xs text-danger"
                      onClick={() => handleDelete(p)}
                      disabled={deleteMut.isPending}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showForm && (
        <CustomProviderForm
          provider={editingProvider}
          onClose={() => { setShowForm(false); setEditingProvider(null); }}
          onSaved={() => {
            setShowForm(false);
            setEditingProvider(null);
            qc.invalidateQueries({ queryKey: ["admin", "custom-providers"] });
          }}
        />
      )}
    </div>
  );
}

function CustomProviderForm({
  provider,
  onClose,
  onSaved,
}: {
  provider: CustomProviderRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  // Comma-separated keys input (same UX as built-in providers)
  const [keysText, setKeysText] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  // Saved masked keys fetched from server (when editing existing provider)
  const [savedMaskedKeys, setSavedMaskedKeys] = useState<string[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [defaultModel, setDefaultModel] = useState(provider?.default_model ?? "");
  const [modelsRaw, setModelsRaw] = useState(provider?.models.join(", ") ?? "");
  const [docsUrl, setDocsUrl] = useState(provider?.docs_url ?? "");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Fetch saved masked keys when editing an existing provider
  useEffect(() => {
    if (!provider?.id || !provider.configured) return;
    setLoadingKeys(true);
    API.get<{ keys: string[]; count: number }>(`/admin/custom-providers/${provider.id}/keys`)
      .then((r) => setSavedMaskedKeys(r.keys ?? []))
      .catch(() => {})
      .finally(() => setLoadingKeys(false));
  }, [provider?.id]);

  async function save() {
    if (!name.trim() || !baseUrl.trim()) {
      setErr("Nama dan Base URL wajib diisi");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const models = modelsRaw.split(",").map((m) => m.trim()).filter(Boolean);
      const filledKeys = keysText.split(",").map((k) => k.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        name: name.trim(),
        base_url: baseUrl.trim(),
        default_model: defaultModel.trim(),
        models,
        docs_url: docsUrl.trim(),
        enabled,
      };
      // Only send api_keys when the user actually typed something —
      // an empty value means "don't touch stored keys" on the backend.
      if (filledKeys.length > 0) body.api_keys = filledKeys;
      if (provider?.id) {
        await API.put(`/admin/custom-providers/${provider.id}`, body);
      } else {
        await API.post("/admin/custom-providers", body);
      }
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? "Gagal menyimpan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="card w-full max-w-lg p-6 overflow-auto max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {provider ? "Edit Custom Provider" : "Tambah Custom Provider"}
          </h2>
          <button onClick={onClose} className="btn-ghost p-1"><X size={14} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">Nama Provider *</label>
            <input
              className="input w-full"
              placeholder="My Llama, Together AI, Fireworks, dsb"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Base URL * <span className="font-normal text-text-muted">(tanpa /chat/completions)</span>
            </label>
            <input
              className="input w-full font-mono text-sm"
              placeholder="https://api.together.xyz/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <p className="mt-1 text-[10px] text-text-muted">
              Format: <code className="rounded bg-bg-subtle px-1">https://host/v1</code> — PremDev akan tambah <code className="rounded bg-bg-subtle px-1">/chat/completions</code> otomatis
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              API Keys
              {!provider?.configured && (
                <span className="ml-1.5 font-normal text-text-muted">(opsional — bisa diisi nanti)</span>
              )}
            </label>

            {/* Show currently saved masked keys */}
            {provider?.configured && (
              <div className="mb-2 rounded border border-bg-border bg-bg-subtle px-3 py-2 text-[11px]">
                <div className="mb-1 flex items-center gap-1.5 font-medium text-success">
                  <Check size={11} />
                  {provider.key_count} key tersimpan{provider.key_count > 1 ? " (dirotasi acak)" : ""}
                  {loadingKeys && <Loader2 size={10} className="animate-spin ml-1" />}
                </div>
                <div className="space-y-0.5 font-mono text-text-muted">
                  {savedMaskedKeys.map((k, i) => (
                    <div key={i}>
                      <span className="opacity-60">#{i + 1}:</span> {k}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comma-separated key input */}
            <div className="flex gap-2">
              <input
                className="input flex-1 font-mono text-sm"
                type={showKeys ? "text" : "password"}
                placeholder={
                  provider?.configured
                    ? "key baru (kosong = tidak ubah) — pisah koma untuk multi-key"
                    : "sk-… — pisahkan dengan koma untuk multi-key (sk-key1,sk-key2)"
                }
                value={keysText}
                onChange={(e) => setKeysText(e.target.value)}
              />
              <button
                className="btn-ghost px-2 shrink-0"
                onClick={() => setShowKeys((s) => !s)}
                title={showKeys ? "Sembunyikan" : "Tampilkan"}
                type="button"
              >
                {showKeys ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {keysText.split(",").filter(k => k.trim()).length > 1 && (
              <p className="mt-1 text-[10px] text-info">
                ✓ {keysText.split(",").filter(k => k.trim()).length} keys — dirotasi acak setiap request
              </p>
            )}
            {provider?.configured && keysText.trim() && (
              <p className="mt-1 text-[10px] text-warning">
                ⚠ Akan MENGGANTI semua {provider.key_count} key lama
              </p>
            )}
            <p className="mt-1 text-[10px] text-text-muted">
              Multi-key: tempel beberapa key dipisah <code className="rounded bg-bg-hover px-1 font-mono">,</code> — AI rotasi otomatis tiap request
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">Default Model</label>
              <input
                className="input w-full font-mono text-sm"
                placeholder="gpt-4o-mini"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">Daftar Model (pisah koma)</label>
              <input
                className="input w-full font-mono text-sm"
                placeholder="gpt-4o, gpt-4o-mini"
                value={modelsRaw}
                onChange={(e) => setModelsRaw(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Link Dokumentasi / Dashboard API Key
            </label>
            <input
              className="input w-full text-sm"
              placeholder="https://api.together.xyz/settings/api-keys"
              value={docsUrl}
              onChange={(e) => setDocsUrl(e.target.value)}
            />
            <p className="mt-1 text-[10px] text-text-muted">
              Link ini akan muncul di panel Admin → AI Keys saat admin edit key untuk provider ini
            </p>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Aktif (provider muncul di dropdown AI Chat)
          </label>

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center justify-end gap-2 border-t border-bg-border pt-3">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>
              Batal
            </button>
            <button
              className="btn-primary"
              onClick={save}
              disabled={busy || !name.trim() || !baseUrl.trim()}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {provider ? "Simpan perubahan" : "Tambah provider"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  field,
  value,
  defaultValue,
  onChange,
}: {
  field: SettingField;
  value: number;
  defaultValue: number;
  onChange: (v: number) => void;
}) {
  const isUnlimited = field.unlimitedAllowed && value === 0;
  const isModified = value !== defaultValue;
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-3">
      <div>
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{field.label}</span>
          {isUnlimited && (
            <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success">∞ unlimited</span>
          )}
          {isModified && !isUnlimited && (
            <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">ubah</span>
          )}
          {isModified && isUnlimited && (
            <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">ubah</span>
          )}
        </div>
        <div className="text-xs text-text-muted">{field.hint}</div>
        <div className="mt-0.5 text-[10px] font-mono text-text-muted opacity-60">
          default: {defaultValue} · min: {field.min} · max: {field.max}
          {field.key.includes("RefillPerSec") && !isUnlimited && (
            <span className="ml-2 text-info opacity-80">
              = {(value * 60).toFixed(1)} req/menit
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {field.unlimitedAllowed && (
          <button
            type="button"
            title={isUnlimited ? "Klik untuk set batas" : "Klik untuk unlimited (∞)"}
            onClick={() => onChange(isUnlimited ? defaultValue : 0)}
            className={`shrink-0 rounded px-2 py-1 text-[11px] font-semibold transition-colors ${
              isUnlimited
                ? "bg-success/20 text-success hover:bg-success/30"
                : "bg-bg-hover text-text-muted hover:bg-bg-border"
            }`}
          >
            ∞
          </button>
        )}
        <input
          type="number"
          className={`input w-28 text-right font-mono text-sm ${isUnlimited ? "opacity-40 pointer-events-none" : ""}`}
          min={0}
          max={field.max}
          step={field.step}
          value={isUnlimited ? 0 : value}
          disabled={isUnlimited}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v >= 0) onChange(v);
          }}
        />
      </div>
    </div>
  );
}

