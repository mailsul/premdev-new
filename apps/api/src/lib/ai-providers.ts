/**
 * ai-providers.ts — streaming provider implementations and model config.
 * Extracted from apps/api/src/routes/ai.ts for maintainability.
 */

import { getAIKey, getAIKeys, getCustomProviderKeys, listCustomProviders } from "./ai-settings.js";
import { config } from "./config.js";
import type { Provider, ChatMsg } from "./ai-prompt.js";

// ---------------------------------------------------------------------------
// Model lists
// ---------------------------------------------------------------------------

/**
 * Default model per provider. "auto" = smartest-first tier rotation.
 */
export const DEFAULT_MODELS: Record<string, string> = {
  openai: "auto",
  anthropic: "auto",
  google: "auto",
  openrouter: "auto",
  groq: "auto",
  konektika: "auto",
  snifox: "auto",
  "9router": "auto",
};

/**
 * Free-tier Gemini models, ordered by cost-effectiveness (cheapest first).
 * "auto" iterates this list and falls through on 429 quota errors. The live
 * list from Google's ListModels endpoint is preferred at runtime; this
 * constant is only the fallback when the API call fails.
 * NOTE: Only use stable API model identifiers here — NOT display names from
 * AI Studio. Wrong names cause 404 "model not found" errors.
 */
export const GEMINI_FREE_TIER = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
] as const;

export const PROVIDER_MODELS: Record<Provider, string[]> = {
  "9router": ["auto"],   // populated at runtime from /v1/models
  openai: ["auto", "gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
  anthropic: ["auto", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  google: [
    "auto",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
  ],
  openrouter: [
    "auto",
    // === Top picks — supports actions (non text-only) ===
    "deepseek/deepseek-r1:free",
    "deepseek/deepseek-chat-v3.1:free",
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "openai/gpt-oss-120b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
    "minimax/minimax-m2.5:free",
    "openai/gpt-oss-20b:free",
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "nvidia/nemotron-nano-9b-v2:free",
    "poolside/laguna-m.1:free",
    "baidu/cobuddy:free",
    // === Text-only (no actions / tool-use) ===
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-2-9b-it:free",
    "liquid/lfm-2.5-1.2b-thinking:free",
    "liquid/lfm-2.5-1.2b-instruct:free",
    "meta-llama/llama-3.2-3b-instruct:free",
    "baidu/qianfan-ocr-fast:free",
    "openrouter/auto",
  ],
  groq: ["auto", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  konektika: ["auto", "kimi-pro"],
  snifox: [
    "auto",
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "openai/gpt-5-codex",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-3-flash-preview",
    "google/gemini-2.5-flash",
  ],
  "9router": [
    "auto",
    // Model-model ini di-resolve oleh 9Router ke provider terbaik yang tersedia.
    // Tambah / ubah di dashboard router.flixprem.org, bukan di sini.
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4",
    "anthropic/claude-haiku-3-5",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "openai/gpt-4.1-mini",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite",
    "deepseek/deepseek-r1",
    "deepseek/deepseek-v3",
    "meta-llama/llama-3.3-70b-instruct",
  ],
};

/**
 * Per-provider "auto" tier — smartest first, cheapest last.
 * Google has its own dynamic auto handler in streamGoogle (it queries the
 * live model list per-key), so its tier here is unused by the dispatcher.
 */
export const AUTO_TIERS: Record<Provider, string[]> = {
  "9router": [],  // auto-tier populated at runtime from fetchNineRouterModels
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
  anthropic: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  google: [...GEMINI_FREE_TIER],
  openrouter: [
    "deepseek/deepseek-r1:free",
    "deepseek/deepseek-chat-v3.1:free",
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "openai/gpt-oss-120b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "qwen/qwen-2.5-72b-instruct:free",
  ],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  konektika: ["kimi-pro"],
  snifox: [
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-flash",
  ],
  "9router": [
    // Auto tier: 9Router picks best available provider based on your configured fallbacks.
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-4o",
    "google/gemini-2.5-flash",
    "anthropic/claude-haiku-3-5",
    "deepseek/deepseek-r1",
  ],
};

/**
 * Per-model context window size in tokens (approximate).
 * Used to skip models that would reject a large context outright.
 * Free-tier Groq has very tight TPM quotas, so models with small
 * context windows are skipped when the estimated prompt is large.
 */
export const MODEL_CONTEXT_LIMIT: Record<string, number> = {
  // Groq — free tier has very low TPM even on "128k" models
  "llama-3.3-70b-versatile": 12000,  // effective TPM cap on free tier
  "llama-3.1-8b-instant":    6000,   // effective TPM cap on free tier
  "mixtral-8x7b-32768":      8000,
  // OpenAI
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1-mini": 128000,
  // Anthropic
  "claude-3-5-sonnet-20241022": 200000,
  "claude-3-5-haiku-20241022": 200000,
  // Google (context-rich)
  "gemini-2.5-flash": 1000000,
  "gemini-2.0-flash": 1000000,
  "gemini-1.5-flash": 1000000,
};

/**
 * Estimate token count from a message array (4 chars ≈ 1 token).
 */
function estimateTokens(messages: ChatMsg[]): number {
  return Math.ceil(messages.reduce((s, m) => s + (m.content?.length || 0), 0) / 4);
}

/**
 * Models known to ignore the structured action format and respond with
 * plain prose only. Surfaced in the /providers response so the UI can
 * mark them with a "text only" badge.
 */
export const TEXT_ONLY_MODEL_PATTERNS: RegExp[] = [
  /gemma/i,
  /llama-3\.1-8b/i,
  /llama-3\.2-(?:1b|3b)/i,
  /qwen-2\.5-(?:0\.5|1\.5|3|7)b/i,
  /mixtral-8x7b/i,
  /lfm-2\.5/i,
  /qianfan/i,
];

export function isTextOnlyModel(name: string): boolean {
  if (name === "auto") return false;
  return TEXT_ONLY_MODEL_PATTERNS.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Model capability scores (0–100)
// Represents estimated reasoning + tool-use + instruction-following ability.
// ---------------------------------------------------------------------------

export const MODEL_CAPABILITY: Record<string, number> = {
  // OpenAI
  "gpt-4o": 92,
  "gpt-4o-mini": 75,
  "gpt-4.1-mini": 72,
  // Anthropic
  "claude-3-5-sonnet-20241022": 95,
  "claude-3-5-haiku-20241022": 78,
  // Google — stable & preview API identifiers (from ai.google.dev/gemini-api/docs/models)
  "gemini-2.5-flash": 88,
  "gemini-2.5-flash-lite": 68,
  "gemini-3.1-flash-lite-preview": 72,
  "gemini-3-flash-preview": 82,
  "gemini-2.0-flash": 78,
  "gemini-2.0-flash-lite": 62,
  "gemini-1.5-flash": 70,
  "gemini-1.5-flash-8b": 55,
  // OpenRouter — free tier models (sorted by capability)
  "deepseek/deepseek-r1:free": 85,
  "deepseek/deepseek-chat-v3.1:free": 80,
  "nousresearch/hermes-3-llama-3.1-405b:free": 80,
  "openai/gpt-oss-120b:free": 78,
  "nvidia/nemotron-3-super-120b-a12b:free": 75,
  "meta-llama/llama-3.3-70b-instruct:free": 72,
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": 68,
  "nvidia/nemotron-3-nano-30b-a3b:free": 63,
  "qwen/qwen-2.5-72b-instruct:free": 68,
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free": 62,
  "minimax/minimax-m2.5:free": 65,
  "openai/gpt-oss-20b:free": 58,
  "nvidia/nemotron-nano-12b-v2-vl:free": 55,
  "nvidia/nemotron-nano-9b-v2:free": 50,
  "poolside/laguna-m.1:free": 52,
  "baidu/cobuddy:free": 50,
  // OpenRouter — text-only free
  "google/gemma-4-31b-it:free": 57,
  "google/gemma-4-26b-a4b-it:free": 55,
  "google/gemma-2-9b-it:free": 45,
  "liquid/lfm-2.5-1.2b-thinking:free": 35,
  "liquid/lfm-2.5-1.2b-instruct:free": 30,
  "meta-llama/llama-3.2-3b-instruct:free": 35,
  "baidu/qianfan-ocr-fast:free": 38,
  "openrouter/auto": 88,
  // Groq
  "llama-3.3-70b-versatile": 72,
  "llama-3.1-8b-instant": 40,
  "mixtral-8x7b-32768": 55,
  // Konektika
  "kimi-pro": 70,
  // Ollama (local) — scores based on model quality benchmarks
  "qwen2.5-coder:14b": 72,
  "qwen2.5-coder:7b": 62,
  "qwen2.5-coder:3b": 45,
  "codellama:13b": 55,
  "llama3.1:8b": 50,
  "llama3.2:3b": 38,
  "deepseek-coder-v2:16b": 75,
  // Snifox
  "openai/gpt-5": 98,
  "openai/gpt-5-mini": 82,
  "openai/gpt-5-codex": 90,
  "anthropic/claude-opus-4.6": 97,
  "anthropic/claude-sonnet-4.5": 93,
  "google/gemini-3-flash-preview": 83,
  "google/gemini-2.5-flash": 88,
  // 9Router (via self-hosted gateway — scores reflect underlying model quality)
  "anthropic/claude-sonnet-4-5": 93,
  "anthropic/claude-opus-4": 97,
  "anthropic/claude-haiku-3-5": 78,
  "openai/gpt-4o": 92,
  "openai/gpt-4o-mini": 75,
  "openai/gpt-4.1-mini": 72,
  "google/gemini-2.5-flash-lite": 68,
  "deepseek/deepseek-r1": 85,
  "deepseek/deepseek-v3": 80,
  "meta-llama/llama-3.3-70b-instruct": 72,
};

/**
 * Prefix-based scoring for versioned Google model names returned by the live
 * /v1beta/models endpoint (e.g. "gemini-2.5-flash-preview-04-17" → 88).
 * Order matters: more specific prefixes first.
 */
const GEMINI_PREFIX_SCORES: [RegExp, number][] = [
  [/^gemini-3\.1-flash-lite/i, 72],
  [/^gemini-3\.1-flash/i, 80],
  [/^gemini-3-flash/i, 82],
  [/^gemini-2\.5-flash-lite/i, 68],
  [/^gemini-2\.5-flash/i, 88],
  [/^gemini-2\.0-flash-lite/i, 62],
  [/^gemini-2\.0-flash/i, 78],
  [/^gemini-1\.5-flash-8b/i, 55],
  [/^gemini-1\.5-flash/i, 70],
  [/^gemini-1\.5-pro/i, 85],
];

/**
 * Returns a capability score (0–100) for a given model name, or null if unknown.
 * "auto" is excluded — its score is dynamic depending on which model wins.
 * Handles versioned live-fetched names (e.g. "gemini-2.5-flash-preview-04-17")
 * via prefix matching when an exact match is not found.
 */
export function getModelCapability(name: string): number | null {
  if (name === "auto" || name === "openrouter/auto") return null;
  if (MODEL_CAPABILITY[name] !== undefined) return MODEL_CAPABILITY[name];
  for (const [re, score] of GEMINI_PREFIX_SCORES) {
    if (re.test(name)) return score;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Multi-key failover
// ---------------------------------------------------------------------------

/**
 * HTTP statuses that indicate "this specific key is exhausted / invalid".
 * The multi-key failover should try the next key instead of surfacing the
 * error. 5xx and body-shape errors are NOT here on purpose — those are
 * upstream issues, not key issues.
 */
export const KEY_FAILOVER_STATUSES = new Set([401, 402, 403, 429]);

// ---------------------------------------------------------------------------
// Rate-limit retry helpers
// ---------------------------------------------------------------------------

/**
 * Delays (ms) between successive retries on a 429 response, for the SAME key.
 * The sequence is: wait 5 s → 15 s → 30 s before giving up and failing over
 * to the next key.  Three retry attempts = four total attempts per key.
 */
const RATE_LIMIT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

/**
 * Sleep for `ms` milliseconds.  Resolves early (throws AbortError) if the
 * provided AbortSignal fires, so a user Stop always cancels immediately.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const t = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Live model list caches
// ---------------------------------------------------------------------------

let cachedGoogleModels: { at: number; list: string[] } | null = null;
export async function fetchGoogleModels(): Promise<string[]> {
  const key = getAIKey("google");
  if (!key) return [];
  if (cachedGoogleModels && Date.now() - cachedGoogleModels.at < 10 * 60 * 1000) {
    return cachedGoogleModels.list;
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`,
  );
  if (!res.ok) return cachedGoogleModels?.list ?? [];
  const j = (await res.json().catch(() => null)) as any;
  const arr = Array.isArray(j?.models) ? j.models : [];
  const list: string[] = arr
    .filter(
      (m: any) =>
        Array.isArray(m?.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent"),
    )
    .map((m: any) => String(m.name || "").replace(/^models\//, ""))
    .filter((n: string) => n.startsWith("gemini-"))
    .filter((n: string) => !/-001$|-002$/.test(n));
  list.sort((a, b) => b.localeCompare(a));
  cachedGoogleModels = { at: Date.now(), list };
  return list;
}

let cachedNineRouterModels: { at: number; list: string[] } | null = null;
let cachedOpenRouterModels: { at: number; list: string[] } | null = null;
export async function fetchOpenRouterModels(): Promise<string[]> {
  if (cachedOpenRouterModels && Date.now() - cachedOpenRouterModels.at < 10 * 60 * 1000) {
    return cachedOpenRouterModels.list;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const key = getAIKey("openrouter");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) return cachedOpenRouterModels?.list ?? [];
    const j = (await res.json().catch(() => null)) as any;
    const arr = Array.isArray(j?.data) ? j.data : [];
    const list: string[] = arr
      .map((m: any) => String(m?.id ?? "").trim())
      .filter((s: string) => s.length > 0)
      .sort((a: string, b: string) => {
        const aFree = a.endsWith(":free");
        const bFree = b.endsWith(":free");
        if (aFree && !bFree) return -1;
        if (!aFree && bFree) return 1;
        return a.localeCompare(b);
      });
    cachedOpenRouterModels = { at: Date.now(), list };
    return list;
  } finally {
    clearTimeout(t);
  }
}

let cachedSnifoxModels: { at: number; list: string[] } | null = null;
export async function fetchSnifoxModels(): Promise<string[]> {
  if (cachedSnifoxModels && Date.now() - cachedSnifoxModels.at < 10 * 60 * 1000) {
    return cachedSnifoxModels.list;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const key = getAIKey("snifox");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const res = await fetch("https://core.snifoxai.com/v1/models", {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) return cachedSnifoxModels?.list ?? [];
    const j = (await res.json().catch(() => null)) as any;
    const arr = Array.isArray(j?.data) ? j.data : [];
    const list: string[] = arr
      .map((m: any) => String(m?.id ?? "").trim())
      .filter((s: string) => s.length > 0)
      .sort((a: string, b: string) => {
        const av = a.split("/")[0];
        const bv = b.split("/")[0];
        if (av !== bv) return av.localeCompare(bv);
        return b.localeCompare(a);
      });
    cachedSnifoxModels = { at: Date.now(), list };
    return list;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Stream dispatchers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom provider streaming (OpenAI-compatible, base_url from DB)
// ---------------------------------------------------------------------------

/**
 * Per-provider RPM throttler.
 * Stores the timestamp of the most-recent request start for each provider id.
 * When a provider has rpm > 0, we enforce a minimum gap of (60000 / rpm) ms
 * between consecutive requests so we stay under the limit proactively instead
 * of waiting for a 429 after the fact.
 */
const providerLastRequestAt = new Map<string, number>();

async function throttleProvider(
  providerId: string,
  rpm: number,
  signal: AbortSignal,
): Promise<void> {
  if (!rpm || rpm <= 0) return;
  const minGapMs = Math.ceil(60_000 / rpm);
  const last = providerLastRequestAt.get(providerId) ?? 0;
  const now = Date.now();
  const waitMs = minGapMs - (now - last);
  if (waitMs > 0) {
    await sleepWithAbort(waitMs, signal);
  }
  providerLastRequestAt.set(providerId, Date.now());
}

export async function* streamCustomProvider(
  customId: string,
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const providers = listCustomProviders();
  const prov = providers.find((p) => p.id === customId && p.enabled);
  if (!prov) {
    yield `(Custom provider "${customId}" tidak ditemukan atau dinonaktifkan)`;
    return;
  }
  const keys = googleKeys;
  if (keys.length === 0) {
    yield `(API key untuk "${prov.name}" belum diset — buka Admin → Custom Providers untuk isi)`;
    return;
  }
      const baseUrl = config.NINE_ROUTER_BASE_URL;
      const url = baseUrl.replace(/\/v1\/?$/, "") + "/v1/chat/completions";
      let resolvedModel = model;

        const live = await fetchNineRouterModels().catch(() => []);

  // Proactive RPM throttle — wait if needed before sending the request.
  if (prov.rpm > 0) {
    try {
      await throttleProvider(customId, prov.rpm, signal);
    } catch {
      return; // user pressed Stop during the wait
    }
  }

  // Always log custom provider requests so debugging is possible via
  // `docker logs premdev-app-1 2>&1 | grep "\[CUSTOM\]"` without needing
  // AI_DEBUG_LOG. Shows URL, model, messages count, and system prompt length.
  const sysMsg = messages.find((m) => m.role === "system");
  console.error(
    `[CUSTOM] provider=${prov.name} model=${resolvedModel} url=${url} ` +
    `msgs=${messages.length} sysLen=${sysMsg?.content.length ?? 0} ` +
    `hasSysPrompt=${!!sysMsg} sysPreview=${(sysMsg?.content ?? "").slice(0, 120).replace(/\n/g, "↵")}`
  );

  // Pass all keys — streamOpenAICompat will try them in order on 429/401/403.
  // Shuffle so load is distributed across keys when multiple are configured.
  const shuffled = keys.length > 1
    ? [...keys].sort(() => Math.random() - 0.5)
    : keys;
  let yielded = false;
  for await (const chunk of streamOpenAICompat({
    url,
    keys: shuffled,
    providerLabel: prov.name,
    model: resolvedModel,
    messages,
    signal,
    maxTokens,
  })) {
    yielded = true;
    yield chunk;
  }
  // If the provider returned nothing at all (empty SSE stream), surface a
  // diagnostic message so the user sees it in the chat bubble instead of
  // a silent "~0 tok".
  if (!yielded) {
    console.error(`[CUSTOM] provider=${prov.name} model=${resolvedModel} — stream returned 0 bytes`);
    yield `⚠️ **${prov.name} tidak mengembalikan respons** (0 byte dari server).\n` +
      `Kemungkinan penyebab:\n` +
      `- Context terlalu panjang untuk model ini\n` +
      `- API key tidak valid atau quota habis\n` +
      `- URL endpoint salah: \`${url}\`\n\n` +
      `Cek log server: \`docker logs premdev-app-1 2>&1 | grep "\\[CUSTOM\\]"\``;
  }
}

export async function* streamProvider(
  provider: string,
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  // Handle custom providers (format: "custom:{id}")
  if (provider.startsWith("custom:")) {
    const customId = provider.slice(7);
    yield* streamCustomProvider(customId, model, messages, maxTokens, signal);
    return;
  }
  if (model === "auto" && provider !== "google") {
    yield* streamProviderAuto(provider as Provider, messages, maxTokens, signal);
    return;
  }
  switch (provider as Provider) {
    case "openai":
      yield* streamOpenAICompat({
        url: "https://api.openai.com/v1/chat/completions",
        keys: getAIKeys("openai"),
        providerLabel: "OpenAI",
        model, messages, signal, maxTokens,
      });
      return;
    case "anthropic":
      yield* streamAnthropic(model, messages, maxTokens, signal);
      return;
    case "google":
      yield* streamGoogle(model, messages, maxTokens, signal);
      return;
    case "openrouter":
      yield* streamOpenAICompat({
        url: "https://openrouter.ai/api/v1/chat/completions",
        keys: getAIKeys("openrouter"),
        providerLabel: "OpenRouter",
        model, messages, signal, maxTokens,
        extraHeaders: {
          "HTTP-Referer": "https://flixprem.org",
          "X-Title": "PremDev",
        },
      });
      return;
    case "groq":
      yield* streamOpenAICompat({
        url: "https://api.groq.com/openai/v1/chat/completions",
        keys: getAIKeys("groq"),
        providerLabel: "Groq",
        model, messages, signal, maxTokens,
      });
      return;
    case "konektika":
      yield* streamOpenAICompat({
        url: "https://konektika.web.id/v1/chat/completions",
        keys: getAIKeys("konektika"),
        providerLabel: "Konektika",
        model, messages, signal, maxTokens,
        omitMaxTokens: true,
      });
      return;
    case "snifox":
      yield* streamOpenAICompat({
        url: "https://core.snifoxai.com/v1/chat/completions",
        keys: getAIKeys("snifox"),
        providerLabel: "Snifox",
        model, messages, signal, maxTokens,
      });
      return;
  }
}

/**
 * AUTO-mode router for any non-google provider.
 * Iterates the provider's tier (smartest → cheapest), running each model
 * through the normal streamProvider dispatch. The first model that emits
 * real content wins; if a model fails (rate-limit, quota, key-not-set,
 * 5xx, etc.) we silently roll over to the next.
 */
export async function* streamProviderAuto(
  provider: Provider,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const tier = AUTO_TIERS[provider] ?? [];
  if (tier.length === 0) {
    yield `(Auto: tier list untuk ${provider} kosong — pilih model spesifik di dropdown.)`;
    return;
  }
  // Estimate context size once; use it to skip models too small to handle it.
  const estimatedPromptTokens = estimateTokens(messages);
    let lastErr: string | null = null;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
    // Skip model if its known context limit is smaller than the prompt.
    // Leave an 20% buffer for the response (maxTokens) on top of the prompt.
    const limit = MODEL_CONTEXT_LIMIT[candidate];
    if (limit && estimatedPromptTokens + maxTokens > limit * 0.9) {
      lastErr = `${candidate}: prompt ~${estimatedPromptTokens} tok melewati context limit ${limit} tok — dilewati otomatis`;
      continue;
    }
    let firstSeen = false;
    let success = false;
    let abortedThis = false;
    try {
      for await (const chunk of streamProvider(provider, candidate, messages, maxTokens, signal)) {
        if (!firstSeen) {
          firstSeen = true;
          if (
            chunk.startsWith("Error:") ||
            /^\([^)]*key not configured[^)]*\)$/i.test(chunk.trim())
          ) {
            lastErr = chunk.slice(0, 200);
            abortedThis = true;
            break;
          }
          success = true;
          yield `\n[Auto pilih ${provider}/${candidate}${i > 0 ? ` — ${i} model sebelumnya gagal` : ""}]\n`;
        }
        yield chunk;
      }
    } catch (e: any) {
      lastErr = e?.message || String(e);
      abortedThis = true;
    }
    if (success && !abortedThis) return;
    if (!firstSeen) lastErr ||= `${candidate} returned no chunks`;
  }
  yield `\n[Auto: semua ${tier.length} kandidat ${provider} gagal. Last: ${lastErr || "(no detail)"}]`;
}

// ---------------------------------------------------------------------------
// Error formatting helper
// ---------------------------------------------------------------------------

/**
 * Converts a raw HTTP error response from an AI provider into a clean,
 * user-friendly Indonesian message. Handles OpenRouter's nested JSON
 * format (including rate-limit 429 with `metadata.raw`) and falls back
 * gracefully for any other shape.
 */
function formatProviderError(
  status: number,
  body: string,
  providerLabel?: string,
  model?: string,
  keyCount?: number,
): string {
  const label = providerLabel ?? "Provider";
  const isOpenRouter = providerLabel === "OpenRouter";

  // Try to extract a meaningful message from the JSON body.
  let detail = "";
  try {
    const j = JSON.parse(body);
    const err = j?.error;
    if (err) {
      // OpenRouter wraps upstream errors in metadata.raw
      const raw: string = err?.metadata?.raw ?? "";
      const msg: string = err?.message ?? "";
      detail = (raw || msg).slice(0, 300);
    }
  } catch {
    detail = body.slice(0, 300);
  }

  if (status === 429) {
    const modelHint = model && model !== "auto" ? ` (model: \`${model}\`)` : "";
    const autoHint = isOpenRouter
      ? "\n\n💡 **Tip:** Pilih **Auto** di dropdown model — AI otomatis coba model lain saat satu kena rate-limit."
      : "";
    return (
      `⚠️ **${label} kena rate-limit${modelHint}** — model ini sedang penuh di sisi provider (free tier).` +
      (detail ? `\n\nDetail: ${detail}` : "") +
      autoHint
    );
  }

  if (status === 401 || status === 403) {
    const allFailed = keyCount !== undefined && keyCount > 1;
    return (
      `🔑 **${label} API key tidak valid${allFailed ? ` (semua ${keyCount} key gagal)` : ""}** — ` +
      `cek atau update key di Admin → AI Keys.` +
      (detail ? `\n\nDetail: ${detail}` : "")
    );
  }

  if (status === 402) {
    return (
      `💳 **${label} kredit habis** — top-up atau ganti ke model free (\`:free\`).` +
      (detail ? `\n\nDetail: ${detail}` : "")
    );
  }

  if (status >= 500) {
    return (
      `🔴 **${label} server error (${status})** — provider sedang bermasalah, coba lagi sebentar.` +
      (detail ? `\n\nDetail: ${detail}` : "")
    );
  }

  // Generic fallback — still cleaner than raw JSON
  return `Error ${status} dari ${label}${detail ? `: ${detail}` : "."}`;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible streaming (also used by OpenRouter / Groq / Konektika / Snifox)
// ---------------------------------------------------------------------------

export async function* streamOpenAICompat(opts: {
  url: string;
  keys: string[];
  model: string;
  messages: ChatMsg[];
  signal: AbortSignal;
  maxTokens: number;
  extraHeaders?: Record<string, string>;
  omitMaxTokens?: boolean;
  extraBody?: Record<string, unknown>;
  providerLabel?: string;
  firstTokenTimeoutMs?: number;
}): AsyncGenerator<string> {
  if (!opts.keys || opts.keys.length === 0) {
    yield `(${opts.providerLabel ?? opts.url} key not configured)`;
    return;
  }
  const apiMessages = opts.messages.map((m) => {
    if (m.images && m.images.length > 0 && m.role === "user") {
      const parts: any[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const img of m.images) {
        parts.push({ type: "image_url", image_url: { url: img } });
      }
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
  const reqBody = JSON.stringify({
    model,
    // Anthropic requires max_tokens; use 100 000 as the "unlimited" sentinel
    // (the model will stop at its own context limit before that anyway).
    max_tokens: maxTokens === 0 ? 100_000 : maxTokens,
    stream: true,
    system: sys,
    messages: msgs,
  });

  /**
   * Outer quota-reset loop.
   * When ALL keys are exhausted and every failure was a 429 (pure rate-limit),
   * we wait QUOTA_RESET_WAIT_MS then retry from key #1 instead of surfacing
   * an error.  Any non-429 failure still breaks out immediately.
   */
  const QUOTA_RESET_WAIT_MS = 60_000;

  let quotaRound = 0;
  while (true) {
      let lastError: string | null = null;
    let allRateLimited = true; // assume true until proven otherwise

      for (let i = 0; i < candidates.length; i++) {
    const key = keys[ki];

      // Inner retry loop for 429 rate-limit on the same key.
      // Attempt 0 = first try; attempts 1..N = retries after waiting.
      let keySucceeded = false;
      for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt++) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
        // 0 = unlimited: omit maxOutputTokens so Gemini uses its full window.
        generationConfig: maxTokens === 0 ? {} : { maxOutputTokens: maxTokens },
      }),
      signal,
    },
  );

        if (res.ok && res.body) {
          keySucceeded = true;
          if (i > 0) yield `\n[Key #${i + 1} dipakai (key sebelumnya gagal)]\n`;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
          let firstToken = false;
          // Timer for first-token timeout (useful for slow local models like Ollama)
          const ftTimeoutMs = opts.firstTokenTimeoutMs;
          let ftTimer: ReturnType<typeof setTimeout> | null = null;
          let ftAbortCtrl: AbortController | null = null;
          if (ftTimeoutMs) {
            ftAbortCtrl = new AbortController();
            ftTimer = setTimeout(() => ftAbortCtrl!.abort(), ftTimeoutMs);
          }
          try {
            while (true) {
              // Check first-token timeout
              if (ftAbortCtrl?.signal.aborted && !firstToken) {
                yield `\n⏱ Ollama timeout — model sedang sibuk atau konteks terlalu panjang. Coba lagi dengan pesan lebih singkat, atau tunggu request sebelumnya selesai.`;
                reader.cancel().catch(() => {});
                return;
              }
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") return;
                try {
        const j = JSON.parse(line.slice(5).trim());
    const txt = (await res.text().catch(() => "")).slice(0, 300);
                  if (txt) {
                    if (!firstToken) {
                      firstToken = true;
                      if (ftTimer) clearTimeout(ftTimer);
                    }
                    yield txt;
                  }
                } catch {}
              }
            }
          } finally {
            if (ftTimer) clearTimeout(ftTimer);
          }
          return;
        }

    const body = await r.text().catch(() => "");
        lastError = { status: res.status, body: body.slice(0, 300) };

        // Treat as rate-limit if status is 429 OR if the body clearly says so
        // (some providers return 400/503 with a "rate_limit" body instead of 429).
        const bodyLower = body.toLowerCase();
        const isRateLimitResponse =
          res.status === 429 ||
          bodyLower.includes("rate_limit") ||
          bodyLower.includes("rate limit") ||
          bodyLower.includes("quota") ||
          bodyLower.includes("too many requests");
        if (!isRateLimitResponse) allRateLimited = false;

        // 429: retry the same key with exponential backoff before failing over.
        if (res.status === 429 && attempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
          const waitMs = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      const waitSec = Math.round(QUOTA_RESET_WAIT_MS / 1000);
      const label = opts.providerLabel ?? opts.url;
          yield `\n⏳ **${label} — batas RPM tercapai**, menunggu ${waitSec}s lalu coba lagi (percobaan ${attempt + 2}/${RATE_LIMIT_RETRY_DELAYS_MS.length + 1})…\n`;
          try {
            await sleepWithAbort(waitMs, opts.signal);
          } catch {
            // User pressed Stop — exit immediately.
            return;
          }
          continue; // retry same key
        }

        // Non-429 error or retries exhausted: break inner loop and evaluate failover.
        break;
      }

      if (keySucceeded) return;

      // Failover to next key for all KEY_FAILOVER_STATUSES (including 429 if all retries exhausted).
      if (lastError && KEY_FAILOVER_STATUSES.has(lastError.status) && i < opts.keys.length - 1) continue;

      // Non-failover error (e.g. 500, 400) — surface immediately, no quota-wait.
      if (lastError && !KEY_FAILOVER_STATUSES.has(lastError.status)) {
        yield formatProviderError(lastError.status, lastError.body, opts.providerLabel, opts.model);
        return;
      }

      // Only 1 key and it hit a failover status: fall through to quota-wait check below.
    }

    // All keys exhausted.  If every failure was a rate-limit (status 429 or body says so),
    // wait for quota reset and retry automatically.
    if (allRateLimited && lastError) {
      quotaRound++;
      const waitSec = Math.round(QUOTA_RESET_WAIT_MS / 1000);
      const label = opts.providerLabel ?? opts.url;
      const keyCount = opts.keys.length;
      const keyInfo = keyCount === 1 ? "1 key" : `semua ${keyCount} key`;
      yield `\n⏳ **${label} — ${keyInfo} batas RPM tercapai.** Menunggu ${waitSec}s untuk quota reset, lalu coba otomatis (round ${quotaRound})… Tekan Stop untuk batal.\n`;
      try {
        await sleepWithAbort(QUOTA_RESET_WAIT_MS, opts.signal);
      } catch {
        return; // User pressed Stop.
      }
      continue; // restart outer loop — try all keys again
    }

    // Not all-429: surface the last error and stop.
    if (lastError) {
      yield formatProviderError(lastError.status, lastError.body, opts.providerLabel, opts.model, opts.keys.length);
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Anthropic streaming
// ---------------------------------------------------------------------------

export async function* streamAnthropic(
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const keys = googleKeys;
  if (keys.length === 0) { yield "(Anthropic key not configured)"; return; }
  const sys = messages.find((m) => m.role === "system")?.content;
  const msgs = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.images && m.images.length > 0 && m.role === "user") {
        const blocks: any[] = [];
        for (const img of m.images) {
          const parsed = parseDataUrlLocal(img);
          if (!parsed) continue;
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: parsed.mimeType, data: parsed.data },
          });
        }
        if (m.content) blocks.push({ type: "text", text: m.content });
        return { role: m.role, content: blocks };
      }
      return { role: m.role, content: m.content };
    });
  const reqBody = JSON.stringify({
    model,
    // Anthropic requires max_tokens; use 100 000 as the "unlimited" sentinel
    // (the model will stop at its own context limit before that anyway).
    max_tokens: maxTokens === 0 ? 100_000 : maxTokens,
    stream: true,
    system: sys,
    messages: msgs,
  });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
        // 0 = unlimited: omit maxOutputTokens so Gemini uses its full window.
        generationConfig: maxTokens === 0 ? {} : { maxOutputTokens: maxTokens },
      }),
      signal,
    },
  );
  let usedKeyIdx = 0;
      let lastError: string | null = null;
      for (let i = 0; i < candidates.length; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": keys[i],
        "anthropic-version": "2023-06-01",
      },
      body: reqBody,
      signal,
    });
    if (r.ok && r.body) { res = r; usedKeyIdx = i; break; }
    const body = await r.text().catch(() => "");
    lastError = { status: r.status, body: body.slice(0, 300) };
    if (KEY_FAILOVER_STATUSES.has(r.status) && i < keys.length - 1) continue;
    yield `Error: ${r.status} ${body}`;
    return;
  }
  if (!res || !res.body) {
    yield lastError
      ? `Error: semua ${keys.length} Anthropic key gagal. Last: ${lastError.status} ${lastError.body}`
      : `Error: Anthropic request failed`;
    return;
  }
  if (usedKeyIdx > 0) yield `\n[Anthropic key #${usedKeyIdx + 1} dipakai (key sebelumnya gagal)]\n`;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.type === "content_block_delta" && j.delta?.text) yield j.delta.text;
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Google / Gemini streaming
// ---------------------------------------------------------------------------

export async function* streamGoogle(
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const googleKeys = getAIKeys("google");
  if (googleKeys.length === 0) { yield "(Google key not configured)"; return; }
  const keys = googleKeys;

  let lastQuotaMsg: string | null = null;
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    if (ki > 0) yield `\n[Google key #${ki + 1} dipakai (quota key sebelumnya habis)]\n`;

    if (model === "auto") {
      const liveList = await fetchGoogleModels().catch(() => [] as string[]);
      const freeFromLive = liveList.filter(
        (n) => /flash-lite|flash$|flash-/.test(n) && !/exp|pro/.test(n),
      );
      const candidates = freeFromLive.length > 0 ? freeFromLive : [...GEMINI_FREE_TIER];
      let lastError: string | null = null;
      let allQuotaThisKey = true;
      let keyDead = false;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        let emitted = false;
        let skipReason: "quota" | "notfound" | "keydead" | null = null;
        const wrapped = streamGoogleSingle(candidate, key, messages, maxTokens, signal);
        for await (const chunk of wrapped) {
          if (chunk.startsWith("__KEYDEAD__")) {
            skipReason = "keydead";
            keyDead = true;
            lastError = chunk.slice(11);
            break;
          }
          if (chunk.startsWith("__QUOTA__")) { skipReason = "quota"; lastError = chunk.slice(9); break; }
          if (chunk.startsWith("__ERROR__")) {
            lastError = chunk.slice(9);
            if (/^404\b|NOT_FOUND/i.test(lastError ?? "")) skipReason = "notfound";
            break;
          }
          emitted = true;
          yield chunk;
        }
        if (emitted) return;
        if (!skipReason) {
          if (lastError) yield `\n\n[Gemini error: ${lastError}]`;
          return;
        }
        if (skipReason === "keydead") break;
        if (skipReason === "notfound") allQuotaThisKey = false;
        const reason = skipReason === "quota" ? "Quota habis" : "Model tidak tersedia";
        const next = candidates[i + 1] ?? "(habis semua)";
        // Wait briefly before trying next model so quota window can partially recover.
        const googleWaitMs = skipReason === "quota" ? 3_000 : 0;
        yield `\n[${reason} di ${candidate}${googleWaitMs ? `, menunggu ${googleWaitMs / 1000}s` : ""}, coba ${next}…]\n`;
        if (googleWaitMs > 0) {
          try { await sleepWithAbort(googleWaitMs, signal); } catch { return; }
        }
      }
      if ((keyDead || allQuotaThisKey) && ki < keys.length - 1) {
        lastQuotaMsg = lastError;
        continue;
      }
      if (keyDead) {
        yield `\n\n[Google key #${ki + 1} ditolak (auth/quota habis): ${lastError ?? ""}]`;
      } else {
        yield `\n\n[Semua kandidat Gemini free-tier gagal pada key #${ki + 1}. Coba lagi nanti atau pilih model spesifik.]`;
      }
      return;
    }

    let emittedSingle = false;
    let advanceKey = false;
    let lastErr: string | null = null;
    for await (const chunk of streamGoogleSingle(model, key, messages, maxTokens, signal)) {
      if (chunk.startsWith("__KEYDEAD__")) {
        advanceKey = true; lastErr = chunk.slice(11); lastQuotaMsg = lastErr; break;
      }
      if (chunk.startsWith("__QUOTA__")) {
        advanceKey = true; lastErr = chunk.slice(9); lastQuotaMsg = lastErr; break;
      }
      if (chunk.startsWith("__ERROR__")) {
        yield `\n[Gemini error: ${chunk.slice(9)}]`; return;
      }
      emittedSingle = true;
      yield chunk;
    }
    if (emittedSingle) return;
    if (advanceKey && ki < keys.length - 1) continue;
    yield `\n[Model "${model}" kena quota / rate-limit / key invalid (key #${ki + 1}). Tambah API key di admin atau pilih model lain.${lastErr ? " Detail: " + lastErr : ""}]`;
    return;
  }
  if (lastQuotaMsg) {
    yield `\n[Semua ${getAIKeys("google").length} Google key habis quota / invalid. Last: ${lastQuotaMsg}]`;
  }
}

export async function* streamGoogleSingle(
  model: string,
  key: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const sys = messages.find((m) => m.role === "system")?.content;
  const contents = messages.filter((m) => m.role !== "system").map((m) => {
    const parts: any[] = [];
    if (m.content) parts.push({ text: m.content });
    if (m.images && m.role === "user") {
      for (const img of m.images) {
        const parsed = parseDataUrlLocal(img);
        if (!parsed) continue;
        parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
      }
    }
    if (parts.length === 0) parts.push({ text: "" });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
        // 0 = unlimited: omit maxOutputTokens so Gemini uses its full window.
        generationConfig: maxTokens === 0 ? {} : { maxOutputTokens: maxTokens },
      }),
      signal,
    },
  );
  if (!res.ok || !res.body) {
    const txt = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      yield `__KEYDEAD__${res.status} ${txt}`;
    } else if (res.status === 429 || /quota|RESOURCE_EXHAUSTED|rate.?limit|exceeded/i.test(txt)) {
      yield `__QUOTA__${res.status} ${txt}`;
    } else if (res.status === 503 || /UNAVAILABLE|high.demand|overload|try.again.later/i.test(txt)) {
      // 503 = model overloaded — treat like quota so auto-mode can fall through to next model
      yield `__QUOTA__503 Model sedang overloaded (server penuh). Coba lagi dalam 1-2 menit atau pilih model lain.`;
    } else {
      // Parse JSON error message if possible, otherwise show raw
      let friendly = txt;
      try {
        const j = JSON.parse(line.slice(5).trim());
        const msg = j?.error?.message ?? j?.message;
        const status = j?.error?.status ?? "";
        if (msg) friendly = status ? `${status}: ${msg}` : msg;
      } catch {}
      yield `__ERROR__${res.status} ${friendly}`;
    }
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let emittedAnyText = false;
  let lastFinishReason: string | null = null;
  let lastBlockReason: string | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        const cand = j.candidates?.[0];
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (typeof p?.text === "string" && p.text.length > 0) {
              emittedAnyText = true;
              yield p.text;
            }
          }
        }
        if (typeof cand?.finishReason === "string") lastFinishReason = cand.finishReason;
        if (typeof j?.promptFeedback?.blockReason === "string") {
          lastBlockReason = j.promptFeedback.blockReason;
        }
      } catch {}
    }
  }
  if (!emittedAnyText) {
    if (lastBlockReason) {
      yield `\n\n[Gemini blocked the prompt: ${lastBlockReason}. Try rephrasing or removing the image.]`;
    } else if (lastFinishReason && lastFinishReason !== "STOP") {
      yield `\n\n[Gemini returned no text (finishReason=${lastFinishReason}). Try a different model or shorter prompt.]`;
    } else {
      yield `\n\n[Gemini returned an empty response. Check the API key, the model name, and that your account has access to it.]`;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helper (avoids cross-module dependency on ai-prompt for data URLs)
// ---------------------------------------------------------------------------

function parseDataUrlLocal(
  dataUrl: string,
): { mimeType: string; data: string } | null {
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}


/**
 * Fetch the live model list from a 9Router instance.
 * Returns only models whose provider is actually connected in 9Router
 * (i.e. the endpoint returns them in GET /v1/models).
 * Result is cached for 2 minutes so repeated /providers calls are cheap.
 */
export async function fetchNineRouterModels(): Promise<string[]> {
  const baseUrl = config.NINE_ROUTER_BASE_URL;
  const apiKey  = config.NINE_ROUTER_API_KEY;
  if (!baseUrl) return [];
  if (cachedNineRouterModels && Date.now() - cachedNineRouterModels.at < 2 * 60 * 1000) {
    return cachedNineRouterModels.list;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = baseUrl.replace(/\/v1\/?$/, "") + "/v1/models";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return cachedNineRouterModels?.list ?? [];
    const j = (await res.json().catch(() => null)) as any;
    const arr = Array.isArray(j?.data) ? j.data : [];
    const list: string[] = arr
      .map((m: any) => String(m?.id ?? m?.name ?? "").trim())
      .filter((s: string) => s.length > 0)
      .sort((a: string, b: string) => a.localeCompare(b));
    cachedNineRouterModels = { at: Date.now(), list };
    return list;
  } catch {
    return cachedNineRouterModels?.list ?? [];
  } finally {
    clearTimeout(t);
  }
}
