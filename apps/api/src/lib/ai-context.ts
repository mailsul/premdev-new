/**
 * ai-context.ts — workspace context builders for the AI system prompt.
 * Extracted from apps/api/src/routes/ai.ts for maintainability.
 */

import fs from "node:fs";
import path from "node:path";
import { workspacePath } from "./runtime.js";
import { config } from "./config.js";
import {
  search as semanticSearch,
  indexWorkspace,
  workspaceIndexStats,
} from "./semantic-search.js";
import type { ChatMsg } from "./ai-prompt.js";

// ---------------------------------------------------------------------------
// Directory traversal helpers
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__",
  "target", "dist", "build", ".next", ".replit-cache", ".idea",
]);

// ---------------------------------------------------------------------------
// Project memory
// ---------------------------------------------------------------------------

/**
 * Read a file from the workspace .premdev folder, truncated to maxBytes.
 * Returns "" if missing, unreadable, or empty.
 */
function readPremdevFile(p: string, maxBytes: number): string {
  try {
    if (!fs.existsSync(p)) return "";
    const stats = fs.statSync(p);
    if (!stats.isFile()) return "";
    const buf = fs.readFileSync(p, "utf8");
    const text = buf.length > maxBytes ? buf.slice(0, maxBytes) + "\n…(truncated)" : buf;
    return text.trim();
  } catch { return ""; }
}

/**
 * Returns the path to the `.premdev-data/` directory for a workspace.
 * NOTE: `.premdev` (no suffix) is a JSON config *file* — we MUST NOT treat
 * it as a directory. All AI memory and instruction files live in the separate
 * `.premdev-data/` folder.
 */
function premdevDataDir(workspaceId: string): string {
  // "__global__" stores cross-workspace shared memory outside any specific workspace.
  if (workspaceId === "__global__") {
    const base = path.dirname(workspacePath("_dummy_"));
    return path.join(base, "__global__", ".premdev-data");
  }
  return path.join(workspacePath(workspaceId), ".premdev-data");
}

function ensurePremdevDataDir(workspaceId: string): string {
  const dir = premdevDataDir(workspaceId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * User-authored instructions at `.premdev-data/instructions.md`.
 * Up to 4 KB injected into every system prompt as project-wide rules.
 */
const PROJECT_MEMORY_MAX_BYTES = 4096;
export function loadProjectMemory(workspaceId: string): string {
  return readPremdevFile(path.join(premdevDataDir(workspaceId), "instructions.md"), PROJECT_MEMORY_MAX_BYTES);
}

/**
 * AI-generated persistent memory at `.premdev-data/memory.md`.
 * Written by the `/api/ai/memory/update` endpoint after the user
 * requests a memory save. Up to 6 KB injected into every system prompt
 * so the model remembers past sessions, user preferences, and project facts.
 */
const AI_MEMORY_MAX_BYTES = 6144;
export function loadAIMemory(workspaceId: string): string {
  return readPremdevFile(path.join(premdevDataDir(workspaceId), "memory.md"), AI_MEMORY_MAX_BYTES);
}

/**
 * Write AI-generated memory to `.premdev-data/memory.md` (full overwrite).
 */
export function writeAIMemory(workspaceId: string, content: string): void {
  const dir = ensurePremdevDataDir(workspaceId);
  fs.writeFileSync(path.join(dir, "memory.md"), content.trim() + "\n", "utf8");
}

/**
 * Append a raw note to `.premdev-data/memory.md` without an AI call.
 * Used by the `memory:save` action block.
 */
export function appendAIMemory(workspaceId: string, note: string): void {
  const dir = ensurePremdevDataDir(workspaceId);
  const p = path.join(dir, "memory.md");
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  const separator = `\n\n---\n*Auto-appended ${date}:*\n`;
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  fs.writeFileSync(p, (existing.trimEnd() + separator + note.trim()).trimStart() + "\n", "utf8");
}

/**
 * Delete `.premdev-data/memory.md` (called when the user clears the chat).
 * Instructions file is kept — only AI-generated memory is wiped.
 */
export function clearAIMemory(workspaceId: string): void {
  const p = path.join(premdevDataDir(workspaceId), "memory.md");
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Workspace snapshot
// ---------------------------------------------------------------------------

/**
 * Build a compact workspace snapshot for the AI:
 *   - working directory
 *   - up to MAX_ENTRIES files/dirs (depth-first, depth-limited),
 *     each with size for files, sorted dirs-first.
 */
/**
 * Returns relative paths of SQL schema files found in the workspace root.
 * Used to cross-reference with the workspace DB hint so the AI knows to
 * proactively offer to import them when the DB is empty.
 */
function detectSchemaFiles(root: string): string[] {
  const candidates = [
    "schema.sql", "db.sql", "init.sql", "database.sql",
    "migrations/schema.sql", "prisma/schema.prisma", "drizzle/schema.ts",
  ];
  const found: string[] = [];
  for (const rel of candidates) {
    try {
      const p = path.join(root, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) found.push(rel);
    } catch { /* skip */ }
  }
  return found;
}

export function buildWorkspaceContext(
  workspaceId: string,
  username?: string,
  workspaceName?: string,
): string {
  const root = workspacePath(workspaceId);
  if (!fs.existsSync(root)) {
    const wsDb = buildWorkspaceDbHint(username, workspaceName, []);
    return `Working directory: /workspace (empty)\nFiles: (workspace folder is empty)${wsDb}`;
  }
  const MAX_ENTRIES = 80;
  const MAX_DEPTH = 4;
  const lines: string[] = [];

  function walk(dir: string, rel: string, depth: number) {
    if (lines.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    items
      .filter((e) => !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .forEach((e) => {
        if (lines.length >= MAX_ENTRIES) return;
        if (e.isSymbolicLink()) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          lines.push(`${childRel} (symlink, not followed)`);
          return;
        }
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          lines.push(`${childRel}/`);
          walk(path.join(dir, e.name), childRel, depth + 1);
        } else if (e.isFile()) {
          let size = "";
          try {
            const s = fs.lstatSync(path.join(dir, e.name));
            size = ` (${s.size}B)`;
          } catch {}
          lines.push(`${childRel}${size}`);
        }
      });
  }

  walk(root, "", 0);
  const truncated = lines.length >= MAX_ENTRIES ? "\n…(truncated)" : "";
  const body = lines.length ? lines.join("\n") : "(workspace folder is empty)";
  const hints = detectProjectHints(root, lines);
  const hintBlock = hints.length ? `\nDetected project: ${hints.join("; ")}` : "";
  const schemaFiles = detectSchemaFiles(root);
  const dbBlock = sniffDatabaseSchema(root);
  const wsDb = buildWorkspaceDbHint(username, workspaceName, schemaFiles);
  return `Working directory: /workspace\nFiles:\n${body}${truncated}${hintBlock}${dbBlock}${wsDb}`;
}

// ---------------------------------------------------------------------------
// Workspace database hint
// ---------------------------------------------------------------------------

/**
 * Tell the model exactly which MySQL database belongs to this workspace
 * (created automatically at workspace-create time by `createProjectDb`),
 * and which env vars are pre-injected into the runtime container so user
 * code can connect without configuration. The actual password is NEVER
 * surfaced — the model uses the env vars from inside the container instead.
 */
export function buildWorkspaceDbHint(
  username?: string,
  workspaceName?: string,
  schemaFiles?: string[],
): string {
  if (!config.MYSQL_HOST || !username || !workspaceName) return "";
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  const safeProj = workspaceName.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!safeUser || !safeProj) return "";
  const dbName = `${safeUser}_${safeProj}`;

  const schemaHint = schemaFiles && schemaFiles.length > 0
    ? `- Schema file(s) found in workspace: ${schemaFiles.join(", ")}. ` +
      `If SHOW TABLES returns empty or the app throws "Unknown database" / "Table doesn't exist", ` +
      `proactively offer to initialize the DB by reading the schema file and running each CREATE TABLE ` +
      `statement via \`db:query\` blocks — one statement per block.\n`
    : `- If the app throws "Unknown database" or "Table doesn't exist", ` +
      `run \`db:query SHOW TABLES;\` first to check the DB state, ` +
      `then offer to create the needed tables.\n`;

  return (
    `\n\nWorkspace database (MySQL):\n` +
    `- Host: ${config.MYSQL_HOST}  Port: ${config.MYSQL_PORT}\n` +
    `- Database: \`${dbName}\` — this is the FIXED, IMMUTABLE database name for this workspace. ` +
    `MySQL user \`${safeUser}\` has GRANT ALL on this DB. ` +
    `The database is auto-created on first \`db:query\` — it may be empty (no tables) if schema has not been imported yet.\n` +
    `- **CRITICAL — DATABASE_NAME IS LOCKED**: The env var \`DATABASE_NAME\` is ALREADY set to \`${dbName}\` in the workspace. ` +
    `NEVER use \`workspace:setEnv\` to set \`DATABASE_NAME\` to a different value — the server IGNORES it and always uses \`${dbName}\` for all \`db:query\` actions. ` +
    `If app code uses \`getenv('DATABASE_NAME')\`, the value IS \`${dbName}\`, so just ensure the app code reads that env var correctly.\n` +
    `- PROACTIVE RULE: At the start of any conversation where the user reports a DB/connection error ` +
    `OR where you see DB-related files in the workspace, immediately run ` +
    `\`\`\`db:query\nSHOW TABLES;\n\`\`\` to check the current state before doing anything else. ` +
    `Do NOT ask the user to manually connect or configure credentials — everything is already injected.\n` +
    schemaHint +
    `- Inside the runtime container these env vars are pre-set: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DATABASE_NAME=${dbName}, DATABASE_HOST, DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD, MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD. Reference them via process.env / getenv / os.environ — DO NOT ask the user for credentials, they are already there.\n` +
    `- To run SQL directly from chat use the \`db:query\` action (one statement per block). Example: \`\`\`db:query\nSHOW TABLES;\n\`\`\`\n` +
    `- To use it from app code, e.g. PHP: \`new mysqli(getenv('DB_HOST'), getenv('DB_USER'), getenv('DB_PASSWORD'), getenv('DATABASE_NAME'))\`. Node: \`mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DATABASE_NAME })\`. Python: \`pymysql.connect(host=os.environ['DB_HOST'], user=os.environ['DB_USER'], password=os.environ['DB_PASSWORD'], database=os.environ['DATABASE_NAME'])\`.`
  );
}

// ---------------------------------------------------------------------------
// Database schema sniffer
// ---------------------------------------------------------------------------

/**
 * If the workspace has either:
 *   - a SQLite file at the root (≤ 50 MB), or
 *   - SQL DDL files (schema.sql / migrations/*.sql / db.sql), or
 *   - a .env / .premdev with DB_* hints
 * surface a short "Database schema" section so the assistant can write
 * code against the real tables/columns rather than guessing. We intentionally
 * never connect to remote databases here — credentials live with the user
 * and we cannot route from the API container into their MySQL anyway.
 *
 * Best-effort and defensive: any failure returns "" so the chat continues.
 */
export function sniffDatabaseSchema(root: string): string {
  try {
    const out: string[] = [];
    const candidateFiles = [
      "schema.sql", "db.sql", "init.sql", "database.sql",
      "migrations/schema.sql", "prisma/schema.prisma", "drizzle/schema.ts",
    ];
    for (const rel of candidateFiles) {
      const p = path.join(root, rel);
      try {
        const s = fs.statSync(p);
        if (!s.isFile() || s.size > 200_000) continue;
        const txt = fs.readFileSync(p, "utf8");
        out.push(
          `-- ${rel} (${s.size}B):\n${txt.slice(0, 4000)}${txt.length > 4000 ? "\n…(truncated)" : ""}`,
        );
        if (out.length >= 2) break;
      } catch { /* skip */ }
    }
    let envHint = "";
    for (const envName of [".env", ".env.local"]) {
      try {
        const envTxt = fs.readFileSync(path.join(root, envName), "utf8");
        const lines = envTxt
          .split("\n")
          .filter((l) => /^DB_|^DATABASE_/.test(l) && !/=\s*$/.test(l));
        if (lines.length) {
          const keys = lines.map((l) => l.split("=")[0]).join(", ");
          envHint = `External database referenced in ${envName} via env keys: ${keys} (values not shown).`;
          break;
        }
      } catch { /* skip */ }
    }
    const sqliteHits: string[] = [];
    const sqliteRe = /\.(db|sqlite|sqlite3)$/i;
    const dirsToScan = [
      root,
      path.join(root, "data"),
      path.join(root, "db"),
      path.join(root, "var"),
    ];
    for (const dir of dirsToScan) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          if (!sqliteRe.test(ent.name)) continue;
          const full = path.join(dir, ent.name);
          let size = 0;
          try { size = fs.statSync(full).size; } catch {}
          sqliteHits.push(`${path.relative(root, full)} (${size}B)`);
          if (sqliteHits.length >= 4) break;
        }
        if (sqliteHits.length >= 4) break;
      } catch { /* dir missing — fine */ }
    }

    if (!out.length && !envHint && !sqliteHits.length) return "";
    const parts = ["\nDatabase schema:"];
    if (envHint) parts.push(envHint);
    if (sqliteHits.length) {
      parts.push(
        `SQLite database file(s) detected: ${sqliteHits.join(", ")}. ` +
          `Use \`bash:run sqlite3 <file> ".schema"\` to inspect schema.`,
      );
    }
    if (out.length) parts.push(out.join("\n\n"));
    return "\n" + parts.join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Project type detection
// ---------------------------------------------------------------------------

/**
 * Inspect the listing for known project-type signals and return one or more
 * short hints like 'PHP web app, run: php -S 0.0.0.0:5000 -t .'.
 * Hints are strictly suggestions — the model still decides what to emit.
 */
export function detectProjectHints(root: string, lines: string[]): string[] {
  const has = (name: string) => lines.some((l) => l.split(" ")[0] === name);
  const hasAny = (re: RegExp) => lines.some((l) => re.test(l.split(" ")[0]));
  const out: string[] = [];

  if (has("package.json")) {
    let runHint = "npm install && npm start";
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(root, "package.json"), "utf8"),
      );
      const scripts = pkg.scripts ?? {};
      if (scripts.dev) runHint = "npm install && npm run dev";
      else if (scripts.start) runHint = "npm install && npm start";
      else if (pkg.main) runHint = `npm install && node ${pkg.main}`;
    } catch {}
    out.push(`Node.js project (package.json), run: ${runHint}`);
  }
  if (has("requirements.txt") || has("pyproject.toml") || hasAny(/\.py$/)) {
    let entry = "main.py";
    for (const cand of ["app.py", "main.py", "server.py", "run.py", "manage.py"]) {
      if (has(cand)) { entry = cand; break; }
    }
    const install = has("requirements.txt") ? "pip install -r requirements.txt && " : "";
    out.push(
      `Python project (runtime has flask/fastapi/uvicorn pre-installed), run: ${install}python3 ${entry}`,
    );
  }
  if (has("index.php") || has("router.php") || hasAny(/\.php$/)) {
    const router = has("router.php") ? " router.php" : "";
    out.push(`PHP web app, run: php -S 0.0.0.0:5000 -t .${router}`);
  }
  if (has("Gemfile")) {
    out.push("Ruby project, run: bundle install && bundle exec rackup -o 0.0.0.0 -p 5000");
  }
  if (has("go.mod")) out.push("Go project, run: go run .");
  if (has("Cargo.toml")) out.push("Rust project, run: cargo run");
  if (has("pom.xml")) {
    out.push("Java Maven project, run: mvn -q spring-boot:run");
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    out.push("Java Gradle project, run: ./gradlew bootRun");
  }
  if (has("index.html") && out.length === 0) {
    out.push("Static site, serve: python3 -m http.server 5000");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Semantic snippet retrieval
// ---------------------------------------------------------------------------

export const SEARCH_TOP_K = 5;
const SEARCH_MAX_SNIPPET_CHARS = 1500;

/**
 * Inject the top-K most semantically relevant code chunks for the user's
 * latest message into the system prompt. This is the lumen-style token
 * optimisation — instead of letting the model issue dozens of follow-up
 * `bash:run cat <file>` calls (each one duplicating the file contents into
 * chat history forever), we pre-compute the relevant excerpts ONCE and ship
 * them as part of the workspace snapshot.
 *
 * Returns "" on any failure (model not loaded, index empty, search error)
 * — the chat handler MUST keep working even when search is dead.
 *
 * Side effect: if the index is empty for this workspace, we kick off a
 * background `indexWorkspace()` so the *next* chat turn has hits. The
 * current turn still returns "" — we don't block the user waiting for an
 * index to build.
 */
export async function buildRelevantSnippets(
  workspaceId: string,
  history: ChatMsg[],
): Promise<string> {
  let query = "";
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      const content = history[i].content;
      query = typeof content === "string" ? content : "";
      break;
    }
  }
  query = query.trim();
  if (query.length < 8) return "";

  const stats = workspaceIndexStats(workspaceId);
  if (!stats.exists || stats.chunks === 0) {
    indexWorkspace(workspaceId).catch(() => {});
    return "";
  }

  const hits = await semanticSearch(workspaceId, query, SEARCH_TOP_K);
  if (hits.length === 0) return "";

  const formatted = hits
    .map((h) => {
      const snippet =
        h.content.length > SEARCH_MAX_SNIPPET_CHARS
          ? h.content.slice(0, SEARCH_MAX_SNIPPET_CHARS) + "\n… (truncated)"
          : h.content;
      return `### ${h.path} (lines ${h.startLine}-${h.endLine}, score ${h.score.toFixed(2)})\n\`\`\`\n${snippet}\n\`\`\``;
    })
    .join("\n\n");

  return `\n\n--- Relevant code snippets (semantic search; pre-fetched, do NOT re-read these files unless changed) ---\n${formatted}`;
}
