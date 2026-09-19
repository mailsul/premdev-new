/**
 * CronJobsPanel — manage scheduled jobs for a workspace.
 * Modal overlay, consistent with GitPanel / SecretsPanel style.
 */

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Plus, Trash2, Play, Clock, Check, AlertTriangle, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { API } from "@/lib/api";

type CronJob = {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  command: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "running" | null;
  lastExitCode: number | null;
  lastOutput: string | null;
  createdAt: string;
  updatedAt: string;
};

type JobRun = {
  id: string;
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "success" | "failed" | "running";
  exitCode: number | null;
  output: string;
  error: string | null;
  jobName?: string;
  cronExpression?: string;
};

const SCHEDULE_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at midnight", value: "0 0 * * *" },
  { label: "Every day at noon", value: "0 12 * * *" },
  { label: "Every Monday at 9am", value: "0 9 * * 1" },
  { label: "Custom…", value: "" },
];

const TIMEZONES = [
  "UTC",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Australia/Sydney",
];

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const colors: Record<string, string> = {
    success: "bg-success/15 text-success",
    failed: "bg-danger/15 text-danger",
    running: "bg-accent/15 text-accent",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${colors[status] ?? "bg-bg-subtle text-text-muted"}`}>
      {status}
    </span>
  );
}

interface FormState {
  name: string;
  cronExpression: string;
  timezone: string;
  command: string;
  enabled: boolean;
  preset: string;
}

const emptyForm = (): FormState => ({
  name: "",
  cronExpression: "0 * * * *",
  timezone: "Asia/Jakarta",
  command: "",
  enabled: true,
  preset: "0 * * * *",
});

export function CronJobsPanel({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null); // null = list view
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const { data: jobsData, isLoading, error } = useQuery({
    queryKey: ["cron-jobs", workspaceId],
    queryFn: () => API.get<{ jobs: CronJob[] }>(`/workspaces/${workspaceId}/cron-jobs`),
    refetchInterval: form ? false : 15000,
  });
  const jobs = jobsData?.jobs ?? [];

  const { data: runsData } = useQuery({
    queryKey: ["cron-runs", workspaceId, expandedJob],
    queryFn: () => API.get<{ runs: JobRun[] }>(`/workspaces/${workspaceId}/cron-jobs/${expandedJob}/runs`),
    enabled: !!expandedJob,
    refetchInterval: 10000,
  });
  const runs = runsData?.runs ?? [];

  const createMut = useMutation({
    mutationFn: (body: Omit<FormState, "preset">) =>
      API.post(`/workspaces/${workspaceId}/cron-jobs`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cron-jobs", workspaceId] });
      setForm(null);
    },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<FormState> }) =>
      API.patch(`/workspaces/${workspaceId}/cron-jobs/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cron-jobs", workspaceId] });
      setForm(null);
      setEditingId(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => API.delete(`/workspaces/${workspaceId}/cron-jobs/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cron-jobs", workspaceId] });
      setDeleteConfirm(null);
    },
  });

  const toggleMut = useMutation({
    mutationFn: (id: string) =>
      API.post(`/workspaces/${workspaceId}/cron-jobs/${id}/toggle`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron-jobs", workspaceId] }),
  });

  const runNowMut = useMutation({
    mutationFn: (id: string) =>
      API.post(`/workspaces/${workspaceId}/cron-jobs/${id}/run`, {}),
    onSuccess: (_, id) => {
      setRunningJob(null);
      qc.invalidateQueries({ queryKey: ["cron-jobs", workspaceId] });
      qc.invalidateQueries({ queryKey: ["cron-runs", workspaceId, id] });
    },
    onError: () => setRunningJob(null),
  });

  async function fetchPreview(expr: string, tz: string) {
    setPreview(null);
    setPreviewErr(null);
    if (!expr.trim()) return;
    try {
      const r = await API.post<{ nextRunAt: string }>(`/workspaces/cron-jobs/preview`, {
        cronExpression: expr,
        timezone: tz,
      });
      setPreview(r.nextRunAt ? `Next: ${fmtDate(r.nextRunAt)}` : null);
    } catch (e: any) {
      setPreviewErr(e?.message ?? "Invalid expression");
    }
  }

  function openEdit(job: CronJob) {
    setEditingId(job.id);
    setForm({
      name: job.name,
      cronExpression: job.cronExpression,
      timezone: job.timezone,
      command: job.command,
      enabled: job.enabled,
      preset: SCHEDULE_PRESETS.find((p) => p.value === job.cronExpression)?.value ?? "",
    });
    fetchPreview(job.cronExpression, job.timezone);
  }

  function handleCronChange(val: string) {
    setForm((f) => f ? { ...f, cronExpression: val, preset: val } : f);
  }

  function handleSave() {
    if (!form) return;
    const { preset: _p, ...body } = form;
    if (editingId) {
      updateMut.mutate({ id: editingId, body });
    } else {
      createMut.mutate(body);
    }
  }

  const saving = createMut.isPending || updateMut.isPending;
  const saveErr = (createMut.error || updateMut.error) as any;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-lg border border-bg-border bg-bg-base shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-bg-border bg-bg-panel px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Clock size={16} className="text-accent" />
            {form ? (editingId ? "Edit Cron Job" : "New Cron Job") : "Cron Jobs"}
          </h2>
          <div className="flex items-center gap-2">
            {!form && (
              <button
                className="btn-primary text-xs"
                onClick={() => { setForm(emptyForm()); setEditingId(null); setPreview(null); setPreviewErr(null); }}
              >
                <Plus size={13} /> New Job
              </button>
            )}
            <button className="btn-ghost p-1" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-5">
          {/* ── Form view ── */}
          {form && (
            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">Job Name</label>
                <input
                  className="input w-full text-sm"
                  placeholder="e.g. Daily cleanup"
                  value={form.name}
                  onChange={(e) => setForm((f) => f ? { ...f, name: e.target.value } : f)}
                />
              </div>

              {/* Schedule preset */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">Schedule Preset</label>
                <select
                  className="input w-full text-sm"
                  value={form.preset}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((f) => f ? { ...f, preset: v, cronExpression: v || f.cronExpression } : f);
                    if (v) fetchPreview(v, form.timezone);
                  }}
                >
                  {SCHEDULE_PRESETS.map((p) => (
                    <option key={p.label} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>

              {/* Cron expression */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Cron Expression <span className="text-text-muted/60">(minute hour day month weekday)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    className="input flex-1 font-mono text-sm"
                    placeholder="* * * * *"
                    value={form.cronExpression}
                    onChange={(e) => handleCronChange(e.target.value)}
                    onBlur={() => fetchPreview(form.cronExpression, form.timezone)}
                  />
                </div>
                {preview && (
                  <p className="mt-1 text-[11px] text-success flex items-center gap-1">
                    <Check size={11} /> {preview}
                  </p>
                )}
                {previewErr && (
                  <p className="mt-1 text-[11px] text-danger flex items-center gap-1">
                    <AlertTriangle size={11} /> {previewErr}
                  </p>
                )}
              </div>

              {/* Timezone */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">Timezone</label>
                <select
                  className="input w-full text-sm"
                  value={form.timezone}
                  onChange={(e) => {
                    setForm((f) => f ? { ...f, timezone: e.target.value } : f);
                    fetchPreview(form.cronExpression, e.target.value);
                  }}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                  {!TIMEZONES.includes(form.timezone) && (
                    <option value={form.timezone}>{form.timezone}</option>
                  )}
                </select>
              </div>

              {/* Command */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">Command</label>
                <input
                  className="input w-full font-mono text-sm"
                  placeholder="e.g. node scripts/cleanup.js"
                  value={form.command}
                  onChange={(e) => setForm((f) => f ? { ...f, command: e.target.value } : f)}
                />
              </div>

              {/* Enabled toggle */}
              <div className="flex items-center gap-3">
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={form.enabled}
                    onChange={(e) => setForm((f) => f ? { ...f, enabled: e.target.checked } : f)}
                  />
                  <div className="h-5 w-9 rounded-full bg-bg-border peer-checked:bg-accent transition-colors" />
                  <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                </label>
                <span className="text-sm text-text-muted">{form.enabled ? "Enabled" : "Disabled"}</span>
              </div>

              {saveErr && (
                <div className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
                  {saveErr?.message ?? String(saveErr)}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 pt-1">
                <button
                  className="btn-primary"
                  disabled={saving || !form.name.trim() || !form.command.trim() || !!previewErr}
                  onClick={handleSave}
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {editingId ? "Update" : "Create"}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => { setForm(null); setEditingId(null); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── List view ── */}
          {!form && (
            <>
              {isLoading && (
                <div className="flex items-center gap-2 py-8 text-text-muted">
                  <Loader2 size={16} className="animate-spin" /> Loading…
                </div>
              )}
              {error && (
                <div className="rounded-md bg-danger/10 p-3 text-xs text-danger">
                  {String((error as any)?.message ?? error)}
                </div>
              )}
              {!isLoading && jobs.length === 0 && (
                <div className="py-10 text-center text-sm text-text-muted">
                  <Clock size={32} className="mx-auto mb-3 opacity-30" />
                  <p>No scheduled jobs yet.</p>
                  <p className="mt-1 text-xs">Click <strong>New Job</strong> to create one.</p>
                </div>
              )}
              {jobs.length > 0 && (
                <div className="space-y-2">
                  {jobs.map((job) => (
                    <div
                      key={job.id}
                      className="rounded-lg border border-bg-border bg-bg-subtle"
                    >
                      {/* Job header row */}
                      <div className="flex items-center gap-3 px-4 py-3">
                        {/* Toggle */}
                        <button
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                            job.enabled ? "bg-accent" : "bg-bg-border"
                          }`}
                          title={job.enabled ? "Disable" : "Enable"}
                          onClick={() => toggleMut.mutate(job.id)}
                          disabled={toggleMut.isPending}
                        >
                          <div
                            className={`absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                              job.enabled ? "translate-x-4" : "translate-x-0"
                            }`}
                          />
                        </button>

                        {/* Info */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{job.name}</span>
                            <StatusBadge status={job.lastStatus} />
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
                            <code className="font-mono">{job.cronExpression}</code>
                            <span>{job.timezone}</span>
                            <span>Next: {fmtDate(job.nextRunAt)}</span>
                            {job.lastRunAt && <span>Last: {fmtDate(job.lastRunAt)}</span>}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            className="btn-ghost px-1.5 py-1 text-xs"
                            title="Run now"
                            disabled={runningJob === job.id}
                            onClick={() => { setRunningJob(job.id); runNowMut.mutate(job.id); }}
                          >
                            {runningJob === job.id
                              ? <Loader2 size={13} className="animate-spin" />
                              : <Play size={13} />
                            }
                          </button>
                          <button
                            className="btn-ghost px-1.5 py-1 text-xs"
                            title="Edit"
                            onClick={() => openEdit(job)}
                          >
                            Edit
                          </button>
                          {deleteConfirm === job.id ? (
                            <>
                              <button
                                className="btn-ghost px-1.5 py-1 text-xs text-danger"
                                onClick={() => deleteMut.mutate(job.id)}
                                disabled={deleteMut.isPending}
                              >
                                Confirm
                              </button>
                              <button
                                className="btn-ghost px-1.5 py-1 text-xs"
                                onClick={() => setDeleteConfirm(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn-ghost px-1.5 py-1 text-xs text-danger"
                              title="Delete"
                              onClick={() => setDeleteConfirm(job.id)}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                          <button
                            className="btn-ghost px-1.5 py-1 text-xs"
                            title="View run history"
                            onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
                          >
                            {expandedJob === job.id
                              ? <ChevronDown size={13} />
                              : <ChevronRight size={13} />
                            }
                          </button>
                        </div>
                      </div>

                      {/* Last output preview */}
                      {job.lastOutput && (
                        <div className="border-t border-bg-border/50 bg-bg-base px-4 py-2">
                          <pre className="max-h-20 overflow-y-auto whitespace-pre-wrap break-all text-[10px] text-text-muted">
                            {job.lastOutput.slice(0, 400)}
                            {job.lastOutput.length > 400 ? "…" : ""}
                          </pre>
                        </div>
                      )}

                      {/* Run history */}
                      {expandedJob === job.id && (
                        <div className="border-t border-bg-border bg-bg-base px-4 py-3">
                          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
                            Run History
                          </div>
                          {runs.length === 0 ? (
                            <p className="text-xs text-text-muted">No runs recorded yet.</p>
                          ) : (
                            <div className="space-y-2 max-h-60 overflow-y-auto">
                              {runs.map((run) => (
                                <div key={run.id} className="rounded border border-bg-border/60 p-2 text-xs">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                      <StatusBadge status={run.status} />
                                      <span className="text-text-muted">{fmtDate(run.startedAt)}</span>
                                      {run.exitCode != null && (
                                        <span className="text-text-muted">exit: {run.exitCode}</span>
                                      )}
                                    </div>
                                    {run.finishedAt && (
                                      <span className="text-text-muted shrink-0">
                                        {((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1)}s
                                      </span>
                                    )}
                                  </div>
                                  {(run.output || run.error) && (
                                    <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-all text-[10px] text-text-muted bg-bg-subtle p-1.5 rounded">
                                      {(run.output || run.error || "").slice(0, 500)}
                                    </pre>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
