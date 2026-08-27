import fs from "node:fs";
import path from "node:path";

// Canonical config filename (Replit-style — short, no extension).
export const CONFIG_FILENAME = ".premdev";
// Legacy filename. Existing workspaces still have `.premdev.json`; we
// transparently read it as a fallback and migrate on first write.
export const LEGACY_CONFIG_FILENAME = ".premdev.json";

/**
 * One named process inside a multi-process workspace.
 * Each gets its own port and run command.
 * Example in .premdev (TOML):
 *   [processes.web]
 *   run  = "php -S 0.0.0.0:$PORT_web"
 *   port = 8080
 */
export type ProcessConfig = {
  run: string;
  port: number;
};

export type WorkspaceConfig = {
  run?: string;
  env?: Record<string, string>;
  /**
   * Force the preview to be served from this exact port inside the
   * container. Use this when the user's app hard-codes the port (e.g.
   * Flask's `app.run(port=5000)`, Django default 8000) and isn't
   * willing/able to read `os.environ["PORT"]`. Without this, PremDev
   * assigns a random port via the PORT env var and the user's app
   * binds to a different one — proxy gets ECONNREFUSED → blank page.
   * Ignored when `processes` is set.
   */
  port?: number;
  /** Replit-style hints: copied at workspace creation, AI reads them. */
  language?: string;
  entrypoint?: string;
  modules?: string[];
  /**
   * Multi-process mode.  When present, `run` and `port` are ignored.
   * PremDev spawns every listed process inside one container, prefixes
   * each line of output with [name], and exposes each port at
   * <project>-<port>-<user>.<domain>.
   *
   * The first entry is treated as the "main" process: its URL is the
   * default <project>-<user>.<domain> preview URL.
   */
  processes?: Record<string, ProcessConfig>;
};

// ── Minimal TOML support ──────────────────────────────────────────────────
// Handles only the limited schema PremDev uses.  No external dependency.
// Supports: top-level scalars, [env] table, [processes.name] tables,
// string and number values, basic string escape sequences.

function tomlStr(s: string): string {
  // Basic string — escape backslash, double-quote, and control chars.
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

function tomlKey(k: string): string {
  // Bare key: letters, digits, dash, underscore (TOML spec §2.1).
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k);
}

export function serializeToml(cfg: WorkspaceConfig): string {
  const lines: string[] = [];

  // Top-level scalars — order mirrors .replit for familiarity.
  if (cfg.language)   lines.push(`language   = ${tomlStr(cfg.language)}`);
  if (cfg.entrypoint) lines.push(`entrypoint = ${tomlStr(cfg.entrypoint)}`);
  if (cfg.modules?.length) {
    lines.push(`modules    = [${cfg.modules.map(tomlStr).join(", ")}]`);
  }
  if (cfg.run)  lines.push(`run  = ${tomlStr(cfg.run)}`);
  if (cfg.port) lines.push(`port = ${cfg.port}`);

  // [env] table
  const envEntries = Object.entries(cfg.env ?? {});
  if (envEntries.length) {
    lines.push("");
    lines.push("[env]");
    for (const [k, v] of envEntries) {
      lines.push(`${tomlKey(k)} = ${tomlStr(v)}`);
    }
  }

  // [processes.<name>] tables
  for (const [name, proc] of Object.entries(cfg.processes ?? {})) {
    lines.push("");
    lines.push(`[processes.${tomlKey(name)}]`);
    lines.push(`run  = ${tomlStr(proc.run)}`);
    lines.push(`port = ${proc.port}`);
  }

  return lines.join("\n") + "\n";
}

function unescapeTomlStr(s: string): string {
  return s
    .replace(/\\"/g,  '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g,  "\n")
    .replace(/\\r/g,  "\r")
    .replace(/\\t/g,  "\t");
}

function parseTomlValue(raw: string): string | number | string[] {
  const t = raw.trim();
  // Basic string
  if (t.startsWith('"') && t.endsWith('"')) return unescapeTomlStr(t.slice(1, -1));
  // Literal string
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  // Array of strings  ["a", "b", ...]
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => {
      const item = s.trim();
      if (item.startsWith('"') && item.endsWith('"')) return unescapeTomlStr(item.slice(1, -1));
      if (item.startsWith("'") && item.endsWith("'")) return item.slice(1, -1);
      return item;
    });
  }
  // Integer
  if (/^-?\d+$/.test(t)) return Number(t);
  // Boolean / bare (shouldn't appear but handle gracefully)
  return t;
}

export function parseToml(src: string): WorkspaceConfig {
  const cfg: WorkspaceConfig = {};
  let section: string | null = null;

  for (const rawLine of src.split("\n")) {
    // Strip inline comments only outside of string values
    // (simple heuristic: only strip if '#' appears after whitespace)
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Section header: [env] or [processes.name]
    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      section = secMatch[1].trim();
      if (section === "env") {
        cfg.env ??= {};
      } else if (section.startsWith("processes.")) {
        const name = section.slice("processes.".length).replace(/^["']|["']$/g, "");
        cfg.processes ??= {};
        cfg.processes[name] ??= { run: "", port: 0 };
      }
      continue;
    }

    // Key = value (split on first '=' only — values may contain '=')
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const rawKey = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();
    const key = rawKey.replace(/^["']|["']$/g, "");
    const val = parseTomlValue(rawVal);

    if (section === null) {
      if      (key === "run")        cfg.run        = val as string;
      else if (key === "language")   cfg.language   = val as string;
      else if (key === "entrypoint") cfg.entrypoint = val as string;
      else if (key === "port")       cfg.port       = Number(val);
      else if (key === "modules" && Array.isArray(val)) cfg.modules = val as string[];
    } else if (section === "env") {
      cfg.env![key] = val as string;
    } else if (section.startsWith("processes.")) {
      const name = section.slice("processes.".length).replace(/^["']|["']$/g, "");
      if (key === "run")  cfg.processes![name].run  = val as string;
      if (key === "port") cfg.processes![name].port = Number(val);
    }
  }
  return cfg;
}

// ── File helpers ──────────────────────────────────────────────────────────

export function configPath(workspaceDir: string): string {
  return path.join(workspaceDir, CONFIG_FILENAME);
}
export function legacyConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, LEGACY_CONFIG_FILENAME);
}

/**
 * Resolve the active config path: prefer the new `.premdev`, but fall
 * back to the legacy `.premdev.json` so workspaces created before the
 * rename keep working without manual migration.
 */
export function resolveConfigPath(workspaceDir: string): string | null {
  const p = configPath(workspaceDir);
  if (fs.existsSync(p)) return p;
  const legacy = legacyConfigPath(workspaceDir);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/**
 * Read a workspace config, auto-detecting JSON (legacy) vs TOML (new).
 */
export function readWorkspaceConfig(workspaceDir: string): WorkspaceConfig | null {
  try {
    const p = resolveConfigPath(workspaceDir);
    if (!p) return null;
    const raw = fs.readFileSync(p, "utf8");
    // JSON detection: content starts with '{' (after stripping whitespace)
    if (raw.trim().startsWith("{")) {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed as WorkspaceConfig;
    }
    return parseToml(raw);
  } catch {
    return null;
  }
}

// Default template for brand-new workspaces — TOML format.
export const DEFAULT_CONFIG_TEMPLATE = `run  = ""\n\n[env]\n`;

export type InitialConfigInput = {
  run?: string;
  language?: string;
  entrypoint?: string;
  modules?: string[];
  env?: Record<string, string>;
};

/**
 * Build a Replit-style initial `.premdev` config (TOML) populated from
 * a template.  Including `language`, `entrypoint`, and `modules` makes it
 * cheap for the AI (and the user) to understand the project at a glance.
 */
export function buildInitialConfig(input: InitialConfigInput): string {
  return serializeToml({
    language:   input.language,
    modules:    input.modules,
    entrypoint: input.entrypoint,
    run:        input.run ?? "",
    env:        input.env ?? {},
  });
}

export function ensureWorkspaceConfig(workspaceDir: string, initial?: InitialConfigInput): string {
  const existing = resolveConfigPath(workspaceDir);
  if (existing) return existing;
  const p = configPath(workspaceDir);
  const body = initial ? buildInitialConfig(initial) : DEFAULT_CONFIG_TEMPLATE;
  fs.writeFileSync(p, body, "utf8");
  return p;
}

/**
 * Safely merge a partial patch into the workspace config.
 *
 * - `run`       — replaces the run command
 * - `env`       — shallow-merged; pass `{ KEY: null }` to delete a key
 * - `port`      — replaces/removes the forced-port field
 * - `processes` — replaces/removes the entire processes map
 *
 * Always writes TOML (migrates existing JSON workspaces on first patch).
 * Returns the merged config that was written.
 */
export function patchWorkspaceConfig(
  workspaceDir: string,
  patch: {
    run?:       string;
    env?:       Record<string, string | null>;
    port?:      number | null;
    processes?: Record<string, ProcessConfig> | null;
  },
): WorkspaceConfig {
  const cur  = readWorkspaceConfig(workspaceDir) ?? {};
  const next: WorkspaceConfig = { ...cur };

  if (typeof patch.run === "string" && patch.run.trim()) {
    next.run = patch.run.trim();
  }
  if (patch.env && typeof patch.env === "object") {
    const merged: Record<string, string> = { ...(cur.env ?? {}) };
    for (const [k, v] of Object.entries(patch.env)) {
      if (v === null) delete merged[k];
      else if (typeof v === "string") merged[k] = v;
    }
    next.env = merged;
  }
  if (patch.port !== undefined) {
    if (patch.port === null) delete next.port;
    else next.port = patch.port;
  }
  if (patch.processes !== undefined) {
    if (patch.processes === null) delete next.processes;
    else next.processes = patch.processes;
  }

  // Always write TOML — migrates legacy JSON workspaces on first patch.
  fs.writeFileSync(configPath(workspaceDir), serializeToml(next), "utf8");

  // Remove legacy .premdev.json once migrated.
  try {
    const legacy = legacyConfigPath(workspaceDir);
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch {}

  return next;
}
