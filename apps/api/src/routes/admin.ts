import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { db, DbUser, userToPublic, writeAudit } from "../lib/db.js";
import { requireAdmin } from "../lib/auth-helpers.js";
import { ensureMysqlUser } from "../lib/mysql.js";
import { config } from "../lib/config.js";
import {
  listAIKeysMasked, setAIKey, isEncryptionKeyWeak,
  getAllRtSettings, getRtSetting, setRtSetting, RT_DEFAULTS,
  listCustomProviders, getCustomProviderKeys, upsertCustomProvider, deleteCustomProvider,
  type RtSettingKey,
} from "../lib/ai-settings.js";
import { clientIp, loginLimiter, apiLimiter, aiLimiter } from "../lib/rate-limit.js";
import { applyAIBudgets } from "../lib/ai-prompt.js";
import { writeDomainSnippet, deleteDomainSnippet, reloadCaddy } from "../lib/caddy.js";
import { embeddingStatus, preloadModel } from "../lib/embeddings.js";
import { indexWorkspace, workspaceIndexStats, clearWorkspaceIndex } from "../lib/semantic-search.js";

// ---------------------------------------------------------------------------
// Backup / restore bridge.
//
// The API container has NO direct access to docker, mysql, or rclone, so we
// can't run backups from here. Instead we use a "trigger file" pattern: write
// a small JSON file into a host-mounted directory; a cron job on the host
// (`premdev-trigger`) picks it up, executes the action, and writes a result
// file we can read back.
//
// Mount: host /opt/premdev/data ↔ container /var/lib/premdev (compose).
// All paths below assume /var/lib/premdev exists in production. In dev (when
// running outside compose) /var/lib/premdev does not exist — endpoints
// gracefully report "not configured" instead of crashing.
// ---------------------------------------------------------------------------
const BACKUP_DATA_DIR = process.env.PREMDEV_DATA_DIR_INSIDE || "/var/lib/premdev";
const TRIGGER_DIR = path.join(BACKUP_DATA_DIR, "triggers");
const INDEX_FILE = path.join(BACKUP_DATA_DIR, "backup_index.json");
const FAVORITES_FILE = path.join(BACKUP_DATA_DIR, "backup-favorites.json");
// Written by POST /backups/run when workspaceIds is provided; read + deleted by backup.sh.
const WS_SPEC_FILE = path.join(BACKUP_DATA_DIR, "backup-ws-spec.json");

function bridgeAvailable(): boolean {
  try { return fs.statSync(TRIGGER_DIR).isDirectory(); } catch { return false; }
}

function readFavorites(): string[] {
  try { return JSON.parse(fs.readFileSync(FAVORITES_FILE, "utf8")); } catch { return []; }
}
function writeFavorites(favs: string[]) {
  const tmp = FAVORITES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify([...new Set(favs)]));
  fs.renameSync(tmp, FAVORITES_FILE);
}

// Same regex as restore.sh — accept only well-formed snapshot paths.
const SNAPSHOT_RE = /^(daily|weekly)\/[0-9]{8}-[0-9]{6}$/;

function writeTrigger(action: "backup" | "restore" | "refresh" | "delete" | "cleanup", body: Record<string, unknown>): { jobId: string; file: string } {
  if (!bridgeAvailable()) {
    throw Object.assign(new Error("backup bridge not available (host trigger dir missing)"), { statusCode: 503 });
  }
  const jobId = `${Date.now()}-${nanoid(8)}`;
  const file = path.join(TRIGGER_DIR, `${action}-${jobId}.json`);
  // Atomic write: tmp + rename so a half-written file is never picked up.
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ action, jobId, ...body, queuedAt: Date.now() }));
  fs.renameSync(tmp, file);
  return { jobId, file };
}

function readJobs(limit = 20): any[] {
  if (!bridgeAvailable()) return [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(TRIGGER_DIR); } catch { return []; }
  const jobs: any[] = [];
  for (const name of entries) {
    const full = path.join(TRIGGER_DIR, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (name.endsWith(".result.json")) {
      try {
        const j = JSON.parse(fs.readFileSync(full, "utf8"));
        jobs.push({ ...j, state: "done", _mtime: stat.mtimeMs });
      } catch { /* skip malformed */ }
    } else if (name.endsWith(".running")) {
      const m = name.match(/^(\w[\w-]*)-(.+)\.running$/);
      if (m) jobs.push({ action: m[1], jobId: m[2], state: "running", _mtime: stat.mtimeMs });
    } else if (name.endsWith(".json")) {
      const m = name.match(/^(\w[\w-]*)-(.+)\.json$/);
      if (m) jobs.push({ action: m[1], jobId: m[2], state: "queued", _mtime: stat.mtimeMs });
    }
  }
  jobs.sort((a, b) => b._mtime - a._mtime);
  return jobs.slice(0, limit).map(({ _mtime, ...rest }) => rest);
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/users", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as DbUser[];
    const result = users.map((u) => {
      const c = db.prepare("SELECT COUNT(*) as c FROM workspaces WHERE user_id = ?").get(u.id) as any;
      return { ...userToPublic(u), workspaceCount: c.c };
    });
    return { users: result };
  });

  const NewUser = z.object({
    username: z.string().min(2).regex(/^[a-zA-Z0-9_]+$/),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(["admin", "user"]).default("user"),
    quotaCpu: z.number().min(0.25).default(1),
    quotaMemMb: z.number().int().min(128).default(2048),
    quotaDiskMb: z.number().int().min(512).default(10240),
    maxWorkspaces: z.number().int().min(1).default(3),
  });

  app.post("/users", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const body = NewUser.parse(req.body);
    const exists = db.prepare("SELECT 1 FROM users WHERE username = ? OR email = ?").get(body.username, body.email);
    if (exists) return reply.code(400).send({ error: "User already exists" });
    const id = nanoid(12);
    const hash = bcrypt.hashSync(body.password, 10);
    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, quota_cpu, quota_mem_mb, quota_disk_mb, max_workspaces, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, body.username, body.email, hash, body.role, body.quotaCpu, body.quotaMemMb, body.quotaDiskMb, body.maxWorkspaces, Date.now());
    // Provision MySQL user with shared password
    if (config.MYSQL_USER_PASSWORD) {
      await ensureMysqlUser(body.username, config.MYSQL_USER_PASSWORD).catch((e) => {
        app.log.warn({ e }, "MySQL user provisioning failed");
      });
    }
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as DbUser;
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "user-create", target: u.username,
      meta: { role: u.role, quotaCpu: u.quota_cpu, quotaMemMb: u.quota_mem_mb },
    });
    return { user: userToPublic(u) };
  });

  app.delete("/users/:id", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const id = (req.params as any).id;
    if (id === a.id) return reply.code(400).send({ error: "Cannot delete yourself" });
    const target = db.prepare("SELECT username FROM users WHERE id = ?").get(id) as any;
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "user-delete", target: target?.username ?? id,
    });
    return { ok: true };
  });

  app.get("/ai-keys", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    return { keys: listAIKeysMasked(), encryptionWeak: isEncryptionKeyWeak() };
  });

  const KeyBody = z.object({
    provider: z.enum(["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox"]),
    value: z.string().max(500),
  });
  app.put("/ai-keys", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const body = KeyBody.parse(req.body);
    const trimmed = body.value.trim();
    setAIKey(body.provider, trimmed);
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: trimmed ? "ai-key-set" : "ai-key-remove",
      target: body.provider,
    });
    return { ok: true, keys: listAIKeysMasked(), encryptionWeak: isEncryptionKeyWeak() };
  });

  // === AI tool-call audit (admin view) ===
  // Filterable across all users. The frontend uses this for the admin's
  // "what did the AI do for everyone" dashboard.
  app.get("/ai-tool-calls", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const q = req.query as any;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const userFilter = typeof q.user === "string" && q.user ? q.user : null;
    const wsFilter = typeof q.workspace === "string" && q.workspace ? q.workspace : null;
    const where: string[] = [];
    const args: any[] = [];
    if (userFilter) { where.push("user_id = ?"); args.push(userFilter); }
    if (wsFilter)   { where.push("workspace_id = ?"); args.push(wsFilter); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limit);
    const rows = db.prepare(`
      SELECT t.*, u.username
      FROM ai_tool_calls t
      LEFT JOIN users u ON u.id = t.user_id
      ${whereSql}
      ORDER BY t.created_at DESC LIMIT ?
    `).all(...args);
    return { rows };
  });

  app.get("/stats", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const totalUsers = (db.prepare("SELECT COUNT(*) as c FROM users").get() as any).c;
    const totalWorkspaces = (db.prepare("SELECT COUNT(*) as c FROM workspaces").get() as any).c;
    const runningWorkspaces = (db.prepare("SELECT COUNT(*) as c FROM workspaces WHERE status = 'running'").get() as any).c;

    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const cpus = os.cpus();
    const load = os.loadavg()[0];
    const cpuPercent = Math.min(100, (load / cpus.length) * 100);

    // Real disk usage on the workspaces volume (best-effort; statvfs via fs).
    let diskUsedMb = 0;
    let diskTotalMb = 0;
    try {
      const s: any = (fs as any).statfsSync?.(config.WORKSPACES_DIR);
      if (s) {
        diskTotalMb = Math.round((s.blocks * s.bsize) / (1024 * 1024));
        diskUsedMb  = Math.round(((s.blocks - s.bavail) * s.bsize) / (1024 * 1024));
      }
    } catch {}

    return {
      totalUsers,
      totalWorkspaces,
      runningWorkspaces,
      cpuPercent,
      memUsedMb: Math.round((totalmem - freemem) / (1024 * 1024)),
      memTotalMb: Math.round(totalmem / (1024 * 1024)),
      diskUsedMb,
      diskTotalMb,
    };
  });

  // === Login attempts (admin view) ===
  // Includes both successes and failures so admins can spot brute-force
  // attempts (many fails from one IP) and verify legitimate logins.
  app.get("/login-attempts", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const q = req.query as any;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const ipFilter = typeof q.ip === "string" && q.ip ? q.ip : null;
    const onlyFails = q.onlyFails === "1" || q.onlyFails === "true";
    const where: string[] = [];
    const args: any[] = [];
    if (ipFilter) { where.push("ip = ?"); args.push(ipFilter); }
    if (onlyFails) { where.push("ok = 0"); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limit);
    const rows = db.prepare(`
      SELECT * FROM login_attempts ${whereSql}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args);
    // Aggregate fails per IP in last 24h to flag suspect attackers.
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const topFails = db.prepare(`
      SELECT ip, COUNT(*) as fails
      FROM login_attempts
      WHERE ok = 0 AND created_at > ?
      GROUP BY ip ORDER BY fails DESC LIMIT 10
    `).all(cutoff);
    return { rows, topFails };
  });

  // === Generic security/admin audit log (admin view) ===
  app.get("/audit-log", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const q = req.query as any;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const action = typeof q.action === "string" && q.action ? q.action : null;
    const actor = typeof q.actor === "string" && q.actor ? q.actor : null;
    const where: string[] = [];
    const args: any[] = [];
    if (action) { where.push("action = ?"); args.push(action); }
    if (actor)  { where.push("actor_username = ?"); args.push(actor); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limit);
    const rows = db.prepare(`
      SELECT * FROM audit_log ${whereSql}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args);
    return { rows };
  });

  // ===== Backups (R2) =====================================================
  // List of snapshots — read from the index file maintained by
  // /usr/local/sbin/premdev-refresh-index (cron + post-backup hook).
  app.get("/backups", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    if (!bridgeAvailable()) {
      return { configured: false, snapshots: [], jobs: [], favorites: [], reason: "host bridge not mounted (dev mode?)" };
    }
    let index: any = { configured: false, snapshots: [], updatedAt: 0 };
    try {
      index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    } catch {
      return { configured: false, snapshots: [], jobs: readJobs(), favorites: readFavorites(), reason: "index not built yet — click Refresh" };
    }
    return { ...index, jobs: readJobs(), favorites: readFavorites() };
  });

  // List all workspaces for the backup workspace selector.
  app.get("/backups/workspaces", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const rows = db.prepare(`
      SELECT w.id, w.name, u.username
      FROM workspaces w JOIN users u ON u.id = w.user_id
      ORDER BY u.username, w.name
    `).all() as { id: string; name: string; username: string }[];
    return { workspaces: rows };
  });

  // Trigger a backup now — uses saved ws-spec if present (see GET/POST /backups/ws-spec).
  app.post("/backups/run", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    try {
      let partial = false;
      try { const s = JSON.parse(fs.readFileSync(WS_SPEC_FILE, "utf8")); partial = !!(s?.workspaceIds?.length); } catch { /* ok */ }
      const j = writeTrigger("backup", { requestedBy: a.username, partial });
      writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "backup-run", target: j.jobId });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // Read the persistent workspace backup selection.
  app.get("/backups/ws-spec", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    try {
      const s = JSON.parse(fs.readFileSync(WS_SPEC_FILE, "utf8"));
      return { workspaceIds: s?.workspaceIds ?? [] };
    } catch {
      return { workspaceIds: [] };
    }
  });

  // Save the persistent workspace backup selection.
  // Send [] or omit workspaceIds to go back to full-backup (deletes spec file).
  app.post("/backups/ws-spec", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { workspaceIds } = z.object({ workspaceIds: z.array(z.string()) }).parse(req.body);
    if (workspaceIds.length) {
      const tmp = WS_SPEC_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ workspaceIds }));
      fs.renameSync(tmp, WS_SPEC_FILE);
    } else {
      try { fs.unlinkSync(WS_SPEC_FILE); } catch { /* already gone */ }
    }
    writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "backup-ws-spec-save", meta: { count: workspaceIds.length } });
    return { ok: true, workspaceIds };
  });

  // Add a snapshot to favorites — exempt from retention pruning.
  app.post("/backups/favorites", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { snapshot } = z.object({ snapshot: z.string().regex(SNAPSHOT_RE) }).parse(req.body);
    const favs = readFavorites();
    if (!favs.includes(snapshot)) { favs.push(snapshot); writeFavorites(favs); }
    return { ok: true, favorites: favs };
  });

  // Remove a snapshot from favorites.
  app.delete("/backups/favorites/:snapshot/:ts", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { snapshot, ts } = req.params as { snapshot: string; ts: string };
    const path_ = `${snapshot}/${ts}`;
    if (!SNAPSHOT_RE.test(path_)) return reply.code(400).send({ error: "invalid snapshot path" });
    writeFavorites(readFavorites().filter((f) => f !== path_));
    return { ok: true, favorites: readFavorites() };
  });

  // Refresh the snapshot index from R2 (cheap; just rclone lsjson).
  app.post("/backups/refresh", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    try {
      const j = writeTrigger("refresh", { requestedBy: a.username });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // Delete a snapshot from R2.
  app.delete("/backups/:snapshot/:ts", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { snapshot, ts } = req.params as { snapshot: string; ts: string };
    const path_ = `${snapshot}/${ts}`;
    if (!SNAPSHOT_RE.test(path_)) {
      return reply.code(400).send({ error: "invalid snapshot path" });
    }
    try {
      const j = writeTrigger("delete", { snapshot: path_, requestedBy: a.username });
      writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "backup-delete", target: path_ });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // ===== System maintenance =================================================
  // Trigger an on-demand Docker cleanup (prune containers/images/builder/
  // volumes). The host runner executes /usr/local/sbin/premdev-docker-cleanup
  // and returns the freed bytes. Same daily script also runs from cron.
  app.post("/system/cleanup", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    try {
      const j = writeTrigger("cleanup", { requestedBy: a.username });
      writeAudit({
        actorId: a.id, actorUsername: a.username, ip: clientIp(req),
        action: "system-cleanup", target: j.jobId,
      });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // Restore from a specific snapshot. DESTRUCTIVE — gated by an explicit
  // confirmation phrase the UI requires the operator to type.
  app.post("/backups/restore", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const body = z.object({
      snapshot: z.string().regex(SNAPSHOT_RE, "snapshot must be (daily|weekly)/YYYYMMDD-HHMMSS"),
      confirm:  z.string(),
    }).parse(req.body);
    // Belt-and-braces: require typed confirmation matching the snapshot
    // path. Stops "click the wrong row" mishaps.
    if (body.confirm !== body.snapshot) {
      return reply.code(400).send({ error: "confirm must equal snapshot path" });
    }
    try {
      const j = writeTrigger("restore", { snapshot: body.snapshot, requestedBy: a.username });
      writeAudit({
        actorId: a.id, actorUsername: a.username, ip: clientIp(req),
        action: "backup-restore", target: body.snapshot, meta: { jobId: j.jobId },
      });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // -------------------------------------------------------------------------
  // Semantic search admin (TODO #2 — token-saving feature).
  //
  // The embedding model is loaded lazily on first /chat call. These endpoints
  // give the operator visibility (status + per-workspace stats) and manual
  // controls (preload, reindex, clear) without having to SSH into the box.
  // -------------------------------------------------------------------------

  app.get("/semantic-search/status", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const model = embeddingStatus();
    // Per-workspace breakdown joined with the user that owns each workspace.
    const rows = db.prepare(`
      SELECT w.id, w.name, w.user_id, u.username
      FROM workspaces w
      LEFT JOIN users u ON u.id = w.user_id
      ORDER BY u.username, w.name
    `).all() as Array<{ id: string; name: string; user_id: string; username: string | null }>;
    const workspaces = rows.map((r) => {
      const stats = workspaceIndexStats(r.id);
      return {
        id: r.id,
        name: r.name,
        username: r.username,
        ...stats,
      };
    });
    const totals = workspaces.reduce(
      (acc, w) => ({
        chunks: acc.chunks + w.chunks,
        files: acc.files + w.files,
        dbBytes: acc.dbBytes + w.dbBytes,
        indexed: acc.indexed + (w.exists && w.chunks > 0 ? 1 : 0),
      }),
      { chunks: 0, files: 0, dbBytes: 0, indexed: 0 }
    );
    return { model, workspaces, totals: { ...totals, totalWorkspaces: workspaces.length } };
  });

  app.post("/semantic-search/preload", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    // Fire-and-forget — model load can take ~30s on first run (download).
    // The status endpoint will report state="loading" → "ready".
    preloadModel().catch((e) => {
      // Errors are surfaced via embeddingStatus().error on the next status poll.
      // Logging here is best-effort.
      // eslint-disable-next-line no-console
      console.error("[semantic-search] preload failed:", e);
    });
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "semantic-preload", target: "model",
    });
    return { ok: true, started: true };
  });

  // Workspace IDs are nanoid(16) — strict allowlist defends path joining in
  // semantic-search helpers from `../`-style escapes if a malformed param
  // ever slips past the SQL existence check.
  const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  app.post("/semantic-search/reindex/:workspaceId", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { workspaceId } = req.params as { workspaceId: string };
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return reply.code(400).send({ error: "invalid workspaceId" });
    }
    // Verify the workspace exists; gives a clean 404 instead of an empty
    // index DB getting created in /tmp by mistake.
    const w = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id?: string } | undefined;
    if (!w?.id) return reply.code(404).send({ error: "workspace not found" });
    try {
      const result = await indexWorkspace(workspaceId);
      writeAudit({
        actorId: a.id, actorUsername: a.username, ip: clientIp(req),
        action: "semantic-reindex", target: workspaceId,
        // Spread into a fresh object literal so the named IndexResult
        // interface widens to the Record<string, unknown> writeAudit expects.
        meta: { ...result } as Record<string, unknown>,
      });
      return { ok: true, ...result };
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message || "reindex failed" });
    }
  });

  app.delete("/semantic-search/index/:workspaceId", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { workspaceId } = req.params as { workspaceId: string };
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return reply.code(400).send({ error: "invalid workspaceId" });
    }
    // Match reindex semantics: 404 for unknown ids so the audit log doesn't
    // record fake "success" entries (and so we don't silently no-op when an
    // operator typos a workspace id).
    const w = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id?: string } | undefined;
    if (!w?.id) return reply.code(404).send({ error: "workspace not found" });
    clearWorkspaceIndex(workspaceId);
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "semantic-clear", target: workspaceId,
    });
    return { ok: true };
  });

  // ── AI runtime settings (token budgets + rate limiters) ──────────────────
  app.get("/ai-runtime-settings", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    return { settings: getAllRtSettings(), defaults: RT_DEFAULTS };
  });

  app.put("/ai-runtime-settings", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const body = req.body as Record<string, unknown>;
    const validKeys = new Set(Object.keys(RT_DEFAULTS));
    const saved: Record<string, number> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!validKeys.has(k)) continue;
      const n = Number(v);
      // 0 is allowed — it signals "unlimited" for token caps and rate limiters.
      if (isNaN(n) || n < 0) continue;
      setRtSetting(k as RtSettingKey, n);
      saved[k] = n;
    }
    // Apply budget changes to in-memory _rt immediately (no restart needed).
    applyAIBudgets({
      MAX_HISTORY_CHARS:        getRtSetting("ai.budget.maxHistoryChars"),
      MAX_HISTORY_MESSAGES:     getRtSetting("ai.budget.maxHistoryMessages"),
      MAX_SINGLE_MESSAGE_CHARS: getRtSetting("ai.budget.maxSingleMessageChars"),
      MAX_TOKENS_DEFAULT:       getRtSetting("ai.budget.maxTokensDefault"),
      MAX_TOKENS_AUTOPILOT:     getRtSetting("ai.budget.maxTokensAutopilot"),
    });
    // Apply rate-limiter changes immediately.
    loginLimiter.reconfigure(
      getRtSetting("ai.rate.loginCapacity"),
      getRtSetting("ai.rate.loginRefillPerSec"),
    );
    apiLimiter.reconfigure(
      getRtSetting("ai.rate.apiCapacity"),
      getRtSetting("ai.rate.apiRefillPerSec"),
    );
    aiLimiter.reconfigure(
      getRtSetting("ai.rate.aiCapacity"),
      getRtSetting("ai.rate.aiRefillPerSec"),
    );
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "ai-settings-update", meta: saved as any,
    });
    return { ok: true, settings: getAllRtSettings() };
  });

  // ── Custom Domains ─────────────────────────────────────────────────────
  // Admin can register additional base domains pointing to this PremDev
  // instance (e.g. "premdev.xyz"). PRIMARY_DOMAIN is always active and is
  // not stored here. Users then pick a domain when setting a custom subdomain.

  app.get("/domains", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const rows = db.prepare("SELECT * FROM custom_domains ORDER BY added_at ASC").all();
    return { primary: config.PRIMARY_DOMAIN, domains: rows };
  });

  app.post("/domains", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { name } = z.object({ name: z.string().min(3).max(100) }).parse(req.body);
    const clean = name.toLowerCase().trim();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(clean)) {
      return reply.code(400).send({ error: "Format domain tidak valid (contoh: premdev.xyz)" });
    }
    if (clean === config.PRIMARY_DOMAIN.toLowerCase()) {
      return reply.code(400).send({ error: "Domain utama sudah aktif secara otomatis" });
    }
    const { nanoid: _nanoid } = await import("nanoid");
    try {
      db.prepare("INSERT INTO custom_domains (id, name, active, added_at) VALUES (?, ?, 1, ?)").run(_nanoid(), clean, Date.now());
    } catch (e: any) {
      if (String(e?.message ?? "").includes("UNIQUE")) {
        return reply.code(409).send({ error: "Domain sudah terdaftar" });
      }
      throw e;
    }
    writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "domain-add", meta: { name: clean } as any });
    writeDomainSnippet(clean);
    reloadCaddy().catch(() => {});
    return { ok: true };
  });

  app.patch("/domains/:name/toggle", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const name = (req.params as any).name;
    const row = db.prepare("SELECT active FROM custom_domains WHERE name = ?").get(name) as { active: number } | undefined;
    if (!row) return reply.code(404).send({ error: "Domain tidak ditemukan" });
    const next = row.active ? 0 : 1;
    db.prepare("UPDATE custom_domains SET active = ? WHERE name = ?").run(next, name);
    writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "domain-toggle", meta: { name, active: next } as any });
    if (next === 1) writeDomainSnippet(name); else deleteDomainSnippet(name);
    reloadCaddy().catch(() => {});
    return { ok: true, active: next === 1 };
  });

  app.delete("/domains/:name", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const name = (req.params as any).name;
    db.prepare("DELETE FROM custom_domains WHERE name = ?").run(name);
    writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "domain-delete", meta: { name } as any });
    deleteDomainSnippet(name);
    reloadCaddy().catch(() => {});
    return { ok: true };
  });

  // ── Custom AI Providers (OpenAI-compatible, added via Admin UI) ─────────────
  // Admin dapat tambah provider AI baru (Ollama, Together AI, LM Studio, dsb)
  // yang kompatibel dengan OpenAI API format. API key disimpan terenkripsi.

  const CustomProviderBody = z.object({
    name: z.string().min(1).max(100),
    base_url: z.string().min(1).max(500),
    // api_keys: array of plaintext keys (preferred multi-key form)
    api_keys: z.array(z.string().max(500)).optional(),
    // legacy single-key field still accepted for backward compat
    api_key: z.string().max(500).optional().default(""),
    models: z.array(z.string().max(200)).max(100).optional().default([]),
    default_model: z.string().max(200).optional().default(""),
    docs_url: z.string().max(500).optional().default(""),
    enabled: z.boolean().optional().default(true),
    sort_order: z.number().int().optional().default(0),
  });

  app.get("/custom-providers", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const providers = listCustomProviders();
    return { providers };
  });

  app.post("/custom-providers", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const body = CustomProviderBody.parse(req.body);
    const id = upsertCustomProvider({
      name: body.name,
      base_url: body.base_url,
      api_keys: body.api_keys ?? (body.api_key ? [body.api_key] : []),
      models: body.models,
      default_model: body.default_model,
      docs_url: body.docs_url,
      enabled: body.enabled,
      sort_order: body.sort_order,
    });
    writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "custom-provider-add", target: body.name });
    return { ok: true, id, providers: listCustomProviders() };
  });

  app.put("/custom-providers/:id", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { id } = req.params as { id: string };
    const existing = listCustomProviders().find((p) => p.id === id);
    if (!existing) return reply.code(404).send({ error: "Provider tidak ditemukan" });
    const body = CustomProviderBody.parse(req.body);
    upsertCustomProvider({
      id,
      name: body.name,
      base_url: body.base_url,
      api_keys: body.api_keys ?? (body.api_key ? [body.api_key] : undefined),
      models: body.models,
      default_model: body.default_model,
      docs_url: body.docs_url,
      enabled: body.enabled,
      sort_order: body.sort_order,
    });
    writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "custom-provider-update", target: body.name });
    return { ok: true, providers: listCustomProviders() };
  });

  app.delete("/custom-providers/:id", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { id } = req.params as { id: string };
    const existing = listCustomProviders().find((p) => p.id === id);
    if (!existing) return reply.code(404).send({ error: "Provider tidak ditemukan" });
    deleteCustomProvider(id);
    writeAudit({ actorId: a.id, actorUsername: a.username, ip: clientIp(req), action: "custom-provider-delete", target: existing.name });
    return { ok: true, providers: listCustomProviders() };
  });

  // Get masked API keys for a custom provider (admin-only) — returns list
  app.get("/custom-providers/:id/keys", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { id } = req.params as { id: string };
    const keys = getCustomProviderKeys(id);
    const mask = (s: string) =>
      s.length <= 8 ? "*".repeat(s.length)
        : s.slice(0, 4) + "•".repeat(Math.min(s.length - 8, 16)) + s.slice(-4);
    return { keys: keys.map(mask), count: keys.length };
  });

  // Keep the old single-key endpoint for backward compat
  app.get("/custom-providers/:id/key", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { id } = req.params as { id: string };
    const keys = getCustomProviderKeys(id);
    const mask = (s: string) =>
      s.length <= 8 ? "*".repeat(s.length)
        : s.slice(0, 4) + "•".repeat(Math.min(s.length - 8, 16)) + s.slice(-4);
    const key = keys[0] ?? "";
    return { masked: key ? mask(key) : "", configured: keys.length > 0 };
  });
};
