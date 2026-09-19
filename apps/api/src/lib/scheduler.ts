import { nanoid } from "nanoid";
import { db } from "./db.js";
import { config } from "./config.js";
import { nextCronRun } from "./cron.js";
import { runScheduledCommand } from "./runtime.js";
import { schedulerLockAvailable } from "./scheduler-lock.js";
import { logEvent } from "./logging.js";

export const SCHEDULER_OUTPUT_LIMIT = 64 * 1024;
export const SCHEDULER_LOCK_STALE_MS = Math.max(config.CRON_JOB_TIMEOUT_MS * 2, 10 * 60_000);
export { schedulerLockAvailable } from "./scheduler-lock.js";

export type ScheduledJobRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  cron_expression: string;
  timezone: string;
  command: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_exit_code: number | null;
  last_output: string | null;
  lock_token: string | null;
  lock_acquired_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ScheduledRunRow = {
  id: string;
  job_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  exit_code: number | null;
  output: string;
  error: string | null;
  job_name?: string;
  cron_expression?: string;
};

function trimOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= SCHEDULER_OUTPUT_LIMIT) return output;
  const bytes = Buffer.from(output, "utf8").subarray(0, SCHEDULER_OUTPUT_LIMIT);
  return `${bytes.toString("utf8")}\n[output truncated at ${SCHEDULER_OUTPUT_LIMIT} bytes]`;
}

export function publicJob(row: ScheduledJobRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    command: row.command,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    lastStatus: row.last_status,
    lastExitCode: row.last_exit_code,
    lastOutput: row.last_output,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function publicRun(row: ScheduledRunRow) {
  return {
    id: row.id,
    jobId: row.job_id,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    status: row.status,
    exitCode: row.exit_code,
    output: row.output,
    error: row.error,
    jobName: row.job_name,
    cronExpression: row.cron_expression,
  };
}

function calculateNext(job: Pick<ScheduledJobRow, "cron_expression" | "timezone">, after = Date.now()) {
  return nextCronRun(job.cron_expression, job.timezone, after);
}

async function executeClaimedJob(job: ScheduledJobRow, token: string, runId: string) {
  const startedAt = Date.now();
  let result: { output: string; exitCode: number; skipped?: boolean };
  let error: string | null = null;
  try {
    result = await runScheduledCommand(job.workspace_id, job.command, config.CRON_JOB_TIMEOUT_MS);
  } catch (cause: any) {
    result = { output: "", exitCode: 1 };
    error = cause?.message ?? "Scheduler execution failed";
  }

  const finishedAt = Date.now();
  const output = trimOutput([result.output, error ? `\n${error}` : ""].join("").trim());
  const status = result.skipped
    ? "skipped"
    : result.exitCode === 0
      ? "success"
      : result.exitCode === 124
        ? "timeout"
        : "failed";
  const nextRunAt = (() => {
    try { return calculateNext(job, finishedAt); } catch { return null; }
  })();

  const finish = db.transaction(() => {
    db.prepare(`
      UPDATE scheduled_job_runs
      SET finished_at = ?, status = ?, exit_code = ?, output = ?, error = ?
      WHERE id = ? AND job_id = ?
    `).run(finishedAt, status, result.exitCode, output, error, runId, job.id);
    db.prepare(`
      UPDATE scheduled_jobs
      SET last_run_at = ?, last_status = ?, last_exit_code = ?, last_output = ?,
          next_run_at = CASE WHEN enabled = 1 THEN ? ELSE NULL END,
          lock_token = NULL, lock_acquired_at = NULL, updated_at = ?
      WHERE id = ? AND lock_token = ?
    `).run(finishedAt, status, result.exitCode, output, nextRunAt, finishedAt, job.id, token);
    db.prepare(`
      DELETE FROM scheduled_job_runs
      WHERE job_id = ? AND id NOT IN (
        SELECT id FROM scheduled_job_runs WHERE job_id = ?
        ORDER BY started_at DESC LIMIT ?
      )
    `).run(job.id, job.id, config.CRON_JOB_RETENTION);
  });
  try { finish(); } catch (cause) {
    console.error("[scheduler] failed to persist job result", cause);
  }
}

async function claimAndRun(job: ScheduledJobRow, now: number) {
  if (!schedulerLockAvailable(job.lock_token, job.lock_acquired_at, now, SCHEDULER_LOCK_STALE_MS)) return;
  const token = nanoid(18);
  const claimed = db.prepare(`
    UPDATE scheduled_jobs
    SET lock_token = ?, lock_acquired_at = ?, updated_at = ?
    WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      AND (lock_token IS NULL OR lock_acquired_at < ?)
  `).run(token, now, now, job.id, now, now - SCHEDULER_LOCK_STALE_MS);
  if (claimed.changes !== 1) return;

  const runId = nanoid(18);
  try {
    db.prepare(`
      INSERT INTO scheduled_job_runs
        (id, job_id, started_at, status, output)
      VALUES (?, ?, ?, 'running', '')
    `).run(runId, job.id, now);
  } catch {
    db.prepare("UPDATE scheduled_jobs SET lock_token = NULL, lock_acquired_at = NULL WHERE id = ? AND lock_token = ?")
      .run(job.id, token);
    return;
  }
  await executeClaimedJob(job, token, runId);
}

async function tickOnce() {
  const now = Date.now();
  const due = db.prepare(`
    SELECT * FROM scheduled_jobs
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC LIMIT 50
  `).all(now) as ScheduledJobRow[];
  await Promise.all(due.map((job) => claimAndRun(job, now)));
  return due.length;
}

let interval: NodeJS.Timeout | null = null;
let ticking = false;
let lastTickAt: number | null = null;
let lastTickDurationMs: number | null = null;
let lastDueCount = 0;
let lastError: string | null = null;
let totalRuns = 0;

export function getSchedulerState() {
  return {
    running: interval !== null,
    ticking,
    pollIntervalMs: config.CRON_POLL_INTERVAL_MS,
    timeoutMs: config.CRON_JOB_TIMEOUT_MS,
    retention: config.CRON_JOB_RETENTION,
    lastTickAt,
    lastTickDurationMs,
    lastDueCount,
    lastError,
    totalRuns,
  };
}

export function startScheduler() {
  if (interval) return;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    const startedAt = Date.now();
    lastTickAt = startedAt;
    void tickOnce()
      .then((count) => {
        lastDueCount = count;
        lastTickDurationMs = Date.now() - startedAt;
        lastError = null;
        totalRuns += count;
        logEvent("scheduler.tick", { due: count, durationMs: lastTickDurationMs });
      })
      .catch((error) => {
        lastError = error?.message ?? String(error);
        logEvent("scheduler.tick_failed", { error: lastError });
      })
      .finally(() => { ticking = false; });
  };
  interval = setInterval(tick, config.CRON_POLL_INTERVAL_MS);
  interval.unref?.();
  tick();
  logEvent("scheduler.started", { pollIntervalMs: config.CRON_POLL_INTERVAL_MS });
}

export function stopScheduler() {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
  ticking = false;
}

export async function triggerJob(jobId: string): Promise<boolean> {
  const job = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(jobId) as ScheduledJobRow | undefined;
  if (!job || !job.enabled) return false;
  const now = Date.now();
  if (!schedulerLockAvailable(job.lock_token, job.lock_acquired_at, now, SCHEDULER_LOCK_STALE_MS)) return false;
  const token = nanoid(18);
  const claimed = db.prepare(`
    UPDATE scheduled_jobs
    SET lock_token = ?, lock_acquired_at = ?, next_run_at = ?, updated_at = ?
    WHERE id = ? AND enabled = 1
      AND (lock_token IS NULL OR lock_acquired_at < ?)
  `).run(token, now, now, now, jobId, now - SCHEDULER_LOCK_STALE_MS);
  if (claimed.changes !== 1) return false;
  const runId = nanoid(18);
  db.prepare("INSERT INTO scheduled_job_runs (id, job_id, started_at, status, output) VALUES (?, ?, ?, 'running', '')")
    .run(runId, jobId, now);
  await executeClaimedJob({ ...job, next_run_at: now }, token, runId);
  return true;
}