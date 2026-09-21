import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db, DbWorkspace } from "../lib/db.js";
import { requireUser } from "../lib/auth-helpers.js";
import { config } from "../lib/config.js";
import { detectHardcodedPort, fixRunCommandHost } from "../lib/project-hints.js";
import { getTemplate } from "../lib/templates.js";
import { readWorkspaceConfig } from "../lib/workspace-config.js";
import { workspacePath } from "../lib/runtime.js";
import {
  codePreviewPath,
  codeServerPath,
  codeServerIsRunning,
  ensurePremDevMetadata,
  getCodeServerPreviewLogs,
  startCodeServer,
  startCodeServerPreview,
  stopCodeServer,
  stopCodeServerPreview,
} from "../lib/code-server.js";

const PreviewBody = z.object({
  port: z.number().int().min(1).max(65535).optional(),
});

function ownerWorkspace(id: string, userId: string): DbWorkspace | undefined {
  return db
    .prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?")
    .get(id, userId) as DbWorkspace | undefined;
}

function resolvePreview(w: DbWorkspace): { command: string; port: number; envVars: Record<string, string> } {
  const dir = workspacePath(w.id);
  const cfg = readWorkspaceConfig(dir);
  const template = getTemplate(w.template);
  const placeholder = "echo 'No run command set'";
  const command =
    cfg?.run?.trim() && cfg.run.trim() !== placeholder
      ? cfg.run.trim()
      : w.run_command?.trim() && w.run_command.trim() !== placeholder
        ? w.run_command.trim()
        : template.runCommand;
  const fixedCommand = fixRunCommandHost(command);
  const port =
    (cfg?.port && Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536)
      ? cfg.port
      : (detectHardcodedPort(dir, fixedCommand) ?? template.port ?? config.CODE_SERVER_PREVIEW_PORT);
  let envVars: Record<string, string> = {};
  try { envVars = JSON.parse(w.env_vars || "{}"); } catch {}
  envVars = { ...envVars, ...(cfg?.env ?? {}) };
  return { command: fixedCommand, port, envVars };
}

function publicSession(id: string, row: any, running: boolean) {
  const active = running && row?.status === "running";
  return {
    active,
    status: active ? "running" : "stopped",
    previewStatus: active ? (row.preview_status ?? "stopped") : "stopped",
    previewPort: active ? (row.preview_port ?? null) : null,
    codeServerPath: active ? codeServerPath(id) : null,
    previewPath: active && row.preview_status === "running" ? codePreviewPath(id) : null,
    lastClientAt: row?.last_client_at ?? null,
  };
}

export const codeServerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/:id/code-server", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id as string;
    const w = ownerWorkspace(id, u.id);
    if (!w) return reply.code(404).send({ error: "Not found" });
    const row = db.prepare("SELECT * FROM code_server_sessions WHERE workspace_id = ? AND owner_id = ?").get(id, u.id) as any;
    const running = await codeServerIsRunning(id);
    if (row && !running && row.status === "running") {
      db.prepare(`
        UPDATE code_server_sessions
        SET status = 'stopped', preview_status = 'stopped', preview_pid = NULL, updated_at = ?
        WHERE workspace_id = ?
      `).run(Date.now(), id);
      row.status = "stopped";
      row.preview_status = "stopped";
    }
    if (row && running) {
      db.prepare("UPDATE code_server_sessions SET last_client_at = ?, updated_at = ? WHERE workspace_id = ?").run(Date.now(), Date.now(), id);
    }
    return { session: publicSession(id, row, running) };
  });

  app.post("/:id/code-server/open", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id as string;
    const w = ownerWorkspace(id, u.id);
    if (!w) return reply.code(404).send({ error: "Not found" });
    const user = db.prepare("SELECT quota_cpu, quota_mem_mb FROM users WHERE id = ?").get(u.id) as { quota_cpu: number; quota_mem_mb: number };
    const now = Date.now();
    try {
      const preview = resolvePreview(w);
      ensurePremDevMetadata(id);
      const started = await startCodeServer({
        workspaceId: id,
        username: u.username,
        cpu: user.quota_cpu,
        memMb: Math.min(user.quota_mem_mb, 2048),
        envVars: preview.envVars,
      });
      db.prepare(`
        INSERT INTO code_server_sessions
          (workspace_id, owner_id, container_id, status, code_server_port, preview_status, last_client_at, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, 'stopped', ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          container_id = excluded.container_id,
          status = 'running',
          code_server_port = excluded.code_server_port,
          last_client_at = excluded.last_client_at,
          updated_at = excluded.updated_at
      `).run(id, u.id, started.containerId, started.port, now, now, now);
      const row = db.prepare("SELECT * FROM code_server_sessions WHERE workspace_id = ?").get(id) as any;
      return { session: publicSession(id, row, true) };
    } catch (e: any) {
      return reply.code(503).send({ error: e?.message ?? "Code Server gagal dibuka." });
    }
  });

  app.post("/:id/code-server/stop", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id as string;
    if (!ownerWorkspace(id, u.id)) return reply.code(404).send({ error: "Not found" });
    await stopCodeServer(id);
    db.prepare(`
      UPDATE code_server_sessions
      SET status = 'stopped', preview_status = 'stopped', preview_pid = NULL, updated_at = ?
      WHERE workspace_id = ? AND owner_id = ?
    `).run(Date.now(), id, u.id);
    return { session: publicSession(id, null, false) };
  });

  app.post("/:id/code-server/preview/start", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id as string;
    const w = ownerWorkspace(id, u.id);
    if (!w) return reply.code(404).send({ error: "Not found" });
    const row = db.prepare("SELECT * FROM code_server_sessions WHERE workspace_id = ? AND owner_id = ?").get(id, u.id) as any;
    if (!row || !(await codeServerIsRunning(id))) {
      return reply.code(409).send({ error: "Buka Code Server terlebih dahulu." });
    }
    const body = PreviewBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Port preview tidak valid." });
    const resolved = resolvePreview(w);
    try {
      const started = await startCodeServerPreview(id, resolved.command, body.data.port ?? resolved.port);
      const now = Date.now();
      db.prepare(`
        UPDATE code_server_sessions
        SET preview_port = ?, preview_pid = ?, preview_status = 'running', preview_started_at = ?, last_client_at = ?, updated_at = ?
        WHERE workspace_id = ? AND owner_id = ?
      `).run(started.port, started.pid, now, now, now, id, u.id);
      const updated = db.prepare("SELECT * FROM code_server_sessions WHERE workspace_id = ?").get(id) as any;
      return { session: publicSession(id, updated, true) };
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message ?? "Preview code-server gagal dijalankan." });
    }
  });

  app.post("/:id/code-server/preview/stop", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id as string;
    if (!ownerWorkspace(id, u.id)) return reply.code(404).send({ error: "Not found" });
    await stopCodeServerPreview(id);
    db.prepare(`
      UPDATE code_server_sessions
      SET preview_status = 'stopped', preview_pid = NULL, updated_at = ?
      WHERE workspace_id = ? AND owner_id = ?
    `).run(Date.now(), id, u.id);
    const row = db.prepare("SELECT * FROM code_server_sessions WHERE workspace_id = ?").get(id) as any;
    return { session: publicSession(id, row, await codeServerIsRunning(id)) };
  });

  app.get("/:id/code-server/preview/logs", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id as string;
    if (!ownerWorkspace(id, u.id)) return reply.code(404).send({ error: "Not found" });
    return { output: await getCodeServerPreviewLogs(id) };
  });
};