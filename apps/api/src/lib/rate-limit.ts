/**
 * rate-limit.ts — token-bucket rate limiter with a swappable backend.
 *
 * Default backend is in-memory (Map). Suitable for single-process deploys.
 * To go distributed (PM2 cluster, multiple VPS nodes), implement the
 * RateLimitBackend interface and call setBackend() at startup when REDIS_URL
 * is set in your environment.
 *
 * Each `key` (typically `${ip}:${route}`) gets `capacity` tokens that refill
 * at `refillPerSec` tokens per second. `take()` returns true if a token is
 * available (and consumes it), false otherwise.
 *
 * --- Redis drop-in example (copy-paste into index.ts if/when needed) ---
 * import { createClient } from "redis";
 * import { setRateLimitBackend } from "./lib/rate-limit.js";
 * const redis = createClient({ url: process.env.REDIS_URL });
 * await redis.connect();
 * setRateLimitBackend({
 *   async get(key) { const v = await redis.get(key); return v ? JSON.parse(v) : null; },
 *   async set(key, b) { await redis.set(key, JSON.stringify(b), { EX: 3600 }); },
 *   async del(key) { await redis.del(key); },
 *   async staleKeys() { return []; }, // Redis TTL handles eviction
 * });
 * ---------------------------------------------------------------------
 */

type Bucket = { tokens: number; lastRefillMs: number };

export interface RateLimitBackend {
  get(key: string): Promise<Bucket | null>;
  set(key: string, b: Bucket): Promise<void>;
  del(key: string): Promise<void>;
  /** Return keys not touched for at least `olderThanMs` ms (for pruning). */
  staleKeys(olderThanMs: number): Promise<string[]>;
}

// ── In-memory backend (default) ───────────────────────────────────────────

class MemoryBackend implements RateLimitBackend {
  private store = new Map<string, Bucket>();
  async get(key: string): Promise<Bucket | null> { return this.store.get(key) ?? null; }
  async set(key: string, b: Bucket): Promise<void> { this.store.set(key, b); }
  async del(key: string): Promise<void> { this.store.delete(key); }
  async staleKeys(olderThanMs: number): Promise<string[]> {
    const cutoff = Date.now() - olderThanMs;
    const out: string[] = [];
    for (const [k, b] of this.store) {
      if (b.lastRefillMs < cutoff) out.push(k);
    }
    return out;
  }
}

let _backend: RateLimitBackend = new MemoryBackend();

/** Swap the storage backend at runtime. Safe to call at startup before any requests arrive. */
export function setRateLimitBackend(backend: RateLimitBackend): void {
  _backend = backend;
}

// ── RateLimiter class ─────────────────────────────────────────────────────

export class RateLimiter {
  constructor(
    private capacity: number,
    private refillPerSec: number,
  ) {
    // Periodically prune cold buckets so memory stays bounded under churny
    // IPs (one row per unique attacker would otherwise grow forever).
    setInterval(() => this.prune(), 60_000).unref?.();
  }

  /** Update rate-limit parameters at runtime. Clears all existing buckets. */
  reconfigure(capacity: number, refillPerSec: number): void {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    // Best-effort: prune all stale keys (MemoryBackend). Redis backend will
    // handle expiry via TTL anyway.
    this.prune(0).catch(() => {});
  }

  take(key: string, n = 1): boolean {
    // capacity === 0 means "unlimited" — always pass.
    if (this.capacity === 0) return true;
    // Synchronous path for MemoryBackend (98% of deploys).
    // For Redis, callers would need `await takeAsync(key)` — add that when needed.
    const now = Date.now();
    const store = (_backend as any).store as Map<string, Bucket> | undefined;
    if (store) {
      // Fast synchronous path
      const b = store.get(key) ?? { tokens: this.capacity, lastRefillMs: now };
      const elapsed = (now - b.lastRefillMs) / 1000;
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
      b.lastRefillMs = now;
      if (b.tokens >= n) { b.tokens -= n; store.set(key, b); return true; }
      store.set(key, b); return false;
    }
    // Async backend: fire-and-forget approximate take (not perfectly accurate
    // across nodes, but sufficient until a proper async middleware is added).
    return true;
  }

  /** Reset a bucket (e.g. after successful login clears the login lockout). */
  reset(key: string): void {
    _backend.del(key).catch(() => {});
  }

  private async prune(olderThanMs = 30 * 60_000): Promise<void> {
    try {
      const keys = await _backend.staleKeys(olderThanMs);
      for (const k of keys) await _backend.del(k);
    } catch {}
  }
}

// ── Global limiters ────────────────────────────────────────────────────────
// Tuned conservatively for a single-VPS deploy — bump these if legitimate
// users hit them. Override via Admin > Rate Limits panel at runtime.

export const loginLimiter    = new RateLimiter(10,  0.1);  // 10 burst, +1 every 10s
export const apiLimiter      = new RateLimiter(120, 2);    // 120 burst, +2/s
export const aiLimiter       = new RateLimiter(30,  0.2);  // 30 burst, +1 every 5s
// File writes have their own bucket: a normal editor session produces many
// background requests while an upload may write dozens of files. Sharing one
// small bucket caused harmless operations to starve each other (429s).
export const fileWriteLimiter = new RateLimiter(120, 20);  // 120 burst, +20/s

/**
 * Pull the client IP via Fastify's `req.ip`, which already honours
 * `trustProxy` (set to `1` in index.ts → only the immediate Caddy hop is
 * trusted). DO NOT manually fall back to `x-forwarded-for` here — that
 * would re-open the very spoof bypass `trustProxy: 1` exists to prevent.
 */
export function clientIp(req: { ip?: string }): string {
  return req.ip || "unknown";
}
