import type { FastifyInstance } from "fastify";
import http from "node:http";
import net from "node:net";
import { db, DbWorkspace, dnsSafe, getActiveDomains } from "../lib/db.js";
import { config } from "../lib/config.js";
import { docker } from "../lib/runtime.js";

/**
 * Decide whether a proxy connection failure means the workspace is *truly*
 * dead (container missing / exited) or just transiently unreachable
 * (container alive but the user's app crashed / hasn't bound the port yet /
 * is a non-HTTP daemon like a Telegram userbot).
 *
 * Only the first case warrants flipping the DB status to 'stopped'. The
 * second case must NOT — otherwise headless workloads (bots, workers,
 * cron-style scripts) get marked stopped the moment anyone hits the
 * preview URL, which then makes the IDE show "Stopped" while the
 * container's logs keep streaming. That mismatch was the source of
 * "kayak udh jalan tp dipaksa stop cmn log ttp jalan".
 */
async function containerIsTrulyDead(containerName: string): Promise<boolean> {
  if (!docker) return false; // dev mode: don't touch DB on local processes
  try {
    const info = await docker.getContainer(containerName).inspect();
    // Running OR Restarting = treat as alive. Only Exited / Dead / Removing
    // count as dead.
    return !info.State.Running && !info.State.Restarting;
  } catch {
    // inspect throws 404 → container removed → really gone
    return true;
  }
}

/**
 * Subdomain-based workspace proxy.
 *
 * URL format: `<project>-<user>.<PRIMARY_DOMAIN>` (e.g.
 * `keuangan-naufal.flixprem.org`). The subdomain doubles as the live
 * preview AND the deploy URL — workspaces stay running 24/7 unless the
 * user explicitly stops them.
 *
 * Caddy is the public TLS terminator and forwards every non-reserved
 * subdomain (`*.flixprem.org` minus app/admin/db/api/ws) to this app on
 * port 3001. The hook below inspects the Host header, looks up the
 * matching workspace by sanitised project + username, then streams the
 * request to the workspace container's preview port.
 *
 * IMPORTANT: this is wired in via `setupProxy(app)` (NOT `app.register`)
 * because Fastify plugin encapsulation would otherwise scope the
 * `onRequest` hook to the plugin only, and since the plugin owns no
 * routes, the hook would never fire for requests handled by other
 * plugins / static.
 */

// First-party subdomains that must NEVER be treated as workspace previews.
const RESERVED_SUBS = new Set([
  "app", "admin", "db", "api", "ws", "preview", "deploy", "www",
  "mail", "smtp", "imap", "ftp", "cpanel",
]);

// Connection-level / hop-by-hop headers we MUST NOT forward as-is per
// RFC 7230 §6.1. Letting them through corrupts framing or leaks state
// across hops.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

type Target = { containerName: string; port: number };

/**
 * Resolve a subdomain label to a running workspace target.
 * `incomingDomain` is the base domain that received this request (e.g.
 * "flixprem.org"). Used for domain-aware routing so that `myapp.domainA`
 * cannot accidentally hit a workspace pinned to `myapp.domainB`.
 */
function resolveSubdomain(sub: string, incomingDomain: string):
  | { ok: true; target: Target }
  | { ok: false; status: number; msg: string }
  | null {
  const primary = config.PRIMARY_DOMAIN.toLowerCase();

  // 1) Custom-subdomain lookup wins over the auto-form. The workspace's
  //    custom_domain column tells us which base domain it belongs to;
  //    NULL means it lives on PRIMARY_DOMAIN.
  const customRow = db
    .prepare(`
      SELECT w.*, u.username AS _username
      FROM workspaces w
      JOIN users u ON u.id = w.user_id
      WHERE w.custom_subdomain = ?
    `)
    .get(sub) as (DbWorkspace & { _username: string }) | undefined;
  if (customRow) {
    // Domain verification: ensure the request comes in on the right domain.
    const expectedDomain = (customRow.custom_domain ?? primary).toLowerCase();
    if (expectedDomain !== incomingDomain.toLowerCase()) {
      // Label is registered on a different domain; fall through to 503.
      return { ok: false, status: 503, msg: "Workspace not running" };
    }
    if (customRow.status !== "running" || customRow.preview_port == null) {
      return { ok: false, status: 503, msg: "Workspace not running" };
    }
    return { ok: true, target: { containerName: `pw_${customRow.id}`, port: customRow.preview_port } };
  }

  // 2) Fall back to the auto-generated <project>-<user> form.
  //    Only PRIMARY_DOMAIN uses the auto-form; custom domains require an
  //    explicit custom_subdomain mapping.
  if (incomingDomain.toLowerCase() !== primary) {
    return { ok: false, status: 503, msg: "Workspace not running" };
  }
  if (!sub.includes("-")) {
    return { ok: false, status: 503, msg: "Workspace not running" };
  }
  const rows = db
    .prepare(`
      SELECT w.*, u.username AS _username
      FROM workspaces w
      JOIN users u ON u.id = w.user_id
      WHERE w.status = 'running' AND w.preview_port IS NOT NULL
    `)
    .all() as Array<DbWorkspace & { _username: string }>;
  const matches = rows.filter((r) =>
    !r.custom_subdomain &&
    `${dnsSafe(r.name)}-${dnsSafe(r._username)}` === sub,
  );
  if (matches.length === 0) {
    // ── Multi-port routing ───────────────────────────────────────────────
    // Try pattern: <project>-<PORT_NUMBER>-<user>  (e.g. bot-3000-naufal)
    // Port number must be a pure numeric segment between project and user.
    // We scan all possible positions for a numeric segment to handle
    // projects/users that contain hyphens themselves.
    const parts = sub.split("-");
    for (let i = 1; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!/^\d+$/.test(seg)) continue;
      const portNum = Number(seg);
      if (portNum < 1 || portNum > 65535) continue;

      const candidateSub = [...parts.slice(0, i), ...parts.slice(i + 1)].join("-");
      const multiRows = db
        .prepare(`
          SELECT w.*, u.username AS _username
          FROM workspaces w
          JOIN users u ON u.id = w.user_id
          WHERE w.status = 'running' AND w.preview_ports IS NOT NULL
        `)
        .all() as Array<DbWorkspace & { _username: string }>;

      for (const r of multiRows) {
        if (r.custom_subdomain) continue;
        if (`${dnsSafe(r.name)}-${dnsSafe(r._username)}` !== candidateSub) continue;
        try {
          const portMap: Record<string, number> = JSON.parse(r.preview_ports);
          // Check if any process runs on the requested port
          const hasPort = Object.values(portMap).includes(portNum);
          if (hasPort) {
            return { ok: true, target: { containerName: `pw_${r.id}`, port: portNum } };
          }
        } catch { /* malformed JSON — skip */ }
      }
    }
    return { ok: false, status: 503, msg: "Workspace not running" };
  }
  if (matches.length > 1) {
    console.warn(
      `[proxy] subdomain collision for "${sub}":`,
      matches.map((m) => ({ id: m.id, name: m.name, user: m._username })),
    );
    return { ok: false, status: 409, msg: "Workspace name collision — rename one of the projects" };
  }
  const w = matches[0];
  return { ok: true, target: { containerName: `pw_${w.id}`, port: w.preview_port! } };
}

/**
 * Pick the target for an inbound Host. Returns null when this host should
 * fall through to the rest of the app (main UI, /api, /ws, etc.).
 * Handles PRIMARY_DOMAIN and all active custom domains from the DB.
 */
function targetForHost(rawHost: string):
  | { ok: true; target: Target }
  | { ok: false; status: number; msg: string }
  | null {
  if (!rawHost) return null;
  const host = rawHost.toLowerCase().split(":")[0];
  const primary = config.PRIMARY_DOMAIN.toLowerCase();
  const primarySuffix = `.${primary}`;

  // Check PRIMARY_DOMAIN first.
  if (host.endsWith(primarySuffix) && host !== primary) {
    const sub = host.slice(0, host.length - primarySuffix.length);
    if (sub.includes(".") || RESERVED_SUBS.has(sub)) return null;
    return resolveSubdomain(sub, primary);
  }

  // Check any active custom domains registered by the admin.
  for (const d of getActiveDomains()) {
    const dl = d.toLowerCase();
    const suffix = `.${dl}`;
    if (host.endsWith(suffix) && host !== dl) {
      const sub = host.slice(0, host.length - suffix.length);
      if (sub.includes(".") || RESERVED_SUBS.has(sub)) continue;
      return resolveSubdomain(sub, dl);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Nice HTML error page for stopped / unreachable workspaces
// ---------------------------------------------------------------------------
function workspaceErrorHtml(title: string, body: string, statusCode: number): string {
  const color = statusCode === 503 ? "#f59e0b" : "#ef4444";
  const colorSoft = statusCode === 503 ? "rgba(245,158,11,0.12)" : "rgba(239,68,68,0.12)";
  const icon = statusCode === 503
    ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <meta name="robots" content="noindex,nofollow"/>
  <link rel="icon" href="data:,"/>
  <style>
    :root{color-scheme:dark;--bg-0:#0b0b12;--bg-1:#15151f;--border:#2a2a3a;--text:#e8e8f0;--muted:#8a8aa0;--accent:${color};--accent-soft:${colorSoft}}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;height:100%}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:radial-gradient(ellipse at top,rgba(139,92,246,.06) 0%,transparent 60%) var(--bg-0);color:var(--text);display:grid;place-items:center;padding:24px;line-height:1.5;-webkit-font-smoothing:antialiased}
    .card{max-width:520px;width:100%;background:var(--bg-1);border:1px solid var(--border);border-radius:14px;padding:36px 32px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    .icon{display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:var(--accent-soft);color:var(--accent);margin-bottom:18px}
    h1{margin:0 0 12px;font-size:22px;font-weight:600;letter-spacing:-.01em}
    p{margin:0;color:var(--muted);font-size:14px;line-height:1.6}
    .footer{margin-top:24px;font-size:12px;color:var(--muted)}
    .code{font-size:12px;color:var(--accent);background:var(--accent-soft);padding:2px 7px;border-radius:4px;font-family:monospace}
  </style>
</head>
<body>
  <main class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${body}</p>
    <div class="footer"><span class="code">HTTP ${statusCode}</span></div>
  </main>
</body>
</html>`;
}

export function setupProxy(app: FastifyInstance): void {
  // ---- Plain HTTP requests ----
  app.addHook("onRequest", async (req, reply) => {
    const decision = targetForHost(req.headers.host ?? "");
    if (!decision) return; // fall through to other handlers
    if (!decision.ok) {
      reply
        .code(decision.status)
        .header("content-type", "text/html; charset=utf-8")
        .send(workspaceErrorHtml(
          decision.status === 409 ? "Name Collision" : "Workspace Not Running",
          decision.msg,
          decision.status,
        ));
      return reply;
    }
    const { target } = decision;

    // Buffer the body up-front so we can send a precise Content-Length
    // and never resort to chunked transfer encoding. PHP's built-in dev
    // server (and other minimal HTTP servers commonly used in workspace
    // templates) hang up the socket on chunked POST, which is the root
    // cause of "socket hang up" / "GET succeeded but POST never arrived".
    // 8 MB cap is plenty for forms and small JSON; uploads larger than
    // that should go through the dedicated /api/files endpoints anyway.
    const method = (req.method ?? "GET").toUpperCase();
    const bodyless = method === "GET" || method === "HEAD" || method === "DELETE" || method === "OPTIONS";
    let body: Buffer = Buffer.alloc(0);
    if (!bodyless) {
      try {
        body = await new Promise<Buffer>((resolveBody, rejectBody) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const MAX = 8 * 1024 * 1024;
          req.raw.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX) {
              rejectBody(new Error("body too large (>8MB)"));
              return;
            }
            chunks.push(c);
          });
          req.raw.on("end", () => resolveBody(Buffer.concat(chunks)));
          req.raw.on("error", rejectBody);
        });
      } catch (e: any) {
        reply.code(413).send(e?.message ?? "body read error");
        return reply;
      }
    }

    return new Promise<void>((resolve) => {
      // Strip hop-by-hop headers when forwarding to upstream. Keep the
      // original Host header — PHP / Flask / etc. compare it against
      // their configured ServerName and reject mismatches.
      const fwdHeaders: Record<string, any> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (lk === "content-length" || lk === "expect") continue; // recomputed / dropped
        fwdHeaders[k] = v;
      }
      fwdHeaders["x-forwarded-host"] = (req.headers.host ?? "").toString();
      fwdHeaders["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) || "https";
      fwdHeaders["x-forwarded-for"] = req.ip;
      // Force connection close + explicit Content-Length on EVERY request
      // so Node never picks Transfer-Encoding: chunked or keep-alive.
      fwdHeaders["connection"] = "close";
      fwdHeaders["content-length"] = String(body.length);

      const upstream = http.request({
        host: target.containerName,
        port: target.port,
        method,
        path: req.url,
        headers: fwdHeaders,
        timeout: 120_000,
      }, (upRes) => {
        reply.code(upRes.statusCode ?? 502);
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          if (v !== undefined) reply.header(k, v as any);
        }
        reply.send(upRes);
        upRes.on("end", resolve);
        upRes.on("error", () => resolve());
        upRes.on("close", resolve);
      });

      upstream.on("error", async (err: NodeJS.ErrnoException) => {
        if (!reply.sent) {
          if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "EAI_AGAIN") {
            // Only flip DB to stopped if the container itself is gone.
            // ECONNREFUSED with a live container = app crashed or never
            // bound a port (totally normal for headless bots / workers
            // that don't expose HTTP at all). Don't lie to the UI.
            const dead = await containerIsTrulyDead(target.containerName).catch(() => false);
            if (dead) {
              try {
                const id = target.containerName.replace(/^pw_/, "");
                db.prepare("UPDATE workspaces SET status = 'stopped', preview_port = NULL WHERE id = ?").run(id);
              } catch {}
            }
            reply
              .code(503)
              .header("content-type", "text/html; charset=utf-8")
              .send(workspaceErrorHtml(
                "Workspace Not Running",
                dead
                  ? "This workspace is not running. Open the editor and click <strong>Run</strong> to start it."
                  : err.code === "ECONNREFUSED"
                    ? "The workspace is running but hasn&apos;t bound to the preview port yet. Make sure your app listens on <code>0.0.0.0:$PORT</code> — or this workspace is a headless process (bot/worker) with no web interface."
                    : "The workspace is running but unreachable (DNS lookup failed). Try restarting the workspace.",
                503,
              ));
          } else {
            reply.code(502).send(`Upstream error: ${err.message}`);
          }
        }
        resolve();
      });
      upstream.on("timeout", () => {
        if (!reply.sent) reply.code(504).send("Upstream timeout");
        try { upstream.destroy(new Error("timeout")); } catch {}
        resolve();
      });
      // Send the buffered body atomically and close the request stream.
      if (body.length > 0) upstream.write(body);
      upstream.end();
    });
  });

  // ---- WebSocket / HTTP/1.1 Upgrade tunneling ----
  // Native http server emits 'upgrade' BEFORE Fastify's request lifecycle
  // gets to peek at it. We attach an additional listener that catches
  // workspace-host upgrades and tunnels them as raw bidirectional sockets.
  // For non-workspace hosts (e.g. /ws/terminal/* served by the app itself),
  // we return early so @fastify/websocket's listener handles it.
  app.server.on("upgrade", (req, clientSocket, head) => {
    const decision = targetForHost(req.headers.host ?? "");
    if (!decision) return; // not a workspace upgrade — let fastify-websocket handle it
    if (!decision.ok) {
      try {
        clientSocket.write(`HTTP/1.1 ${decision.status} ${decision.msg}\r\n\r\n`);
      } catch {}
      try { clientSocket.destroy(); } catch {}
      return;
    }
    const { target } = decision;

    const upstream = net.connect(target.port, target.containerName);
    upstream.setNoDelay(true);
    if (clientSocket instanceof net.Socket) clientSocket.setNoDelay(true);

    const teardown = () => {
      try { upstream.destroy(); } catch {}
      try { clientSocket.destroy(); } catch {}
    };
    upstream.on("error", teardown);
    clientSocket.on("error", teardown);
    upstream.on("close", teardown);
    clientSocket.on("close", teardown);

    upstream.on("connect", () => {
      // Replay the original upgrade request line + headers, then any
      // bytes that arrived after the head (rare but possible).
      const headerLines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const vv of v) headerLines.push(`${k}: ${vv}`);
        else if (v !== undefined) headerLines.push(`${k}: ${v}`);
      }
      headerLines.push("", "");
      upstream.write(headerLines.join("\r\n"));
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });
}
