import { db, type DbWorkspace } from "./db.js";
import { detectHardcodedPort, fixRunCommandHost } from "./project-hints.js";
import { getTemplate } from "./templates.js";
import { readWorkspaceConfig } from "./workspace-config.js";
import { resolveWorkspaceEnv } from "./workspace-env.js";
import {
  ensureWorkspaceDir,
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