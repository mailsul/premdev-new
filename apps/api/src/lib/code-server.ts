import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { config } from "./config.js";
import {
  docker,
  ensureNetwork,
  ensureWorkspaceDir,
  ensureWorkspaceUserOwnership,
  isDocker,
  workspaceHostPath,
  workspacePath,
} from "./runtime.js";

const PREVIEW_LOG = "/tmp/premdev-code-server-preview.log";
const PREVIEW_PID = "/tmp/premdev-code-server-preview.pid";

export function codeServerContainerName(workspaceId: string): string {
  return `pwc_${workspaceId}`;
}

export function codeServerBasePath(workspaceId: string): string {
  return `/code-server/${encodeURIComponent(workspaceId)}`;
}

export function codeServerPath(workspaceId: string): string {
  return `${codeServerBasePath(workspaceId)}/`;
}

export function codePreviewPath(workspaceId: string): string {
  return `/code-preview/${encodeURIComponent(workspaceId)}/`;
}

/**
 * Keep editor/runtime metadata separate from the canonical `.premdev` file.
 * This directory never contains credentials; it only tells tools that the
 * workspace has been opened through PremDev's optional code-server interface.
 */
export function ensurePremDevMetadata(workspaceId: string): void {
  const dir = path.join(ensureWorkspaceDir(workspaceId), ".Premdev");
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "code-server.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        managedBy: "PremDev",
        interface: "code-server",
        workspaceRoot: "/workspace",
        previewLifecycle: "session",
      }, null, 2)}\n`,
      { mode: 0o644 },
    );
  }
  const readmePath = path.join(dir, "README.md");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(
      readmePath,
      "# PremDev workspace metadata\n\nThis folder is managed by PremDev. It contains non-secret code-server metadata.\n",
      { mode: 0o644 },
    );
  }
}

function codeServerHomeHostPath(workspaceId: string): string {
  return path.join(workspaceHostPath(workspaceId), ".Premdev", "code-server-home");
}

function codeServerHomePath(workspaceId: string): string {
  return path.join(workspacePath(workspaceId), ".Premdev", "code-server-home");
}

function ensureCodeServerHome(workspaceId: string): string {
  const localHome = codeServerHomePath(workspaceId);
  fs.mkdirSync(localHome, { recursive: true });
  try { fs.chownSync(localHome, 1000, 1000); } catch {}
  // The Docker daemon sees the host-side path, while local development uses
  // the workspace path. Both are created under the workspace so the bind
  // source exists even when the API itself runs in a container.
  const hostHome = codeServerHomeHostPath(workspaceId);
  if (hostHome !== localHome) {
    try { fs.mkdirSync(hostHome, { recursive: true }); } catch {}
    try { fs.chownSync(hostHome, 1000, 1000); } catch {}
  }
  return hostHome;
}

async function ensureRuntimeImage(): Promise<void> {
  if (!docker) throw new Error("Docker runtime is not available");
  try {
    await docker.getImage(config.RUNTIME_IMAGE).inspect();
    return;
  } catch {
    // The production runtime image is normally already present. Pulling on
    // demand keeps first use self-healing after a clean Docker host.
    await new Promise<void>((resolve, reject) => {
      docker!.pull(config.RUNTIME_IMAGE, (err: Error | null, stream: any) => {
        if (err) return reject(err);
        stream.on("data", () => {});
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    });
  }
}

export async function codeServerIsRunning(workspaceId: string): Promise<boolean> {
  if (!docker) return false;
  try {
    const info = await docker.getContainer(codeServerContainerName(workspaceId)).inspect();
    return Boolean(info.State?.Running && !info.State?.Paused && !info.State?.Dead);
  } catch {
    return false;
  }
}

export async function startCodeServer(opts: {
  workspaceId: string;
  username: string;
  cpu: number;
  memMb: number;
  envVars: Record<string, string>;
}): Promise<{ containerId: string; port: number }> {
  if (!isDocker() || !docker) {
    throw new Error("Code Server membutuhkan runtime Docker aktif.");
  }
  await ensureNetwork();
  ensurePremDevMetadata(opts.workspaceId);
  ensureWorkspaceUserOwnership(opts.workspaceId);
  const name = codeServerContainerName(opts.workspaceId);

  try {
    const existing = docker.getContainer(name);
    const info = await existing.inspect();
    if (info.State?.Running && !info.State?.Paused && !info.State?.Dead) {
      try {
        await waitForCodeServerReady(opts.workspaceId);
        return { containerId: info.Id, port: config.CODE_SERVER_PORT };
      } catch {
        await existing.remove({ force: true }).catch(() => {});
      }
    } else {
      await existing.remove({ force: true }).catch(() => {});
    }
  } catch {}

  await ensureRuntimeImage();
  const wsHostDir = workspaceHostPath(opts.workspaceId);
  const homeHostDir = ensureCodeServerHome(opts.workspaceId);
  const env = Object.entries(opts.envVars).map(([key, value]) => `${key}=${value}`);
  env.push(
    "HOME=/home/premdev",
    "USER=premdev",
    "PYTHONUSERBASE=/home/premdev/.local",
    "PIP_CACHE_DIR=/home/premdev/.cache/pip",
    "PATH=/home/premdev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  );
  const container = await docker.createContainer({
    name,
    Image: config.RUNTIME_IMAGE,
    Tty: false,
    OpenStdin: false,
    User: "premdev",
    WorkingDir: "/workspace",
    Env: env,
    Cmd: [
      "bash",
      "-lc",
      `exec code-server --bind-addr 0.0.0.0:${config.CODE_SERVER_PORT} --auth=none --disable-telemetry /workspace`,
    ],
    HostConfig: {
      NetworkMode: config.DOCKER_NETWORK,
      Binds: [`${wsHostDir}:/workspace`, `${homeHostDir}:/home/premdev`],
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      Memory: Math.max(512, opts.memMb) * 1024 * 1024,
      MemorySwap: Math.max(512, opts.memMb) * 1024 * 1024,
      NanoCpus: Math.max(0.25, opts.cpu) * 1e9,
      PidsLimit: 2048,
      Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 8192 }],
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      CapDrop: ["ALL"],
    },
    Labels: {
      "premdev.interface": "code-server",
      "premdev.workspace": opts.workspaceId,
      "premdev.user": opts.username,
    },
  });
  await container.start();
  try {
    await waitForCodeServerReady(opts.workspaceId);
  } catch (error) {
    const logs = await container.logs({ stdout: true, stderr: true, tail: 80 }).catch(() => Buffer.from(""));
    await container.remove({ force: true }).catch(() => {});
    const detail = logs.toString().trim();
    throw new Error(
      detail
        ? `Code Server gagal listen di port ${config.CODE_SERVER_PORT}: ${detail.slice(-2000)}`
        : (error as Error)?.message ?? "Code Server gagal listen.",
    );
  }
  return { containerId: container.id, port: config.CODE_SERVER_PORT };
}

/**
 * Docker reports a container as Running before the code-server process has
 * finished binding its HTTP port. Do not expose the proxy until the process
 * is actually reachable from inside the container.
 */
export async function waitForCodeServerReady(workspaceId: string, timeoutMs = 20_000): Promise<void> {
  const result = await execCodeServer(
    workspaceId,
    [
      "set -eu",
      `for i in $(seq 1 80); do`,
      `  (echo > /dev/tcp/127.0.0.1/${config.CODE_SERVER_PORT}) 2>/dev/null && exit 0`,
      "  sleep 0.25",
      "done",
      `echo "port ${config.CODE_SERVER_PORT} did not open"`,
      "exit 1",
    ].join("\n"),
    timeoutMs,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || `Code Server port ${config.CODE_SERVER_PORT} belum siap.`);
  }
}

async function execCodeServer(workspaceId: string, command: string, timeoutMs = 30_000): Promise<{ output: string; exitCode: number }> {
  if (!docker) throw new Error("Docker runtime is not available");
  const container = docker.getContainer(codeServerContainerName(workspaceId));
  const exec = await container.exec({
    Cmd: ["bash", "-lc", command],
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: "premdev",
    WorkingDir: "/workspace",
  });
  const stream = await exec.start({});
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  const append = (data: Buffer) => {
    if (output.length < 64 * 1024) output += data.toString().slice(0, 64 * 1024 - output.length);
  };
  stdout.on("data", append);
  stderr.on("data", append);
  (docker as any).modem.demuxStream(stream, stdout, stderr);

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
    setTimeout(finish, timeoutMs).unref?.();
  });
  const inspected = await exec.inspect().catch(() => ({ ExitCode: 1 }));
  return { output, exitCode: inspected.ExitCode ?? 1 };
}

export async function startCodeServerPreview(workspaceId: string, command: string, port: number): Promise<{ pid: string; port: number }> {
  if (!(await codeServerIsRunning(workspaceId))) {
    throw new Error("Code Server belum aktif.");
  }
  await stopCodeServerPreview(workspaceId);
  const safePort = Math.max(1, Math.min(65535, Math.floor(port)));
  const commandScript = [
    "set -eu",
    `rm -f ${PREVIEW_PID}`,
    `rm -f ${PREVIEW_LOG}`,
    "cd /workspace",
    `export PORT=${safePort} HOST=0.0.0.0`,
    `setsid bash -lc ${JSON.stringify(command)} >${PREVIEW_LOG} 2>&1 < /dev/null &`,
    "pid=$!",
    `printf '%s' \"$pid\" > ${PREVIEW_PID}`,
    "printf '%s' \"$pid\"",
  ].join("\n");
  const result = await execCodeServer(workspaceId, commandScript);
  const pid = result.output.trim().match(/\d+/)?.[0];
  if (result.exitCode !== 0 || !pid) {
    throw new Error(result.output.trim() || "Preview code-server gagal dijalankan.");
  }
  return { pid, port: safePort };
}

export async function stopCodeServerPreview(workspaceId: string): Promise<void> {
  if (!(await codeServerIsRunning(workspaceId))) return;
  await execCodeServer(
    workspaceId,
    `if [ -s ${PREVIEW_PID} ]; then pid=$(cat ${PREVIEW_PID}); kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; fi; rm -f ${PREVIEW_PID}`,
    10_000,
  ).catch(() => {});
}

export async function getCodeServerPreviewLogs(workspaceId: string): Promise<string> {
  if (!(await codeServerIsRunning(workspaceId))) return "";
  const result = await execCodeServer(workspaceId, `tail -c 65536 ${PREVIEW_LOG} 2>/dev/null || true`, 10_000).catch(() => ({ output: "", exitCode: 1 }));
  return result.output;
}

export async function stopCodeServer(workspaceId: string): Promise<void> {
  await stopCodeServerPreview(workspaceId);
  if (!docker) return;
  try {
    const container = docker.getContainer(codeServerContainerName(workspaceId));
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch {}
}

export function codeServerWorkspacePath(workspaceId: string): string {
  return workspacePath(workspaceId);
}