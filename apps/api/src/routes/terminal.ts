import type { FastifyPluginAsync } from "fastify";
import { spawn } from "node:child_process";
import { db, DbWorkspace } from "../lib/db.js";
import { workspacePath, isDocker, docker, ensureShellContainer, recordShellActivity } from "../lib/runtime.js";

/**
 * Terminal WebSocket route.
 *
 * Docker mode (production):
 *   Uses node-pty to spawn `docker exec -it <pwsh_id> bash -l` — this gives
 *   full PTY semantics identical to running `docker exec -it` from your own
 *   shell: backspace, delete, arrow keys, Ctrl+C, copy-paste, resize all work
 *   correctly. Falls back to dockerode exec if node-pty is unavailable.
 *
 * Local mode (dev, no Docker socket):
 *   node-pty → bash in workspace dir, or plain child_process as last resort.
 */

let pty: any = null;
async function loadPty() {
  if (pty !== null) return pty;
  try {
    pty = await (0, eval)('import("node-pty")');
  } catch {
    pty = false;
  }
  return pty;
}

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws/terminal/:id", { websocket: true }, async (socket, req) => {
    let userId: string | null = null;
    try {
      await (req as any).jwtVerify();
      userId = (req.user as any).sub;
    } catch (err: any) {
      try { socket.send(`\r\n\x1b[31m[auth failed: ${err?.message || "no token"}]\x1b[0m\r\n`); } catch {}
      socket.close(1008, "Unauthorized");
      return;
    }

    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, userId) as DbWorkspace | undefined;
    if (!w) {
      socket.close(1008, "Not found");
      return;
    }

    const q = req.query as any;
    const cols = Number(q.cols) || 80;
    const rows = Number(q.rows) || 24;

    // Keep-alive ping — prevents proxies (Caddy, Cloudflare) from dropping
    // the WebSocket after ~60s of idle (user sitting at a prompt).
    const pingInterval = setInterval(() => {
      try { if (socket.readyState === 1) (socket as any).ping?.(); } catch {}
    }, 25_000);
    const stopPing = () => clearInterval(pingInterval);

    // ── Docker mode ───────────────────────────────────────────────────────────
    if (isDocker() && docker) {
      const ptyMod = await loadPty();

      if (ptyMod) {
        // PRIMARY path: node-pty + `docker exec -it`
        // This is the standard way to get a fully-correct PTY: backspace,
        // delete, arrow keys, Ctrl+C, paste, resize — all work perfectly.
        try {
          const target = await ensureShellContainer(id);

          const term = ptyMod.spawn("docker", [
            "exec",
            "-it",
            "-e", "TERM=xterm-256color",
            "-e", `COLUMNS=${cols}`,
            "-e", `LINES=${rows}`,
            "-w", "/workspace",
            "-u", "premdev",
            target,
            "bash", "-lc", "exec $(command -v zsh || command -v bash)",
          ], {
            name: "xterm-256color",
            cols,
            rows,
            env: { ...process.env, TERM: "xterm-256color" },
          });

          term.onData((data: string) => {
            if (socket.readyState === 1) socket.send(data);
          });

          term.onExit(() => {
            stopPing();
            try { socket.close(); } catch {}
          });

          socket.on("message", (raw) => {
            try {
              const m = JSON.parse(raw.toString());
              if (m.type === "input") {
                recordShellActivity(id);
                term.write(m.data);
              } else if (m.type === "resize") {
                recordShellActivity(id);
                term.resize(m.cols, m.rows);
              }
            } catch {}
          });

          const cleanup = () => {
            stopPing();
            try { term.kill(); } catch {}
          };
          socket.on("close", cleanup);
          socket.on("error", cleanup);
          return;

        } catch (e: any) {
          try { socket.send(`\r\n\x1b[31mTerminal error: ${e.message}\x1b[0m\r\n`); } catch {}
          stopPing();
          socket.close();
          return;
        }
      }

      // FALLBACK: dockerode exec (node-pty unavailable)
      try {
        const target = await ensureShellContainer(id);
        const c = docker.getContainer(target);
        const exec = await c.exec({
          Cmd: ["bash", "-lc", "exec $(command -v zsh || command -v bash)"],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          User: "premdev",
          WorkingDir: "/workspace",
          Env: [`TERM=xterm-256color`, `COLUMNS=${cols}`, `LINES=${rows}`],
        });
        const stream = await exec.start({ hijack: true, stdin: true });
        stream.on("data", (d: Buffer) => {
          if (socket.readyState === 1) socket.send(d);
        });
        socket.on("message", (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type === "input") {
              recordShellActivity(id);
              stream.write(m.data);
            } else if (m.type === "resize") {
              recordShellActivity(id);
              exec.resize({ h: m.rows, w: m.cols }).catch(() => {});
            }
          } catch {}
        });
        const cleanup = () => { stopPing(); try { stream.end(); } catch {} };
        socket.on("close", cleanup);
        socket.on("error", cleanup);
        return;
      } catch (e: any) {
        try { socket.send(`\r\n\x1b[31mTerminal error: ${e.message}\x1b[0m\r\n`); } catch {}
        stopPing();
        socket.close();
        return;
      }
    }

    // ── Local / dev mode ──────────────────────────────────────────────────────
    const cwd = workspacePath(w.id);
    const ptyMod = await loadPty();

    if (ptyMod) {
      const term = ptyMod.spawn(process.env.SHELL || "bash", ["-l"], {
        name: "xterm-256color",
        cols, rows,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });
      term.onData((data: string) => { if (socket.readyState === 1) socket.send(data); });
      term.onExit(() => { stopPing(); try { socket.close(); } catch {} });
      socket.on("message", (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === "input") term.write(m.data);
          else if (m.type === "resize") term.resize(m.cols, m.rows);
        } catch {}
      });
      socket.on("close", () => { stopPing(); try { term.kill(); } catch {} });
      return;
    }

    // Last-resort fallback: plain child_process (no PTY — very limited)
    socket.send("\x1b[33m[dev mode: limited terminal — PTY not loaded]\x1b[0m\r\n$ ");
    let cmdBuf = "";
    socket.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type !== "input") return;
        const data: string = m.data;
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            socket.send("\r\n");
            const line = cmdBuf;
            cmdBuf = "";
            if (line.trim()) {
              const proc = spawn("bash", ["-c", line], { cwd });
              proc.stdout.on("data", (d) => socket.send(d.toString()));
              proc.stderr.on("data", (d) => socket.send(d.toString()));
              proc.on("close", () => socket.send("$ "));
            } else {
              socket.send("$ ");
            }
          } else if (ch === "\x7f") {
            if (cmdBuf.length) { cmdBuf = cmdBuf.slice(0, -1); socket.send("\b \b"); }
          } else {
            cmdBuf += ch;
            socket.send(ch);
          }
        }
      } catch {}
    });
    socket.on("close", stopPing);
  });
};
