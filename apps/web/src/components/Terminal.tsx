import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

type SearchState = {
  query: string;
  caseS: boolean;
  regex: boolean;
  matches: { line: number; col: number; len: number }[];
  cursor: number;
};

function buildMatches(
  term: Terminal,
  query: string,
  caseS: boolean,
  regex: boolean,
): SearchState["matches"] {
  if (!query) return [];
  const buf = term.buffer.active;
  const results: SearchState["matches"] = [];
  let re: RegExp | null = null;
  if (regex) {
    try { re = new RegExp(query, caseS ? "g" : "gi"); } catch { return []; }
  }
  for (let i = 0; i < buf.length; i++) {
    const lineObj = buf.getLine(i);
    if (!lineObj) continue;
    const text = lineObj.translateToString();
    if (re) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        results.push({ line: i, col: m.index, len: m[0].length });
        if (!re.global) break;
      }
    } else {
      const haystack = caseS ? text : text.toLowerCase();
      const needle   = caseS ? query : query.toLowerCase();
      let idx = haystack.indexOf(needle);
      while (idx !== -1) {
        results.push({ line: i, col: idx, len: needle.length });
        idx = haystack.indexOf(needle, idx + 1);
      }
    }
  }
  return results;
}

function applyMatch(term: Terminal, m: { line: number; col: number; len: number }) {
  term.scrollToLine(m.line);
  term.select(m.col, m.line, m.len);
}

export function TerminalPane({ workspaceId }: { workspaceId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeWsRef = useRef<WebSocket | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [matchIdx, setMatchIdx] = useState(-1);
  const matchesRef = useRef<SearchState["matches"]>([]);

  function openSearch() {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }

  function closeSearch() {
    setSearchOpen(false);
    termRef.current?.focus();
  }

  function clearTerminal() {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.focus();
  }

  useEffect(() => {
    if (!ref.current) return;

    const term = new Terminal({
      fontFamily: "JetBrains Mono, Fira Code, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: "#0a0a0f",
        foreground: "#e6e6f0",
        cursor: "#7c5cff",
        selectionBackground: "#7c5cff44",
        black: "#16161f",
        brightBlack: "#606070",
        red: "#ef4444",
        brightRed: "#ff6b6b",
        green: "#22c55e",
        brightGreen: "#4ade80",
        yellow: "#f59e0b",
        brightYellow: "#fbbf24",
        blue: "#7c5cff",
        brightBlue: "#9b80ff",
        magenta: "#d946ef",
        brightMagenta: "#e879f9",
        cyan: "#06b6d4",
        brightCyan: "#22d3ee",
        white: "#e6e6f0",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(ref.current);
    fit.fit();
    termRef.current = term;

    // Ctrl+L → clear terminal (intercept sebelum dikirim ke shell)
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.key === "l" && e.type === "keydown") {
        term.clear();
        return false;
      }
      return true;
    });

    let attempt = 0;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let activeWs: WebSocket | null = null;
    let hasEverConnected = false;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${window.location.host}/ws/terminal/${workspaceId}?cols=${term.cols}&rows=${term.rows}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      activeWsRef.current = ws;
      activeWs = ws;

      ws.onopen = () => {
        const wasReconnect = hasEverConnected;
        hasEverConnected = true;
        attempt = 0;
        term.writeln(wasReconnect
          ? "\x1b[2;32m[Reconnected]\x1b[0m"
          : "\x1b[2;90m[Connected]\x1b[0m");
        try {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        } catch {}
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          term.write(ev.data);
        } else {
          term.write(new Uint8Array(ev.data) as any);
        }
      };
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        if (cancelled) return;
        if (ev.code === 1008) {
          term.writeln(`\r\n\x1b[31m[Disconnected: ${ev.reason || "unauthorized"}]\x1b[0m`);
          return;
        }
        attempt += 1;
        if (attempt > 8) {
          term.writeln("\r\n\x1b[31m[Connection lost — tekan Enter atau refresh untuk coba lagi]\x1b[0m");
          return;
        }
        const delay = Math.min(15_000, 500 * Math.pow(1.7, attempt - 1));
        term.writeln(`\r\n\x1b[2;90m[Terputus — mencoba lagi dalam ${(delay / 1000).toFixed(1)}s…]\x1b[0m`);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    const dispDisposable = term.onData((data) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: "input", data }));
      } else if (data === "\r" && attempt > 8) {
        attempt = 0;
        connect();
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          activeWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });
    ro.observe(ref.current);

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ro.disconnect();
      dispDisposable.dispose();
      try { activeWs?.close(); } catch {}
      term.dispose();
    };
  }, [workspaceId]);

  // Ctrl+F — buka/tutup search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const inTerminal = !!(e.target as HTMLElement)?.closest?.(".terminal-wrapper");
      if ((e.ctrlKey || e.metaKey) && e.key === "f" && inTerminal) {
        e.preventDefault();
        if (!searchOpen) openSearch(); else closeSearch();
      }
      if (e.key === "Escape" && searchOpen) closeSearch();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  function runSearch(q: string, cas: boolean, rx: boolean, direction: "next" | "prev" = "next") {
    const term = termRef.current;
    if (!term || !q) { matchesRef.current = []; setMatchCount(0); setMatchIdx(-1); return; }
    const matches = buildMatches(term, q, cas, rx);
    matchesRef.current = matches;
    setMatchCount(matches.length);
    if (matches.length === 0) { setMatchIdx(-1); return; }
    let next: number;
    if (direction === "next") {
      next = ((matchIdx < 0 ? -1 : matchIdx) + 1) % matches.length;
    } else {
      next = matchIdx <= 0 ? matches.length - 1 : matchIdx - 1;
    }
    setMatchIdx(next);
    applyMatch(term, matches[next]);
  }

  return (
    <div className="terminal-wrapper flex h-full w-full flex-col bg-[#0a0a0f]">

      {/* ── Toolbar atas (seperti Replit shell) ── */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] bg-[#0d0d14] px-2 py-1">
        {/* Label */}
        <div className="flex items-center gap-1.5 mr-auto">
          <span className="text-[10px] font-semibold text-[#7c5cff] uppercase tracking-widest select-none">
            Shell
          </span>
          <span className="text-[10px] text-white/20 select-none">—</span>
          <span className="text-[10px] text-white/30 font-mono select-none">/workspace</span>
        </div>

        {/* Tombol Search */}
        <button
          title="Cari (Ctrl+F)"
          onClick={() => { if (!searchOpen) openSearch(); else closeSearch(); }}
          className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
            searchOpen
              ? "bg-[#7c5cff]/20 text-[#7c5cff]"
              : "text-white/40 hover:text-white/70 hover:bg-white/5"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="6.5" cy="6.5" r="4.5"/>
            <line x1="10.5" y1="10.5" x2="14" y2="14"/>
          </svg>
          <span>Cari</span>
        </button>

        {/* Tombol Clear */}
        <button
          title="Clear terminal (Ctrl+L)"
          onClick={clearTerminal}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M2 4h12M5 4V2h6v2M6 7v6M10 7v6M3 4l1 10h8l1-10"/>
          </svg>
          <span>Clear</span>
        </button>
      </div>

      {/* ── Search bar (muncul saat dibuka) ── */}
      {searchOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] bg-[#0d0d14] px-2 py-1.5">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#7c5cff" strokeWidth="1.8" className="shrink-0">
            <circle cx="6.5" cy="6.5" r="4.5"/>
            <line x1="10.5" y1="10.5" x2="14" y2="14"/>
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            className="flex-1 rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-white outline-none focus:border-[#7c5cff]/50 placeholder:text-white/20"
            placeholder="Cari di terminal…"
            value={searchQ}
            onChange={(e) => {
              const q = e.target.value;
              setSearchQ(q);
              setMatchIdx(-1);
              runSearch(q, searchCase, searchRegex, "next");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(searchQ, searchCase, searchRegex, e.shiftKey ? "prev" : "next");
              if (e.key === "Escape") closeSearch();
            }}
          />
          {matchCount > 0 && (
            <span className="shrink-0 text-[10px] text-white/40 tabular-nums">
              {matchIdx + 1}/{matchCount}
            </span>
          )}
          {searchQ && matchCount === 0 && (
            <span className="shrink-0 text-[10px] text-red-400">Tidak ditemukan</span>
          )}
          <button
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${searchCase ? "bg-[#7c5cff]/20 text-[#7c5cff]" : "text-white/30 hover:text-white/60"}`}
            title="Case-sensitive"
            onClick={() => { const v = !searchCase; setSearchCase(v); runSearch(searchQ, v, searchRegex); }}
          >Aa</button>
          <button
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${searchRegex ? "bg-[#7c5cff]/20 text-[#7c5cff]" : "text-white/30 hover:text-white/60"}`}
            title="Regex"
            onClick={() => { const v = !searchRegex; setSearchRegex(v); runSearch(searchQ, searchCase, v); }}
          >.*</button>
          <button
            className="rounded px-1.5 py-0.5 text-[10px] text-white/30 hover:text-white/60 transition"
            title="Sebelumnya (Shift+Enter)"
            onClick={() => runSearch(searchQ, searchCase, searchRegex, "prev")}
          >↑</button>
          <button
            className="rounded px-1.5 py-0.5 text-[10px] text-white/30 hover:text-white/60 transition"
            title="Berikutnya (Enter)"
            onClick={() => runSearch(searchQ, searchCase, searchRegex, "next")}
          >↓</button>
          <button
            className="rounded px-1.5 py-0.5 text-[10px] text-white/30 hover:text-white/60 transition"
            title="Tutup (Esc)"
            onClick={closeSearch}
          >✕</button>
        </div>
      )}

      {/* ── Terminal canvas ── */}
      <div ref={ref} className="flex-1 w-full" />
    </div>
  );
}
