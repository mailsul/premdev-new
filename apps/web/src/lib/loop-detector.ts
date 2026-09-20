/**
 * loop-detector.ts — detect when the AI is stuck repeating itself.
 *
 * Two checks:
 *  (a) Fingerprint loop — same action fingerprint appears in 3 consecutive batches.
 *  (b) Regression loop  — same (kind, target) action failed, then AI retries it
 *      immediately without a different strategy.
 *
 * Returns a warning string or null.
 */
import type { Action } from "./action-executor";
import { actionFingerprint } from "./action-executor";

export type LoopState = {
  history: string[][];     // last 3 batches of fingerprints
  recentRuns: { kind: string; target: string; ok: boolean; output: string }[];
  lastWarning: string | null;
};

export function createLoopState(): LoopState {
  return { history: [], recentRuns: [], lastWarning: null };
}

function actionTarget(a: Action): string {
  switch (a.kind) {
    case "bash":       return a.command.split("\n")[0].slice(0, 200);
    case "file":       return a.path;
    case "delete":     return a.path;
    case "mkdir":      return a.path;
    case "rename":     return `${a.from}→${a.to}`;
    case "patch":      return a.path;
    case "search":     return a.pattern.slice(0, 200);
    case "diag":       return "";
    case "test":       return a.command?.slice(0, 200) ?? "";
    case "web":        return a.query.slice(0, 200);
    case "webFetch":   return a.url.slice(0, 200);
    case "preview":    return a.path ?? "/";
    case "browser":    return `${a.path ?? "/"} ${a.steps.join(" | ")}`.slice(0, 200);
    case "validate":   return "";
    case "memorySave": return a.content.split("\n")[0].slice(0, 200);
    case "setRun":        return a.command.slice(0, 200);
    case "setEnv":        return Object.keys(a.vars).join(",");
    case "setProcesses":  return Object.keys(a.processes).join(",");
    case "start":
    case "stop":
    case "restart":       return "";
    case "checkpoint": return a.message;
    case "db":         return a.sql.split("\n")[0].slice(0, 200);
    case "open":       return a.path;
  }
}

/**
 * Called after each executed batch. Returns `{ warning, newState }`.
 * `warning` is non-null when a loop is detected; caller should stop the session.
 * `results` may be empty (pre-execution check) — in that case only fingerprint
 * history is updated without regression analysis.
 */
export function recordBatch(
  state: LoopState,
  batch: Action[],
  results: { ok: boolean; output: string }[],
): { warning: string | null; newState: LoopState } {
  const next: LoopState = {
    history: [...state.history, batch.map(actionFingerprint)].slice(-3),
    recentRuns: [
      ...state.recentRuns,
      ...batch.map((a, i) => ({
        kind: a.kind,
        target: actionTarget(a),
        ok: results[i]?.ok ?? false,
        output: results[i]?.output ?? "",
      })),
    ].slice(-20),
    lastWarning: state.lastWarning,
  };

  // Check (a): same fingerprint in all 3 most-recent batches
  if (next.history.length === 3) {
    const [a, b, c] = next.history;
    const sa = new Set(a);
    const sb = new Set(b);
    const sc = new Set(c);
    for (const fp of a) {
      if (sb.has(fp) && sc.has(fp)) {
        const warning = `Aksi yang sama persis muncul di 3 giliran berturut-turut. Coba ubah strategi — introspeksi state dulu dengan bash atau search sebelum mencoba lagi.`;
        next.lastWarning = warning;
        return { warning, newState: next };
      }
    }
  }

  // Check (b): regression loop (same action failed and retried immediately)
  if (results.length > 0 && next.recentRuns.length >= 2) {
    const last = next.recentRuns[next.recentRuns.length - 1];
    const prev = next.recentRuns[next.recentRuns.length - 2];
    if (
      !prev.ok &&
      last.kind === prev.kind &&
      last.target === prev.target &&
      /error|fail|denied|invalid|timeout|refused|not found|exists|conflict/i.test(prev.output)
    ) {
      const warning = `Regression loop: aksi "${last.kind}" ke target "${last.target}" baru saja gagal dan AI mencoba lagi tanpa perubahan strategi. Periksa state aktual terlebih dahulu.`;
      if (warning !== next.lastWarning) {
        next.lastWarning = warning;
        return { warning, newState: next };
      }
    }
  }

  // Clear warning when a different successful action is seen
  if (next.recentRuns.length >= 2) {
    const last = next.recentRuns[next.recentRuns.length - 1];
    const prev = next.recentRuns[next.recentRuns.length - 2];
    if (last.ok && (last.kind !== prev.kind || last.target !== prev.target)) {
      next.lastWarning = null;
    }
  }

  return { warning: null, newState: next };
}
