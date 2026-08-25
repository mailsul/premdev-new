/**
 * ai.ts — HTTP route handlers for AI chat.
 * Business logic is delegated to lib modules:
 *   - ai-prompt.ts    → prompt templates, message types, token utilities
 *   - ai-context.ts   → workspace snapshot & semantic search helpers
 *   - ai-providers.ts → streaming provider implementations & model config
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  createJob,
  getJob,
  appendChunk,
  finishJob,
  abortJob,
  listActiveJobs,
  type ChatJob,
  type JobStatus,
} from "../lib/ai-jobs.js";
import { requireUser } from "../lib/auth-helpers.js";
import { db, DbWorkspace } from "../lib/db.js";
import { getAIKey, listCustomProviders } from "../lib/ai-settings.js";
import {
  type Provider,
  type ChatMsg,
  AUTO_PILOT_PROMPT,
  SYSTEM_PROMPT,
  CONT_TRUNC_INSTRUCTION,
  trimHistory,
  getAIBudgets,
} from "../lib/ai-prompt.js";
import {
  buildWorkspaceContext,
  loadProjectMemory,
  loadAIMemory,
  writeAIMemory,
  appendAIMemory,
  clearAIMemory,
  buildRelevantSnippets,
} from "../lib/ai-context.js";
import {
  streamProvider,
  PROVIDER_MODELS,
  DEFAULT_MODELS,
  isTextOnlyModel,
  getModelCapability,
  fetchGoogleModels,
  fetchSnifoxModels,
  fetchOpenRouterModels,
} from "../lib/ai-providers.js";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const ImageDataUrl = z
  .string()
  .max(7 * 1024 * 1024)
  .regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/);

const Body = z.object({
  workspaceId: z.string(),
  tabId: z.string().min(1).max(64).optional().default("default"),
  provider: z.string().min(1).max(200),
  model: z.string().optional(),
  autoPilot: z.boolean().default(true),
  continuation: z.boolean().optional().default(false),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    images: z.array(ImageDataUrl).max(4).optional(),
  })),
  // File currently open in the editor — injected into system prompt so the
  // AI knows exactly what the user is looking at without needing bash:run cat.
  activeFile: z.object({
    path: z.string().max(500),
    content: z.string().max(120_000),
  }).optional(),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // POST /chat
  // Immediately returns { jobId }; actual streaming runs in the background
  // via ai-jobs.ts so tab closes / refreshes don't kill the AI run.
  app.post("/chat", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = Body.parse(req.body);

    const w = db
      .prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?")
      .get(body.workspaceId, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Workspace not found" });

    const sys = body.autoPilot ? AUTO_PILOT_PROMPT : SYSTEM_PROMPT;
    const ownerRow = db
      .prepare("SELECT username FROM users WHERE id = ?")
      .get(w.user_id) as { username?: string } | undefined;
    const ctx = buildWorkspaceContext(body.workspaceId, ownerRow?.username, w.name);
    const memory = loadProjectMemory(body.workspaceId);
    const aiMemory = loadAIMemory(body.workspaceId);
    const trimmed = trimHistory(body.messages as ChatMsg[]);
    const snippetsBlock = await buildRelevantSnippets(body.workspaceId, trimmed).catch(() => "");
    const memoryBlock = memory
      ? `\n\n--- Project instructions (.premdev-data/instructions.md) ---\n${memory}`
      : "";
    const aiMemoryBlock = aiMemory
      ? `\n\n--- AI learned memory (.premdev-data/memory.md) — user preferences & past learnings ---\n${aiMemory}`
      : "";
    const continuationBlock = body.continuation ? CONT_TRUNC_INSTRUCTION : "";

    // Inject the currently open file so the AI can see exactly what the user
    // is looking at without needing a bash:run cat round-trip. Content is
    // truncated to 200 lines (~8 KB) to keep prompt size bounded.
    let activeFileBlock = "";
    if (body.activeFile?.path && body.activeFile.content) {
      const rawLines = body.activeFile.content.split("\n");
      const truncated = rawLines.length > 200;
      const preview = truncated ? rawLines.slice(0, 200).join("\n") + "\n… (truncated at 200 lines)" : body.activeFile.content;
      const ext = body.activeFile.path.split(".").pop() ?? "";
      activeFileBlock = `\n\n--- Currently open in editor: ${body.activeFile.path} (${rawLines.length} lines total) ---\n\`\`\`${ext}\n${preview}\n\`\`\``;
    }

    // Server-side iteration cap: count how many autonomous "Tool results:"
    // continuations are already in the history. If the session has run ≥ 40
    // tool-result turns, instruct the model to stop and summarise — regardless
    // of what the client's localStorage cap says.
    const toolResultTurns = (body.messages as ChatMsg[]).filter(
      (m) => m.role === "user" && m.content.startsWith("Tool results:"),
    ).length;
    const iterCapBlock = toolResultTurns >= 40
      ? "\n\n⚠️ SERVER CAP: Sesi otonom ini sudah mencapai 40 iterasi. HENTIKAN loop sekarang — kirim SATU pesan ringkasan singkat (max 5 baris) tanpa action blocks. Jangan lanjutkan aksi apapun."
      : "";

    const messages: ChatMsg[] = [
      {
        role: "system",
        content: `${sys}\n\n--- Workspace snapshot ---\n${ctx}${snippetsBlock}${memoryBlock}${aiMemoryBlock}${activeFileBlock}${continuationBlock}${iterCapBlock}`,
      },
      ...trimmed,
    ];
    const model = body.model || DEFAULT_MODELS[body.provider];
    const { MAX_TOKENS_DEFAULT, MAX_TOKENS_AUTOPILOT } = getAIBudgets();
    const maxTokens = body.autoPilot ? MAX_TOKENS_AUTOPILOT : MAX_TOKENS_DEFAULT;

    // ── DEBUG LOGGING (opt-in: set AI_DEBUG_LOG=1 in environment) ──────────
    if (process.env.AI_DEBUG_LOG === "1") {
      const sysContent = messages[0]?.content ?? "(no system message!)";
      const msgRoles = messages.map((m) => m.role).join(", ");
      console.error(
        `[AI-DEBUG] provider=${body.provider} model=${model} autoPilot=${body.autoPilot}\n` +
        `[AI-DEBUG] messages count=${messages.length} roles=[${msgRoles}]\n` +
        `[AI-DEBUG] system prompt (first 400 chars):\n${sysContent.slice(0, 400)}\n` +
        `[AI-DEBUG] system prompt (last 200 chars):\n...${sysContent.slice(-200)}`
      );
    }
    // ────────────────────────────────────────────────────────────────────────

    const job = createJob({
      workspaceId: body.workspaceId,
      tabId: body.tabId,
      userId: u.id,
      provider: body.provider,
      model,
      continuation: body.continuation,
    });

    void reply.send({ jobId: job.id });

    setImmediate(() => {
      runChatJob(job, body, model, maxTokens, messages, u.id).catch((e) => {
        finishJob(job, "error", e?.message || String(e));
      });
    });
  });

  // Background worker: drives the upstream provider stream into the job buffer.
  async function runChatJob(
    job: ChatJob,
    body: z.infer<typeof Body>,
    model: string,
    maxTokens: number,
    messages: ChatMsg[],
    userId: string,
  ) {
    const startedAt = Date.now();
    let totalChars = 0;
    let lastChunk = "";
    let ok = true;
    let errMsg: string | null = null;
    try {
      const stream = streamProvider(body.provider, model, messages, maxTokens, job.controller.signal);
      for await (const chunk of stream) {
        if (job.status !== "running") break;
        totalChars += chunk.length;
        lastChunk = chunk;
        appendChunk(job, chunk);
      }
      if (job.status === "running") finishJob(job, "done");
    } catch (e: any) {
      ok = false;
      errMsg = e?.message || String(e);
      if (errMsg && !errMsg.includes("aborted")) {
        appendChunk(job, `\n[Error: ${errMsg}]`);
      }
      finishJob(
        job,
        errMsg && errMsg.includes("aborted") ? "aborted" : "error",
        errMsg ?? undefined,
      );
    } finally {
      try {
        const dur = Date.now() - startedAt;
        const preview = (errMsg ? `[err] ${errMsg}` : lastChunk).slice(-2000);
        db.prepare(`
          INSERT INTO ai_tool_calls
            (id, user_id, workspace_id, provider, model, kind, target, ok, output_preview, created_at)
          VALUES (?, ?, ?, ?, ?, 'chat', ?, ?, ?, ?)
        `).run(
          nanoid(16),
          userId,
          body.workspaceId,
          body.provider,
          model,
          `chars=${totalChars} dur=${dur}ms${body.autoPilot ? " autopilot" : ""}${body.continuation ? " cont" : ""}`,
          ok ? 1 : 0,
          preview || null,
          startedAt,
        );
      } catch {}
    }
  }

  // GET /chat/jobs/active?workspaceId=…
  app.get("/chat/jobs/active", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const q = z.object({ workspaceId: z.string().min(1) }).parse(req.query);
    const list = listActiveJobs(q.workspaceId, u.id).map((j) => ({
      id: j.id,
      tabId: j.tabId,
      provider: j.provider,
      model: j.model,
      continuation: j.continuation,
      bufferLen: j.buffer.length,
      createdAt: j.createdAt,
    }));
    return reply.send({ jobs: list });
  });

  // GET /chat/jobs/:id/stream?offset=N  — SSE, replays from byte N then tails.
  app.get("/chat/jobs/:id/stream", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const params = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    const query = z
      .object({ offset: z.coerce.number().int().min(0).optional().default(0) })
      .parse(req.query);
    const job = getJob(params.id);
    if (!job) return reply.code(404).send({ error: "Job not found or expired" });
    if (job.userId !== u.id) return reply.code(403).send({ error: "Forbidden" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const writeEvent = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { /* socket gone */ }
    };

    // Atomic replay + subscribe (no await between snapshot and subscribe).
    const snapshotLen = job.buffer.length;
    const replaySlice =
      snapshotLen > query.offset ? job.buffer.slice(query.offset, snapshotLen) : "";

    if (job.status !== "running") {
      if (replaySlice) writeEvent("chunk", { text: replaySlice });
      writeEvent("done", { status: job.status, error: job.error });
      reply.raw.end();
      return;
    }

    const sub = (payload: { chunk?: string; status?: JobStatus; error?: string }) => {
      if (payload.chunk) writeEvent("chunk", { text: payload.chunk });
      if (payload.status) {
        writeEvent("done", { status: payload.status, error: payload.error });
        try { reply.raw.end(); } catch {}
        job.subscribers.delete(sub);
      }
    };
    job.subscribers.add(sub);

    if (replaySlice) writeEvent("chunk", { text: replaySlice });

    const hb = setInterval(() => {
      try { reply.raw.write(`: heartbeat\n\n`); } catch {}
    }, 20_000);

    req.raw.on("close", () => {
      clearInterval(hb);
      job.subscribers.delete(sub);
    });
  });

  // POST /chat/jobs/:id/abort  — user-initiated stop.
  app.post("/chat/jobs/:id/abort", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const params = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    const ok = abortJob(params.id, u.id);
    if (!ok) return reply.code(404).send({ error: "Job not found" });
    return reply.send({ ok: true });
  });

  // POST /audit  — client logs one row per executed AI action.
  const AuditBody = z.object({
    workspaceId: z.string().min(1).max(64),
    provider: z.string().max(32).optional(),
    model: z.string().max(128).optional(),
    kind: z.string().min(1).max(32),
    target: z.string().max(500).optional(),
    ok: z.boolean(),
    output: z.string().max(2000).optional(),
  });
  app.post("/audit", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = AuditBody.parse(req.body);
    const w = db
      .prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
      .get(body.workspaceId, u.id);
    if (!w) return reply.code(404).send({ error: "Workspace not found" });
    const id = nanoid(16);
    const preview = (body.output ?? "").slice(0, 2000);
    db.prepare(`
      INSERT INTO ai_tool_calls
        (id, user_id, workspace_id, provider, model, kind, target, ok, output_preview, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      u.id,
      body.workspaceId,
      body.provider ?? null,
      body.model ?? null,
      body.kind,
      body.target ?? null,
      body.ok ? 1 : 0,
      preview || null,
      Date.now(),
    );
    return { id };
  });

  // GET /audit  — user's own workspace history.
  app.get("/audit", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const q = req.query as any;
    const wsId = typeof q.workspaceId === "string" ? q.workspaceId : null;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const rows = wsId
      ? db.prepare(`
          SELECT * FROM ai_tool_calls
          WHERE user_id = ? AND workspace_id = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(u.id, wsId, limit)
      : db.prepare(`
          SELECT * FROM ai_tool_calls
          WHERE user_id = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(u.id, limit);
    return { rows };
  });

  // GET /providers  — returns configured providers + model lists.
  app.get("/providers", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const [googleLive, snifoxLive, openrouterLive] = await Promise.all([
      fetchGoogleModels().catch(() => null),
      fetchSnifoxModels().catch(() => null),
      fetchOpenRouterModels().catch(() => null),
    ]);
    const builtIn = (
      ["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox"] as Provider[]
    ).map((id) => {
      let models = PROVIDER_MODELS[id];
      if (id === "google" && googleLive && googleLive.length > 0) {
        models = ["auto", ...googleLive];
      }
      if (id === "snifox" && snifoxLive && snifoxLive.length > 0) {
        models = ["auto", ...snifoxLive];
      }
      if (id === "openrouter" && openrouterLive && openrouterLive.length > 0) {
        models = ["auto", ...openrouterLive];
      }
      const capabilities: Record<string, number> = {};
      for (const m of models) {
        const score = getModelCapability(m);
        if (score !== null) capabilities[m] = score;
      }
      return {
        id,
        name: id,
        configured: !!getAIKey(id),
        models,
        textOnlyModels: models.filter(isTextOnlyModel),
        modelCapabilities: capabilities,
        defaultModel: DEFAULT_MODELS[id],
        isCustom: false,
      };
    });
    // Add custom providers from DB
    const customProvs = listCustomProviders()
      .filter((p) => p.enabled)
      .map((p) => ({
        id: `custom:${p.id}`,
        name: p.name,
        configured: p.configured,
        models: p.models.length > 0 ? ["auto", ...p.models] : ["auto"],
        textOnlyModels: [] as string[],
        modelCapabilities: {} as Record<string, number>,
        defaultModel: "auto",
        isCustom: true,
        docsUrl: p.docs_url,
        baseUrl: p.base_url,
      }));
    return { providers: [...builtIn, ...customProvs] };
  });

  // POST /memory/update  — save AI-learned memory for a workspace.
  // Calls the AI to extract/merge learnings from recent chat, writes to
  // .premdev-data/memory.md so future sessions benefit from past context.
  const MemoryUpdateBody = z.object({
    workspaceId: z.string().min(1).max(64),
    provider: z.string().min(1).max(200),
    model: z.string().optional(),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string().max(8000),
    })).max(300),
  });
  app.post("/memory/update", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = MemoryUpdateBody.parse(req.body);
    // "__global__" is a special key — stores cross-workspace shared memory.
    // Skip workspace DB validation for it; anyone authenticated can read/write it.
    if (body.workspaceId !== "__global__") {
      const w = db
        .prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?")
        .get(body.workspaceId, u.id) as DbWorkspace | undefined;
      if (!w) return reply.code(404).send({ error: "Workspace not found" });
    }

    const existingMemory = loadAIMemory(body.workspaceId);
    const instructions = loadProjectMemory(body.workspaceId);
    const today = new Date().toISOString().slice(0, 10);

    const curatorSystem = `You are a memory curator for PremDev IDE. Extract and consolidate key learnings from a coding session into a concise structured memory file.

Output ONLY the updated memory file content — no preamble, no explanation, no markdown fences around the whole thing.

Use this exact format:
# Memori AI
*Diperbarui: ${today}. Edit .premdev-data/memory.md untuk ubah manual.*

## Gaya & Preferensi User
(bullet points: communication language, coding style, naming conventions, likes/dislikes)

## Tech Stack Terdeteksi
(bullet points: frameworks, languages, tools, databases seen in this session)

## Pengetahuan Penting Project
(bullet points: architecture decisions, important file paths, configs, constraints)

## Solusi & Pola Berguna
(bullet points: fixes, patterns, approaches that worked well)

Rules:
- Max 80 lines total
- In Bahasa Indonesia if user communicates in Indonesian
- Be specific and factual (e.g. "User pakai React + Vite + TypeScript" not "User suka React")
- Do NOT include conversation snippets or raw code blocks
- Merge with existing memory rather than discarding it
- Skip sections with nothing worth noting (omit entire section rather than leaving it empty)`;

    const existingBlock = existingMemory
      ? `\n\nEXISTING MEMORY (update/merge, do not discard valuable items):\n${existingMemory}`
      : "\n\nNo existing memory yet — create fresh.";
    const instructionsBlock = instructions
      ? `\n\nUSER MANUAL INSTRUCTIONS (.premdev-data/instructions.md — read-only for you, do NOT reproduce in output):\n${instructions}`
      : "";

    const recentMsgs = body.messages.slice(-50);
    const historyText = recentMsgs
      .filter((m) => !m.content.startsWith("Tool results:") && !m.content.startsWith("Lanjutkan"))
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`)
      .join("\n\n---\n\n");

    const model = body.model || DEFAULT_MODELS[body.provider];
    const { MAX_TOKENS_DEFAULT } = getAIBudgets();

    const curatorMessages: ChatMsg[] = [
      { role: "system", content: curatorSystem + existingBlock + instructionsBlock },
      { role: "user", content: `Extract memory from this conversation:\n\n${historyText}` },
    ];

    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 60_000);
      let result = "";
      const stream = streamProvider(body.provider, model, curatorMessages, Math.min(MAX_TOKENS_DEFAULT, 2048), ac.signal);
      for await (const chunk of stream) result += chunk;
      clearTimeout(t);

      result = result.trim();
      if (!result || result.length < 30) {
        return reply.code(500).send({ error: "AI returned empty memory" });
      }
      writeAIMemory(body.workspaceId, result);
      return reply.send({ ok: true, memory: result });
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message || "Memory update failed" });
    }
  });

  // POST /memory/append  — used by the AI's `memory:save` action (no AI call, raw append).
  const MemoryAppendBody = z.object({
    workspaceId: z.string().min(1),
    content: z.string().min(1).max(8000),
  });
  app.post("/memory/append", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = MemoryAppendBody.parse(req.body);
    try {
      appendAIMemory(body.workspaceId, body.content);
      return reply.send({ ok: true });
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message || "Memory append failed" });
    }
  });

  // POST /memory/clear  — delete the AI memory file for a workspace (called on clear-chat).
  const MemoryClearBody = z.object({ workspaceId: z.string().min(1).max(64) });
  app.post("/memory/clear", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = MemoryClearBody.parse(req.body);
    const w = db
      .prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
      .get(body.workspaceId, u.id);
    if (!w) return reply.code(404).send({ error: "Workspace not found" });
    try {
      clearAIMemory(body.workspaceId);
      return reply.send({ ok: true });
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message || "Memory clear failed" });
    }
  });

  // POST /memory/compact  — merge a new note into existing AI memory via a
  // lightweight, non-streaming AI call. Used when the AI emits a memorySave
  // action mid-session so inline notes are merged rather than blindly appended.
  // Falls back to raw append if the AI call fails or existing memory is empty.
  const MemoryCompactBody = z.object({
    workspaceId: z.string().min(1).max(64),
    newNote: z.string().min(1).max(4000),
    provider: z.string().min(1).max(200),
    model: z.string().optional(),
  });
  app.post("/memory/compact", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = MemoryCompactBody.parse(req.body);
    if (body.workspaceId !== "__global__") {
      const w = db
        .prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
        .get(body.workspaceId, u.id);
      if (!w) return reply.code(404).send({ error: "Workspace not found" });
    }

    const existing = loadAIMemory(body.workspaceId);
    if (!existing) {
      // No existing memory — raw append is safe (nothing to deduplicate).
      appendAIMemory(body.workspaceId, body.newNote);
      return reply.send({ ok: true, compacted: false });
    }

    const today = new Date().toISOString().slice(0, 10);
    const compactSystem = `You are a memory compactor for PremDev IDE. Merge the EXISTING MEMORY with the NEW NOTE into a single clean memory file, deduplicating and resolving contradictions (prefer the NEW NOTE when they conflict).

Output ONLY the merged file — no preamble, no fences.

Format (keep existing section headers):
# Memori AI
*Diperbarui: ${today}. Edit .premdev-data/memory.md untuk ubah manual.*

Rules:
- Max 80 lines total
- Merge duplicate facts; remove stale/contradicted entries
- Keep every unique important fact from both sources
- Omit empty sections entirely`;

    const messages: ChatMsg[] = [
      { role: "system", content: compactSystem },
      {
        role: "user",
        content: `EXISTING MEMORY:\n${existing}\n\nNEW NOTE TO MERGE:\n${body.newNote}`,
      },
    ];

    const model = body.model || DEFAULT_MODELS[body.provider];
    const { MAX_TOKENS_DEFAULT } = getAIBudgets();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30_000);
    let result = "";
    try {
      const stream = streamProvider(
        body.provider,
        model,
        messages,
        Math.min(MAX_TOKENS_DEFAULT, 2048),
        ac.signal,
      );
      for await (const chunk of stream) result += chunk;
      clearTimeout(t);
      result = result.trim();
      if (!result || result.length < 20) throw new Error("empty");
      writeAIMemory(body.workspaceId, result);
      return reply.send({ ok: true, compacted: true });
    } catch {
      clearTimeout(t);
      // Graceful degradation: fall back to raw append so the note is never lost.
      appendAIMemory(body.workspaceId, body.newNote);
      return reply.send({ ok: true, compacted: false });
    }
  });

  // POST /web-fetch  — used by the AI's `web:fetch` action (full page text via Jina reader).
  // Supports pagination via `offset` so the AI can read long docs in 12 KB pages:
  //   first call:  { url, offset: 0 }     → chars 0..12000
  //   second call: { url, offset: 12000 } → chars 12000..24000
  //   etc.  The response includes `hasMore` and `totalLength` for context.
  const WebFetchBody = z.object({
    url: z.string().url().max(2000),
    offset: z.number().int().min(0).optional().default(0),
  });
  app.post("/web-fetch", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = WebFetchBody.parse(req.body);
    try {
      const jinaUrl = `https://r.jina.ai/${body.url}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20_000);
      const r = await fetch(jinaUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept": "text/plain, text/markdown, */*",
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) return reply.code(502).send({ ok: false, error: `HTTP ${r.status} from Jina reader` });
      const raw = await r.text();
      const PAGE = 12_000;
      const offset = body.offset ?? 0;
      const content = raw.slice(offset, offset + PAGE);
      const hasMore = offset + PAGE < raw.length;
      return reply.send({
        ok: true,
        url: body.url,
        content,
        offset,
        nextOffset: hasMore ? offset + PAGE : null,
        hasMore,
        totalLength: raw.length,
      });
    } catch (e: any) {
      return reply.code(502).send({ ok: false, error: e?.message ?? "Fetch failed" });
    }
  });

  // POST /web-search  — used by the AI's `web:search` action.
  const WebSearchBody = z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().positive().max(20).optional().default(8),
  });
  app.post("/web-search", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = WebSearchBody.parse(req.body);
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(body.query)}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `q=${encodeURIComponent(body.query)}`,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (!r.ok) return reply.code(502).send({ error: `Upstream returned ${r.status}` });
      const html = (await r.text()).slice(0, 1024 * 1024);
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const linkRe =
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe =
        /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const links: Array<{ title: string; url: string }> = [];
      const snippets: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(html)) && links.length < body.maxResults) {
        let href = m[1];
        const ud = href.match(/[?&]uddg=([^&]+)/);
        if (ud) try { href = decodeURIComponent(ud[1]); } catch { /* keep */ }
        if (href.startsWith("//")) href = "https:" + href;
        const title = m[2]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
        if (title) links.push({ title, url: href });
      }
      while ((m = snippetRe.exec(html)) && snippets.length < links.length) {
        snippets.push(
          m[1]
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim(),
        );
      }
      for (let i = 0; i < links.length; i++) {
        results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
      }
      return { ok: true, query: body.query, results };
    } catch (e: any) {
      return reply.code(502).send({ error: e?.message ?? "Web search failed" });
    }
  });

  // POST /chat/council — multi-model debate: N providers answer in parallel, one synthesises.
  const CouncilBody = z.object({
    workspaceId: z.string().min(1).max(64),
    members: z.array(z.object({
      provider: z.string().min(1).max(200),
      model: z.string().optional().default("auto"),
    })).min(1).max(6),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
    })).min(1),
    synthProvider: z.string().min(1).max(200).optional(),
    synthModel: z.string().optional(),
  });
  app.post("/chat/council", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = CouncilBody.parse(req.body);
    const w = db
      .prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?")
      .get(body.workspaceId, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Workspace not found" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const ctrl = new AbortController();
    req.raw.on("close", () => ctrl.abort());

    const writeEvent = (event: string, data: unknown) => {
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    const ownerRow = db
      .prepare("SELECT username FROM users WHERE id = ?")
      .get(w.user_id) as { username?: string } | undefined;
    const ctx = buildWorkspaceContext(body.workspaceId, ownerRow?.username, w.name);
    const { MAX_TOKENS_DEFAULT } = getAIBudgets();

    const sysContent = `${SYSTEM_PROMPT}\n\n--- Workspace snapshot ---\n${ctx}\n\n--- Council mode: give your best, direct answer to the user's question. ---`;
    const messages: ChatMsg[] = [
      { role: "system", content: sysContent },
      ...(body.messages as ChatMsg[]),
    ];

    // Run all council members in parallel, stream member-done events as each finishes.
    const memberResults = await Promise.all(
      body.members.map(async (m) => {
        const provModel = m.model || DEFAULT_MODELS[m.provider];
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 45_000);
        try {
          let text = "";
          const stream = streamProvider(m.provider, provModel, messages, Math.min(MAX_TOKENS_DEFAULT, 4096), ac.signal);
          for await (const chunk of stream) {
            if (ctrl.signal.aborted) break;
            if (chunk.startsWith("__ERROR__") || chunk.startsWith("__KEYDEAD__") || chunk.startsWith("__QUOTA__")) {
              text += `[Provider error: ${chunk.replace(/^__\w+__/, "")}]`;
              break;
            }
            text += chunk;
          }
          clearTimeout(timer);
          const ok = !text.startsWith("[Provider error");
          const result = { provider: m.provider, model: provModel, text: text.trim(), ok };
          writeEvent("member-done", result);
          return result;
        } catch (e: any) {
          clearTimeout(timer);
          const result = { provider: m.provider, model: provModel, text: `[Error: ${e?.message || "unknown"}]`, ok: false };
          writeEvent("member-done", result);
          return result;
        }
      })
    );

    if (ctrl.signal.aborted) { try { reply.raw.end(); } catch {} return; }

    // Synthesise using the specified provider (or first member's provider).
    const goodMembers = memberResults.filter((m) => m.ok && m.text && m.text.length > 10);
    if (goodMembers.length > 1) {
      const synthProv = (body.synthProvider ?? memberResults[0].provider) as string;
      const synthMod = body.synthModel || DEFAULT_MODELS[synthProv as Provider] || "auto";
      const perspectives = goodMembers
        .map((m, i) => `### ${m.provider}/${m.model} (Perspective ${i + 1}):\n\n${m.text}`)
        .join("\n\n---\n\n");
      const userQ = body.messages.filter((m) => m.role === "user").pop()?.content ?? "";
      const synthMessages: ChatMsg[] = [
        {
          role: "system",
          content: "You are a synthesis AI. Multiple AI models have each answered the same question. Synthesize them into the single best, most comprehensive answer. Be direct — do not say 'Model A said X'. Give the unified best answer. Keep it concise and actionable.",
        },
        {
          role: "user",
          content: `Original question:\n${userQ}\n\n---\n\n${perspectives}\n\n---\n\nSynthesize these into the single best answer:`,
        },
      ];
      try {
        const synthStream = streamProvider(synthProv, synthMod, synthMessages, Math.min(MAX_TOKENS_DEFAULT, 8192), ctrl.signal);
        for await (const chunk of synthStream) {
          if (ctrl.signal.aborted) break;
          if (!chunk.startsWith("__")) writeEvent("synthesis-chunk", { text: chunk });
        }
      } catch {}
    } else if (goodMembers.length === 1) {
      writeEvent("synthesis-chunk", { text: goodMembers[0].text });
    }

    writeEvent("done", { memberCount: memberResults.length });
    try { reply.raw.end(); } catch {}
  });
};
