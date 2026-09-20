import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { config } from "./config.js";

type Provider = "openai" | "anthropic" | "google" | "openrouter" | "groq" | "konektika" | "snifox" | "9router";

const PROVIDERS: Provider[] = ["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox", "9router"];

const WEAK_JWT_SECRETS = new Set([
  "dev-secret-change-me-in-production",
  "premdev-default-key",
  "",
]);

let warnedWeakKey = false;
function getCipherKey(): Buffer {
  const seed = config.JWT_SECRET || "premdev-default-key";
  if (WEAK_JWT_SECRETS.has(seed) && !warnedWeakKey) {
    warnedWeakKey = true;
    console.warn(
      "⚠️  AI keys are encrypted with a default JWT_SECRET. " +
      "Set a strong JWT_SECRET (>=32 random chars) in your environment so DB-stored AI keys are not decryptable with the shipped default."
    );
  }
  return crypto.createHash("sha256").update(seed).digest();
}

export function isEncryptionKeyWeak(): boolean {
  const seed = config.JWT_SECRET || "";
  return WEAK_JWT_SECRETS.has(seed) || seed.length < 16;
}

function encrypt(plain: string): string {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const key = getCipherKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(payload: string): string {
  if (!payload || !payload.startsWith("v1:")) return "";
  try {
    const [, ivB64, tagB64, dataB64] = payload.split(":");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const key = getCipherKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return "";
  }
}

function envFallback(provider: Provider): string {
  switch (provider) {
    case "openai": return config.OPENAI_API_KEY;
    case "anthropic": return config.ANTHROPIC_API_KEY;
    case "google": return config.GOOGLE_API_KEY;
    case "openrouter": return config.OPENROUTER_API_KEY;
    case "groq": return config.GROQ_API_KEY;
    case "konektika": return config.KONEKTIKA_API_KEY;
    case "snifox": return config.SNIFOX_API_KEY;
    case "9router": return config.NINE_ROUTER_API_KEY;
  }
}

const cache = new Map<Provider, string>();
let cacheLoaded = false;

function loadCache() {
  if (cacheLoaded) return;
  for (const p of PROVIDERS) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai.${p}.key`) as { value: string } | undefined;
    if (row?.value) {
      const dec = decrypt(row.value);
      if (dec) cache.set(p, dec);
    }
  }
  cacheLoaded = true;
}

export function getAIKey(provider: Provider): string {
  loadCache();
  return cache.get(provider) || envFallback(provider) || "";
}

/**
 * Multi-key support: a single configured value may contain several keys
 * separated by `,` (or `;` / newline). Returns them split + trimmed +
 * de-duplicated, with empty entries dropped. Order is preserved so the
 * stream callers can iterate "primary first, fall over on rate-limit".
 *
 * Example stored value: `sk-aaa,sk-bbb,sk-ccc` → returns
 *   ["sk-aaa", "sk-bbb", "sk-ccc"].
 *
 * Returns an empty array if no key is configured at all (caller should
 * yield "(provider key not configured)" in that case, same as before).
 */
export function getAIKeys(provider: Provider): string[] {
  const raw = getAIKey(provider);
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\n]/)) {
    const k = part.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

export function setAIKey(provider: Provider, plain: string) {
  loadCache();
  if (!plain) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(`ai.${provider}.key`);
    cache.delete(provider);
    return;
  }
  const enc = encrypt(plain);
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`ai.${provider}.key`, enc);
  cache.set(provider, plain);
}

// ---------------------------------------------------------------------------
// AI runtime settings — persisted in the `settings` table, applied in-memory
// at startup and whenever the admin panel saves new values.
// ---------------------------------------------------------------------------

export type RtSettingKey =
  | "ai.budget.maxHistoryChars"
  | "ai.budget.maxHistoryMessages"
  | "ai.budget.maxSingleMessageChars"
  | "ai.budget.maxTokensDefault"
  | "ai.budget.maxTokensAutopilot"
  | "ai.rate.loginCapacity"
  | "ai.rate.loginRefillPerSec"
  | "ai.rate.apiCapacity"
  | "ai.rate.apiRefillPerSec"
  | "ai.rate.aiCapacity"
  | "ai.rate.aiRefillPerSec"
  | "ai.agent.maxActions"
  | "ai.agent.maxRuntimeSeconds"
  | "ai.agent.maxContinuations"
  | "ai.agent.maxProviderRetries"
  | "ai.agent.maxToolOutputChars"
  | "ai.agent.maxProviderRoundSeconds"
  | "ai.agent.maxConcurrentRuns";

export const RT_DEFAULTS: Record<RtSettingKey, number> = {
  "ai.budget.maxHistoryChars":        18000,
  "ai.budget.maxHistoryMessages":     24,
  "ai.budget.maxSingleMessageChars":  6000,
  "ai.budget.maxTokensDefault":       4096,
  "ai.budget.maxTokensAutopilot":     16384,
  "ai.rate.loginCapacity":            10,
  "ai.rate.loginRefillPerSec":        0.1,
  "ai.rate.apiCapacity":              120,
  "ai.rate.apiRefillPerSec":          2,
  "ai.rate.aiCapacity":               30,
  "ai.rate.aiRefillPerSec":           0.2,
  // Agent safety limits. These are deliberately finite; Admin may tune them
  // upward for larger/sub-agent workflows, but never beyond RT_BOUNDS.
  "ai.agent.maxActions":              30,
  "ai.agent.maxRuntimeSeconds":       600,
  "ai.agent.maxContinuations":        3,
  "ai.agent.maxProviderRetries":      2,
  "ai.agent.maxToolOutputChars":      12000,
  "ai.agent.maxProviderRoundSeconds": 180,
  "ai.agent.maxConcurrentRuns":       1,
};

export const RT_BOUNDS: Record<RtSettingKey, { min: number; max: number }> = {
  "ai.budget.maxHistoryChars":        { min: 2000, max: 80000 },
  "ai.budget.maxHistoryMessages":     { min: 4, max: 100 },
  "ai.budget.maxSingleMessageChars":  { min: 500, max: 32000 },
  "ai.budget.maxTokensDefault":       { min: 0, max: 32768 },
  "ai.budget.maxTokensAutopilot":     { min: 0, max: 65536 },
  "ai.rate.loginCapacity":            { min: 1, max: 100 },
  "ai.rate.loginRefillPerSec":        { min: 0.01, max: 5 },
  "ai.rate.apiCapacity":              { min: 0, max: 2000 },
  "ai.rate.apiRefillPerSec":          { min: 0.1, max: 100 },
  "ai.rate.aiCapacity":               { min: 0, max: 500 },
  "ai.rate.aiRefillPerSec":           { min: 0.01, max: 10 },
  "ai.agent.maxActions":              { min: 1, max: 200 },
  "ai.agent.maxRuntimeSeconds":       { min: 30, max: 3600 },
  "ai.agent.maxContinuations":        { min: 0, max: 20 },
  "ai.agent.maxProviderRetries":      { min: 0, max: 5 },
  // 1k is too small for diagnostics and error output: it causes the agent to
  // continue with an incomplete tool result and makes recovery less reliable.
  "ai.agent.maxToolOutputChars":      { min: 4000, max: 50000 },
  "ai.agent.maxProviderRoundSeconds": { min: 30, max: 600 },
  "ai.agent.maxConcurrentRuns":       { min: 1, max: 4 },
};

export type AgentLimits = {
  maxActions: number;
  maxRuntimeSeconds: number;
  maxContinuations: number;
  maxProviderRetries: number;
  maxToolOutputChars: number;
  maxProviderRoundSeconds: number;
  maxConcurrentRuns: number;
};

// Named, bounded profiles keep larger website tasks practical without
// introducing an unlimited execution mode. The admin UI can apply these
// values through the existing persisted settings endpoint.
export type AgentProfile = "default" | "website-builder";
export const AGENT_PROFILES: Record<AgentProfile, Partial<AgentLimits>> = {
  default: {},
  "website-builder": {
    maxActions: 100,
    maxRuntimeSeconds: 1800,
    maxContinuations: 8,
    maxProviderRetries: 3,
    maxToolOutputChars: 20000,
    maxProviderRoundSeconds: 300,
    maxConcurrentRuns: 1,
  },
};

export function getRtSetting(key: RtSettingKey): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (row?.value) {
    const n = parseFloat(row.value);
    if (!isNaN(n)) {
      const bounds = RT_BOUNDS[key];
      return Math.min(bounds.max, Math.max(bounds.min, n));
    }
  }
  return RT_DEFAULTS[key];
}

export function setRtSetting(key: RtSettingKey, value: number): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function getAllRtSettings(): Record<RtSettingKey, number> {
  return Object.fromEntries(
    (Object.keys(RT_DEFAULTS) as RtSettingKey[]).map((k) => [k, getRtSetting(k)])
  ) as Record<RtSettingKey, number>;
}

export function getAgentLimits(): AgentLimits {
  return {
    maxActions: getRtSetting("ai.agent.maxActions"),
    maxRuntimeSeconds: getRtSetting("ai.agent.maxRuntimeSeconds"),
    maxContinuations: getRtSetting("ai.agent.maxContinuations"),
    maxProviderRetries: getRtSetting("ai.agent.maxProviderRetries"),
    maxToolOutputChars: getRtSetting("ai.agent.maxToolOutputChars"),
    maxProviderRoundSeconds: getRtSetting("ai.agent.maxProviderRoundSeconds"),
    maxConcurrentRuns: getRtSetting("ai.agent.maxConcurrentRuns"),
  };
}

export function listAIKeysMasked(): {
  provider: Provider;
  configured: boolean;
  source: "db" | "env" | "none";
  masked: string;
  keyCount: number;
  maskedAll: string[];
}[] {
  loadCache();
  return PROVIDERS.map((p) => {
    const dbVal = cache.get(p);
    const envVal = envFallback(p);
    const val = dbVal || envVal;
    const source: "db" | "env" | "none" = dbVal ? "db" : envVal ? "env" : "none";
    const all = getAIKeys(p);
    const mask = (s: string) =>
      s.length <= 8
        ? "*".repeat(s.length)
        : s.slice(0, 4) + "•".repeat(Math.min(s.length - 8, 16)) + s.slice(-4);
    return {
      provider: p,
      configured: !!val,
      source,
      // First key masked — preserves the old single-key UI rendering.
      masked: all[0] ? mask(all[0]) : "",
      // Total number of comma/newline-separated keys configured. Lets the
      // admin UI render "3 keys configured" alongside the masked preview
      // and lets ops see at a glance whether failover is set up.
      keyCount: all.length,
      // Masked preview of every key in order, for the admin-side per-key
      // listing ("Key #1: sk-aa…cd, Key #2: sk-ee…hh"). Never leaks more
      // than the first 4 + last 4 chars of any key.
      maskedAll: all.map(mask),
    };
  });
}

// ---------------------------------------------------------------------------
// Custom provider management — OpenAI-compatible providers added via Admin UI
// ---------------------------------------------------------------------------

export type CustomProvider = {
  id: string;
  name: string;
  base_url: string;
  models: string[];
  default_model: string;
  docs_url: string;
  enabled: boolean;
  sort_order: number;
  /** Requests per minute cap (0 = no throttle). */
  rpm: number;
  configured: boolean;
  key_count: number;   // number of API keys stored for this provider
  created_at: number;
};

// ---------------------------------------------------------------------------
// Internal helpers — multiple-key storage
// Keys are stored in the `api_key` column as:
//   ""            → no key
//   "v1:…"        → legacy single encrypted key (still supported on read)
//   '["v1:…",…]'  → JSON array of encrypted keys (new multi-key format)
// ---------------------------------------------------------------------------

function encodeKeys(keys: string[]): string {
  const filtered = keys.filter(Boolean);
  if (filtered.length === 0) return "";
  if (filtered.length === 1) return encrypt(filtered[0]);          // legacy-compat single
  return JSON.stringify(filtered.map(encrypt));
}

function decodeKeys(raw: string): string[] {
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw) as string[];
      return arr.map(decrypt).filter(Boolean);
    } catch { return []; }
  }
  const k = decrypt(raw);
  return k ? [k] : [];
}

export function listCustomProviders(): CustomProvider[] {
  const rows = db.prepare("SELECT * FROM custom_providers ORDER BY sort_order, created_at").all() as any[];
  return rows.map((r) => {
    const keys = decodeKeys(r.api_key ?? "");
    return {
      id: r.id,
      name: r.name,
      base_url: r.base_url,
      models: r.models ? r.models.split(",").map((m: string) => m.trim()).filter(Boolean) : [],
      default_model: r.default_model || "",
      docs_url: r.docs_url || "",
      enabled: r.enabled === 1,
      sort_order: r.sort_order || 0,
      rpm: r.rpm || 0,
      configured: keys.length > 0,
      key_count: keys.length,
      created_at: r.created_at,
    };
  });
}

/** Returns all decrypted API keys for a provider (for streaming key-rotation). */
export function getCustomProviderKeys(id: string): string[] {
  const r = db.prepare("SELECT api_key FROM custom_providers WHERE id = ?").get(id) as any;
  return decodeKeys(r?.api_key ?? "");
}

/** @deprecated Use getCustomProviderKeys(); kept for one-off callers. */
export function getCustomProviderKey(id: string): string {
  return getCustomProviderKeys(id)[0] ?? "";
}

export function upsertCustomProvider(opts: {
  id?: string;
  name: string;
  base_url: string;
  /** Pass `api_keys` (preferred) OR legacy `api_key` for a single key. */
  api_keys?: string[];
  api_key?: string;
  models: string[];
  default_model: string;
  docs_url?: string;
  enabled?: boolean;
  sort_order?: number;
  /** Requests per minute cap (0 = no throttle). */
  rpm?: number;
}): string {
  const id = opts.id || nanoid(12);
  // Resolve the key list: prefer api_keys array, fall back to single api_key.
  const newKeys: string[] | undefined =
    opts.api_keys !== undefined ? opts.api_keys :
    opts.api_key             ? [opts.api_key] :
    undefined;
  const encKeysStr = newKeys !== undefined ? encodeKeys(newKeys) : "";
  const rpm = opts.rpm ?? 0;

  if (opts.id) {
    // CASE WHEN: only overwrite api_key if a new value was provided.
    db.prepare(`
      UPDATE custom_providers SET
        name = ?, base_url = ?,
        api_key = CASE WHEN ? = '' THEN api_key ELSE ? END,
        models = ?, default_model = ?, docs_url = ?,
        enabled = ?, sort_order = ?, rpm = ?
      WHERE id = ?
    `).run(
      opts.name, opts.base_url,
      encKeysStr, encKeysStr,
      opts.models.join(","), opts.default_model, opts.docs_url ?? "",
      opts.enabled !== false ? 1 : 0, opts.sort_order ?? 0, rpm,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO custom_providers (id, name, base_url, api_key, models, default_model, docs_url, enabled, sort_order, rpm, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.name, opts.base_url, encKeysStr,
      opts.models.join(","), opts.default_model, opts.docs_url ?? "",
      opts.enabled !== false ? 1 : 0, opts.sort_order ?? 0, rpm,
      Date.now(),
    );
  }
  return id;
}

export function deleteCustomProvider(id: string): void {
  db.prepare("DELETE FROM custom_providers WHERE id = ?").run(id);
}
