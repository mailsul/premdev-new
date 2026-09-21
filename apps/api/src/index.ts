import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./lib/config.js";
import { db, initDb, ensureFirstAdmin } from "./lib/db.js";
import { authRoutes } from "./routes/auth.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { fileRoutes } from "./routes/files.js";
import { attachRoutes } from "./routes/attach.js";
import { terminalRoutes } from "./routes/terminal.js";
import { aiRoutes } from "./routes/ai.js";
import { adminRoutes } from "./routes/admin.js";
import { dbRoutes } from "./routes/db.js";
import { vfsRoutes } from "./routes/vfs.js";
import { isWorkspaceUpgradeRequest, setupProxy } from "./routes/proxy.js";
import { apiLimiter, aiLimiter, fileWriteLimiter, loginLimiter, clientIp } from "./lib/rate-limit.js";
import { getAllRtSettings } from "./lib/ai-settings.js";
import { applyAIBudgets } from "./lib/ai-prompt.js";
import { cronJobRoutes } from "./routes/cron-jobs.js";
import { codeServerRoutes } from "./routes/code-server.js";
import { shareRoutes, publicShareRoutes } from "./routes/share.js";
import { startCrashMonitor, getLifecycleState } from "./lib/crash-monitor.js";
import { startScheduler, getSchedulerState } from "./lib/scheduler.js";
import { reloadCaddy, syncActiveDomainSnippets } from "./lib/caddy.js";
import { startWorkspaceLifecycleReconciler } from "./lib/workspace-lifecycle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: FastifyInstance = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport: config.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
  },
  // Trust ONLY the immediate proxy (Caddy) — not arbitrary upstream
  // X-Forwarded-For headers. Without this restriction an attacker could
  // spoof X-Forwarded-For to bypass per-IP rate limiting and lockout.
  // In production the request chain is: client → Caddy → app, so only the
  // direct peer (hop 0) is trusted.
  // In dev (no proxy) this still works — req.ip falls back to the socket.
  trustProxy: (_address, hop) => hop === 0,
  bodyLimit: 50 * 1024 * 1024,
});

await app.register(fastifyCors, {
  origin: true,
  credentials: true,
});
await app.register(fastifyCookie);
await app.register(fastifyJwt, {
  secret: config.JWT_SECRET,
  cookie: { cookieName: "token", signed: false },
});
await app.register(fastifyMultipart, {
  limits: { fileSize: 200 * 1024 * 1024 },
});

initDb();
ensureFirstAdmin();
// Reconcile the persisted custom-domain registry with the generated Caddy
// snippets. The snippets are mounted from the shared data directory and can
// disappear independently during a redeploy, while the SQLite rows remain.
syncActiveDomainSnippets();

// Apply any AI runtime settings persisted in the DB so they take effect
// immediately at startup (before the first chat request arrives).
try {
  const rt = getAllRtSettings();
  applyAIBudgets({
    MAX_HISTORY_CHARS:        rt["ai.budget.maxHistoryChars"],
    MAX_HISTORY_MESSAGES:     rt["ai.budget.maxHistoryMessages"],
    MAX_SINGLE_MESSAGE_CHARS: rt["ai.budget.maxSingleMessageChars"],
    MAX_TOKENS_DEFAULT:       rt["ai.budget.maxTokensDefault"],
    MAX_TOKENS_AUTOPILOT:     rt["ai.budget.maxTokensAutopilot"],
  });
  loginLimiter.reconfigure(rt["ai.rate.loginCapacity"],  rt["ai.rate.loginRefillPerSec"]);
  apiLimiter.reconfigure(  rt["ai.rate.apiCapacity"],    rt["ai.rate.apiRefillPerSec"]);
  aiLimiter.reconfigure(   rt["ai.rate.aiCapacity"],     rt["ai.rate.aiRefillPerSec"]);
} catch {}

// Subdomain proxy must come first. It attaches an onRequest hook at root
// scope (NOT via `register`, which would encapsulate the hook to a child
// scope and silently never fire) plus a raw `upgrade` listener for workspace
// containers.
setupProxy(app);

// @fastify/websocket installs its own raw `upgrade` listener. Keep it for
// /ws/terminal/*, but do not let it process workspace upgrades after the
// proxy has already tunneled them. Without this guard, its no-route handler
// closes Code Server's `/`/`/vscode` WebSocket with a 404.
const upgradeListenersBeforeWebsocket = new Set(app.server.listeners("upgrade"));
await app.register(fastifyWebsocket);
const genericUpgradeListeners = app.server
  .listeners("upgrade")
  .filter((listener) => !upgradeListenersBeforeWebsocket.has(listener));
for (const listener of genericUpgradeListeners) {
  app.server.removeListener("upgrade", listener as (...args: any[]) => void);
  app.server.on("upgrade", (req, socket, head) => {
    if (isWorkspaceUpgradeRequest(req)) return;
    (listener as (...args: any[]) => void).call(app.server, req, socket, head);
  });
}

// WebSocket terminal — registered at root so the URL stays /ws/terminal/:id
// (the setNotFoundHandler below specifically excludes /ws/* from the SPA fallback)
await app.register(terminalRoutes);

// Per-IP rate limiting on the API surface. Three pools:
//   - apiLimiter: generous (120 burst / +2/s) — covers normal browsing
//   - fileWriteLimiter: separate bounded pool for editor writes/uploads, so
//     background tree/status polling cannot make a user upload hit a 429
//   - aiLimiter:  tight   (30  burst / +1/5s) — applied to /api/ai/* only,
//     since each AI call costs real money on upstream providers
// Health endpoint is excluded so monitoring scripts don't burn tokens.
app.addHook("onRequest", async (req, reply) => {
  const url = req.raw.url || "";
  if (!url.startsWith("/api/")) return;
  if (url === "/api/health") return;
  const ip = clientIp(req);
  const isAi = url.startsWith("/api/ai/");
  // SSE streams stay open for the duration of a model round. They do not
  // represent a new AI request and must not consume the user's AI bucket.
  // The active-jobs endpoint is also bookkeeping, not a provider call.
  const isAiStreamOrBookkeeping =
    /^\/api\/ai\/chat\/jobs\/(?:[^/]+\/stream|active)(?:\?|$)/.test(url) &&
    ["GET", "HEAD", "OPTIONS"].includes(req.method);
  const isFileWrite =
    /^\/api\/workspaces\/[^/]+\/(?:files(?:\/(?:create|delete|rename|upload))?|upload-zip)(?:\?|$)/.test(url) &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const ok = isAiStreamOrBookkeeping
    ? true
    : isAi
    ? aiLimiter.take(`ai:${ip}`)
    : isFileWrite
      ? fileWriteLimiter.take(`file-write:${ip}`)
      : apiLimiter.take(`api:${ip}`);
  if (!ok) {
    reply.code(429).send({
      error: "PremDev internal rate limit reached. Please wait a moment and try again.",
      source: "premdev",
      code: "PREMDEV_RATE_LIMIT",
      retryable: true,
    });
  }
});

// API routes
await app.register(async (api) => {
  await api.register(authRoutes, { prefix: "/auth" });
  await api.register(workspaceRoutes, { prefix: "/workspaces" });
  await api.register(fileRoutes, { prefix: "/workspaces" });
  await api.register(attachRoutes, { prefix: "/workspaces" });
  await api.register(aiRoutes, { prefix: "/ai" });
  await api.register(adminRoutes, { prefix: "/admin" });
  await api.register(dbRoutes, { prefix: "/db" });
  await api.register(vfsRoutes, { prefix: "/vfs" });
  await api.register(cronJobRoutes, { prefix: "/workspaces" });
  await api.register(codeServerRoutes, { prefix: "/workspaces" });
  await api.register(shareRoutes, { prefix: "/workspaces" });
}, { prefix: "/api" });

// Public read-only share lookup is deliberately outside /api so the copied
// link is a simple /share/<token> URL.
await app.register(publicShareRoutes);

// Health
app.get("/api/health", async () => ({
  ok: true,
  version: "0.1.0",
  time: Date.now(),
  scheduler: getSchedulerState(),
  workspaceLifecycle: getLifecycleState(),
}));

// Serve built frontend in production
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    wildcard: false,
    // Hashed assets (Vite adds content hash to filename) get long cache.
    // index.html itself must never be cached so deploys take effect immediately.
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      } else {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not found" });
    }
    reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    return reply.sendFile("index.html");
  });
}

const port = Number(config.PORT);
const host = config.HOST;

try {
  await app.listen({ port, host });
  // Caddy may start in parallel with the API. Reload now and once more after
  // a short delay so regenerated custom-domain snippets are loaded even when
  // the first Docker probe races service startup.
  syncActiveDomainSnippets();
  void reloadCaddy();
  const caddyRetry = setTimeout(() => {
    syncActiveDomainSnippets();
    void reloadCaddy();
  }, 5000);
  caddyRetry.unref?.();
  startScheduler();
  startCrashMonitor();
  startWorkspaceLifecycleReconciler();
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
