import Docker from "dockerode";
import { db, DbWorkspace } from "./db.js";
import { config } from "./config.js";
import { notifyAdmin, telegramConfigured } from "./telegram.js";

const POLL_INTERVAL_MS = 60_000;

let docker: Docker | null = null;

function getDocker(): Docker {
  if (!docker) {
    docker = new Docker({ socketPath: config.DOCKER_SOCKET });
  }
  return docker;
}

async function containerIsRunning(name: string): Promise<boolean> {
  try {
    const info = await getDocker().getContainer(name).inspect();
    return info.State.Running || info.State.Restarting;
  } catch {
    return false;
  }
}

async function checkRunningWorkspaces() {
  const rows = db
    .prepare("SELECT * FROM workspaces WHERE status = 'running'")
    .all() as DbWorkspace[];

  for (const w of rows) {
    const containerName = `pw_${w.id}`;
    const alive = await containerIsRunning(containerName).catch(() => false);
    if (!alive) {
      db.prepare(
        "UPDATE workspaces SET status = 'stopped', preview_port = NULL WHERE id = ?",
      ).run(w.id);

      if (telegramConfigured()) {
        await notifyAdmin(
          `🛑 *Workspace crash terdeteksi*\n` +
            `Nama: \`${w.name}\`\n` +
            `ID: \`${w.id}\`\n` +
            `Container \`${containerName}\` berhenti tak terduga.\n` +
            `Status sudah diupdate ke stopped.`,
          "warn",
        ).catch(() => {});
      }
    }
  }
}

export function startCrashMonitor() {
  if (!telegramConfigured()) return;

  setInterval(() => {
    checkRunningWorkspaces().catch(() => {});
  }, POLL_INTERVAL_MS);
}
