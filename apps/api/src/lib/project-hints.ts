import fs from "node:fs";
import path from "node:path";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__",
  "target", "dist", "build", ".next", ".replit-cache", ".idea",
]);

export type ListingEntry = string;

/**
 * Walk a workspace directory (depth-limited, entry-capped) and return the
 * relative paths in dirs-first sorted order. Skips dotfiles and well-known
 * heavy build/dependency dirs. Never follows symlinks.
 */
export function listWorkspace(root: string, maxEntries = 80, maxDepth = 4): ListingEntry[] {
  const lines: string[] = [];
  if (!fs.existsSync(root)) return lines;
  function walk(dir: string, rel: string, depth: number) {
    if (lines.length >= maxEntries || depth > maxDepth) return;
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
        if (lines.length >= maxEntries) return;
        if (e.isSymbolicLink()) return;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          lines.push(`${childRel}/`);
          walk(path.join(dir, e.name), childRel, depth + 1);
        } else if (e.isFile()) {
          lines.push(childRel);
        }
      });
  }
  walk(root, "", 0);
  return lines;
}

/**
 * Scan workspace source files to detect a hard-coded port number.
 * Called when no explicit port is set in .premdev so the proxy can be aimed
 * at the port the user's app actually binds to instead of the template default.
 *
 * Strategy:
 *   1. If runCommand mentions an entry file (python3 app.py, node server.js)
 *      read that file first.
 *   2. Fall back to common entry-file names.
 *   3. For each file, search for port-binding patterns specific to each lang.
 *   Returns the first port found in range 1025–65535, or null.
 */
export function detectHardcodedPort(root: string, runCommand?: string): number | null {
  // Entry file hinted by run command (any language)
  const hintedEntries: string[] = [];
  if (runCommand) {
    // python3 web.py / ruby app.rb / node server.js / go run main.go / etc.
    const m = runCommand.match(/(?:python3?|ruby|node|bun|tsx?|ts-node|deno\s+run)\s+([\w./\\-]+\.\w+)/);
    if (m) hintedEntries.push(m[1]);
    // cargo run / go run . → scan main.rs / main.go
    if (/cargo\s+run/.test(runCommand)) hintedEntries.push("src/main.rs", "main.rs");
    if (/go\s+run/.test(runCommand)) hintedEntries.push("main.go");
    // java -jar / mvn spring-boot:run → scan application.properties
    if (/java|mvn|gradle/.test(runCommand)) {
      hintedEntries.push(
        "src/main/resources/application.properties",
        "src/main/resources/application.yml",
      );
    }
  }

  // Common entry-point names per language (priority order within each lang)
  const COMMON: string[] = [
    // Python
    "app.py","main.py","server.py","run.py","web.py","wsgi.py","bot.py","api.py","manage.py",
    // JavaScript / TypeScript
    "index.js","server.js","app.js","main.js","index.ts","server.ts","app.ts","main.ts",
    // Ruby
    "app.rb","config.ru","server.rb","main.rb",
    // Go
    "main.go",
    // Rust
    "src/main.rs","main.rs",
    // Java / Spring Boot (properties files)
    "src/main/resources/application.properties",
    "src/main/resources/application.yml",
    "application.properties","application.yml",
    // PHP (PHP uses $PORT by default via our run-command so rarely needs this,
    // but cover explicit listen patterns just in case)
    "index.php","server.php",
  ];

  const candidates: string[] = [];
  for (const f of [...hintedEntries, ...COMMON]) {
    if (!candidates.includes(f)) candidates.push(f);
  }

  // Last-resort: scan every source file at root level (catches any name)
  const SOURCE_EXT = /\.(py|js|ts|rb|go|rs|java|php|cs|kt|scala|ex|exs|cr|nim|zig)$/;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      if (!SOURCE_EXT.test(e.name)) continue;
      if (!candidates.includes(e.name)) candidates.push(e.name);
    }
  } catch { /* ignore */ }

  function extractPort(src: string, filename: string): number | null {
    const ext = filename.split(".").pop() ?? "";

    // ── Language-specific patterns ───────────────────────────────────────────

    // Python: .run(port=5000) multiline, port=5000 module-level, uvicorn port=
    if (ext === "py") {
      for (const re of [
        /\.run\s*\([\s\S]*?\bport\s*=\s*(\d{2,5})/,      // flask/uvicorn/fastapi .run()
        /uvicorn\.run\s*\([\s\S]*?\bport\s*=\s*(\d{2,5})/,
        /^PORT\s*=\s*(\d{2,5})\s*$/m,
        /^port\s*=\s*(\d{2,5})\s*$/m,
        /\bint\s*\(\s*os\.getenv\s*\([^,)]+,\s*['""]?(\d{2,5})['""]?\s*\)/,  // int(os.getenv("PORT", 5000))
      ]) {
        const m = src.match(re);
        if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
      }
    }

    // JavaScript / TypeScript: .listen(3000) / port: 3000 / PORT = 3000
    if (ext === "js" || ext === "ts" || ext === "mjs" || ext === "cjs") {
      for (const re of [
        /\.listen\s*\(\s*(\d{2,5})/,                       // express/http .listen(3000)
        /\bport\s*[:=]\s*(\d{2,5})/i,                      // port: 3000 / PORT = 3000
        /\bPORT\s*\|\|\s*(\d{2,5})/,                       // process.env.PORT || 3000
      ]) {
        const m = src.match(re);
        if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
      }
    }

    // Ruby: set :port, 4567 / Port => 3000 / listen '0.0.0.0', 3000
    if (ext === "rb" || filename === "config.ru") {
      for (const re of [
        /set\s+:port\s*,\s*(\d{2,5})/,                     // Sinatra: set :port, 4567
        /[Pp]ort\s*[=>:]+\s*(\d{2,5})/,                    // Port => 3000
        /listen\s+['"]?[\d.]+['"]?\s*,\s*(\d{2,5})/,       // listen '0.0.0.0', 3000
        /\bport\s*=\s*(\d{2,5})/,
      ]) {
        const m = src.match(re);
        if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
      }
    }

    // Go: ListenAndServe(":8080") / Addr: ":8080"
    if (ext === "go") {
      for (const re of [
        /ListenAndServe\s*\(\s*["']:(\d{2,5})["']/,
        /Addr\s*:\s*["'][^"']*:(\d{2,5})["']/,
        /["']:(\d{2,5})["']/,
      ]) {
        const m = src.match(re);
        if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
      }
    }

    // Rust: "0.0.0.0:8080" / bind("127.0.0.1:8080") / port: 8000
    if (ext === "rs") {
      for (const re of [
        /bind\s*\(\s*["'][^"']*:(\d{2,5})["']/,            // .bind("0.0.0.0:8080")
        /["'][^"']*:(\d{2,5})["']/,                         // "127.0.0.1:8080"
        /\bport\s*[:=]\s*(\d{2,5})/,
      ]) {
        const m = src.match(re);
        if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
      }
    }

    // Java/Spring Boot: application.properties / application.yml
    if (filename.endsWith("application.properties")) {
      const m = src.match(/^server\.port\s*=\s*(\d{2,5})/m);
      if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
    }
    if (filename.endsWith("application.yml") || filename.endsWith("application.yaml")) {
      const m = src.match(/port\s*:\s*(\d{2,5})/);
      if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
    }

    // PHP: $app->run([], $port = 5000) / define('PORT', 5000)
    if (ext === "php") {
      for (const re of [
        /\$port\s*=\s*(\d{2,5})/i,
        /define\s*\(\s*['"]PORT['"]\s*,\s*(\d{2,5})/i,
        /port\s*[=>:]+\s*(\d{2,5})/i,
      ]) {
        const m = src.match(re);
        if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
      }
    }

    // Generic fallback: any ":NNNN" or port=NNNN pattern (catches most remaining langs)
    for (const re of [
      /["']:(\d{2,5})["']/,                                // ":8080" in any string
      /\bport\s*[=:]\s*(\d{2,5})/i,                       // port=NNNN / port: NNNN
      /\bPORT\s*[=:]\s*(\d{2,5})/,                        // PORT=NNNN
    ]) {
      const m = src.match(re);
      if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) return p; }
    }

    return null;
  }

  for (const rel of candidates) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    let src: string;
    try { src = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const p = extractPort(src, rel);
    if (p !== null) return p;
  }

  return null;
}

/**
 * Patch a run command so the server binds to 0.0.0.0 instead of 127.0.0.1.
 *
 * Many frameworks default to loopback when no host is specified. The proxy
 * connects from a different container/process so it MUST reach 0.0.0.0.
 * This function handles CLI-based tools where we can just add a flag.
 * Python scripts (app.run()) are handled separately via a PYTHONPATH
 * sitecustomize monkeypatch injected by runtime.ts.
 */
export function fixRunCommandHost(cmd: string): string {
  if (!cmd) return cmd;

  // uvicorn main:app [--port X] → ensure --host 0.0.0.0
  if (/\buvicorn\b/.test(cmd) && !/--host\b/.test(cmd)) {
    return cmd.replace(/(\buvicorn\b)/, "$1 --host 0.0.0.0");
  }

  // flask run [--port X] → ensure --host 0.0.0.0
  if (/\bflask\s+run\b/.test(cmd) && !/--host\b/.test(cmd)) {
    return cmd.replace(/(\bflask\s+run\b)/, "$1 --host 0.0.0.0");
  }

  // gunicorn -b 127.0.0.1:PORT → replace with 0.0.0.0
  if (/\bgunicorn\b/.test(cmd)) {
    return cmd.replace(/-b\s+(127\.0\.0\.1|localhost):/, "-b 0.0.0.0:");
  }

  // rackup / puma → add --host / -o flag
  if (/\brackup\b/.test(cmd) && !/-o\b/.test(cmd)) {
    return cmd.replace(/(\brackup\b)/, "$1 -o 0.0.0.0");
  }
  if (/\bpuma\b/.test(cmd) && !/--bind\b/.test(cmd)) {
    return cmd.replace(/(\bpuma\b)/, "$1 --bind tcp://0.0.0.0");
  }

  // sinatra (ruby script.rb) — Ruby's Sinatra reads RACK_ENV but not HOST;
  // we can't easily inject without source changes, so the sitecustomize-style
  // Rack monkeypatch in the bash wrapper covers this.

  return cmd;
}

/**
 * Heuristically pick a run command for an unknown project. Returns null when
 * we can't confidently guess. The caller should pass the result through to
 * a shell that has $PORT in env (startLocal/startContainer set PORT).
 */
export function detectRunCommand(root: string): string | null {
  const lines = listWorkspace(root);
  const has = (name: string) => lines.some((l) => l === name);
  const hasAny = (re: RegExp) => lines.some((l) => re.test(l));

  // Node.js — read package.json scripts to be smart.
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.dev) return "npm install --silent && npm run dev";
      if (scripts.start) return "npm install --silent && npm start";
      if (pkg.main) return `npm install --silent && node ${pkg.main}`;
    } catch {}
    return "npm install --silent && node index.js";
  }

  // PHP — built-in dev server. Pick the best document root so `/` actually
  // resolves to an index file. Order: project root → common public dirs →
  // first subdir that has an index.php. We deliberately do NOT auto-pass
  // router.php because many projects ship a file named router.php that isn't
  // actually a PHP-S compatible front controller (it would 404 every request).
  // Users who need a router can set it explicitly in .premdev.
  if (hasAny(/\.php$/)) {
    const docRoot = pickWebDocRoot(root, "index.php") ?? ".";
    return `php -S 0.0.0.0:$PORT -t ${docRoot}`;
  }

  // Python — common entry files.
  if (has("requirements.txt") || hasAny(/\.py$/)) {
    let entry: string | null = null;
    for (const cand of ["app.py", "main.py", "server.py", "run.py", "manage.py"]) {
      if (has(cand)) { entry = cand; break; }
    }
    if (!entry) return null;
    const install = has("requirements.txt") ? "pip install -q -r requirements.txt && " : "";
    return `${install}python3 ${entry}`;
  }

  if (has("Gemfile")) {
    return "bundle install --quiet && bundle exec rackup -o 0.0.0.0 -p $PORT";
  }
  if (has("go.mod")) return "go run .";
  if (has("Cargo.toml")) return "cargo run";

  // Static site — only when it's clearly the only thing. Pick the doc root
  // that actually contains index.html (root, public/, web/, dist/, etc.).
  if (hasAny(/index\.html?$/)) {
    const docRoot = pickWebDocRoot(root, "index.html") ?? ".";
    return `python3 -m http.server $PORT --bind 0.0.0.0 --directory ${docRoot}`;
  }

  return null;
}

/**
 * Pick the best document root (relative to `root`) that contains `indexFile`.
 * Order: project root → common conventional public dirs → first immediate
 * subdirectory that has the index file. Symlink-safe: rejects symlinked
 * directories and symlinked index files so the dev server can't be tricked
 * into serving files outside the workspace tree. Returns null when none.
 */
function pickWebDocRoot(root: string, indexFile: string): string | null {
  const isRealDir = (abs: string) => {
    try {
      return fs.lstatSync(abs).isDirectory();
    } catch { return false; }
  };
  const indexIsRealFile = (dirAbs: string) => {
    try {
      return fs.lstatSync(path.join(dirAbs, indexFile)).isFile();
    } catch { return false; }
  };
  if (indexIsRealFile(root)) return ".";
  for (const cand of ["public", "web", "htdocs", "www", "dist", "build"]) {
    const abs = path.join(root, cand);
    if (isRealDir(abs) && indexIsRealFile(abs)) return cand;
  }
  // Fallback: first immediate REAL (non-symlinked) subdirectory containing
  // a real (non-symlinked) index file.
  try {
    const items = fs.readdirSync(root, { withFileTypes: true });
    for (const e of items) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const abs = path.join(root, e.name);
      if (indexIsRealFile(abs)) return e.name;
    }
  } catch {}
  return null;
}
