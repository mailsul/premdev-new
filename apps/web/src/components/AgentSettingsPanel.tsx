import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Cpu, ShieldCheck, X } from "lucide-react";
import { API } from "@/lib/api";

type AgentMode = "premdev" | "hermes";

type AgentConfig = {
  mode: AgentMode;
  provider: string | null;
  model: string | null;
  updatedAt: number | null;
};

export function AgentSettingsPanel({
  workspaceId,
  onClose,
  embedded = false,
}: {
  workspaceId: string;
  onClose: () => void;
  embedded?: boolean;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["workspace", workspaceId, "agent-config"],
    queryFn: () => API.get<{ config: AgentConfig }>(`/workspaces/${workspaceId}/agent-config`),
  });
  const { data: providers } = useQuery({
    queryKey: ["ai", "providers"],
    queryFn: () => API.get<{ providers: Array<{ id: string; name: string; configured: boolean; defaultModel: string }> }>("/ai/providers"),
    staleTime: 60_000,
  });
  const [mode, setMode] = useState<AgentMode>("premdev");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data?.config) return;
    setMode(data.config.mode);
    setProvider(data.config.provider ?? "");
    setModel(data.config.model ?? "");
  }, [data]);

  const save = useMutation({
    mutationFn: () => API.put(`/workspaces/${workspaceId}/agent-config`, {
      mode,
      provider: provider.trim() || null,
      model: model.trim() || null,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["workspace", workspaceId, "agent-config"] });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    },
  });

  const body = (
    <div className={embedded ? "flex h-full min-h-0 flex-col bg-bg-base" : "card flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden p-0"}>
      <div className="flex items-start justify-between gap-3 border-b border-bg-border px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-accent/15 p-2 text-accent"><Bot size={17} /></div>
          <div>
            <h2 className="text-base font-semibold text-text">Agent Workspace</h2>
            <p className="mt-1 text-xs text-text-muted">
              Pilih agent per workspace. PremDev tetap mengontrol runtime, permission, approval, dan isolasi file.
            </p>
          </div>
        </div>
        <button className="btn-ghost p-1" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto space-y-4 px-5 py-4">
        {isLoading ? (
          <div className="text-xs text-text-muted">Memuat konfigurasi agent…</div>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                {
                  value: "premdev" as const,
                  title: "PremDev Agent",
                  description: "Agent bawaan dengan workflow, checkpoint, validation, dan tools PremDev.",
                },
                {
                  value: "hermes" as const,
                  title: "Hermes Agent",
                  description: "Profil autonomous coding yang lebih persisten untuk task panjang dan iteratif.",
                },
              ]).map((option) => (
                <button
                  key={option.value}
                  onClick={() => setMode(option.value)}
                  className={`rounded-lg border p-3 text-left transition ${
                    mode === option.value
                      ? "border-accent bg-accent/10"
                      : "border-bg-border bg-bg-panel hover:border-accent/40"
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-semibold text-text">
                    <Cpu size={14} className={mode === option.value ? "text-accent" : "text-text-subtle"} />
                    {option.title}
                    {mode === option.value && <Check size={13} className="ml-auto text-accent" />}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{option.description}</p>
                </button>
              ))}
            </div>

            <div className="rounded-md border border-bg-border bg-bg-subtle p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-text">
                <ShieldCheck size={14} className="text-success" />
                Runtime safety
              </div>
              <ul className="space-y-1 text-[11px] text-text-muted">
                <li>• Agent hanya bisa mengakses workspace yang sedang dipilih.</li>
                <li>• Command dijalankan melalui workspace runtime, bukan host VPS.</li>
                <li>• Checkpoint, batas action, timeout, dan validation tetap aktif.</li>
                <li>• Mode Hermes dapat dipakai sementara dari toolbar AI dengan opsi “Sesi ini”.</li>
              </ul>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] text-text-muted">
                Provider default (opsional)
                <select
                  className="input mt-1 w-full text-xs"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  <option value="">Ikuti pilihan toolbar AI</option>
                  {(providers?.providers ?? []).map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.configured}>
                      {item.name} {!item.configured ? "(belum dikonfigurasi)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-text-muted">
                Model default (opsional)
                <input
                  className="input mt-1 w-full text-xs"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={mode === "hermes" ? "Hermes model / auto" : "auto"}
                />
              </label>
            </div>
            {save.isError && (
              <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {(save.error as any)?.message ?? "Gagal menyimpan konfigurasi agent."}
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-bg-border bg-bg-subtle px-5 py-3">
        <span className="text-[11px] text-text-muted">
          {saved ? "Konfigurasi tersimpan untuk workspace ini." : "Perubahan berlaku pada chat agent berikutnya."}
        </span>
        <button
          className="btn-primary text-xs"
          disabled={isLoading || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Menyimpan…" : saved ? "Tersimpan" : "Simpan agent"}
        </button>
      </div>
    </div>
  );

  if (embedded) return body;
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} className="w-full max-w-xl">{body}</div>
    </div>
  );
}