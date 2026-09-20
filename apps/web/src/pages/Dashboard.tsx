import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { API } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { useConfirm } from "@/lib/useConfirm";
import {
  Plus,
  Play,
  Square,
  Trash2,
  ExternalLink,
  Loader2,
  FolderOpen,
  Search,
  Sparkles,
  Activity,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

type Workspace = {
  id: string;
  name: string;
  template: string;
  status: "stopped" | "starting" | "running" | "error";
  createdAt: string;
  previewPort?: number;
  previewUrl?: string;
};

const WORKSPACE_CACHE_KEY = "premdev:workspaces-cache";

function readWorkspaceCache(): { workspaces: Workspace[] } | undefined {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_CACHE_KEY);
    return raw ? JSON.parse(raw) as { workspaces: Workspace[] } : undefined;
  } catch {
    return undefined;
  }
}

function writeWorkspaceCache(data: { workspaces: Workspace[] }) {
  try {
    sessionStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Cache is an optimization; private browsing may disable storage.
  }
}

const TEMPLATES = [
  { id: "blank", label: "Blank", color: "bg-bg-hover" },
  { id: "node", label: "Node.js", color: "bg-emerald-600" },
  { id: "python", label: "Python", color: "bg-blue-600" },
  { id: "php", label: "PHP", color: "bg-indigo-600" },
  { id: "static", label: "Static HTML", color: "bg-amber-600" },
  { id: "react", label: "React + Vite", color: "bg-cyan-600" },
  { id: "express", label: "Express", color: "bg-emerald-700" },
  { id: "flask", label: "Flask", color: "bg-blue-700" },
  { id: "laravel", label: "Laravel", color: "bg-rose-600" },
  { id: "go", label: "Go", color: "bg-sky-600" },
  { id: "rust", label: "Rust", color: "bg-orange-700" },
  { id: "java", label: "Java", color: "bg-red-700" },
  { id: "cpp", label: "C/C++", color: "bg-slate-600" },
  { id: "ruby", label: "Ruby", color: "bg-red-600" },
  { id: "zip", label: "Upload ZIP", color: "bg-purple-600" },
  { id: "git", label: "Import Git", color: "bg-gray-700" },
];

export default function Dashboard() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | Workspace["status"]>("all");

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const result = await API.get<{ workspaces: Workspace[] }>("/workspaces", { timeoutMs: 12_000 });
      writeWorkspaceCache(result);
      return result;
    },
    initialData: readWorkspaceCache,
    initialDataUpdatedAt: 0,
  });
  const workspaces = data?.workspaces ?? [];
  const visibleWorkspaces = useMemo(() => workspaces.filter((workspace) => {
    const matchesSearch = workspace.name.toLowerCase().includes(search.toLowerCase()) ||
      workspace.template.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (filter === "all" || workspace.status === filter);
  }), [workspaces, search, filter]);
  const counts = {
    all: workspaces.length,
    running: workspaces.filter((workspace) => workspace.status === "running").length,
    starting: workspaces.filter((workspace) => workspace.status === "starting").length,
    error: workspaces.filter((workspace) => workspace.status === "error").length,
  };

  const startStop = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "start" | "stop" }) =>
      API.post(`/workspaces/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
  });

  const del = useMutation({
    mutationFn: (id: string) => API.delete(`/workspaces/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
  });

  return (
    <Layout>
      <div className="page-shell">
        <div className="mb-8 overflow-hidden rounded-3xl border border-accent/20 bg-gradient-to-br from-accent/15 via-bg-panel to-cyan-500/5 p-6 shadow-2xl shadow-accent/5 sm:p-8">
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
          <div>
            <div className="eyebrow mb-3 flex items-center gap-2"><Sparkles size={13} /> Developer cloud</div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Your workspaces</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-text-muted">Everything you build, in one focused place. Start a project or jump back into your latest flow.</p>
          </div>
          <button className="btn-primary shrink-0" onClick={() => setShowNew(true)}><Plus size={16} /> New workspace</button>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "All projects", value: counts.all, tone: "text-text", filter: "all" as const },
            { label: "Running", value: counts.running, tone: "text-success", filter: "running" as const },
            { label: "Starting", value: counts.starting, tone: "text-warning", filter: "starting" as const },
            { label: "Needs attention", value: counts.error, tone: "text-danger", filter: "error" as const },
          ].map((item) => (
            <button key={item.label} onClick={() => setFilter(item.filter)} className={`surface p-4 text-left transition hover:-translate-y-0.5 hover:border-accent/40 ${filter === item.filter ? "border-accent/50 bg-accent/5" : ""}`}>
              <div className="text-xs text-text-muted">{item.label}</div>
              <div className={`mt-2 text-2xl font-semibold ${item.tone}`}>{item.value}</div>
            </button>
          ))}
        </div>

        <div className="mb-5 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input className="input pl-9" placeholder="Search workspaces or templates…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="flex gap-2 overflow-auto">
            {(["all", "running", "stopped", "error"] as const).map((value) => (
              <button key={value} className={filter === value ? "btn-primary whitespace-nowrap" : "btn-secondary whitespace-nowrap"} onClick={() => setFilter(value)}>
                {value === "all" ? "All" : value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
            <button className="btn-ghost" onClick={() => refetch()} title="Refresh workspaces"><RefreshCw size={16} className={isFetching ? "animate-spin" : ""} /></button>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((item) => <div key={item} className="surface h-48 p-5"><div className="skeleton h-10 w-10" /><div className="skeleton mt-5 h-5 w-40" /><div className="skeleton mt-2 h-4 w-24" /><div className="skeleton mt-8 h-10 w-full" /></div>)}
          </div>
        ) : error ? (
          <div className="surface flex flex-col items-center justify-center p-12 text-center">
            <AlertCircle size={28} className="mb-3 text-danger" />
            <div className="font-medium">Could not load workspaces</div>
            <p className="mt-1 max-w-sm text-sm text-text-muted">The server may still be warming up after a deploy. Try again without leaving this page.</p>
            <button className="btn-secondary mt-5" onClick={() => refetch()}><RefreshCw size={14} /> Try again</button>
          </div>
        ) : visibleWorkspaces.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleWorkspaces.map((w) => {
              const tmpl = TEMPLATES.find((t) => t.id === w.template) ?? TEMPLATES[0];
              return (
                <div key={w.id} className="card group p-5 transition duration-200 hover:-translate-y-1 hover:border-accent/50 hover:shadow-accent/10">
                  <div className="mb-3 flex items-start justify-between">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-md text-white text-xs font-bold"
                      style={{}}
                    >
                      <span className={`grid h-10 w-10 place-items-center rounded-md text-white text-xs font-bold ${tmpl.color}`}>
                        {tmpl.label.slice(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                        w.status === "running"
                          ? "bg-success/20 text-success"
                          : w.status === "starting"
                          ? "bg-warning/20 text-warning"
                          : w.status === "error"
                          ? "bg-danger/20 text-danger"
                          : "bg-bg-hover text-text-muted"
                      }`}
                    >
                      {w.status === "running" ? "Running" : w.status === "starting" ? "Starting" : w.status === "error" ? "Needs attention" : "Stopped"}
                    </span>
                  </div>

                  <button
                    className="text-left"
                    onClick={() => nav(`/workspace/${w.id}`)}
                  >
                    <div className="font-semibold tracking-tight">{w.name}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-text-muted"><Activity size={12} /> {tmpl.label}</div>
                  </button>

                  <div className="mt-4 flex items-center gap-1.5">
                     <button
                       className="btn-secondary flex-1"
                      onClick={() => nav(`/workspace/${w.id}`)}
                    >
                      <FolderOpen size={14} /> Open
                    </button>
                    {w.status === "running" ? (
                      <button
                        className="btn-ghost"
                         title="Stop workspace"
                         aria-label="Stop workspace"
                        onClick={() => startStop.mutate({ id: w.id, action: "stop" })}
                      >
                        <Square size={14} />
                      </button>
                    ) : (
                      <button
                        className="btn-ghost"
                         title="Start workspace"
                         aria-label="Start workspace"
                        onClick={() => startStop.mutate({ id: w.id, action: "start" })}
                      >
                        <Play size={14} />
                      </button>
                    )}
                    {w.previewUrl && (
                      <a
                        className="btn-ghost"
                         title="Open preview"
                         aria-label="Open preview"
                        target="_blank"
                        rel="noreferrer"
                        href={w.previewUrl}
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
                    <button
                      className="btn-ghost text-danger hover:text-danger"
                       title="Delete workspace"
                       aria-label="Delete workspace"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Hapus workspace?",
                          message: `Workspace "${w.name}" beserta semua filenya akan dihapus permanen. Tidak bisa dikembalikan.`,
                          confirmLabel: "Hapus",
                          cancelLabel: "Batal",
                          danger: true,
                        });
                        if (ok) del.mutate(w.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="surface p-12 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-bg-hover text-text-muted">
              <Plus size={20} />
            </div>
            <div className="mb-1 font-medium">{workspaces.length ? "No matching workspaces" : "No workspaces yet"}</div>
            <div className="mb-4 text-sm text-text-muted">
              {workspaces.length ? "Try another search or status filter." : "Create your first workspace to start coding."}
            </div>
            {!workspaces.length && <button className="btn-primary" onClick={() => setShowNew(true)}>
              <Plus size={16} /> New workspace
            </button>}
          </div>
        )}
      </div>

      {showNew && <NewWorkspaceModal onClose={() => setShowNew(false)} />}
      {confirmDialog}
    </Layout>
  );
}

function NewWorkspaceModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("blank");
  const [gitUrl, setGitUrl] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      let body: any = { name, template };
      if (template === "git") body.gitUrl = gitUrl;

      let res: any;
      if (template === "zip" && zipFile) {
        const fd = new FormData();
        fd.append("name", name);
        fd.append("file", zipFile);
        const r = await fetch("/api/workspaces/upload", {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        if (!r.ok) {
          const errData = await r.json().catch(() => ({ error: "Upload failed" }));
          throw new Error(errData.error || "Upload failed");
        }
        res = await r.json();
      } else {
        res = await API.post<{ workspace: any }>("/workspaces", body);
      }
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      onClose();
      if (res?.workspace?.id) nav(`/workspace/${res.workspace.id}`);
    } catch (e: any) {
      setErr(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form
        className="card w-full max-w-2xl p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={onCreate}
      >
        <h2 className="mb-4 text-lg font-semibold">Create new workspace</h2>

        <div className="mb-4">
          <label className="label">Name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-awesome-project"
            required
            autoFocus
          />
        </div>

        <div className="mb-4">
          <label className="label">Template</label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TEMPLATES.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setTemplate(t.id)}
                className={`rounded-md border px-3 py-3 text-left text-xs transition ${
                  template === t.id
                    ? "border-accent bg-accent/10"
                    : "border-bg-border bg-bg-subtle hover:border-bg-border"
                }`}
              >
                <div className={`mb-1.5 inline-block rounded px-1.5 py-0.5 text-[9px] font-bold text-white ${t.color}`}>
                  {t.label.slice(0, 3).toUpperCase()}
                </div>
                <div className="font-medium">{t.label}</div>
              </button>
            ))}
          </div>
        </div>

        {template === "git" && (
          <div className="mb-4">
            <label className="label">Git URL</label>
            <input
              className="input"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              required
            />
          </div>
        )}

        {template === "zip" && (
          <div className="mb-4">
            <label className="label">ZIP file</label>
            <input
              type="file"
              accept=".zip"
              className="input"
              onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
              required
            />
          </div>
        )}

        {err && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
