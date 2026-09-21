import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, Code2, ExternalLink, Loader2, RefreshCw, Server } from "lucide-react";
import { API } from "@/lib/api";
import { Layout } from "@/components/Layout";

type Workspace = {
  id: string;
  name: string;
  template: string;
  status: "stopped" | "starting" | "running" | "error";
};

type CodeServerSession = {
  codeServerPath: string | null;
};

export default function CodeServerPortal() {
  const workspaces = useQuery({
    queryKey: ["code-server-portal-workspaces"],
    queryFn: () => API.get<{ workspaces: Workspace[] }>("/workspaces", { timeoutMs: 8_000 }),
    retry: 1,
  });

  const open = useMutation({
    mutationFn: (workspaceId: string) =>
      API.post<{ session: CodeServerSession }>(`/workspaces/${workspaceId}/code-server/open`),
    onSuccess: (result) => {
      const path = result.session.codeServerPath;
      if (!path) throw new Error("Code Server belum siap. Coba lagi sebentar.");
      // Navigate in the same tab after the API has prepared the container.
      // This avoids leaving a confusing about:blank tab when startup fails.
      window.location.assign(path);
    },
  });

  return (
    <Layout>
      <div className="mx-auto min-h-screen w-full max-w-5xl px-5 py-10 md:px-10">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
              <Code2 size={13} /> PremDev Code
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Pilih workspace untuk membuka Code Server</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-muted">
              Code Server berjalan di container terpisah. Workspace utama boleh sedang stopped; proses IDE tetap akan dinyalakan sendiri setelah Anda memilih workspace.
            </p>
          </div>
          <button
            className="btn-secondary shrink-0"
            onClick={() => workspaces.refetch()}
            disabled={workspaces.isFetching}
            title="Refresh workspace"
          >
            <RefreshCw size={14} className={workspaces.isFetching ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        {workspaces.isLoading ? (
          <div className="card flex items-center gap-3 p-6 text-sm text-text-muted">
            <Loader2 size={18} className="animate-spin text-accent" /> Memuat workspace…
          </div>
        ) : workspaces.isError ? (
          <div className="card border-danger/30 p-6">
            <div className="flex items-center gap-2 text-sm font-semibold text-danger">
              <AlertCircle size={16} /> Workspace tidak dapat dimuat
            </div>
            <p className="mt-2 text-xs text-text-muted">Session mungkin belum siap atau API sedang restart. Coba refresh.</p>
          </div>
        ) : workspaces.data?.workspaces.length === 0 ? (
          <div className="card p-8 text-center">
            <Server size={28} className="mx-auto text-text-subtle" />
            <h2 className="mt-3 text-sm font-semibold text-text">Belum ada workspace</h2>
            <p className="mt-1 text-xs text-text-muted">Buat workspace dari dashboard PremDev terlebih dahulu.</p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {workspaces.data?.workspaces.map((workspace) => {
              const pending = open.isPending && open.variables === workspace.id;
              return (
                <div key={workspace.id} className="card p-5 transition hover:border-accent/50">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent/15 text-accent">
                          <Server size={17} />
                        </div>
                        <div className="min-w-0">
                          <h2 className="truncate font-semibold text-text">{workspace.name}</h2>
                          <p className="text-[11px] text-text-muted">{workspace.template}</p>
                        </div>
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-bg-hover px-2.5 py-1 text-[10px] font-medium text-text-muted">
                      Runtime {workspace.status}
                    </span>
                  </div>
                  <p className="mt-4 text-xs leading-relaxed text-text-muted">
                    Membuka IDE workspace ini tanpa perlu menjalankan runtime aplikasi utamanya.
                  </p>
                  <button
                    className="btn-primary mt-4 w-full justify-center"
                    onClick={() => open.mutate(workspace.id)}
                    disabled={open.isPending}
                  >
                    {pending ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                    {pending ? "Menyiapkan Code Server…" : "Buka Code Server"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {open.isError && (
          <div className="mt-5 rounded-xl border border-danger/30 bg-danger/10 p-4 text-xs text-danger">
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle size={14} /> Code Server gagal dibuka
            </div>
            <p className="mt-1 opacity-90">{(open.error as Error).message}</p>
          </div>
        )}
      </div>
    </Layout>
  );
}