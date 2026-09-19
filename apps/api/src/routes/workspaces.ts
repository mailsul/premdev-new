import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import yauzl from "yauzl";
import { simpleGit } from "simple-git";
import { db, DbWorkspace, workspaceToPublic, validateSubdomainLabel, dnsSafe } from "../lib/db.js";
import { requireUser } from "../lib/auth-helpers.js";
import { applyTemplate, getTemplate } from "../lib/templates.js";
import { detectRunCommand, detectHardcodedPort, fixRunCommandHost } from "../lib/project-hints.js";
import { readWorkspaceConfig, ensureWorkspaceConfig, configPath, CONFIG_FILENAME, patchWorkspaceConfig } from "../lib/workspace-config.js";
import {
  ensureWorkspaceDir,
  workspacePath,
  isDocker,
  startContainer,
  stopContainer,
  startLocal,
  stopLocal,
  isLocalRunning,
  getContainerLogs,
  runOneOff,
  stopShellContainer,
} from "../lib/runtime.js";
import { config } from "../lib/config.js";
import { closeWorkspaceDb } from "../lib/semantic-search.js";
import { createProjectDb, dropProjectDb, ensureMysqlUser, ensureWorkspaceAdminUser, warmupMysqlUserCache, runWorkspaceQuery } from "../lib/mysql.js";
import { createCheckpoint, listCheckpoints, listCheckpointFiles, restoreCheckpoint, deleteCheckpoint, deleteAllCheckpointsFor } from "../lib/checkpoints.js";
import { checkSqlReadOnly } from "../lib/sql-safety.js";

/**
 * Build the full set of MySQL env vars to inject into a workspace container.
 * Provides both internal (Docker hostname) and public (VPS domain) connection
 * strings so code inside the container and tools outside both just work.
 */
function buildDbEnvVars(dbName: string, ownerUsername: string): Record<string, string> {
  const dbUser = config.MYSQL_WORKSPACE_USER || ownerUsername.replace(/[^a-zA-Z0-9_]/g, "");
  const dbPass = config.MYSQL_WORKSPACE_PASSWORD || config.MYSQL_USER_PASSWORD;
  const host   = config.MYSQL_HOST || "mysql";
  const port   = config.MYSQL_PORT || 3306;
  const pubHost = config.MYSQL_PUBLIC_HOST || config.PRIMARY_DOMAIN;
  return {
    DATABASE_NAME:       dbName,
    DB_NAME:             dbName,
    DB_HOST:             host,
    DB_PUBLIC_HOST:      pubHost,
    DB_PORT:             String(port),
    DB_USER:             dbUser,
    DB_PASS:             dbPass,
    DATABASE_URL:        `mysql://${dbUser}:${dbPass}@${host}:${port}/${dbName}`,
    DATABASE_PUBLIC_URL: `mysql://${dbUser}:${dbPass}@${pubHost}:${port}/${dbName}`,
  };
}

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const list = db
      .prepare("SELECT * FROM workspaces WHERE user_id = ? ORDER BY created_at DESC")
      .all(u.id) as DbWorkspace[];
    return { workspaces: list.map(workspaceToPublic) };
  });

  app.get("/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    return { workspace: workspaceToPublic(w) };
  });

  // ── Persistent AI chat history ─────────────────────────────────────────────
  app.get("/:id/chat-history", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const tabId = (req.query as any).tab || "default";
    const w = db.prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id);
    if (!w) return reply.code(404).send({ error: "Not found" });
    const row = db.prepare("SELECT messages_json FROM chat_history WHERE workspace_id = ? AND tab_id = ?").get(id, tabId) as any;
    return { messages: row ? JSON.parse(row.messages_json) : [] };
  });

  app.put("/:id/chat-history", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const tabId = (req.query as any).tab || "default";
    const body = req.body as any;
    const w = db.prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id);
    if (!w) return reply.code(404).send({ error: "Not found" });
    const json = JSON.stringify(Array.isArray(body?.messages) ? body.messages : []);
    db.prepare(`
      INSERT INTO chat_history (workspace_id, tab_id, messages_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, tab_id) DO UPDATE SET messages_json = excluded.messages_json, updated_at = excluded.updated_at
    `).run(id, tabId, json, Date.now());
    return { ok: true };
  });

  app.delete("/:id/chat-history", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const tabId = (req.query as any).tab;
    const w = db.prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id);
    if (!w) return reply.code(404).send({ error: "Not found" });
    if (tabId) {
      db.prepare("DELETE FROM chat_history WHERE workspace_id = ? AND tab_id = ?").run(id, tabId);
    } else {
      db.prepare("DELETE FROM chat_history WHERE workspace_id = ?").run(id);
    }
    return { ok: true };
  });

  // Rename workspace (update name only)
  app.put("/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const body = req.body as any;
    const name = String(body?.name ?? "").trim();
    if (!name || name.length > 64) return reply.code(400).send({ error: "Invalid name" });
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const existing = db.prepare("SELECT id FROM workspaces WHERE user_id = ? AND name = ? AND id != ?").get(u.id, name, id);
    if (existing) return reply.code(409).send({ error: `Kamu sudah punya workspace bernama "${name}". Pakai nama lain.` });
    db.prepare("UPDATE workspaces SET name = ? WHERE id = ? AND user_id = ?").run(name, id, u.id);
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  // Initialize a bare git repo in workspaceDir.
  // Uses --template=/dev/null to skip copying hook templates from
  // /usr/share/git-core — those directories are owned by root and cause
  // "Permission denied" when the premdev user tries to write inside them.
  // UID/GID of the premdev user inside workspace containers.
  const PREMDEV_UID = 1000;
  const PREMDEV_GID = 1000;

  function initWorkspaceGit(workspaceDir: string) {
    try {
      const gitDir = path.join(workspaceDir, ".git");
      // Remove any broken .git owned by root from a previous failed attempt.
      if (fs.existsSync(gitDir)) {
        fs.rmSync(gitDir, { recursive: true, force: true });
      }
      // Run git as premdev (UID/GID 1000) so every file inside .git is
      // owned by 1000:1000 from the start — no post-hoc chown needed.
      // --template=/dev/null skips copying hook templates from
      // /usr/share/git-core (owned by root → EACCES inside the container).
      const execOpts = { cwd: workspaceDir, uid: PREMDEV_UID, gid: PREMDEV_GID };
      execSync("git init --template=/dev/null", execOpts);
      execSync('git config user.email "premdev@local"', execOpts);
      execSync('git config user.name "PremDev"', execOpts);
      // Mark /workspace as safe in the LOCAL .git/config so git doesn't
      // complain about "dubious ownership" when the workspace dir is owned
      // by root but git runs as premdev (UID 1000).
      execSync("git config --local --add safe.directory /workspace", execOpts);
      // Create a sensible .gitignore if none exists yet.
      const giPath = path.join(workspaceDir, ".gitignore");
      if (!fs.existsSync(giPath)) {
        fs.writeFileSync(giPath, [
          "node_modules/",
          "__pycache__/",
          "*.pyc",
          ".env",
          ".env.*",
          "!.env.example",
          "dist/",
          "build/",
          ".cache/",
          "*.log",
          ".premdev",
        ].join("\n") + "\n");
        try { fs.chownSync(giPath, PREMDEV_UID, PREMDEV_GID); } catch {}
      }
    } catch {
      // Non-fatal — workspace still usable even without git.
    }
  }

  const Create = z.object({
    name: z.string().min(1).max(64),
    template: z.string().default("blank"),
    gitUrl: z.string().optional(),
  });

  app.post("/", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = Create.parse(req.body);
    const duplicate = db.prepare("SELECT id FROM workspaces WHERE user_id = ? AND name = ?").get(u.id, body.name);
    if (duplicate) return reply.code(409).send({ error: `Kamu sudah punya workspace bernama "${body.name}". Pakai nama lain.` });
    const id = nanoid(10);
    const dir = ensureWorkspaceDir(id);

    if (body.template === "git" && body.gitUrl) {
      try {
        await simpleGit().clone(body.gitUrl, dir);
      } catch (e: any) {
        return reply.code(400).send({ error: `Git clone failed: ${e.message}` });
      }
    } else if (body.template === "blank") {
      initWorkspaceGit(dir);
    } else {
      applyTemplate(dir, body.template);
      initWorkspaceGit(dir);
    }

    const tmpl = getTemplate(body.template === "git" || body.template === "zip" ? "blank" : body.template);
    const dbName = await createProjectDb(u.username, body.name).catch(() => null);

    // Persist NULL when the template's runCommand is just the placeholder, so
    // resolveRunCommand at start time falls through to detect/template logic
    // instead of treating the placeholder as a "user override".
    const PLACEHOLDER = "echo 'No run command set'";
    const initialRunCommand =
      tmpl.runCommand && tmpl.runCommand !== PLACEHOLDER ? tmpl.runCommand : null;

    // Write a Replit-style `.premdev` populated from the template so the AI
    // (and the human reading the file) can immediately tell the language,
    // entrypoint, modules, and run command.
    try {
      const dbEnv = dbName ? buildDbEnvVars(dbName, u.username) : {};
      ensureWorkspaceConfig(dir, {
        run: initialRunCommand ?? "",
        language: tmpl.language,
        entrypoint: tmpl.entrypoint,
        modules: tmpl.modules,
        env: dbEnv,
      });
    } catch {}
    const dbEnvForDb = dbName ? buildDbEnvVars(dbName, u.username) : {};
    db.prepare(`
      INSERT INTO workspaces (id, user_id, name, template, status, run_command, env_vars, created_at)
      VALUES (?, ?, ?, ?, 'stopped', ?, ?, ?)
    `).run(id, u.id, body.name, body.template, initialRunCommand, JSON.stringify(dbEnvForDb), Date.now());

    const w = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(w) };
  });

  // Shared helper: extract a zip buffer into targetDir with zip-slip protection.
  async function extractZipBuffer(zipBuf: Buffer, targetDir: string, scratchId: string) {
    const zipPath = path.join(targetDir, "..", `${scratchId}.zip`);
    fs.writeFileSync(zipPath, zipBuf);
    const rootDir = path.resolve(targetDir);
    function safeJoin(name: string): string | null {
      if (!name || path.isAbsolute(name) || name.includes("\0")) return null;
      const candidate = path.resolve(rootDir, name);
      const rel = path.relative(rootDir, candidate);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      return candidate;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
          if (err) return reject(err);
          zip.readEntry();
          zip.on("entry", (entry) => {
            const out = safeJoin(entry.fileName);
            if (!out) { zip.readEntry(); return; }
            if (/\/$/.test(entry.fileName)) {
              fs.mkdirSync(out, { recursive: true });
              zip.readEntry();
            } else {
              fs.mkdirSync(path.dirname(out), { recursive: true });
              zip.openReadStream(entry, (e2, rs) => {
                if (e2) return reject(e2);
                const ws = fs.createWriteStream(out);
                rs.pipe(ws).on("close", () => zip.readEntry());
              });
            }
          });
          zip.on("end", () => resolve());
          zip.on("error", reject);
        });
      });
    } finally {
      try { fs.unlinkSync(zipPath); } catch {}
    }
  }

  app.post("/upload", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const parts = req.parts();
    let name = "";
    let zipBuf: Buffer | null = null;
    for await (const p of parts) {
      if (p.type === "field" && p.fieldname === "name") name = String((p as any).value);
      if (p.type === "file" && p.fieldname === "file") {
        zipBuf = await (p as any).toBuffer();
      }
    }
    if (!name || !zipBuf) return reply.code(400).send({ error: "Missing name or file" });

    const dupUpload = db.prepare("SELECT id FROM workspaces WHERE user_id = ? AND name = ?").get(u.id, name);
    if (dupUpload) return reply.code(409).send({ error: `Kamu sudah punya workspace bernama "${name}". Pakai nama lain.` });

    const id = nanoid(10);
    const dir = ensureWorkspaceDir(id);
    await extractZipBuffer(zipBuf, dir, id);
    initWorkspaceGit(dir);

    const dbName = await createProjectDb(u.username, name).catch(() => null);
    const dbEnvZip = dbName ? buildDbEnvVars(dbName, u.username) : {};
    db.prepare(`
      INSERT INTO workspaces (id, user_id, name, template, status, run_command, env_vars, created_at)
      VALUES (?, ?, ?, 'zip', 'stopped', NULL, ?, ?)
    `).run(id, u.id, name, JSON.stringify(dbEnvZip), Date.now());

    const w = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(w) };
  });

  // Upload a zip into an EXISTING workspace (overlay/extract on top).
  app.post("/:id/upload-zip", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    let zipBuf: Buffer | null = null;
    for await (const p of req.parts()) {
      if (p.type === "file" && p.fieldname === "file") {
        zipBuf = await (p as any).toBuffer();
      }
    }
    if (!zipBuf) return reply.code(400).send({ error: "Missing file" });

    const dir = workspacePath(id);
    if (!fs.existsSync(dir)) ensureWorkspaceDir(id);
    try {
      await extractZipBuffer(zipBuf, dir, `upload-${nanoid(6)}`);
    } catch (e: any) {
      return reply.code(400).send({ error: `Extract failed: ${e.message ?? e}` });
    }
    return { ok: true };
  });

  app.post("/:id/start", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    db.prepare("UPDATE workspaces SET status = 'starting', last_active_at = ? WHERE id = ?").run(Date.now(), id);

    const dir = workspacePath(id);
    const tmpl = getTemplate(w.template);
    const rawCmd = resolveRunCommand(w, tmpl, dir);
    const cmd = rawCmd ? fixRunCommandHost(rawCmd) : rawCmd;
    const cfg = readWorkspaceConfig(dir);

    // ── Multi-process resolution ──────────────────────────────────────────
    // If .premdev has a `processes` map, use the first entry as the main
    // port and build a preview_ports JSON map for all processes.
    const processes = cfg?.processes && Object.keys(cfg.processes).length > 0
      ? cfg.processes
      : undefined;

    let port: number;
    let previewPortsJson: string | null = null;

    if (processes) {
      const entries = Object.entries(processes);
      // If .premdev has a top-level `port` field, use it as the main preview
      // port regardless of process order. Without it, the first process wins.
      const topLevelPort = (cfg?.port && Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536)
        ? cfg.port : null;
      port = topLevelPort ?? entries[0][1].port;
      const portMap: Record<string, number> = {};
      for (const [name, proc] of entries) portMap[name] = proc.port;
      previewPortsJson = JSON.stringify(portMap);
    } else {
      // Port resolution priority (single-process, unchanged):
      //   1. .premdev explicit `port` field
      //   2. Hard-coded port auto-detected in entry file
      //   3. Template default
      port = (cfg?.port && Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536)
        ? cfg.port
        : (detectHardcodedPort(dir, cmd ?? undefined) ?? tmpl.port);
    }

    try {
      // Self-heal: make sure the per-user MySQL account + project DB exist
      // before injecting credentials into the workspace env. Idempotent — safe
      // to call on every start. Both calls swallow errors so a missing
      // MYSQL_USER_PASSWORD or unreachable mysql doesn't block code execution.
      if (config.MYSQL_USER_PASSWORD) {
        await ensureMysqlUser(u.username, config.MYSQL_USER_PASSWORD).catch(() => {});
      }
      // Ensure dedicated workspace admin user exists and has correct grants.
      if (config.MYSQL_WORKSPACE_USER && config.MYSQL_WORKSPACE_PASSWORD) {
        await ensureWorkspaceAdminUser(
          config.MYSQL_WORKSPACE_USER,
          config.MYSQL_WORKSPACE_PASSWORD,
          u.username,
        ).catch(() => {});
        // Warmup caching_sha2_password cache via SSL so Python and other
        // clients can connect without SSL/RSA after this point.
        await warmupMysqlUserCache(
          config.MYSQL_WORKSPACE_USER,
          config.MYSQL_WORKSPACE_PASSWORD,
        ).catch(() => {});
      } else if (config.MYSQL_USER_PASSWORD) {
        // Fallback warmup using per-user account.
        await warmupMysqlUserCache(u.username, config.MYSQL_USER_PASSWORD).catch(() => {});
      }
      await createProjectDb(u.username, w.name).catch(() => {});

      if (isDocker()) {
        const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id) as any;
        await startContainer({
          workspaceId: id,
          username: u.username,
          cpu: userRow.quota_cpu,
          memMb: userRow.quota_mem_mb,
          diskMb: userRow.quota_disk_mb,
          port,
          envVars: resolveEnvVars(w, dir),
          runCommand: processes ? undefined : cmd,
          processes,
        });
      } else {
        startLocal(id, cmd, dir, port);
      }
      db.prepare(
        "UPDATE workspaces SET status = 'running', preview_port = ?, preview_ports = ? WHERE id = ?",
      ).run(port, previewPortsJson, id);
    } catch (e: any) {
      db.prepare("UPDATE workspaces SET status = 'error' WHERE id = ?").run(id);
      return reply.code(500).send({ error: e.message });
    }
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  app.post("/:id/stop", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    if (isDocker()) await stopContainer(id);
    else stopLocal(id);

    db.prepare("UPDATE workspaces SET status = 'stopped', preview_port = NULL WHERE id = ?").run(id);
    return { ok: true };
  });

  app.post("/:id/restart", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    if (isDocker()) await stopContainer(id);
    else stopLocal(id);

    db.prepare("UPDATE workspaces SET status = 'starting', last_active_at = ? WHERE id = ?").run(Date.now(), id);

    const dir = workspacePath(id);
    const tmpl = getTemplate(w.template);
    const rawCmd2 = resolveRunCommand(w, tmpl, dir);
    const cmd2 = rawCmd2 ? fixRunCommandHost(rawCmd2) : rawCmd2;
    const cfg2 = readWorkspaceConfig(dir);

    const processes2 = cfg2?.processes && Object.keys(cfg2.processes).length > 0
      ? cfg2.processes : undefined;

    let port2: number;
    let previewPortsJson2: string | null = null;
    if (processes2) {
      const entries2 = Object.entries(processes2);
      const topLevelPort2 = (cfg2?.port && Number.isInteger(cfg2.port) && cfg2.port > 0 && cfg2.port < 65536)
        ? cfg2.port : null;
      port2 = topLevelPort2 ?? entries2[0][1].port;
      const portMap2: Record<string, number> = {};
      for (const [n, p] of entries2) portMap2[n] = p.port;
      previewPortsJson2 = JSON.stringify(portMap2);
    } else {
      port2 = (cfg2?.port && Number.isInteger(cfg2.port) && cfg2.port > 0 && cfg2.port < 65536)
        ? cfg2.port
        : (detectHardcodedPort(dir, cmd2 ?? undefined) ?? tmpl.port);
    }

    try {
      if (isDocker()) {
        const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id) as any;
        await startContainer({
          workspaceId: id,
          username: u.username,
          cpu: userRow.quota_cpu,
          memMb: userRow.quota_mem_mb,
          diskMb: userRow.quota_disk_mb,
          port: port2,
          envVars: resolveEnvVars(w, dir),
          runCommand: processes2 ? undefined : cmd2,
          processes: processes2,
        });
      } else {
        startLocal(id, cmd2, dir, port2);
      }
      db.prepare(
        "UPDATE workspaces SET status = 'running', preview_port = ?, preview_ports = ? WHERE id = ?",
      ).run(port2, previewPortsJson2, id);
    } catch (e: any) {
      db.prepare("UPDATE workspaces SET status = 'error' WHERE id = ?").run(id);
      return reply.code(500).send({ error: e.message });
    }
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  // ---------------------------------------------------------------------
  // Public list of available base domains.
  // Used by the SubdomainPanel dropdown so users can pick where their
  // workspace lives. PRIMARY_DOMAIN is always first.
  // ---------------------------------------------------------------------
  app.get("/domains", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const rows = db.prepare(
      "SELECT name FROM custom_domains WHERE active = 1 ORDER BY added_at ASC",
    ).all() as { name: string }[];
    return {
      primary: config.PRIMARY_DOMAIN,
      extras: rows.map((r) => r.name),
    };
  });

  // ---------------------------------------------------------------------
  // Custom subdomain — lets the user route this workspace under any unused
  // single-component subdomain (e.g. "myapp.flixprem.org") instead of the
  // auto-generated "<project>-<user>" form. Setting takes effect on next
  // request (proxy.ts checks custom_subdomain first).
  //
  // Reserved labels (api/admin/db/...) are rejected so a user can't shadow
  // first-party services. Collisions across workspaces return 409.
  // ---------------------------------------------------------------------
  const RESERVED_SUB_LABELS = new Set([
    "app", "admin", "db", "api", "ws", "preview", "deploy", "www",
    "mail", "smtp", "imap", "ftp", "cpanel", "phpmyadmin", "static",
    "assets", "cdn", "media", "blog", "docs", "help", "support",
  ]);

  app.get("/check-subdomain", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const q = req.query as any;
    const raw = String(q?.value ?? "").toLowerCase().trim();
    const ignoreId = q?.ignoreId ? String(q.ignoreId) : null;
    if (!raw) return { ok: false, available: false, error: "Subdomain cannot be empty" };
    const err = validateSubdomainLabel(raw);
    if (err) return { ok: false, available: false, error: err };
    if (RESERVED_SUB_LABELS.has(raw)) {
      return { ok: false, available: false, error: `"${raw}" is a reserved subdomain` };
    }
    // Two collision sources:
    //   1. another workspace already has this custom subdomain
    //   2. it would collide with the auto-generated "<proj>-<user>" form
    //      of an existing workspace (only if the requested label has the
    //      "x-y" shape, otherwise the auto-form can never collide)
    const customClash = db
      .prepare("SELECT id FROM workspaces WHERE custom_subdomain = ? AND id != ?")
      .get(raw, ignoreId ?? "") as { id: string } | undefined;
    if (customClash) {
      return { ok: false, available: false, error: "Subdomain is already taken by another workspace" };
    }
    if (raw.includes("-")) {
      // Only workspaces still on the auto form can clash with `<a>-<b>`.
      // Rows that already have a custom_subdomain set don't route via the
      // auto form anymore (see proxy.ts:resolveSubdomain), so excluding
      // them here avoids over-restricting otherwise-free labels.
      const rows = db
        .prepare(`
          SELECT w.id, w.name, u.username FROM workspaces w
          JOIN users u ON u.id = w.user_id
          WHERE w.id != ? AND w.custom_subdomain IS NULL
        `)
        .all(ignoreId ?? "") as Array<{ id: string; name: string; username: string }>;
      const autoClash = rows.find((r) => `${dnsSafe(r.name)}-${dnsSafe(r.username)}` === raw);
      if (autoClash) {
        return {
          ok: false,
          available: false,
          error: `Subdomain "${raw}" is already used by the default URL of another workspace`,
        };
      }
    }
    return { ok: true, available: true };
  });

  const SubdomainBody = z.object({
    // null/empty clears the custom subdomain (revert to default).
    subdomain: z.string().max(50).nullable(),
    // Which base domain to host the subdomain under. null = PRIMARY_DOMAIN.
    domain: z.string().max(100).nullable().optional(),
  });
  app.put("/:id/subdomain", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = SubdomainBody.parse(req.body);
    const raw = body.subdomain == null ? null : body.subdomain.toLowerCase().trim();

    if (!raw) {
      // Clear → revert to <project>-<user>, and also clear the custom domain.
      db.prepare("UPDATE workspaces SET custom_subdomain = NULL, custom_domain = NULL WHERE id = ?").run(id);
      const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
      return { workspace: workspaceToPublic(updated) };
    }

    const err = validateSubdomainLabel(raw);
    if (err) return reply.code(400).send({ error: err });
    if (RESERVED_SUB_LABELS.has(raw)) {
      return reply.code(400).send({ error: `"${raw}" is a reserved subdomain` });
    }
    // Collision check (same logic as /check-subdomain — duplicated here so
    // we don't have a TOCTOU window where two PUTs race past a stale check).
    const customClash = db
      .prepare("SELECT id FROM workspaces WHERE custom_subdomain = ? AND id != ?")
      .get(raw, id) as { id: string } | undefined;
    if (customClash) {
      return reply.code(409).send({ error: "Subdomain is already taken by another workspace" });
    }
    if (raw.includes("-")) {
      // Same exclusion as /check-subdomain: ignore workspaces that already
      // use a custom subdomain — they can't auto-clash anymore.
      const rows = db
        .prepare(`
          SELECT w.id, w.name, u.username FROM workspaces w
          JOIN users u ON u.id = w.user_id
          WHERE w.id != ? AND w.custom_subdomain IS NULL
        `)
        .all(id) as Array<{ id: string; name: string; username: string }>;
      const autoClash = rows.find((r) => `${dnsSafe(r.name)}-${dnsSafe(r.username)}` === raw);
      if (autoClash) {
        return reply.code(409).send({
          error: `Subdomain "${raw}" is already used by the default URL of another workspace`,
        });
      }
    }
    // Validate the chosen domain (if provided) is actually registered.
    const rawDomain = body.domain == null ? null : body.domain.toLowerCase().trim() || null;
    if (rawDomain && rawDomain !== config.PRIMARY_DOMAIN) {
      const domainRow = db.prepare("SELECT name FROM custom_domains WHERE name = ? AND active = 1").get(rawDomain);
      if (!domainRow) {
        return reply.code(400).send({ error: "Domain tidak dikenal atau tidak aktif" });
      }
    }
    try {
      db.prepare("UPDATE workspaces SET custom_subdomain = ?, custom_domain = ? WHERE id = ?").run(raw, rawDomain, id);
    } catch (e: any) {
      // Falls through if the partial-unique index trips (race with a
      // concurrent insert). Translate to a friendly 409.
      if (String(e?.message ?? "").includes("UNIQUE")) {
        return reply.code(409).send({ error: "Subdomain is already taken (race)" });
      }
      throw e;
    }
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  const RunCmdBody = z.object({ runCommand: z.string().max(4000).nullable() });
  app.put("/:id/run-command", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = RunCmdBody.parse(req.body);
    const value = body.runCommand && body.runCommand.trim() ? body.runCommand.trim() : null;
    db.prepare("UPDATE workspaces SET run_command = ? WHERE id = ?").run(value, id);
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  // .premdev — returns the resolved command + raw config so the UI can
  // show "this is how Run will be resolved" right next to the editable file.
  app.get("/:id/config", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const dir = workspacePath(id);
    const tmpl = getTemplate(w.template);
    const cfg = readWorkspaceConfig(dir) ?? {};
    const resolved = resolveRunCommand(w, tmpl, dir);
    const detected = detectRunCommand(dir);
    return {
      filename: CONFIG_FILENAME,
      config: cfg,
      resolvedRunCommand: resolved,
      detectedRunCommand: detected,
      templateRunCommand: tmpl.runCommand,
    };
  });

  // Create-on-open helper: ensures `.premdev` exists so the editor can
  // open it like any other file. Returns its workspace-relative path.
  app.post("/:id/config/init", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const dir = workspacePath(id);
    fs.mkdirSync(dir, { recursive: true });
    ensureWorkspaceConfig(dir);
    return { path: CONFIG_FILENAME };
  });

  // Safe MERGE patch into `.premdev`. Used by the AI's
  // `workspace:setRun` and `workspace:setEnv` actions so secrets the user has
  // already stored in env (DB creds, API tokens, etc.) survive an AI edit.
  // Pass `env: { KEY: null }` to delete a key.
  const PatchBody = z.object({
    run: z.string().max(2000).optional(),
    env: z.record(z.union([z.string().max(8000), z.null()])).optional(),
    port: z.number().int().positive().max(65535).nullable().optional(),
    processes: z.record(z.object({
      run:  z.string().max(2000),
      port: z.number().int().positive().max(65535),
    })).nullable().optional(),
  });
  app.post("/:id/config/patch", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = PatchBody.parse(req.body ?? {});
    const dir = workspacePath(id);
    fs.mkdirSync(dir, { recursive: true });
    const merged = patchWorkspaceConfig(dir, body);
    // Env vars changed — kill the shell container so it gets recreated with
    // fresh env on the next terminal open. Fire-and-forget (don't block response).
    if (body.env) stopShellContainer(id).catch(() => {});
    return { ok: true, config: merged };
  });

  // ── MySQL query passthrough for the AI's `db:query` action ────────────────
  // Runs raw SQL against the workspace owner's per-project database. Owner is
  // resolved from the workspace row, db name defaults to whatever `.premdev`
  // env / workspace.env points at (DATABASE_NAME), and connection uses the
  // owner's MySQL user — never root — so existing GRANTs are the access edge.
  // Note: `database` is intentionally NOT accepted from the client. The
  // database name is always resolved server-side from the workspace row,
  // so a caller in workspace A cannot target workspace B's database (even
  // when both belong to the same MySQL user) by passing a different name.
  const DbQueryBody = z.object({
    sql: z.string().min(1).max(20_000),
    rowLimit: z.number().int().positive().max(1000).optional(),
    // When true (sent by the autonomous orchestrator), SQL is restricted to
    // read-only statements. Human users via the Query tab can write freely.
    autonomous: z.boolean().optional(),
    // DROP DATABASE is allowed for the workspace database only after the
    // browser has obtained an explicit confirmation from the user.
    confirmDestructive: z.boolean().optional(),
  });
  app.post<{ Params: { id: string } }>("/:id/db/query", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { id } = req.params;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = DbQueryBody.parse(req.body);

    const userRow = db.prepare("SELECT username FROM users WHERE id = ?").get(w.user_id) as { username?: string } | undefined;
    const username = userRow?.username;
    if (!username) return reply.code(400).send({ error: "Workspace owner has no username" });
    // SECURITY: db name derives ONLY from immutable workspace identity
    // (owner username + workspace.name, sanitized like createProjectDb).
    // Env vars are user-editable, so they cannot be the auth boundary.
    const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
    const safeProj = w.name.replace(/[^a-zA-Z0-9_]/g, "_");
    if (!safeUser || !safeProj) {
      return reply.code(400).send({ error: "Workspace identity has no usable username/name." });
    }
    const dbName = `${safeUser}_${safeProj}`;

    // Autonomous mode remains read-only except for the one explicitly
    // supported destructive workflow: dropping this workspace's own database
    // after a browser confirmation. This avoids silently destroying data while
    // still allowing an explicit user request to complete through the agent.
    const dropMatch = body.sql.trim().replace(/;\s*$/, "").match(
      /^DROP\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?[`"]?([A-Za-z0-9_$-]+)[`"]?$/i,
    );
    if (body.autonomous) {
      if (dropMatch) {
        const targetDb = dropMatch[1];
        if (targetDb !== dbName) {
          return reply.code(403).send({
            error: `DROP DATABASE hanya boleh menarget database workspace ini (${dbName}).`,
            database: dbName,
          });
        }
        if (!body.confirmDestructive) {
          return reply.code(409).send({
            confirmationRequired: true,
            error: `Konfirmasi diperlukan untuk menghapus database ${dbName}.`,
            database: dbName,
          });
        }
      } else {
        const reason = checkSqlReadOnly(body.sql);
        if (reason) {
          return reply.code(403).send({
            error: `Autonomous mode is read-only: ${reason}. To run writes, INSERT, UPDATE, or DDL, ask the user to execute the query manually in the phpMyAdmin panel or a terminal MySQL session.`,
            database: dbName,
          });
        }
      }
    }
    // Auto-provision: create the DB and user if they don't exist yet so the
    // first query doesn't fail with "Unknown database".
    if (config.MYSQL_USER_PASSWORD) {
      await ensureMysqlUser(username, config.MYSQL_USER_PASSWORD).catch(() => {});
    }
    await createProjectDb(username, w.name).catch(() => {});
    const r = await runWorkspaceQuery({
      username,
      dbName,
      sql: body.sql,
      // Cap autonomous queries to 50 rows — prevent the AI from accidentally
      // pulling huge result sets into its context window.
      rowLimit: body.autonomous ? Math.min(body.rowLimit ?? 50, 50) : body.rowLimit,
    });
    if (!r.ok) return reply.code(400).send({ error: r.error, database: dbName });
    return { ...r, database: dbName };
  });

  const ExecBody = z.object({ command: z.string().min(1).max(4000) });
  /**
   * Parse raw terminal output from common build/lint/test tools into a
   * compact, high-signal summary. Only summarises SUCCESS output — errors
   * are always kept verbatim so the AI has full context to debug.
   * Returns the original string unchanged when no tool is recognised.
   */
  function parseStructuredOutput(cmd: string, output: string, exitCode: number): string {
    const c = cmd.toLowerCase();

    // ── TypeScript compiler ──────────────────────────────────────────────────
    if (c.includes("tsc")) {
      const errors = output.match(/^.+\.tsx?\(\d+,\d+\): error TS\d+:.+$/gm) ?? [];
      if (exitCode !== 0 || errors.length > 0) return output; // keep verbatim on error
      return "✓ TypeScript: 0 errors";
    }

    // ── ESLint ───────────────────────────────────────────────────────────────
    if (c.includes("eslint")) {
      const problems = output.match(/^\s+\d+:\d+\s+(error|warning)\s+.+$/gm) ?? [];
      if (problems.length === 0 && exitCode === 0) return "✓ ESLint: 0 problems";
      if (exitCode !== 0) return output; // keep verbatim
      // summarise: file names + problem lines only
      const summary = output.match(/^[^\s].+\n((?:\s+.+\n)*)/gm)
        ?.map((b) => b.trim()).join("\n\n") ?? output;
      return summary.length < output.length ? summary : output;
    }

    // ── Jest / Vitest ────────────────────────────────────────────────────────
    if (c.includes("jest") || c.includes("vitest") || c.includes("npm test")) {
      if (exitCode !== 0) return output; // keep verbatim so AI sees failure details
      // Success: extract summary lines (Tests:, Test Suites:, Time:)
      const summaryLines = output.match(/(Tests?|Test Suites?|Snapshots?|Time):.*$/gm) ?? [];
      if (summaryLines.length > 0) return "✓ " + summaryLines.join(" · ");
      return output.slice(-800); // tail is usually the summary
    }

    // ── pytest ───────────────────────────────────────────────────────────────
    if (c.includes("pytest")) {
      if (exitCode !== 0) return output; // keep verbatim
      const summary = output.match(/=+ .+passed.+ =+/)?.[0] ?? "";
      return summary ? "✓ " + summary : output.slice(-400);
    }

    return output;
  }

  app.post("/:id/exec", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = ExecBody.parse(req.body);
    try {
      const r = await runOneOff(id, body.command, 120_000);
      const structured = parseStructuredOutput(body.command, r.output, r.exitCode);
      return { output: structured, exitCode: r.exitCode };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Test runner (Batch B #11) ─────────────────────────────────────────────
  // Auto-detects the right test command from project metadata when the caller
  // doesn't pass one. Output is capped to keep the AI loop fast even when a
  // suite spews thousands of lines.
  const TestBody = z.object({ command: z.string().max(500).optional() });
  app.post("/:id/test", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = TestBody.parse(req.body ?? {});
    let cmd = body.command?.trim();
    let tool = "custom";
    if (!cmd) {
      // Auto-detect: read root listing once, then pick a strategy.
      let detect = "";
      try {
        const ls = await runOneOff(id, "ls -1a 2>/dev/null | head -200; echo '---'; cat package.json 2>/dev/null | head -120", 10_000);
        detect = ls.output || "";
      } catch {}
      if (/"scripts"\s*:\s*\{[^}]*"test"\s*:/.test(detect)) {
        cmd = "npm test --silent --if-present";
        tool = "npm";
      } else if (/(^|\n)pytest\.ini|(^|\n)pyproject\.toml|(^|\n)tests\//.test(detect)) {
        cmd = "pytest -q 2>&1 | tail -200";
        tool = "pytest";
      } else if (/(^|\n)go\.mod/.test(detect)) {
        cmd = "go test ./... 2>&1 | tail -200";
        tool = "go";
      } else if (/(^|\n)Cargo\.toml/.test(detect)) {
        cmd = "cargo test 2>&1 | tail -200";
        tool = "cargo";
      } else {
        return { tool: "none", exitCode: 0, ok: true, output: "No tests detected (no npm test script, pytest, go, or cargo project)." };
      }
    }
    try {
      const r = await runOneOff(id, cmd, 180_000);
      const out = r.output.length > 12_000 ? r.output.slice(-12_000) : r.output;
      return { tool, exitCode: r.exitCode, ok: r.exitCode === 0, output: out };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Git integration (Batch B #24) ─────────────────────────────────────────
  // All commands run inside the workspace container so they use the user's
  // own git config and credentials. We expose a small surface (status / log /
  // branches / commit / push / pull) instead of arbitrary git proxying so the
  // UI stays predictable.
  app.get("/:id/git/status", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const r = await runOneOff(id,
        "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo NOREPO; exit 0; }; " +
        "echo '##BRANCH##'; git rev-parse --abbrev-ref HEAD 2>/dev/null; " +
        "echo '##REMOTE##'; git remote -v 2>/dev/null | head -4; " +
        "echo '##STATUS##'; git status --porcelain=v1 2>/dev/null | head -200; " +
        "echo '##AHEAD##'; git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null || echo '0\\t0'",
        15_000);
      const out = r.output;
      if (out.includes("NOREPO")) return { initialised: false };
      const seg = (tag: string) => {
        const i = out.indexOf(`##${tag}##`);
        if (i === -1) return "";
        const next = out.indexOf("##", i + tag.length + 4);
        return out.slice(i + tag.length + 4, next === -1 ? undefined : next).trim();
      };
      const status = seg("STATUS");
      const files = status ? status.split("\n").map((l) => ({
        x: l.charAt(0), y: l.charAt(1), path: l.slice(3).trim(),
      })) : [];
      const ah = seg("AHEAD").split(/\s+/);
      return {
        initialised: true,
        branch: seg("BRANCH"),
        remote: seg("REMOTE"),
        files,
        behind: Number(ah[0] ?? 0) || 0,
        ahead: Number(ah[1] ?? 0) || 0,
      };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.get("/:id/git/log", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const r = await runOneOff(id,
        "git log -n 30 --pretty=format:'%h%x09%an%x09%ar%x09%s' 2>/dev/null || true",
        15_000);
      const commits = r.output.split("\n").filter(Boolean).map((l) => {
        const [hash, author, when, ...rest] = l.split("\t");
        return { hash, author, when, subject: rest.join("\t") };
      });
      return { commits };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  const GitCommitBody = z.object({
    message: z.string().min(1).max(500),
    addAll: z.boolean().default(true),
  });
  app.post("/:id/git/commit", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = GitCommitBody.parse(req.body ?? {});
    const safeMsg = body.message.replace(/'/g, "'\\''");
    const cmd =
      "git config --global --add safe.directory \"$(pwd)\" >/dev/null 2>&1; " +
      "git config user.email >/dev/null 2>&1 || git config user.email 'premdev@local'; " +
      "git config user.name  >/dev/null 2>&1 || git config user.name  'PremDev User'; " +
      (body.addAll ? "git add -A && " : "") +
      `git commit -m '${safeMsg}' 2>&1`;
    try {
      const r = await runOneOff(id, cmd, 30_000);
      return { ok: r.exitCode === 0, exitCode: r.exitCode, output: r.output.slice(-4000) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // Strict allowlist for git remote / branch names — refuses anything that
  // could break out of `git push <remote> <branch>` into shell metachars.
  // Matches the safe subset of git ref-name rules: alnum, ., _, /, -, no
  // leading/trailing `-` or `.`, no consecutive dots.
  const GIT_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/;
  const GitPushBody = z.object({
    remote: z.string().default("origin").refine((v) => GIT_REF_RE.test(v) && !v.includes(".."), {
      message: "remote must match [A-Za-z0-9_./-]+ and contain no '..'",
    }),
    branch: z.string().optional().refine((v) => v == null || (GIT_REF_RE.test(v) && !v.includes("..")), {
      message: "branch must match [A-Za-z0-9_./-]+ and contain no '..'",
    }),
  });
  app.post("/:id/git/push", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    let body: z.infer<typeof GitPushBody>;
    try {
      body = GitPushBody.parse(req.body ?? {});
    } catch (e: any) {
      return reply.code(400).send({ error: e?.errors?.[0]?.message ?? "invalid git args" });
    }
    const branch = body.branch ? ` ${body.branch}` : "";
    try {
      const r = await runOneOff(id, `git push ${body.remote}${branch} 2>&1`, 60_000);
      return { ok: r.exitCode === 0, exitCode: r.exitCode, output: r.output.slice(-4000) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.post("/:id/git/pull", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const r = await runOneOff(id, "git pull --ff-only 2>&1", 60_000);
      return { ok: r.exitCode === 0, exitCode: r.exitCode, output: r.output.slice(-4000) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.get("/:id/git/diff", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const r = await runOneOff(id, "git diff --no-color 2>&1 | head -2000", 20_000);
      return { diff: r.output };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.get("/:id/checkpoints", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    return { checkpoints: listCheckpoints(id) };
  });

  const CkBody = z.object({ message: z.string().max(200).default("") });
  app.post("/:id/checkpoints", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = CkBody.parse(req.body ?? {});
    try {
      const ck = await createCheckpoint(id, body.message);
      return { checkpoint: ck };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // List files inside a checkpoint snapshot — powers the "Changes" button.
  app.get("/:id/checkpoints/:cid/files", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const cid = (req.params as any).cid;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const files = await listCheckpointFiles(id, cid);
      return { files };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post("/:id/checkpoints/:cid/restore", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const cid = (req.params as any).cid;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      await restoreCheckpoint(id, cid);
      return { ok: true };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.delete("/:id/checkpoints/:cid", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const cid = (req.params as any).cid;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    deleteCheckpoint(id, cid);
    return { ok: true };
  });

  app.delete("/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    if (isDocker()) {
      await stopContainer(id);
      await stopShellContainer(id);
    } else {
      stopLocal(id);
    }
    deleteAllCheckpointsFor(id);

    // Close any open semantic-search SQLite handle before removing the
    // workspace dir, so the file lock is released and the embeddings.db
    // gets cleaned up with the rest of the tree (avoids an FD leak when
    // workspaces are deleted while the API process is long-running).
    try { closeWorkspaceDb(id); } catch {}

    try {
      fs.rmSync(workspacePath(id), { recursive: true, force: true });
    } catch {}
    // Also drop the per-workspace pip/npm user-home cache so the next
    // workspace with the same id starts clean and disk space is reclaimed.
    try {
      const userhome = path.join(path.dirname(config.WORKSPACES_DIR), "userhome", id);
      fs.rmSync(userhome, { recursive: true, force: true });
    } catch {}
    await dropProjectDb(u.username, w.name).catch(() => {});
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return { ok: true };
  });

  app.get("/:id/logs", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const logs = await getContainerLogs(id, 500);
    return { logs };
  });

  // GET /workspaces/:id/db/info — resolved DB connection details for display.
  // Returns host/port/user/database + DATABASE_URL (password omitted from URL
  // unless the caller requests it via ?showPassword=1).
  app.get("/:id/db/info", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const dir = workspacePath(id);
    const env = resolveEnvVars(w, dir);
    const host = env.DB_HOST || env.DATABASE_HOST || env.MYSQL_HOST || "";
    const port = env.DB_PORT || env.DATABASE_PORT || env.MYSQL_PORT || "3306";
    const user = env.DB_USER || env.DATABASE_USER || env.MYSQL_USER || "";
    const password = env.DB_PASSWORD || env.DATABASE_PASSWORD || env.MYSQL_PASSWORD || "";
    const database = env.DATABASE_NAME || env.DB_NAME || env.MYSQL_DATABASE || "";
    const showPw = (req.query as any)?.showPassword === "1";
    // Public host for external connections (DBeaver, TablePlus, etc.)
    const publicHost = config.MYSQL_PUBLIC_HOST || config.PRIMARY_DOMAIN || host;
    const publicPort = port;
    // Build URL with or without password
    let url = env.DATABASE_URL || "";
    if (!url && host && user && database) {
      const userInfo = password ? `${user}:${showPw ? encodeURIComponent(password) : "***"}` : user;
      url = `mysql://${userInfo}@${host}:${port}/${database}`;
    } else if (url && !showPw) {
      // Mask password in existing URL
      url = url.replace(/(:\/\/[^:]+:)([^@]+)(@)/, "$1***$3");
    }
    // External URL using public host
    const externalUrl = (host && user && database)
      ? `mysql://${user}:${showPw && password ? encodeURIComponent(password) : "***"}@${publicHost}:${publicPort}/${database}`
      : "";
    return { host, port, user, database, url, hasPassword: !!password, publicHost, publicPort, externalUrl };
  });
};

// Decide which command to spawn for a workspace. Priority:
//   1. `.premdev` "run" field (the canonical, AI-and-user-editable config)
//   2. legacy `run_command` DB override (kept for backward compat)
//   3. template's runCommand if it isn't the placeholder
//   4. auto-detected command from the workspace contents
//   5. fall back to the placeholder so the container at least boots
function resolveRunCommand(
  w: DbWorkspace,
  tmpl: { runCommand: string },
  workspaceDir: string,
): string {
  const PLACEHOLDER = "echo 'No run command set'";
  const cfg = readWorkspaceConfig(workspaceDir);
  if (cfg?.run && cfg.run.trim() && cfg.run !== PLACEHOLDER) return cfg.run.trim();
  const userOverride =
    w.run_command && w.run_command.trim() && w.run_command !== PLACEHOLDER
      ? w.run_command
      : null;
  if (userOverride) return userOverride;
  if (tmpl.runCommand && tmpl.runCommand !== PLACEHOLDER) return tmpl.runCommand;
  const detected = detectRunCommand(workspaceDir);
  return detected ?? tmpl.runCommand;
}

// Merge env vars: auto MySQL creds + workspace DB env_vars + .premdev
// `env` (later sources win on conflict, so .premdev is the source of
// truth, then user-set DB env, then auto MySQL injection as a base layer).
function resolveEnvVars(w: DbWorkspace, workspaceDir: string): Record<string, string> {
  let dbEnv: Record<string, string> = {};
  try { dbEnv = JSON.parse(w.env_vars); } catch {}
  const cfg = readWorkspaceConfig(workspaceDir);

  // Auto-inject MySQL connection details so user code can connect via TCP.
  // Workspace containers use the PUBLIC host (VPS domain, like cPanel) so
  // MySQL 8.4 caching_sha2_password RSA exchange works from any client library.
  // Falls back to internal Docker hostname when MYSQL_PUBLIC_HOST is not set.
  const auto: Record<string, string> = {};
  const userRow = db.prepare("SELECT username FROM users WHERE id = ?").get(w.user_id) as { username?: string } | undefined;
  const username = userRow?.username
    ? userRow.username.replace(/[^a-zA-Z0-9_]/g, "")
    : "";

  // Auto-derive DATABASE_NAME from owner+workspace so users never need to
  // set it manually. Matches the name created by createProjectDb().
  const safeProj = w.name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 48);
  const autoDbName = username && safeProj ? `${username}_${safeProj}` : "";
  if (autoDbName) {
    auto.DATABASE_NAME = autoDbName;
    auto.DB_NAME       = autoDbName;
    auto.MYSQL_DATABASE = autoDbName;
  }

  if (config.MYSQL_HOST) {
    // Internal host (Docker network) — always injected so server-side code works.
    auto.DATABASE_HOST = config.MYSQL_HOST;
    auto.DATABASE_PORT = String(config.MYSQL_PORT);
    auto.DB_HOST       = config.MYSQL_HOST;
    auto.DB_PORT       = String(config.MYSQL_PORT);
    auto.MYSQL_HOST    = config.MYSQL_HOST;
    auto.MYSQL_PORT    = String(config.MYSQL_PORT);

    // External host — for code that connects from outside Docker (or when
    // MYSQL_PUBLIC_HOST is set in .env to the VPS domain / IP).
    const extHost = config.MYSQL_PUBLIC_HOST || config.PRIMARY_DOMAIN;
    if (extHost) {
      auto.DB_EXTERNAL_HOST    = extHost;
      auto.MYSQL_EXTERNAL_HOST = extHost;
    }
  }

  // Credentials: prefer dedicated workspace admin user when configured in
  // .env (MYSQL_WORKSPACE_USER + MYSQL_WORKSPACE_PASSWORD). This single user
  // has ALL PRIVILEGES on all `<owner>_%` databases and works from both
  // inside Docker and externally on port 3306.
  const dbUser = config.MYSQL_WORKSPACE_USER || username;
  const dbPass = config.MYSQL_WORKSPACE_PASSWORD || config.MYSQL_USER_PASSWORD;
  if (dbUser && dbPass) {
    auto.DATABASE_USER     = dbUser;
    auto.DATABASE_PASSWORD = dbPass;
    auto.DB_USER           = dbUser;
    auto.DB_PASSWORD       = dbPass;
    auto.MYSQL_USER        = dbUser;
    auto.MYSQL_PASSWORD    = dbPass;
  }

  // Build DATABASE_URL (mysql://user:pass@host:port/dbname) as a convenience
  // for frameworks that prefer a single connection string (Laravel DATABASE_URL,
  // Prisma, TypeORM, etc.). Built AFTER individual keys so it reflects the
  // final resolved values. User can override by setting DATABASE_URL in Secrets.
  const merged: Record<string, string> = { ...auto, ...dbEnv, ...(cfg?.env ?? {}) };
  if (!merged.DATABASE_URL) {
    const h  = merged.DB_HOST || merged.DATABASE_HOST || "";
    const p  = merged.DB_PORT || merged.DATABASE_PORT || "3306";
    const u2 = merged.DB_USER || merged.DATABASE_USER || "";
    const pw = merged.DB_PASSWORD || merged.DATABASE_PASSWORD || "";
    const db2 = merged.DATABASE_NAME || merged.DB_NAME || "";
    if (h && u2 && db2) {
      const userInfo = pw ? `${u2}:${encodeURIComponent(pw)}` : u2;
      merged.DATABASE_URL = `mysql://${userInfo}@${h}:${p}/${db2}`;
    }
  }

  return merged;
}
