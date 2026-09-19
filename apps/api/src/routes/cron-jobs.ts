import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "../lib/db.js";
import { requireUser } from "../lib/auth-helpers.js";
import { nextCronRun, validateCron } from "../lib/cron.js";
import { publicJob, publicRun, triggerJob, type ScheduledJobRow, type ScheduledRunRow } from "../lib/scheduler.js";

const MAX_NAME = 120;
const MAX_COMMAND = 4000;

const CronBody = z.object({
  name: z.string().trim().min(1, "Job name is required").max(MAX_NAME),
  cronExpression: z.string().trim().min(1, "Cron expression is required").max(200),
  command: z.string().trim().min(1, "Command is required").max(MAX_COMMAND),
  timezone: z.string().trim().min(1).max(100).default("UTC"),
  enabled: z.boolean().default(true),
});

const CronPatch = CronBody.partial();

function workspaceOwned(workspaceId: string, userId: string) {
  return db.prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?").get(workspaceId, userId);
}

function dangerousCommand(command: string): string | null {
  if (command.includes("\0")) return "Command contains an invalid null byte";
  // The app runtime has intentionally privileged integrations for the Run
  // button. Scheduled jobs must not use those integrations to escape the
  // workspace container or alter the host.
  if (/(^|[\s;&|()])(?:sudo|su|doas|docker|podman|nsenter|chroot|mount|umount|mkfs|shutdown|reboot)(?:[\s;&|()]|$)/i.test(command)) {
    return "This command uses a privileged or host-level tool that scheduled jobs do not allow";
  }
  if (/(?:\/var\/run\/docker\.sock|\/proc\/(?:1|sys)|(?:curl|wget)\b[^|]*\|\s*(?:ba)?sh\b|>\s*\/etc\/)/i.test(command)) {
    return "This command targets a host/runtime boundary and is not allowed";
  }
  return null;
}

function validateJobInput(input: {
  cronExpression: string;
  command: string;
  timezone: string;
}) {
  const cronError = validateCron(input.cronExpression, input.timezone);
  if (cronError) return cronError;
  return dangerousCommand(input.command);
}

export const cronJobRoutes: FastifyPluginAsync = async (app) => {
  // Schedule preview is authenticated but not workspace-specific.
  app.post("/cron-jobs/preview", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = z.object({
      cronExpression: z.string().trim().min(1).max(200),
      timezone: z.string().trim().min(1).max(100).default("UTC"),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Invalid schedule input" });
    const error = validateCron(body.data.cronExpression, body.data.timezone);
    if (error) return reply.code(400).send({ error });
    return {
      valid: true,
      nextRunAt: new Date(nextCronRun(body.data.cronExpression, body.data.timezone)).toISOString(),
    };
  });

  app.get("/:workspaceId/cron-jobs", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const workspaceId = (req.params as any).workspaceId;
    if (!workspaceOwned(workspaceId, u.id)) return reply.code(404).send({ error: "Not found" });
    const rows = db.prepare(`
      SELECT * FROM scheduled_jobs WHERE workspace_id = ? ORDER BY created_at DESC
    `).all(workspaceId) as ScheduledJobRow[];
    return { jobs: rows.map(publicJob) };
  });

  app.get("/:workspaceId/cron-jobs/runs", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const workspaceId = (req.params as any).workspaceId;
    if (!workspaceOwned(workspaceId, u.id)) return reply.code(404).send({ error: "Not found" });

    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const rawLimit = Number(query.limit ?? 20);
    const rawOffset = Number(query.offset ?? 0);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 20;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    const jobId = query.jobId?.trim() || null;
    const status = query.status?.trim() || null;
    const filters = ["j.workspace_id = ?"];
    const params: Array<string | number> = [workspaceId];
    if (jobId) {
      filters.push("r.job_id = ?");
      params.push(jobId);
    }
    if (status) {
      filters.push("r.status = ?");
      params.push(status);
    }
    const where = filters.join(" AND ");
    const total = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM scheduled_job_runs r
      INNER JOIN scheduled_jobs j ON j.id = r.job_id
      WHERE ${where}
    `).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT r.*, j.name AS job_name, j.cron_expression
      FROM scheduled_job_runs r
      INNER JOIN scheduled_jobs j ON j.id = r.job_id
      WHERE ${where}
      ORDER BY r.started_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ScheduledRunRow[];
    return { runs: rows.map(publicRun), total, limit, offset };
  });

  app.post("/:workspaceId/cron-jobs", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const workspaceId = (req.params as any).workspaceId;
    if (!workspaceOwned(workspaceId, u.id)) return reply.code(404).send({ error: "Not found" });
    const parsed = CronBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid job" });
    const input = parsed.data;
    const inputError = validateJobInput(input);
    if (inputError) return reply.code(400).send({ error: inputError });
    const now = Date.now();
    const id = nanoid(18);
    const nextRun = input.enabled ? nextCronRun(input.cronExpression, input.timezone, now) : null;
    db.prepare(`
      INSERT INTO scheduled_jobs
        (id, workspace_id, owner_id, name, cron_expression, timezone, command, enabled,
         next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, workspaceId, u.id, input.name, input.cronExpression, input.timezone, input.command,
      input.enabled ? 1 : 0, nextRun, now, now);
    const row = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as ScheduledJobRow;
    return reply.code(201).send({ job: publicJob(row) });
  });

  app.patch("/:workspaceId/cron-jobs/:jobId", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { workspaceId, jobId } = req.params as any;
    if (!workspaceOwned(workspaceId, u.id)) return reply.code(404).send({ error: "Not found" });
    const job = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ? AND workspace_id = ?")
      .get(jobId, workspaceId) as ScheduledJobRow | undefined;
    if (!job) return reply.code(404).send({ error: "Not found" });
    if (job.lock_token) return reply.code(409).send({ error: "Job is running; try again when it finishes" });
    const parsed = CronPatch.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid job" });
    const input = {
      name: parsed.data.name ?? job.name,
      cronExpression: parsed.data.cronExpression ?? job.cron_expression,
      command: parsed.data.command ?? job.command,
      timezone: parsed.data.timezone ?? job.timezone,
      enabled: parsed.data.enabled ?? Boolean(job.enabled),
    };
    const inputError = validateJobInput(input);
    if (inputError) return reply.code(400).send({ error: inputError });
    const now = Date.now();
    const nextRun = input.enabled ? nextCronRun(input.cronExpression, input.timezone, now) : null;
    db.prepare(`
      UPDATE scheduled_jobs
      SET name = ?, cron_expression = ?, command = ?, timezone = ?, enabled = ?,
          next_run_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND lock_token IS NULL
    `).run(input.name, input.cronExpression, input.command, input.timezone,
      input.enabled ? 1 : 0, nextRun, now, jobId, workspaceId);
    const updated = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(jobId) as ScheduledJobRow;
    return { job: publicJob(updated) };
  });

  app.post("/:workspaceId/cron-jobs/:jobId/toggle", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { workspaceId, jobId } = req.params as any;
    if (!workspaceOwned(workspaceId, u.id)) return reply.code(404).send({ error: "Not found" });
    const job = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ? AND workspace_id = ?")
      .get(jobId, workspaceId) as ScheduledJobRow | undefined;
    if (!job) return reply.code(404).send({ error: "Not found" });
    const body = z.object({ enabled: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "enabled must be a boolean" });
    const enabled = body.data.enabled ?? !Boolean(job.enabled);
    const nextRun = enabled ? nextCronRun(job.cron_expression, job.timezone, Date.now()) : null;
    db.prepare(`
      UPDATE scheduled_jobs SET enabled = ?, next_run_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(enabled ? 1 : 0, nextRun, Date.now(), jobId, workspaceId);
    const updated = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(jobId) as ScheduledJobRow;
    return { job: publicJob(updated) };
  });

  app.post("/:workspaceId/cron-jobs/:jobId/run", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { workspaceId, jobId } = req.params as any;
    if (!workspaceOwned(workspaceId, u.id)) return reply.code(404).send({ error: "Not found" });
    const job = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ? AND workspace_id = ?")
      .get(jobId, workspaceId) as ScheduledJobRow | undefined;
    if (!job) return reply.code(404).send({ error: "Not found" });
    if (!job.enabled) return reply.code(400).send({ error: "Enable the job before running it" });
    if (!(await triggerJob(jobId))) return reply.code(409).send({ error: "Job is already running" });
    const updated = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(jobId) as ScheduledJobRow;
    return { job: publicJob(updated) };
  });

  app.get("/:workspaceId/cron-jobs/:jobId/runs", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { workspaceId, jobId } = req.params as any;
    if (!workspaceOwned(workspaceId, u.id)) return reply.code(404).send({ error: "Not found" });
    const job = db.prepare("SELECT id FROM scheduled_jobs WHERE id = ? AND workspace_id = ?")
      .get(jobId, workspaceId);
    if (!job) return reply.code(404).send({ error: "Not found" });
    const rawLimit = Number((req.query as any)?.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 20;
    const rows = db.prepare(`
      SELECT * FROM scheduled_job_runs
      WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
    `).all(jobId, limit) as ScheduledRunRow[];
    return { runs: rows.map(publicRun) };
  });

  app.delete("/:workspaceId/cron-jobs/:jobId", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { workspaceId, jobId } = req.params as any;
    if (!workspaceOwned(workspaceId, u.id)) return reply.code(404).send({ error: "Not found" });
    const job = db.prepare("SELECT * FROM scheduled_jobs WHERE id = ? AND workspace_id = ?")
      .get(jobId, workspaceId) as ScheduledJobRow | undefined;
    if (!job) return reply.code(404).send({ error: "Not found" });
    if (job.lock_token) return reply.code(409).send({ error: "Job is running; try again when it finishes" });
    db.prepare("DELETE FROM scheduled_jobs WHERE id = ? AND workspace_id = ?").run(jobId, workspaceId);
    return { ok: true };
  });
};