import { db, type DbWorkspace } from "./db.js";
import { detectHardcodedPort, fixRunCommandHost } from "./project-hints.js";
import { getTemplate } from "./templates.js";
import { readWorkspaceConfig } from "./workspace-config.js";
import { resolveWorkspaceEnv } from "./workspace-env.js";
import {
  codeServerIsRunning,
  startCodeServer,
} from "./code-server.js";
import {
  docker,
  ensureWorkspaceDir,
  isLocalRunning,
  isDocker,
  startContainer,
  startLocal,
} from "./runtime.js";

type OwnerRow = {
  username: string;
  quota_cpu: number;
  quota_mem_mb: number;
  quota_disk_mb: number;
};

function resolveCommand(workspace: DbWorkspace, dir: string) {
  const template = getTemplate(workspace.template);
  const workspaceConfig = readWorkspaceConfig(dir);
  const raw = workspaceConfig?.run?.trim() || workspace.run_command?.trim() || template.runCommand;
  return {
    template,
    config: workspaceConfig,
    command: raw ? fixRunCommandHost(raw) : raw,
  };
}

function resolvePorts(workspace: DbWorkspace, dir: string, command: string, template: { port: number }, workspaceConfig: any) {
  const processes = workspaceConfig?.processes && Object.keys(workspaceConfig.processes).length > 0
    ? workspaceConfig.processes as Record<string, { run: string; port: number }>
    : undefined;
  if (processes) {
    const entries = Object.entries(processes);
    const configuredPort = Number.isInteger(workspaceConfig?.port) && workspaceConfig.port > 0 && workspaceConfig.port < 65536
      ? workspaceConfig.port
      : null;
    const portMap: Record<string, number> = {};
    for (const [name, process] of entries) portMap[name] = process.port;
    return {
      port: configuredPort ?? entries[0][1].port,
      previewPorts: JSON.stringify(portMap),
      processes,
    };
  }
  return {
    port: Number.isInteger(workspaceConfig?.port) && workspaceConfig.port > 0 && workspaceConfig.port < 65536
      ? workspaceConfig.port
      : (detectHardcodedPort(dir, command) ?? template.port),
    previewPorts: null,
    processes: undefined,
  };
}

/**
 * Restores a workspace runtime without an HTTP request. This is intentionally
 * separate from the authenticated route so the lifecycle monitor can recover
 * workspaces after API/container restarts.
 */
export async function startWorkspaceRuntime(workspace: DbWorkspace): Promise<void> {
  const owner = db.prepare(
    "SELECT username, quota_cpu, quota_mem_mb, quota_disk_mb FROM users WHERE id = ?",
  ).get(workspace.user_id) as OwnerRow | undefined;
  if (!owner) throw new Error("Workspace owner not found");

  const dir = ensureWorkspaceDir(workspace.id);
  const resolved = resolveCommand(workspace, dir);
  const ports = resolvePorts(workspace, dir, resolved.command ?? "", resolved.template, resolved.config);

  db.prepare("UPDATE workspaces SET status = 'starting', last_active_at = ? WHERE id = ?")
    .run(Date.now(), workspace.id);

  try {
    if (isDocker()) {
      await startContainer({
        workspaceId: workspace.id,
        username: owner.username,
        cpu: owner.quota_cpu,
        memMb: owner.quota_mem_mb,
        diskMb: owner.quota_disk_mb,
        port: ports.port,
        envVars: resolveWorkspaceEnv(workspace, dir),
        runCommand: ports.processes ? undefined : resolved.command,
        processes: ports.processes,
      });
    } else {
      startLocal(workspace.id, resolved.command, dir, ports.port);
    }

    db.prepare(`
      UPDATE workspaces
      SET status = 'running', preview_port = ?, preview_ports = ?, desired_running = 1,
          auto_start_failures = 0, auto_start_next_attempt_at = NULL, last_active_at = ?
      WHERE id = ?
    `).run(ports.port, ports.previewPorts, Date.now(), workspace.id);
  } catch (error) {
    db.prepare("UPDATE workspaces SET status = 'error' WHERE id = ?").run(workspace.id);
    throw error;
  }
}

let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileInFlight = false;

async function runtimeIsAlive(workspaceId: string): Promise<boolean> {
  if (isDocker() && docker) {
    try {
      const info = await docker.getContainer(`pw_${workspaceId}`).inspect();
      return Boolean(info.State?.Running || info.State?.Restarting);
    } catch {
      return false;
    }
  }
  return isLocalRunning(workspaceId);
}

function scheduleReconcile(delayMs: number): void {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcileDesiredWorkspaces();
  }, delayMs);
  reconcileTimer.unref?.();
}

/**
 * Recreate runtimes that were intentionally running before an API/redeploy
 * restart. The Docker redeploy script removes pw_* containers, but the
 * desired_running flag is persisted in SQLite. This runs once at boot and
 * retries failed starts with backoff; it never changes a workspace that was
 * manually stopped.
 */
async function reconcileDesiredWorkspaces(): Promise<void> {
  if (reconcileInFlight) return;
  reconcileInFlight = true;
  let shouldRetry = false;
  try {
    const rows = db
      .prepare(`
        SELECT *
        FROM workspaces
        WHERE desired_running = 1
          AND status IN ('running', 'starting', 'error')
      `)
      .all() as DbWorkspace[];
    const now = Date.now();

    for (const workspace of rows) {
      if (
        workspace.auto_start_next_attempt_at != null &&
        workspace.auto_start_next_attempt_at > now
      ) {
        shouldRetry = true;
        continue;
      }
      if (await runtimeIsAlive(workspace.id)) {
        db.prepare(`
          UPDATE workspaces
          SET status = 'running', auto_start_failures = 0,
              auto_start_next_attempt_at = NULL, last_active_at = ?
          WHERE id = ?
        `).run(now, workspace.id);
        continue;
      }

      try {
        await startWorkspaceRuntime(workspace);
      } catch (error) {
        const failures = workspace.auto_start_failures + 1;
        const backoffMs = Math.min(5 * 60_000, Math.max(10_000, failures * 10_000));
        db.prepare(`
          UPDATE workspaces
          SET status = 'error', auto_start_failures = ?,
              auto_start_next_attempt_at = ?
          WHERE id = ?
        `).run(failures, now + backoffMs, workspace.id);
        shouldRetry = true;
        console.warn(`[workspace-lifecycle] restore failed for ${workspace.id}:`, error);
      }
    }

    // Redeploy also removes containers carrying the workspace label, which
    // includes the optional `pwc_*` Code Server containers. Restore sessions
    // that were active before the deploy without reviving sessions the user
    // explicitly stopped.
    const codeServerRows = db.prepare(`
      SELECT
        s.workspace_id, s.owner_id, s.preview_status,
        w.name, w.template, w.run_command, w.env_vars, w.user_id,
        u.username, u.quota_cpu, u.quota_mem_mb, u.quota_disk_mb
      FROM code_server_sessions s
      JOIN workspaces w ON w.id = s.workspace_id
      JOIN users u ON u.id = s.owner_id
      WHERE s.status = 'running'
    `).all() as Array<DbWorkspace & {
      workspace_id: string;
      owner_id: string;
      preview_status: string;
      username: string;
      quota_cpu: number;
      quota_mem_mb: number;
      quota_disk_mb: number;
    }>;

    for (const session of codeServerRows) {
      if (await codeServerIsRunning(session.workspace_id)) continue;
      try {
        const started = await startCodeServer({
          workspaceId: session.workspace_id,
          username: session.username,
          cpu: session.quota_cpu,
          memMb: Math.min(session.quota_mem_mb, 2048),
          envVars: resolveWorkspaceEnv(
            session,
            ensureWorkspaceDir(session.workspace_id),
          ),
        });
        // The preview process is inside the old container and cannot survive
        // a redeploy. Mark it stopped rather than exposing a stale URL.
        db.prepare(`
          UPDATE code_server_sessions
          SET container_id = ?, status = 'running',
              preview_status = 'stopped', preview_port = NULL,
              preview_pid = NULL, updated_at = ?
          WHERE workspace_id = ?
        `).run(started.containerId, now, session.workspace_id);
      } catch (error) {
        shouldRetry = true;
        console.warn(`[workspace-lifecycle] code-server restore failed for ${session.workspace_id}:`, error);
      }
    }
  } finally {
    reconcileInFlight = false;
  }
  if (shouldRetry) scheduleReconcile(10_000);
}

export function startWorkspaceLifecycleReconciler(): void {
  if (reconcileTimer) return;
  // Allow the asynchronous Docker probe to settle before deciding whether
  // to use Docker or the local development runtime.
  scheduleReconcile(2_000);
}

export function getWorkspaceLifecycleReconcileState() {
  return {
    scheduled: reconcileTimer !== null,
    inFlight: reconcileInFlight,
  };
}
