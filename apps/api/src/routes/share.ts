/**
 * share.ts — workspace read-only share tokens.
 *
 * POST   /workspaces/:id/share              → create token
 * POST   /workspaces/:id/share/revoke       → revoke token
 * GET    /workspaces/:id/share              → list tokens
 * GET    /share/:token                      → public workspace info (no auth)
 */
import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import { db } from "../lib/db.js";
import { requireUser } from "../lib/auth-helpers.js";

async function getWorkspaceOwned(req: any, reply: any, workspaceId: string): Promise<any | null> {
  const user = await requireUser(req, reply);
  if (!user) return null;
  const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as any;
  if (!ws) { reply.code(404).send({ error: "Workspace not found" }); return null; }
  if (ws.user_id !== user.id && user.role !== "admin") {
    reply.code(403).send({ error: "Forbidden" }); return null;
  }
  return ws;
}

export const shareRoutes: FastifyPluginAsync = async (fastify) => {

  // Create share token
  fastify.post<{ Params: { id: string }; Body: { label?: string } }>(
    "/:id/share",
    async (req, reply) => {
      const ws = await getWorkspaceOwned(req, reply, req.params.id);
      if (!ws) return;
      const token = nanoid(32);
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        "INSERT INTO share_tokens (token, workspace_id, created_by, label, created_at) VALUES (?,?,?,?,?)"
      ).run(token, ws.id, ws.user_id, req.body?.label ?? null, now);
      return { token };
    },
  );

  // Revoke token
  fastify.post<{ Params: { id: string }; Body: { token: string } }>(
    "/:id/share/revoke",
    async (req, reply) => {
      const ws = await getWorkspaceOwned(req, reply, req.params.id);
      if (!ws) return;
      const { token } = req.body ?? {};
      if (!token) return reply.code(400).send({ error: "token required" });
      db.prepare("DELETE FROM share_tokens WHERE token = ? AND workspace_id = ?").run(token, ws.id);
      return { ok: true };
    },
  );

  // List tokens
  fastify.get<{ Params: { id: string } }>(
    "/:id/share",
    async (req, reply) => {
      const ws = await getWorkspaceOwned(req, reply, req.params.id);
      if (!ws) return;
      const tokens = db.prepare("SELECT token, label, created_at FROM share_tokens WHERE workspace_id = ? ORDER BY created_at DESC").all(ws.id);
      return { tokens };
    },
  );
};

// Public share token lookup — registered separately (no /workspaces prefix)
export const publicShareRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { token: string } }>(
    "/share/:token",
    async (req, reply) => {
      const row = db.prepare("SELECT * FROM share_tokens WHERE token = ?").get(req.params.token) as any;
      if (!row) return reply.code(404).send({ error: "Share link not found or expired" });
      const ws = db.prepare("SELECT id, name, template, status, preview_url FROM workspaces WHERE id = ?").get(row.workspace_id) as any;
      if (!ws) return reply.code(404).send({ error: "Workspace not found" });
      return { workspace: ws, label: row.label };
    },
  );
};
