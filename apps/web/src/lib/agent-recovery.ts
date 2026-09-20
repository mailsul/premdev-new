import type { Action, ActionResult } from "./action-executor";

export type RecoveryCategory =
  | "syntax"
  | "import/require"
  | "dependency"
  | "runtime"
  | "database"
  | "permission"
  | "command-not-found"
  | "port"
  | "ui"
  | "logic"
  | "environment"
  | "unknown";

export type RecoveryAttempt = {
  action: string;
  category: RecoveryCategory;
  fingerprint: string;
  output: string;
  ok: boolean;
};

export type RecoveryState = {
  attempts: RecoveryAttempt[];
  identicalErrorStreak: number;
  strategy: "normal" | "diagnostic" | "minimal" | "blocked";
  lastCategory?: RecoveryCategory;
  lastFingerprint?: string;
};

export function createRecoveryState(): RecoveryState {
  return {
    attempts: [],
    identicalErrorStreak: 0,
    strategy: "normal",
  };
}

function normalizedError(output: string): string {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b\d{1,4}:\d{1,4}\b/g, ":line")
    .replace(/\b0x[0-9a-f]+\b/gi, "0xADDR")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function errorFingerprint(output: string): string {
  const normalized = normalizedError(output);
  return normalized.length > 220 ? normalized.slice(0, 220) : normalized;
}

export function extractDiagnostic(output: string, maxChars = 1800): string {
  const clean = output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
  if (!clean) return "(tool tidak mengembalikan detail error)";
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

export function classifyFailure(action: Action, output: string): RecoveryCategory {
  const text = `${action.kind} ${output}`.toLowerCase();
  if (/syntaxerror|parse error|unexpected token|expected .*[;)}\]]|invalid syntax|ts\d{3,4}\b/.test(text)) {
    return "syntax";
  }
  if (/cannot find module|module not found|no module named|failed to resolve import|importerror|err_require/.test(text)) {
    return "import/require";
  }
  if (/npm err|pnpm err|yarn error|pip install|could not find a version|no matching distribution|lockfile/.test(text)) {
    return "dependency";
  }
  if (/eaddrinuse|address already in use|port .*in use|port conflict|listen .*failed/.test(text)) {
    return "port";
  }
  if (/access denied|permission denied|operation not permitted|eacces|eperm/.test(text)) {
    return "permission";
  }
  if (/command not found|not recognized as an internal|executable file not found|no such file or directory/.test(text)) {
    return "command-not-found";
  }
  if (action.kind === "db" || /sql|mysql|postgres|sqlite|database|relation .*does not exist|table .*doesn't exist/.test(text)) {
    return "database";
  }
  if (action.kind === "browser" || /consoleerror|page error|selector|element .*not found|button|click|navigation/.test(text)) {
    return "ui";
  }
  if (action.kind === "preview" || action.kind === "restart" || /econnrefused|502|503|server.*(crash|down)|traceback|uncaught/.test(text)) {
    return "runtime";
  }
  if (/env|environment|missing .*variable|undefined.*process\.env|configuration|config/.test(text)) {
    return "environment";
  }
  if (/assert|expected .*received|test failed|incorrect|wrong result|logic/.test(text)) {
    return "logic";
  }
  return "unknown";
}

export function recordRecoveryAttempt(
  state: RecoveryState,
  action: Action,
  result: ActionResult,
): RecoveryState {
  if (result.ok) {
    return {
      ...state,
      attempts: state.attempts.slice(-11),
      identicalErrorStreak: 0,
      strategy: "normal",
    };
  }

  const category = classifyFailure(action, result.output);
  const fingerprint = errorFingerprint(result.output);
  const identical = fingerprint && fingerprint === state.lastFingerprint;
  const identicalErrorStreak = identical ? state.identicalErrorStreak + 1 : 1;
  const strategy = identicalErrorStreak >= 3
    ? "blocked"
    : identicalErrorStreak >= 2
      ? "diagnostic"
      : "normal";

  return {
    attempts: [
      ...state.attempts,
      {
        action: action.kind,
        category,
        fingerprint,
        output: extractDiagnostic(result.output),
        ok: false,
      },
    ].slice(-12),
    identicalErrorStreak,
    strategy,
    lastCategory: category,
    lastFingerprint: fingerprint,
  };
}

export function recoveryActionsFor(
  category: RecoveryCategory,
  action: Action,
): Action[] {
  switch (category) {
    case "syntax":
    case "import/require":
    case "dependency":
    case "command-not-found":
    case "logic":
      return [{ kind: "diag" }];
    case "database":
      return [{ kind: "db", sql: "SHOW TABLES;" }];
    case "port":
    case "runtime":
      return [{ kind: "preview", path: "/" }];
    case "ui":
      return [{ kind: "browser", path: "/", steps: [] }];
    case "permission":
    case "environment":
      return [{
        kind: "bash",
        command: "printf '%s\\n' '=== cwd ==='; pwd; printf '%s\\n' '=== files ==='; ls -la | head -80; printf '%s\\n' '=== git state ==='; git status --short 2>&1 | head -80",
      }];
    default:
      return action.kind === "browser" ? [{ kind: "browser", path: "/", steps: [] }] : [{ kind: "diag" }];
  }
}

export function recoveryInstruction(
  state: RecoveryState,
  lastAction: Action,
  lastOutput: string,
): string {
  const category = state.lastCategory ?? classifyFailure(lastAction, lastOutput);
  const exact = extractDiagnostic(lastOutput);
  const categoryRule: Record<RecoveryCategory, string> = {
    syntax: "baca file dan jalankan compiler/syntax check sebelum mengedit ulang",
    "import/require": "cek package.json/lockfile, import path, dan konfigurasi module sebelum memasang atau mengubah kode",
    dependency: "cek package manager, lockfile, versi runtime, dan package yang benar-benar hilang",
    runtime: "cek entrypoint, process state, log runtime, dan lifecycle workspace sebelum restart lagi",
    database: "inspeksi schema/database aktual dengan query read-only sebelum menulis migration atau query baru",
    permission: "jangan ubah source code; cek path, owner, permission, dan batasan runtime",
    "command-not-found": "cek command yang tersedia dan script project; jangan mengganti command secara acak",
    port: "cek process/port yang sedang listen dan gunakan port workspace yang benar",
    ui: "gunakan browser evidence untuk selector, console error, page error, dan state UI",
    logic: "buat hipotesis berdasarkan output/test lalu ubah satu bagian kecil dan ukur hasilnya",
    environment: "cek konfigurasi/runtime env tanpa menulis secret ke source code",
    unknown: "baca output lengkap dan file/config yang paling dekat dengan error sebelum memilih fix",
  };

  return [
    "RECOVERY PROTOCOL (wajib):",
    `- Kategori root cause: ${category}`,
    `- Error exact: ${exact}`,
    `- Langkah diagnosis: ${categoryRule[category]}.`,
    "- Hipotesis: tulis satu penyebab paling mungkin berdasarkan bukti, bukan tebakan umum.",
    "- Fix: ubah satu hal kecil saja, lalu jalankan test/diag/validate yang relevan.",
    state.strategy === "blocked"
      ? "- ERROR IDENTIK 3x: berhenti mengulang. Laporkan blocker, percobaan yang sudah dilakukan, dan pemeriksaan manual yang dibutuhkan."
      : state.strategy === "diagnostic"
        ? "- Pendekatan sebelumnya gagal; jangan ulangi patch/command yang sama. Diagnosis harus berbeda dan terukur."
        : "- Jangan lanjut ke fitur berikutnya sampai hasil pemeriksaan membaik.",
  ].join("\n");
}

export function parseAcceptanceCriteria(plan: string): string[] {
  return plan
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[(?: |x)\]\s+/i.test(line))
    .map((line) => line.replace(/^[-*]\s+\[(?: |x)\]\s+/i, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function acceptanceAnchor(criteria: string[]): string {
  if (criteria.length === 0) return "";
  return [
    "[ACCEPTANCE CHECKLIST — jangan tandai selesai sebelum semua bukti tersedia]",
    ...criteria.map((item) => `- [ ] ${item}`),
    "Untuk setiap item, sebutkan bukti dari test, validator, API, database, atau browser. Item tanpa bukti tetap unverified.",
    "",
  ].join("\n");
}