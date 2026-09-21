import React, { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
} from "react-resizable-panels";
import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  ChevronLeft,
  Play,
  Square,
  Save,
  RefreshCw,
  Sparkles,
  Folder,
  File as FileIcon,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Plus,
  Trash2,
  Pencil,
  Download,
  History,
  RotateCw,
  Terminal,
  Eye,
  EyeOff,
  Settings,
  Lock,
  Globe,
  Check as CheckIcon,
  AlertTriangle,
  Loader2,
  X,
  Wand2,
  GitBranch,
  Database,
  Table2,
  Bot,
  Layers,
  Copy,
  Link,
  Search,
  Monitor,
  Smartphone,
  Tablet,
  Package,
  SlidersHorizontal,
  Sun,
  Moon,
  Command,
  Clock,
  Zap,
  LayoutGrid,
  Share2,
  Activity,
  FileSearch,
  FolderPlus,
  WrapText,
  Columns2,
  Type,
  Replace,
  Keyboard,
  Server,
  FolderInput,
} from "lucide-react";
import { API } from "@/lib/api";
import { TerminalPane } from "@/components/Terminal";
import { AIChat } from "@/components/AIChat";
import { SecretsPanel } from "@/components/SecretsPanel";
import { CronJobsPanel } from "@/components/CronJobsPanel";
import { useConfirm } from "@/lib/useConfirm";

type Workspace = {
  id: string;
  name: string;
  template: string;
  status: "stopped" | "starting" | "running" | "error";
  previewPort?: number;
  previewUrl?: string;
  // Auto-generated <project>-<user>.<domain> URL — always present so the
  // user can compare the fallback against their custom subdomain.
  defaultUrl?: string;
  customSubdomain?: string | null;
  customDomain?: string | null;
  runCommand?: string | null;
};

type FileNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
};

type Checkpoint = {
  id: string;
  workspace_id: string;
  message: string;
  size_bytes: number;
  created_at: number;
};

const AUTO_SAVE_DELAY_MS = 1500;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff"]);
function isImageFile(p: string) {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

const BINARY_EXTS = new Set([
  ".7z", ".avi", ".bin", ".class", ".dll", ".dmg", ".doc", ".docx", ".eot",
  ".exe", ".flac", ".jar", ".mov", ".mp3", ".mp4", ".o", ".otf", ".pdb",
  ".so", ".tar", ".ttf", ".wav", ".woff", ".woff2", ".xls", ".xlsx", ".zip",
]);
function isPdfFile(p: string) {
  return p.toLowerCase().endsWith(".pdf");
}
function isBinaryFile(p: string) {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTS.has(ext);
}

type WorkspaceTool = "console" | "terminal" | "preview" | "database" | "cron" | "secrets" | "git";
type WorkspaceSurface = "file" | WorkspaceTool;

function hashState(): { file: string | null; tool: WorkspaceTool | null } {
  if (typeof window === "undefined") return { file: null, tool: null };
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return { file: null, tool: null };
  if (!raw.includes("=")) {
    try { return { file: decodeURIComponent(raw), tool: null }; } catch { return { file: raw, tool: null }; }
  }
  const params = new URLSearchParams(raw);
  const file = params.get("file");
  const tool = params.get("tool") as WorkspaceTool | null;
  return {
    file: file ? file.replace(/^\/+/, "") : null,
    tool: tool && ["console", "terminal", "preview", "database", "cron", "secrets", "git"].includes(tool) ? tool : null,
  };
}

function setWorkspaceHash(kind: "file" | "tool", value: string) {
  if (typeof window === "undefined") return;
  const next = `#${kind}=${encodeURIComponent(value)}`;
  if (window.location.hash !== next) window.history.pushState({}, "", next);
}

export default function EditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const initialHash = hashState();
  const [compactLayout, setCompactLayout] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );
  const [activePath, setActivePath] = useState<string | null>(() => {
    if (initialHash.file) return initialHash.file;
    try { return localStorage.getItem(`premdev.activePath.${id}`) || null; } catch { return null; }
  });
  const [content, setContent] = useState<string>("");
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // The reference workspace keeps AI available beside the main editor. Users
  // can collapse it from the top tab or the AI toolbar control.
  const [showAI, setShowAI] = useState(true);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [secretsOpenDbTemplate, setSecretsOpenDbTemplate] = useState(false);
  const [openTabs, setOpenTabs] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(`premdev.tabs.${id}`);
      if (saved) { const t = JSON.parse(saved); if (Array.isArray(t)) return t; }
    } catch {}
    return [];
  });
  const [showSubdomain, setShowSubdomain] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [showCronJobs, setShowCronJobs] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showWorkspaceSearch, setShowWorkspaceSearch] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [editorTheme, setEditorTheme] = useState<"vs-dark" | "vs">(() => {
    try { return (localStorage.getItem("premdev.theme") as any) ?? "vs-dark"; } catch { return "vs-dark"; }
  });
  const [minimap, setMinimap] = useState<boolean>(() => {
    try { return localStorage.getItem("premdev.minimap") === "1"; } catch { return false; }
  });
  const [fontSize, setFontSize] = useState<number>(() => {
    try { return Number(localStorage.getItem("premdev.fontSize")) || 13; } catch { return 13; }
  });
  const [wordWrap, setWordWrap] = useState<"off" | "on">(() => {
    try { return (localStorage.getItem("premdev.wordWrap") as any) ?? "off"; } catch { return "off"; }
  });
  const [splitPath, setSplitPath] = useState<string | null>(null);
  const [splitContent, setSplitContent] = useState<string>("");
  const [wsRenaming, setWsRenaming] = useState(false);
  const [wsRenameVal, setWsRenameVal] = useState("");
  const [recentFiles, setRecentFiles] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem(`premdev.recent.${id}`);
      if (s) { const a = JSON.parse(s); if (Array.isArray(a)) return a; }
    } catch {}
    return [];
  });
  const [showReplace, setShowReplace] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [diffOriginal, setDiffOriginal] = useState<string>("");
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null);
  const [vimMode, setVimMode] = useState<boolean>(() => {
    try { return localStorage.getItem("premdev.vimMode") === "1"; } catch { return false; }
  });
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<"console" | "terminal" | "preview" | "database">("console");
  const [activeSurface, setActiveSurface] = useState<WorkspaceSurface>("file");
  // Start on the unified workspace library so the new Tools surface is
  // visible immediately; users can switch to Files without losing the editor.
  const [sidePanelTab, setSidePanelTab] = useState<"files" | "library">("library");
  const [splitTabs, setSplitTabs] = useState<string[]>([]);
  const [splitDirection, setSplitDirection] = useState<"horizontal" | "vertical">("horizontal");
  // Monaco editor instance — captured in onMount so we can read the active
  // selection from anywhere (Ask AI, quick actions, etc.).
  const editorRef = useRef<any>(null);
  // Mirror activePath into a ref so Monaco's onMount closure (captured once
  // per file open) always reads the latest value when an action runs.
  const activePathRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({ path: null as string | null, content: "" });
  // Monotonic save generation so stale completions cannot clear newer dirty state.
  const saveGenRef = useRef(0);
  const lastEditGenRef = useRef(0);
  const openRequestRef = useRef(0);
  const splitRequestRef = useRef(0);

  // The desktop editor has three side-by-side panes. On a phone those panes
  // must stack vertically; forcing the desktop horizontal layout made every
  // panel too narrow to use. Listen for rotation/resizing as well.
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setCompactLayout(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const { data: ws, error: wsError, refetch: wsRefetch } = useQuery({
    queryKey: ["workspace", id],
    queryFn: () => API.get<{ workspace: Workspace }>(`/workspaces/${id}`),
    refetchInterval: 3000,
    retry: 3,
  });

  // When tab comes back from background (Chrome pauses hidden tabs), force
  // a refetch so the workspace status / UI is always up to date.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") wsRefetch();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [wsRefetch]);

  const startStop = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") =>
      API.post(`/workspaces/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspace", id] }),
  });

  async function saveNow(targetPath: string, body: string) {
    const myGen = ++saveGenRef.current;
    const editGenAtStart = lastEditGenRef.current;
    setSavingState("saving");
    try {
      await API.put(`/workspaces/${id}/files`, { path: targetPath, content: body });
      // Only clear dirty if no newer edit happened during this save AND
      // no newer save has been kicked off (avoids stale ack from concurrent saves).
      if (myGen === saveGenRef.current && editGenAtStart === lastEditGenRef.current) {
        setSavingState("saved");
        setDirty(false);
      } else {
        // Newer changes pending; stay dirty so the next debounce/manual save runs.
        setSavingState("idle");
      }
    } catch {
      if (myGen === saveGenRef.current) setSavingState("error");
    }
  }

  // ── File tab helpers ──────────────────────────────────────────────────────
  async function openFile(p: string, options: { syncUrl?: boolean } = {}) {
    const syncUrl = options.syncUrl !== false;
    const normalizedPath = p.replace(/^\/+/, "");
    if (!normalizedPath) return;
    const requestId = ++openRequestRef.current;
    setActiveSurface("file");
    if (dirty && activePath) {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      await saveNow(activePath, content);
    }
    setNewTabOpen(false);
    setFileError(null);
    setLoadingPath(normalizedPath);
    setOpenTabs((prev) => (prev.includes(normalizedPath) ? prev : [...prev, normalizedPath]));
    if (syncUrl) setWorkspaceHash("file", normalizedPath);
    // Track recent files (max 10, no duplicates, most recent first)
    setRecentFiles((prev) => {
      const next = [normalizedPath, ...prev.filter((r) => r !== normalizedPath)].slice(0, 10);
      try { localStorage.setItem(`premdev.recent.${id}`, JSON.stringify(next)); } catch {}
      return next;
    });
    // Preview-only and binary files do not go through Monaco.
    if (isImageFile(normalizedPath) || isPdfFile(normalizedPath) || isBinaryFile(normalizedPath)) {
      if (requestId !== openRequestRef.current) return;
      setContent(""); setDirty(false); setSavingState("idle");
      setActivePath(normalizedPath);
      setLoadingPath(null);
      return;
    }
    // Fetch the file content BEFORE updating activePath so that Monaco never
    // sees a path/value mismatch. If setActivePath ran first, @monaco-editor/react
    // would call model.setValue(oldContent) on the new file's model the moment
    // the path prop changes, recording a spurious undo entry. Then when content
    // arrived it would call setValue again — two phantom undo entries that made
    // Ctrl+Z in file B jump back to file A's content.
    try {
      const res = await API.get<{ content: string }>(`/workspaces/${id}/files?path=${encodeURIComponent(normalizedPath)}`);
      if (requestId !== openRequestRef.current) return;
      setContent(res.content);
      setDiffOriginal(res.content);
      setDirty(false);
      setSavingState("idle");
      // Only now switch the visible path — content is ready, Monaco gets the
      // correct value on the very first render for this path.
      setActivePath(normalizedPath);
      setLoadingPath(null);
    } catch (error: any) {
      if (requestId !== openRequestRef.current) return;
      setLoadingPath(null);
      setFileError(error?.message ?? "File gagal dibuka.");
    }
  }

  async function openSplit(p: string) {
    const normalizedPath = p.replace(/^\/+/, "");
    const requestId = ++splitRequestRef.current;
    setSplitTabs((prev) => (
      prev.includes(normalizedPath)
        ? prev
        : [...prev, normalizedPath].slice(-4)
    ));
    setSplitPath(normalizedPath);
    if (isImageFile(normalizedPath) || isPdfFile(normalizedPath) || isBinaryFile(normalizedPath)) {
      setSplitContent("");
      return;
    }
    try {
      const res = await API.get<{ content: string }>(`/workspaces/${id}/files?path=${encodeURIComponent(normalizedPath)}`);
      if (requestId !== splitRequestRef.current) return;
      setSplitContent(res.content);
    } catch {
      if (requestId !== splitRequestRef.current) return;
      setSplitContent("");
    }
  }

  function closeSplitTab(p: string) {
    const next = splitTabs.filter((tab) => tab !== p);
    setSplitTabs(next);
    if (splitPath !== p) return;
    const nextPath = next[next.length - 1] ?? null;
    if (!nextPath) {
      setSplitPath(null);
      setSplitContent("");
      return;
    }
    void openSplit(nextPath);
  }

  function openTool(tool: WorkspaceTool, options: { syncUrl?: boolean } = {}) {
    const syncUrl = options.syncUrl !== false;
    setNewTabOpen(false);
    if (syncUrl) setWorkspaceHash("tool", tool);
    setActiveSurface(tool);
    if (tool === "cron") {
      setShowCronJobs(true);
      return;
    }
    if (tool === "secrets") {
      setShowSecrets(true);
      return;
    }
    if (tool === "git") {
      setShowGit(true);
      return;
    }
    setBottomTab(tool);
  }

  function closeTab(p: string, e: React.MouseEvent) {
    e.stopPropagation();
    const idx = openTabs.indexOf(p);
    const next = openTabs.filter((t) => t !== p);
    setOpenTabs(next);
    if (activePath === p) {
      const nextActive = next[Math.max(0, idx - 1)] ?? next[0] ?? null;
      if (nextActive) { openFile(nextActive); }
      else {
        setActivePath(null); setContent(""); setDirty(false); setSavingState("idle");
        if (typeof window !== "undefined") window.history.pushState({}, "", window.location.pathname + window.location.search);
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Persist open tabs + active path to localStorage (fixes tabs disappearing on refresh)
  useEffect(() => {
    if (!id) return;
    try { localStorage.setItem(`premdev.tabs.${id}`, JSON.stringify(openTabs)); } catch {}
  }, [openTabs, id]);
  useEffect(() => {
    if (!id) return;
    try {
      if (activePath) localStorage.setItem(`premdev.activePath.${id}`, activePath);
      else localStorage.removeItem(`premdev.activePath.${id}`);
    } catch {}
  }, [activePath, id]);

  // On mount: restore the URL file first, then the last local file. URL state
  // wins so shared/deep links always open the requested file.
  const didRestoreRef = useRef(false);
  useEffect(() => {
    if (didRestoreRef.current) return;
    didRestoreRef.current = true;
    const initial = hashState();
    if (initial.tool) openTool(initial.tool, { syncUrl: false });
    const restorePath = initial.file ?? activePath;
    if (restorePath) void openFile(restorePath, { syncUrl: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser Back/Forward should move between opened files/tools without a
  // full page reload.
  useEffect(() => {
    function onHistoryNavigation() {
      const next = hashState();
      if (next.file && next.file !== activePath) void openFile(next.file, { syncUrl: false });
      if (next.tool) openTool(next.tool, { syncUrl: false });
    }
    window.addEventListener("popstate", onHistoryNavigation);
    window.addEventListener("hashchange", onHistoryNavigation);
    return () => {
      window.removeEventListener("popstate", onHistoryNavigation);
      window.removeEventListener("hashchange", onHistoryNavigation);
    };
  }, [activePath]);

  // Auto-save with debounce
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!dirty || !activePath) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    latestRef.current = { path: activePath, content };
    saveTimer.current = setTimeout(() => {
      saveNow(latestRef.current.path!, latestRef.current.content);
    }, AUTO_SAVE_DELAY_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [content, activePath, dirty]);

  // Manual save + command palette keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (saveTimer.current) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        if (activePath && dirty) saveNow(activePath, content);
      }
      // Ctrl+K / Ctrl+P → command palette
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "p")) {
        e.preventDefault();
        setShowCommandPalette(true);
      }
      // Ctrl+Shift+F → workspace search
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "f") {
        e.preventDefault();
        setShowWorkspaceSearch(true);
      }
      // Ctrl+Shift+H → Find & Replace
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "h") {
        e.preventDefault();
        setShowReplace(true);
      }
      // Ctrl+? → Keyboard shortcuts reference
      if ((e.ctrlKey || e.metaKey) && e.key === "?") {
        e.preventDefault();
        setShowShortcuts(true);
      }
      // Ctrl+J → toggle AI panel
      if ((e.ctrlKey || e.metaKey) && e.key === "j") {
        e.preventDefault();
        setShowAI((v) => !v);
      }
      if (e.key === "Escape") {
        setShowCommandPalette(false);
        setShowWorkspaceSearch(false);
        setShowReplace(false);
        setShowShortcuts(false);
        setShowShare(false);
        setShowActivityLog(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePath, dirty, content]);

  // Listen for AI "open:" action — AI can open any file in the editor
  useEffect(() => {
    function onOpenFile(e: Event) {
      const path = (e as CustomEvent).detail?.path;
      if (path) openFile(path);
    }
    window.addEventListener("premdev:open-file", onOpenFile);
    return () => window.removeEventListener("premdev:open-file", onOpenFile);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function renameWorkspace(newName: string) {
    if (!newName.trim() || !id) return;
    try {
      await API.put(`/workspaces/${id}`, { name: newName.trim() });
      qc.invalidateQueries({ queryKey: ["workspace", id] });
    } catch (e: any) {
      const msg = e?.message ?? "Rename failed";
      alert(msg.includes("409") || msg.includes("sudah punya") ? msg : `Gagal rename: ${msg}`);
    } finally {
      setWsRenaming(false);
    }
  }

  const w = ws?.workspace;
  const saveLabel =
    savingState === "saving" ? "Saving…"
    : savingState === "error" ? "Save failed"
    : dirty ? "Modified"
    : "Saved";

  if (wsError && !ws) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-bg text-text-muted">
        <span className="text-3xl">⚠️</span>
        <p className="text-sm font-medium text-text">Gagal memuat workspace</p>
        <p className="max-w-sm text-center text-xs">{(wsError as any)?.message ?? "Tidak dapat terhubung ke server. Pastikan VPS berjalan."}</p>
        <button
          className="btn-secondary text-xs"
          onClick={() => wsRefetch()}
        >
          <RotateCw size={13} className="mr-1 inline" /> Coba lagi
        </button>
        <button className="text-xs text-accent underline" onClick={() => nav("/")}>← Kembali ke dashboard</button>
      </div>
    );
  }

  if (!ws) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-bg text-text-muted">
        <Loader2 size={28} className="animate-spin text-accent" />
        <span className="text-sm">Memuat workspace…</span>
      </div>
    );
  }

  return (
    <div className="workspace-shell flex h-screen flex-col bg-bg">
      {w && w.status === "stopped" && (
        <div className="flex items-center justify-between gap-3 border-b border-warning/25 bg-warning/10 px-4 py-2 text-xs text-warning">
          <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-warning" /> Workspace belum berjalan. Klik <strong>Run</strong> untuk memulai container.</span>
          <button
            className="rounded-lg border border-warning/25 bg-warning/15 px-3 py-1 font-semibold transition hover:bg-warning/25"
            onClick={() => startStop.mutate("start")}
          >
            <Play size={12} className="mr-1 inline" />Run
          </button>
        </div>
      )}
      <header className="workspace-topbar relative flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-bg-border bg-bg-panel/95 px-3 py-2">
        <button className="btn-ghost shrink-0" onClick={() => nav("/")} title="Back to workspaces">
          <ChevronLeft size={16} />
        </button>
        <div className="workspace-identity flex min-w-0 shrink-0 items-center gap-2.5">
          <div className="workspace-brand-mark grid h-8 w-8 shrink-0 place-items-center rounded-xl text-accent">
            <Layers size={16} />
          </div>
          {wsRenaming ? (
            <input
              autoFocus
              className="input h-7 w-36 rounded-lg px-2 py-0.5 text-sm font-semibold"
              value={wsRenameVal}
              onChange={(e) => setWsRenameVal(e.target.value)}
              onBlur={() => renameWorkspace(wsRenameVal)}
              onKeyDown={(e) => {
                if (e.key === "Enter") renameWorkspace(wsRenameVal);
                if (e.key === "Escape") setWsRenaming(false);
              }}
            />
          ) : (
            <div className="min-w-0">
              <div
                className="cursor-pointer truncate text-sm font-semibold tracking-tight hover:text-accent"
                title="Click to rename workspace"
                onClick={() => { setWsRenameVal(w?.name ?? ""); setWsRenaming(true); }}
              >
                {w?.name ?? "…"}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
                <span>{w?.template ?? "workspace"}</span>
                <span className="text-text-subtle">•</span>
                <span>Cloud IDE</span>
              </div>
            </div>
          )}
          <span
            className={`workspace-status-pill flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
              w?.status === "running"
                ? "bg-success/10 text-success"
                : w?.status === "starting"
                ? "bg-warning/10 text-warning"
                : w?.status === "error"
                ? "bg-danger/10 text-danger"
                : "bg-bg-hover/80 text-text-muted"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${
              w?.status === "running" ? "bg-success" : w?.status === "starting" ? "animate-pulse bg-warning" : w?.status === "error" ? "bg-danger" : "bg-text-subtle"
            }`} />
            {w?.status ?? "loading"}
          </span>
        </div>
        <div className="workspace-toolbar ml-auto flex min-w-0 items-center gap-1.5">
        <span className={`hidden text-xs sm:inline ${dirty ? "text-warning" : "text-text-muted"}`}>{saveLabel}</span>
        <button
          className="btn-secondary"
          onClick={() => activePath && saveNow(activePath, content)}
          disabled={!dirty || !activePath || savingState === "saving"}
          title="Save (Ctrl+S)"
        >
          <Save size={14} />
        </button>
        <button
          className="btn-secondary"
          title="Checkpoints"
          onClick={() => setShowCheckpoints(true)}
        >
          <History size={14} />
        </button>
        <button
          className="btn-secondary"
          title="Secrets — KEY=value vars injected into your container"
          onClick={() => { setSecretsOpenDbTemplate(false); openTool("secrets"); }}
        >
          <Lock size={14} />
        </button>
        <button
          className="btn-secondary"
          title="Konek database eksternal (cPanel / hosting)"
          onClick={() => { setSecretsOpenDbTemplate(true); openTool("secrets"); }}
        >
          <Database size={14} />
        </button>
        <button
          className="btn-secondary"
          title={
            w?.customSubdomain
              ? `Custom subdomain: ${w.customSubdomain}`
              : "Set a custom subdomain for this workspace"
          }
          onClick={() => setShowSubdomain(true)}
        >
          <Globe size={14} />
          {w?.customSubdomain && (
            <span className="ml-1 hidden text-[10px] text-accent sm:inline">
              {w.customSubdomain}
            </span>
          )}
        </button>
        <button
          className="btn-secondary"
          title="Open .premdev (workspace config: run command, env)"
          onClick={async () => {
            try {
              const r = await API.post<{ path: string }>(
                `/workspaces/${id}/config/init`,
                {},
              );
              // Save any pending edits, refresh tree (so the file shows up
              // when hidden files are visible), then load the file content
              // into Monaco — mirroring the file-tree onSelect flow.
              if (dirty && activePath) {
                if (saveTimer.current) {
                  clearTimeout(saveTimer.current);
                  saveTimer.current = null;
                }
                await saveNow(activePath, content);
              }
              await qc.invalidateQueries({ queryKey: ["files", id] });
              setActivePath(r.path);
              const res = await API.get<{ content: string }>(
                `/workspaces/${id}/files?path=${encodeURIComponent(r.path)}`,
              );
              setContent(res.content);
              setDiffOriginal(res.content);
              setDirty(false);
              setSavingState("idle");
            } catch (e: any) {
              alert(e?.message ?? "Failed to open config");
            }
          }}
        >
          <Settings size={14} />
        </button>
        {w?.status === "running" ? (
          <>
            <button
              className="btn-secondary"
              title="Restart"
              onClick={() => startStop.mutate("restart")}
            >
              <RotateCw size={14} />
            </button>
            <button className="btn-secondary" onClick={() => startStop.mutate("stop")}>
              <Square size={14} /> Stop
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={() => startStop.mutate("start")}>
            <Play size={14} /> Run
          </button>
        )}
        <button
          className="btn-secondary"
          title="Git: status, commit, push, pull"
          onClick={() => openTool("git")}
        >
          <GitBranch size={14} />
        </button>
        <button
          className="btn-secondary"
          title="Cron Jobs — scheduled tasks for this workspace"
          onClick={() => openTool("cron")}
        >
          <Clock size={14} />
        </button>
        <div className="relative">
          <button
            className="btn-secondary"
            title="Quick AI actions on the active file"
            onClick={() => { setShowQuickActions((v) => !v); }}
          >
            <Wand2 size={14} />
          </button>
          {showQuickActions && (
            <QuickActionsMenu
              activePath={activePath}
              onClose={() => setShowQuickActions(false)}
              onPick={(prompt) => {
                setShowQuickActions(false);
                setShowAI(true);
                window.dispatchEvent(new CustomEvent("premdev:ai:prefill", {
                  detail: { text: prompt, send: true },
                }));
              }}
            />
          )}
        </div>
        {/* Font size */}
        <div className="flex items-center gap-0.5">
          <button
            className="btn-secondary px-1.5"
            title="Font size kecil"
            onClick={() => setFontSize((v) => { const n = Math.max(8, v - 1); try { localStorage.setItem("premdev.fontSize", String(n)); } catch {} return n; })}
          >
            <Type size={10} />−
          </button>
          <span className="text-[10px] tabular-nums text-text-muted w-5 text-center">{fontSize}</span>
          <button
            className="btn-secondary px-1.5"
            title="Font size besar"
            onClick={() => setFontSize((v) => { const n = Math.min(32, v + 1); try { localStorage.setItem("premdev.fontSize", String(n)); } catch {} return n; })}
          >
            <Type size={12} />+
          </button>
        </div>
        {/* Word wrap */}
        <button
          className={`btn-secondary ${wordWrap === "on" ? "text-accent" : ""}`}
          title={wordWrap === "on" ? "Word wrap ON — click to turn off" : "Word wrap OFF — click to turn on"}
          onClick={() => setWordWrap((v) => { const n = v === "on" ? "off" : "on"; try { localStorage.setItem("premdev.wordWrap", n); } catch {} return n; })}
        >
          <WrapText size={14} />
        </button>
        {/* Split editor */}
        <button
          className={`btn-secondary ${splitPath ? "text-accent" : ""}`}
          title={splitPath ? "Close split editor" : "Split editor — open second file side by side"}
          onClick={() => {
            if (splitPath) { setSplitPath(null); setSplitContent(""); setSplitTabs([]); }
            else if (activePath) openSplit(activePath);
          }}
        >
          <Columns2 size={14} />
        </button>
        {splitTabs.length > 0 && (
          <button
            className={`btn-secondary ${splitDirection === "vertical" ? "text-accent" : ""}`}
            title={splitDirection === "horizontal" ? "Split panes horizontally — click for vertical panes" : "Split panes vertically — click for horizontal panes"}
            onClick={() => setSplitDirection((value) => value === "horizontal" ? "vertical" : "horizontal")}
          >
            <Columns2 size={14} className={splitDirection === "vertical" ? "rotate-90" : ""} />
          </button>
        )}
        {/* Minimap toggle */}
        <button
          className={`btn-secondary ${minimap ? "text-accent" : ""}`}
          title="Toggle minimap"
          onClick={() => setMinimap((v) => { const n = !v; try { localStorage.setItem("premdev.minimap", n ? "1" : "0"); } catch {} return n; })}
        >
          <SlidersHorizontal size={14} />
        </button>
        {/* Theme toggle */}
        <button
          className="btn-secondary"
          title={editorTheme === "vs-dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => setEditorTheme((t) => { const n = t === "vs-dark" ? "vs" : "vs-dark"; try { localStorage.setItem("premdev.theme", n); } catch {} return n; })}
        >
          {editorTheme === "vs-dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        {/* Command palette */}
        <button
          className="btn-secondary"
          title="Command palette (Ctrl+K)"
          onClick={() => setShowCommandPalette(true)}
        >
          <Command size={14} />
        </button>
        {/* Code outline */}
        <button
          className="btn-secondary"
          title="Code outline — daftar simbol dalam file ini (Ctrl+Shift+O)"
          onClick={() => {
            editorRef.current?.getAction("editor.action.quickOutline")?.run();
          }}
        >
          <Layers size={14} />
        </button>
        {/* File diff view */}
        {activePath && dirty && (
          <button
            className="btn-secondary"
            title="Lihat perubahan sejak terakhir disimpan (Diff view)"
            onClick={() => {
              // snapshot content sebelum perubahan saat ini sebagai "original"
              // sudah tersimpan di diffOriginal saat file dibuka
              setShowDiff(true);
            }}
          >
            <GitBranch size={14} />
            <span className="hidden sm:inline text-[11px]">Diff</span>
          </button>
        )}
        {/* Workspace search */}
        <button
          className="btn-secondary"
          title="Search across files (Ctrl+Shift+F)"
          onClick={() => setShowWorkspaceSearch(true)}
        >
          <FileSearch size={14} />
        </button>
        {/* Share */}
        <button
          className="btn-secondary"
          title="Share workspace (read-only link)"
          onClick={() => setShowShare(true)}
        >
          <Share2 size={14} />
        </button>
        {/* Activity log */}
        <button
          className="btn-secondary"
          title="Activity log"
          onClick={() => setShowActivityLog(true)}
        >
          <Activity size={14} />
        </button>
        {/* Vim visual mode */}
        <button
          className={`btn-secondary font-mono text-[10px] ${vimMode ? "text-accent" : ""}`}
          title={vimMode ? "Vim visual mode ON (block cursor, relative lines) — click to disable" : "Vim visual mode: block cursor + relative line numbers"}
          onClick={() => setVimMode((v) => { const n = !v; try { localStorage.setItem("premdev.vimMode", n ? "1" : "0"); } catch {} return n; })}
        >
          VIM
        </button>
        {/* Find & Replace */}
        <button
          className="btn-secondary"
          title="Find & Replace across files (Ctrl+Shift+H)"
          onClick={() => setShowReplace(true)}
        >
          <Replace size={14} />
        </button>
        {/* Keyboard shortcuts */}
        <button
          className="btn-secondary font-mono text-xs font-bold"
          title="Keyboard shortcuts (Ctrl+?)"
          onClick={() => setShowShortcuts(true)}
        >
          ?
        </button>
        <button className="btn-secondary" onClick={() => setShowActivityLog(true)} title="Activity log & notifications">
          <Activity size={14} />
        </button>
        <button className="btn-secondary" onClick={() => setShowAI((s) => !s)}>
          <Sparkles size={14} /> AI
        </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <PanelGroup direction={compactLayout ? "vertical" : "horizontal"}>
          {showAI && (
            <>
              <Panel defaultSize={compactLayout ? 30 : 22} minSize={compactLayout ? 18 : 18}>
                <AIChat
                  workspaceId={id!}
                  activeFile={
                    activePath && !isImageFile(activePath) && content
                      ? { path: activePath, content }
                      : undefined
                  }
                  onWorkspaceMutated={() => qc.invalidateQueries({ queryKey: ["workspace", id] })}
                  onFilesMutated={() => qc.invalidateQueries({ queryKey: ["files", id] })}
                />
              </Panel>
              <PanelResizeHandle className={compactLayout ? "h-px bg-bg-border hover:bg-accent" : "w-px bg-bg-border hover:bg-accent"} />
            </>
          )}

          <Panel defaultSize={compactLayout ? 70 : (showAI ? 56 : 72)}>
            <PanelGroup direction="vertical">
              <Panel defaultSize={65} minSize={20}>
                {/* ── Breadcrumb ─────────────────────────────────────── */}
                {activePath && (
                  <div className="flex items-center gap-0.5 border-b border-bg-border bg-bg-subtle px-3 py-1 text-[11px] text-text-muted overflow-x-auto" style={{ scrollbarWidth: "none" }}>
                    {activePath.split("/").map((part, i, arr) => (
                      <span key={i} className="flex items-center gap-0.5 shrink-0">
                        {i > 0 && <ChevronRight size={10} className="opacity-40" />}
                        <span className={i === arr.length - 1 ? "text-text font-medium" : ""}>{part}</span>
                      </span>
                    ))}
                  </div>
                )}
                <WorkspaceTabBar
                  openTabs={openTabs}
                  activePath={activePath}
                  newTabOpen={newTabOpen}
                  bottomTab={bottomTab}
                  sidePanelTab={sidePanelTab}
                  showAI={showAI}
                  showCronJobs={activeSurface === "cron"}
                  onOpenFiles={() => setSidePanelTab("files")}
                  onOpenAI={() => setShowAI((value) => !value)}
                  onOpenCron={() => openTool("cron")}
                  onOpenSplit={openSplit}
                  onOpenTool={(tool) => {
                    if (tool === "secrets") setSecretsOpenDbTemplate(false);
                    openTool(tool);
                  }}
                  onOpenFile={openFile}
                  onCloseFile={closeTab}
                  onNewTab={() => {
                    setActivePath(null);
                    setActiveSurface("file");
                    setNewTabOpen(true);
                    if (typeof window !== "undefined") window.history.replaceState({}, "", window.location.pathname + window.location.search);
                  }}
                  onCloseNewTab={() => setNewTabOpen(false)}
                  dirty={dirty}
                />
                <div className="relative min-h-0 flex-1">
                {activeSurface !== "file" ? (
                  activeSurface === "cron" ? (
                    <CronJobsPanel
                      workspaceId={id!}
                      embedded
                      onClose={() => { setShowCronJobs(false); setActiveSurface("file"); }}
                    />
                  ) : activeSurface === "git" ? (
                    <GitPanel
                      workspaceId={id!}
                      embedded
                      onClose={() => { setShowGit(false); setActiveSurface("file"); }}
                    />
                  ) : activeSurface === "secrets" ? (
                    <SecretsPanel
                      workspaceId={id!}
                      embedded
                      onClose={() => { setShowSecrets(false); setSecretsOpenDbTemplate(false); setActiveSurface("file"); }}
                      initialDbTemplate={secretsOpenDbTemplate}
                    />
                  ) : (
                    <BottomTabs
                      workspaceId={id!}
                      workspace={w}
                      tab={bottomTab}
                      setTab={setBottomTab}
                      hideTabs
                    />
                  )
                ) : (
                  <>
                 {newTabOpen ? (
                  <NewTabPage
                    workspaceId={id!}
                    openTabs={openTabs}
                    activePath={activePath}
                    onOpenFile={(p) => openFile(p)}
                    onOpenTool={(t) => {
                      if (t === "secrets") setSecretsOpenDbTemplate(false);
                      openTool(t);
                    }}
                    bottomTab={bottomTab}
                    recentFiles={recentFiles}
                  />
                ) : activePath && isImageFile(activePath) ? (
                  <ImagePreview
                    key={activePath}
                    workspaceId={id!}
                    path={activePath}
                  />
                ) : activePath && isPdfFile(activePath) ? (
                  <PdfPreview
                    key={activePath}
                    workspaceId={id!}
                    path={activePath}
                  />
                ) : activePath && isBinaryFile(activePath) ? (
                  <BinaryFilePreview workspaceId={id!} path={activePath} />
                ) : activePath ? (
                  <Editor
                    height="100%"
                    theme={editorTheme}
                    path={activePath}
                    value={content}
                    onMount={(ed, monaco) => {
                      editorRef.current = ed;
                      // Selection-based ask (Batch A #4): right-click /
                      // Cmd+I to send the highlighted code into the AI
                      // chat with an "Explain / Refactor / Fix" preface.
                      const send = (preface: string) => {
                        const sel = ed.getSelection();
                        const model = ed.getModel();
                        if (!sel || !model) return;
                        const text = model.getValueInRange(sel) || "";
                        const path = activePathRef.current ?? "(unsaved)";
                        const prefilled =
                          `${preface}\n\nFile: \`${path}\` (lines ${sel.startLineNumber}-${sel.endLineNumber})\n\n` +
                          "```\n" + (text || "(empty selection — entire file context implied)") + "\n```";
                        setShowAI(true);
                        window.dispatchEvent(new CustomEvent("premdev:ai:prefill", {
                          detail: { text: prefilled },
                        }));
                      };
                      ed.addAction({
                        id: "premdev.askAI",
                        label: "PremDev: Ask AI about selection",
                        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
                        contextMenuGroupId: "premdev",
                        contextMenuOrder: 1,
                        run: () => send("Explain what this code does and call out anything risky."),
                      });
                      ed.addAction({
                        id: "premdev.refactorAI",
                        label: "PremDev: Refactor selection with AI",
                        contextMenuGroupId: "premdev",
                        contextMenuOrder: 2,
                        run: () => send("Refactor the selected code for clarity and reuse. Then patch the file in place."),
                      });
                      ed.addAction({
                        id: "premdev.fixAI",
                        label: "PremDev: Fix selection with AI",
                        contextMenuGroupId: "premdev",
                        contextMenuOrder: 3,
                        run: () => send("Find the bug in this selection and fix it. After patching, run diag:run."),
                      });
                      // Track cursor position for status bar
                      ed.onDidChangeCursorPosition((e) => {
                        setCursorPos({ line: e.position.lineNumber, col: e.position.column });
                      });
                    }}
                    onChange={(v) => {
                      setContent(v ?? "");
                      setDirty(true);
                      lastEditGenRef.current++;
                      setSavingState("idle");
                    }}
                    options={{
                      fontSize,
                      fontFamily: "JetBrains Mono, Fira Code, Menlo, monospace",
                      minimap: { enabled: minimap },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      tabSize: 2,
                      folding: true,
                      foldingHighlight: true,
                      bracketPairColorization: { enabled: true },
                      guides: { bracketPairs: true },
                      renderLineHighlight: "all",
                      smoothScrolling: true,
                      cursorBlinking: "smooth",
                      cursorSmoothCaretAnimation: "on",
                      formatOnPaste: true,
                      suggestOnTriggerCharacters: true,
                      wordWrap,
                      cursorStyle: vimMode ? "block" : "line",
                      lineNumbers: vimMode ? "relative" : "on",
                    }}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-text-muted">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <FileSearch size={36} className="opacity-30" />
                      <p className="text-sm">Select a file to edit</p>
                      <button
                        onClick={() => setNewTabOpen(true)}
                        className="flex items-center gap-1.5 rounded-md bg-bg-subtle px-3 py-1.5 text-xs text-text-muted hover:text-text hover:bg-bg-hover"
                      >
                        <Plus size={12} /> Open a tab
                      </button>
                    </div>
                  </div>
                )}
                {loadingPath && (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center bg-bg/45 backdrop-blur-[1px]">
                    <div className="flex items-center gap-2 rounded-lg border border-bg-border bg-bg-panel/95 px-3 py-2 text-xs text-text-muted shadow-xl">
                      <Loader2 size={13} className="animate-spin text-accent" />
                      Membuka {loadingPath.split("/").pop()}…
                    </div>
                  </div>
                )}
                {fileError && (
                  <div className="absolute inset-x-4 top-4 z-10 flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs shadow-lg">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
                    <div className="min-w-0">
                      <p className="font-medium text-danger">File gagal dibuka</p>
                      <p className="mt-0.5 break-words text-text-muted">{fileError}</p>
                    </div>
                    <button className="ml-auto text-text-muted hover:text-text" onClick={() => setFileError(null)} aria-label="Tutup pesan error">
                      <X size={13} />
                    </button>
                  </div>
                )}
                  </>
                )}
                 </div>
              </Panel>
            </PanelGroup>
          </Panel>

          {splitTabs.length > 0 && (
            <>
              <PanelResizeHandle className={compactLayout ? "h-px bg-bg-border hover:bg-accent" : "w-px bg-bg-border hover:bg-accent"} />
              <Panel defaultSize={compactLayout ? 35 : 30} minSize={compactLayout ? 18 : 15}>
                <PanelGroup direction={compactLayout || splitDirection === "vertical" ? "vertical" : "horizontal"}>
                  {splitTabs.slice(0, 4).map((path, index) => (
                    <React.Fragment key={path}>
                      {index > 0 && (
                        <PanelResizeHandle className={compactLayout ? "h-px bg-bg-border hover:bg-accent" : "w-px bg-bg-border hover:bg-accent"} />
                      )}
                      <Panel defaultSize={100 / Math.min(splitTabs.length, 4)} minSize={12}>
                        <SplitFilePane
                          workspaceId={id!}
                          path={path}
                          active={splitPath === path}
                          onActivate={() => openSplit(path)}
                          onClose={() => closeSplitTab(path)}
                          onOpenMain={() => { openFile(path); closeSplitTab(path); }}
                          editorTheme={editorTheme}
                          fontSize={fontSize}
                          wordWrap={wordWrap}
                        />
                      </Panel>
                    </React.Fragment>
                  ))}
                </PanelGroup>
              </Panel>
            </>
          )}
          <PanelResizeHandle className={compactLayout ? "h-px bg-bg-border hover:bg-accent" : "w-px bg-bg-border hover:bg-accent"} />
          <Panel
            defaultSize={compactLayout ? 24 : 18}
            minSize={compactLayout ? 16 : 12}
            maxSize={compactLayout ? 45 : 30}
          >
            <WorkspaceSidePanel
              workspaceId={id!}
              confirm={confirm}
              tab={sidePanelTab}
              onTabChange={setSidePanelTab}
              onSelect={openFile}
              activePath={activePath}
              onOpenTool={(tool) => {
                if (tool === "secrets") setSecretsOpenDbTemplate(false);
                openTool(tool);
              }}
            />
          </Panel>
        </PanelGroup>
      </div>

      {/* ── Status Bar (VS Code-style bottom bar) ─────────────────────── */}
      <div className="workspace-statusbar flex shrink-0 items-center gap-3 border-t border-bg-border bg-bg-panel px-3 py-1 text-[10px] text-text-muted select-none">
        {/* Workspace status indicator */}
        <span
          className={`flex items-center gap-1 ${
            w?.status === "running" ? "text-success" : w?.status === "starting" ? "text-warning" : "text-text-muted"
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              w?.status === "running" ? "bg-success" : w?.status === "starting" ? "bg-warning animate-pulse" : "bg-text-muted"
            }`}
          />
          {w?.status ?? "loading"}
        </span>

        {/* Save state */}
        {activePath && (
          <span className={savingState === "error" ? "text-danger" : savingState === "saving" ? "text-warning" : dirty ? "text-warning" : "text-text-muted"}>
            {savingState === "saving" ? "Menyimpan…" : savingState === "error" ? "Gagal simpan" : dirty ? "● Belum disimpan" : "Tersimpan"}
          </span>
        )}

        {/* Active file path + language */}
        {activePath && (
          <span className="truncate max-w-xs" title={activePath}>
            {activePath.split("/").pop()}
          </span>
        )}

        {/* Cursor position */}
        {cursorPos && activePath && (
          <span className="font-mono opacity-70">
            Ln {cursorPos.line}, Col {cursorPos.col}
          </span>
        )}

        <span className="ml-auto flex items-center gap-3">
          {/* Ctrl+J hint */}
          <span title="Toggle AI panel (Ctrl+J)" className="hidden sm:inline opacity-60">
            Ctrl+J → AI
          </span>
        </span>
      </div>

      {showCheckpoints && (
        <CheckpointsModal
          workspaceId={id!}
          onClose={() => setShowCheckpoints(false)}
          confirm={confirm}
        />
      )}
      {showSubdomain && w && (
        <SubdomainPanel
          workspaceId={id!}
          workspace={w}
          onClose={() => setShowSubdomain(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["workspace", id] })}
        />
      )}
      {showCommandPalette && (
        <CommandPalette
          workspaceId={id!}
          activePath={activePath}
          onSelect={(path) => {
            setShowCommandPalette(false);
            openFile(path);
          }}
          onClose={() => setShowCommandPalette(false)}
        />
      )}
      {showWorkspaceSearch && (
        <WorkspaceSearch
          workspaceId={id!}
          onSelect={(path) => { setShowWorkspaceSearch(false); openFile(path); }}
          onClose={() => setShowWorkspaceSearch(false)}
        />
      )}
      {showShare && (
        <ShareModal
          workspaceId={id!}
          onClose={() => setShowShare(false)}
        />
      )}
      {showActivityLog && (
        <ActivityLogModal
          workspaceId={id!}
          onClose={() => setShowActivityLog(false)}
        />
      )}
      {showReplace && (
        <WorkspaceReplace
          workspaceId={id!}
          onClose={() => setShowReplace(false)}
          onFileOpen={openFile}
        />
      )}
      {showShortcuts && (
        <ShortcutModal onClose={() => setShowShortcuts(false)} />
      )}
      {showDiff && activePath && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70" onClick={() => setShowDiff(false)}>
          <div
            className="relative m-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden rounded-lg border border-bg-border bg-bg shadow-2xl"
            style={{ maxHeight: "85vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-bg-border bg-bg-panel px-4 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <GitBranch size={14} className="text-accent" />
                Diff: {activePath.split("/").pop()}
                <span className="ml-2 text-[10px] font-normal text-text-muted">
                  Kiri = versi disimpan · Kanan = perubahan saat ini
                </span>
              </div>
              <button className="btn-ghost p-1" onClick={() => setShowDiff(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="flex-1" style={{ minHeight: 0 }}>
              <DiffEditor
                height="100%"
                theme={editorTheme}
                language={activePath.endsWith(".ts") || activePath.endsWith(".tsx") ? "typescript"
                  : activePath.endsWith(".js") || activePath.endsWith(".jsx") ? "javascript"
                  : activePath.endsWith(".py") ? "python"
                  : activePath.endsWith(".json") ? "json"
                  : activePath.endsWith(".css") ? "css"
                  : activePath.endsWith(".html") ? "html"
                  : activePath.endsWith(".go") ? "go"
                  : activePath.endsWith(".rs") ? "rust"
                  : activePath.endsWith(".php") ? "php"
                  : activePath.endsWith(".md") ? "markdown"
                  : "plaintext"}
                original={diffOriginal}
                modified={content}
                options={{
                  fontSize: 12,
                  fontFamily: "JetBrains Mono, Fira Code, Menlo, monospace",
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  readOnly: true,
                  renderSideBySide: true,
                }}
              />
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

// ---------------------------------------------------------------------
// QuickActionsMenu — small dropdown of canned prompts that operate on the
// currently-open file. Each pick is sent straight to AI panel via the
// premdev:ai:prefill event (with send=true so the request fires
// immediately instead of waiting for the user to press Enter).
// ---------------------------------------------------------------------
function QuickActionsMenu({
  activePath,
  onPick,
  onClose,
}: {
  activePath: string | null;
  onPick: (prompt: string) => void;
  onClose: () => void;
}) {
  // Click-outside dismissal — registered on first render so any click that
  // isn't on the menu closes it. The button that opens the menu also calls
  // setShowQuickActions((v) => !v), so a second click on it still toggles.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(ev.target as Node)) onClose();
    }
    // Defer one tick so the very click that opened us doesn't immediately close us.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); };
  }, [onClose]);
  const file = activePath ?? "(no file open)";
  const items: Array<{ label: string; prompt: string }> = [
    {
      label: "Explain this file",
      prompt: `Explain what \`${file}\` does, its public API, and how it interacts with the rest of the project. Don't change anything.`,
    },
    {
      label: "Find bugs / risks",
      prompt: `Audit \`${file}\` for bugs, race conditions, missing error handling, and security risks. Output a numbered list with severity. Don't patch yet.`,
    },
    {
      label: "Refactor for readability",
      prompt: `Refactor \`${file}\` for readability and maintainability without changing behavior. Use patch: blocks, then run diag:run.`,
    },
    {
      label: "Add doc comments",
      prompt: `Add concise doc comments (JSDoc / docstring / equivalent) to every exported symbol in \`${file}\`. Don't change behavior.`,
    },
    {
      label: "Add types",
      prompt: `Strengthen the type annotations in \`${file}\` (TypeScript / Python type hints / etc.) where currently missing. Use patch: blocks, then run diag:run.`,
    },
    {
      label: "Generate tests",
      prompt: `Generate a focused test file covering the public surface of \`${file}\`. After writing it, run test:run.`,
    },
    {
      label: "Optimize performance",
      prompt: `Identify the hottest path in \`${file}\` and propose 1-2 concrete optimisations with measurable trade-offs. Don't patch unless I confirm.`,
    },
  ];
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-64 rounded-md border border-bg-border bg-bg-subtle p-1 text-xs shadow-lg z-20"
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-text-muted">
        Quick actions {activePath ? `· ${activePath.split("/").pop()}` : ""}
      </div>
      {items.map((it) => (
        <button
          key={it.label}
          className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-bg-base disabled:opacity-50"
          disabled={!activePath}
          onClick={() => onPick(it.prompt)}
          title={!activePath ? "Open a file first" : it.prompt}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// GitPanel — read-only-by-default modal that surfaces git status, recent
// commits, and a small write surface (commit / push / pull). All ops run
// inside the workspace container via /workspaces/:id/git/* so they use
// the user's own git credentials and config.
// ---------------------------------------------------------------------
function GitPanel({
  workspaceId,
  onClose,
  embedded = false,
}: {
  workspaceId: string;
  onClose: () => void;
  embedded?: boolean;
}) {
  const qc = useQueryClient();
  const { data: status, isLoading: statusLoading, error: statusErr, refetch: refetchStatus } = useQuery({
    queryKey: ["git", workspaceId, "status"],
    queryFn: () => API.get<any>(`/workspaces/${workspaceId}/git/status`),
    refetchOnWindowFocus: false,
  });
  const { data: log } = useQuery({
    queryKey: ["git", workspaceId, "log"],
    queryFn: () => API.get<any>(`/workspaces/${workspaceId}/git/log`),
    enabled: !!status?.initialised,
    refetchOnWindowFocus: false,
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string>("");

  async function run(label: string, fn: () => Promise<any>) {
    setBusy(true);
    setOutput(`→ ${label}…`);
    try {
      const r = await fn();
      setOutput(`${label}\n${r?.output ?? JSON.stringify(r, null, 2)}`);
      await refetchStatus();
      await qc.invalidateQueries({ queryKey: ["git", workspaceId, "log"] });
    } catch (e: any) {
      setOutput(`${label} failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const dirty = (status?.files?.length ?? 0) > 0;
  return (
    <div
      className={embedded ? "flex h-full min-h-0 flex-col bg-bg-base" : "fixed inset-0 z-50 flex items-center justify-center bg-black/60"}
      onMouseDown={embedded ? undefined : onClose}
    >
      <div
        className={embedded
          ? "flex h-full min-h-0 w-full flex-col overflow-auto bg-bg-base p-5"
          : "max-h-[88vh] w-full max-w-2xl overflow-auto rounded-lg border border-bg-border bg-bg-base p-5 shadow-xl"}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <GitBranch size={18} /> Git
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {statusLoading && <div className="text-text-muted">Loading…</div>}
        {statusErr && (
          <div className="rounded-md bg-danger/10 p-3 text-xs text-danger">
            {String((statusErr as any)?.message ?? statusErr)}
          </div>
        )}
        {status && !status.initialised && (
          <div className="space-y-3">
            <p className="text-sm text-text-muted">
              No git repository in this workspace yet.
            </p>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => run("git init", () => API.post(`/workspaces/${workspaceId}/exec`, { command: "git init && git add -A && git commit --allow-empty -m 'Initial commit' || true" }))}
            >
              Initialise repo
            </button>
          </div>
        )}
        {status?.initialised && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-bg-subtle p-3 text-xs">
              <span><span className="text-text-muted">Branch:</span> <code>{status.branch || "(detached)"}</code></span>
              <span><span className="text-text-muted">Ahead:</span> {status.ahead}</span>
              <span><span className="text-text-muted">Behind:</span> {status.behind}</span>
              {status.remote && <span className="text-text-muted truncate max-w-xs" title={status.remote}>{status.remote.split("\n")[0]}</span>}
            </div>

            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-text-muted">Changes ({status.files.length})</div>
              {status.files.length === 0 ? (
                <div className="rounded-md bg-bg-subtle p-3 text-xs text-text-muted">Working tree clean.</div>
              ) : (
                <div className="max-h-40 overflow-auto rounded-md border border-bg-border">
                  {status.files.map((f: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1 text-xs odd:bg-bg-subtle">
                      <code className="w-8 text-text-muted">{f.x}{f.y}</code>
                      <span className="truncate">{f.path}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex gap-1">
                <input
                  className="input flex-1 text-xs"
                  placeholder="Commit message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <button
                  className="btn-secondary text-xs"
                  title="Generate commit message with AI"
                  disabled={busy || !dirty}
                  onClick={() => {
                    const files = status?.files?.map((f: any) => `${f.x}${f.y} ${f.path}`).join("\n") ?? "";
                    window.dispatchEvent(new CustomEvent("premdev:ai:prefill", {
                      detail: {
                        text: `Berikan 1 baris commit message yang singkat dan deskriptif dalam format conventional commits (feat/fix/refactor/chore/docs dll) untuk perubahan berikut:\n\n${files}\n\nHanya tulis commit messagenya saja, tanpa penjelasan.`,
                        send: true,
                      },
                    }));
                  }}
                >
                  <Sparkles size={12} />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-primary"
                  disabled={busy || !message.trim() || !dirty}
                  onClick={() => run("commit", () =>
                    API.post(`/workspaces/${workspaceId}/git/commit`, { message: message.trim(), addAll: true }),
                  )}
                >
                  Commit (add all)
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => run("push", () => API.post(`/workspaces/${workspaceId}/git/push`, {}))}
                >
                  Push
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => run("pull --ff-only", () => API.post(`/workspaces/${workspaceId}/git/pull`, {}))}
                >
                  Pull
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await API.get<{ diff: string }>(`/workspaces/${workspaceId}/git/diff`);
                      setOutput("git diff\n" + (r.diff || "(no unstaged changes)"));
                    } finally { setBusy(false); }
                  }}
                >
                  Diff
                </button>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-text-muted">Recent commits</div>
              <div className="max-h-40 overflow-auto rounded-md border border-bg-border">
                {(log?.commits ?? []).length === 0 && (
                  <div className="px-3 py-2 text-xs text-text-muted">No commits yet.</div>
                )}
                {(log?.commits ?? []).map((c: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1 text-xs odd:bg-bg-subtle">
                    <code className="text-accent">{c.hash}</code>
                    <span className="truncate">{c.subject}</span>
                    <span className="ml-auto text-text-muted">{c.when}</span>
                  </div>
                ))}
              </div>
            </div>

            {output && (
              <pre className="max-h-40 overflow-auto rounded-md bg-bg-subtle p-2 text-[11px]">{output}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// SubdomainPanel — modal for editing the workspace's custom subdomain.
// Debounces the availability check so we don't hammer the backend on
// every keystroke; shows live validation state (idle/checking/ok/error)
// and lets the user clear the custom mapping to fall back to the default
// <project>-<user>.<domain> form. Pure UI — server is the source of
// truth; on save we re-fetch the workspace via the parent's invalidate.
// ---------------------------------------------------------------------
function SubdomainPanel({
  workspaceId,
  workspace,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  workspace: Workspace;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<string>(workspace.customSubdomain ?? "");
  const [domain, setDomain] = useState<string>(workspace.customDomain ?? "");
  const [check, setCheck] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "ok" }
    | { state: "error"; message: string }
  >({ state: "idle" });
  const [saving, setSaving] = useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const checkSeqRef = useRef(0);

  // Fetch available base domains from the server.
  const { data: domainsData } = useQuery<{ primary: string; extras: string[] }>({
    queryKey: ["workspaces", "domains"],
    queryFn: () => API.get("/workspaces/domains"),
  });
  const allDomains = domainsData
    ? [domainsData.primary, ...domainsData.extras]
    : workspace.defaultUrl
      ? [new URL(workspace.defaultUrl).hostname.split(".").slice(1).join(".")]
      : [];
  // Ensure selected domain is always valid once list loads.
  const effectiveDomain = allDomains.includes(domain) ? domain : (allDomains[0] ?? "");

  const trimmed = value.trim().toLowerCase();
  const subUnchanged = trimmed === (workspace.customSubdomain ?? "");
  const domainUnchanged = effectiveDomain === (workspace.customDomain ?? (domainsData?.primary ?? ""));
  const unchanged = subUnchanged && domainUnchanged;

  useEffect(() => {
    if (unchanged || trimmed === "") {
      setCheck({ state: "idle" });
      return;
    }
    const mySeq = ++checkSeqRef.current;
    setCheck({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const r = await API.get<{ available: boolean; error?: string }>(
          `/workspaces/check-subdomain?value=${encodeURIComponent(trimmed)}&ignoreId=${encodeURIComponent(workspaceId)}`,
        );
        if (mySeq !== checkSeqRef.current) return;
        if (r.available) setCheck({ state: "ok" });
        else setCheck({ state: "error", message: r.error ?? "Not available" });
      } catch (e: any) {
        if (mySeq !== checkSeqRef.current) return;
        setCheck({ state: "error", message: e?.message ?? "Check failed" });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [trimmed, unchanged, workspaceId]);

  async function save(next: string | null) {
    setSaving("saving");
    setSaveError(null);
    try {
      await API.put(`/workspaces/${workspaceId}/subdomain`, {
        subdomain: next,
        domain: next == null ? null : (effectiveDomain || null),
      });
      onSaved();
      onClose();
    } catch (e: any) {
      setSaving("error");
      setSaveError(e?.message ?? "Save failed");
    }
  }

  const canSave =
    !unchanged &&
    saving !== "saving" &&
    (trimmed === "" || check.state === "ok");

  // Live preview URL: combine chosen subdomain + chosen domain.
  const previewUrl = (() => {
    if (!workspace.defaultUrl) return null;
    try {
      const u = new URL(workspace.defaultUrl);
      const sub = trimmed || workspace.defaultUrl.split("//")[1].split(".")[0];
      const baseDomain = effectiveDomain || u.hostname.split(".").slice(1).join(".");
      return `${u.protocol}//${sub}.${baseDomain}`;
    } catch {
      return null;
    }
  })();

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-bg-border bg-bg-panel p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Globe size={18} /> Custom subdomain
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="mb-3 text-xs text-text-muted">
          Pilih subdomain dan domain yang kamu mau. URL default kamu:{" "}
          <code className="text-text">{workspace.defaultUrl}</code>.
        </p>
        <div className="space-y-3">
          {/* Subdomain input */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">Subdomain</label>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                className="input flex-1"
                placeholder="myapp"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              {check.state === "checking" && <Loader2 size={16} className="animate-spin text-text-muted" />}
              {check.state === "ok" && <CheckIcon size={16} className="text-success" />}
              {check.state === "error" && <AlertTriangle size={16} className="text-danger" />}
            </div>
            {check.state === "error" && <div className="mt-1 text-xs text-danger">{check.message}</div>}
            {check.state === "ok" && <div className="mt-1 text-xs text-success">Tersedia</div>}
          </div>

          {/* Domain selector */}
          {allDomains.length > 1 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">
                Base domain
              </label>
              <select
                className="input w-full font-mono text-sm"
                value={effectiveDomain}
                onChange={(e) => setDomain(e.target.value)}
              >
                {allDomains.map((d) => (
                  <option key={d} value={d}>
                    {d}{d === domainsData?.primary ? " (utama)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Live preview */}
          {previewUrl && (
            <div className="rounded border border-bg-border bg-bg p-3 text-xs">
              <div className="text-text-muted">URL workspace kamu:</div>
              <div className="mt-1 break-all font-mono text-accent">{previewUrl}</div>
            </div>
          )}

          {saveError && (
            <div className="rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
              {saveError}
            </div>
          )}
        </div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            className="btn-ghost text-xs"
            onClick={() => save(null)}
            disabled={saving === "saving" || (workspace.customSubdomain == null && workspace.customDomain == null)}
            title="Kembali ke URL default <project>-<user>"
          >
            <Trash2 size={12} /> Clear (pakai default)
          </button>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>
              Batal
            </button>
            <button
              className="btn-primary"
              onClick={() => save(trimmed === "" ? null : trimmed)}
              disabled={!canSave}
            >
              {saving === "saving" ? "Menyimpan…" : "Simpan"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileTree({
  workspaceId,
  onSelect,
  activePath,
  confirm,
}: {
  workspaceId: string;
  onSelect: (p: string) => void;
  activePath: string | null;
  confirm: (o: any) => Promise<boolean>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  // Show hidden files (dotfiles like .env). Persisted per-browser so users
  // don't have to re-enable on every page load.
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem("premdev.showHidden") === "1";
    } catch {
      return false;
    }
  });
  function toggleShowHidden() {
    setShowHidden((v) => {
      const next = !v;
      try {
        localStorage.setItem("premdev.showHidden", next ? "1" : "0");
      } catch {}
      return next;
    });
  }
  const [searchQuery, setSearchQuery] = useState("");
  const [inlineCreate, setInlineCreate] = useState<{ type: "file" | "dir"; value: string } | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inlineCreate) inlineInputRef.current?.focus(); }, [inlineCreate]);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["files", workspaceId, showHidden],
    queryFn: () =>
      API.get<{ tree: FileNode[] }>(
        `/workspaces/${workspaceId}/tree${showHidden ? "?showHidden=1" : ""}`,
      ),
  });

  // A recursive tree fetch is comparatively expensive for large projects.
  // Several changes in a row (multi-file move/upload) previously launched a
  // fetch after every item, making the UI feel stuck and burning the general
  // API rate-limit bucket. Coalesce those into one refresh after the final
  // mutation while keeping the visible action instant.
  function scheduleTreeRefresh() {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refetch();
    }, 350);
  }
  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  const create = useMutation({
    mutationFn: (body: { path: string; type: "file" | "dir" }) =>
      API.post(`/workspaces/${workspaceId}/files/create`, body),
    onSuccess: scheduleTreeRefresh,
  });
  const del = useMutation({
    mutationFn: (paths: string | string[]) =>
      API.post(
        `/workspaces/${workspaceId}/files/delete`,
        Array.isArray(paths) ? { paths } : { path: paths },
      ),
    onSuccess: scheduleTreeRefresh,
  });
  const rename = useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      API.post(`/workspaces/${workspaceId}/files/rename`, body),
    onSuccess: scheduleTreeRefresh,
  });

  async function handleDelete(p: string) {
    // If `p` is part of an active multi-selection (size > 1), bulk-delete
    // ALL selected paths in one request — the user almost certainly meant
    // "delete the things I just selected" rather than "delete only this
    // one item that happened to be the click target".
    const inSelection = selectedPaths.has(p) && selectedPaths.size > 1;
    if (inSelection) {
      const list = Array.from(selectedPaths);
      const preview = list.slice(0, 8).map((x) => `• ${x}`).join("\n");
      const more = list.length > 8 ? `\n…dan ${list.length - 8} item lainnya` : "";
      const ok = await confirm({
        title: `Hapus ${list.length} item?`,
        message: `Akan menghapus:\n${preview}${more}\n\nAksi ini tidak bisa dibatalkan.`,
        confirmLabel: `Hapus ${list.length} item`,
        danger: true,
      });
      if (!ok) return;
      try {
        await del.mutateAsync(list);
      } catch (e: any) {
        alert(e.message ?? "Bulk delete failed");
      }
      setSelectedPaths(new Set());
      return;
    }
    const ok = await confirm({
      title: "Hapus file?",
      message: `Yakin mau hapus "${p}"?\nAksi ini tidak bisa dibatalkan.`,
      confirmLabel: "Hapus",
      danger: true,
    });
    if (ok) del.mutate(p);
  }

  async function handleRename(from: string, to: string) {
    if (!to || to === from) return;
    try {
      await rename.mutateAsync({ from, to });
    } catch (e: any) {
      alert(e.message ?? "Rename failed");
    }
  }

  // Multi-select state for the tree.
  //   - Ctrl/Cmd+click toggles a single entry.
  //   - Shift+click selects an inclusive range from the last anchor.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);

  // Expanded folders, lifted from <NodeRow> so we know which paths are
  // actually visible (matters for Shift+click range select). All folders
  // start collapsed by default — user explicitly opens what they need.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleExpand(p: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function toggleSelect(p: string, additive: boolean) {
    setSelectedPaths((prev) => {
      const next = new Set(additive ? prev : []);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
    anchorRef.current = p;
  }
  function clearSelection() {
    setSelectedPaths((prev) => (prev.size ? new Set() : prev));
  }

  // DFS-flatten the tree but skip children of folders the user collapsed,
  // so range selection only ever picks rows the user can actually see.
  function visiblePaths(nodes: FileNode[] | undefined): string[] {
    const out: string[] = [];
    function walk(list: FileNode[]) {
      for (const n of list) {
        out.push(n.path);
        if (n.type === "dir" && n.children?.length && expanded.has(n.path)) {
          walk(n.children);
        }
      }
    }
    if (nodes) walk(nodes);
    return out;
  }
  function rangeSelect(target: string) {
    const flat = visiblePaths(data?.tree);
    const anchor = anchorRef.current;
    if (!anchor || !flat.includes(anchor)) {
      setSelectedPaths(new Set([target]));
      anchorRef.current = target;
      return;
    }
    const a = flat.indexOf(anchor);
    const b = flat.indexOf(target);
    if (b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelectedPaths(new Set(flat.slice(lo, hi + 1)));
    // Keep the original anchor so the user can extend the range further.
  }

  // Move via drag-and-drop. destDir "" means workspace root. `from` may be
  // a single path or many paths (when the user drags a multi-selection).
  async function handleMove(from: string | string[], destDir: string) {
    const fromList = Array.isArray(from) ? from : [from];
    const failures: string[] = [];
    for (const src of fromList) {
      const base = src.split("/").pop()!;
      const to = destDir ? `${destDir}/${base}` : base;
      if (to === src) continue;
      // Reject moving a folder into itself or any descendant.
      if (destDir === src || destDir.startsWith(`${src}/`)) {
        failures.push(`${src}: can't move into itself`);
        continue;
      }
      try {
        await rename.mutateAsync({ from: src, to });
      } catch (e: any) {
        failures.push(`${src}: ${e?.message ?? "move failed"}`);
      }
    }
    clearSelection();
    if (failures.length) alert(`Move issues:\n${failures.join("\n")}`);
  }

  function downloadZip() {
    const link = document.createElement("a");
    link.href = `/api/workspaces/${workspaceId}/download-zip`;
    link.click();
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const failures: string[] = [];
    setUploadingCount(files.length);
    for (const file of Array.from(files)) {
      try {
        // Zip files: send to extract endpoint so binary contents survive.
        if (/\.zip$/i.test(file.name)) {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch(`/api/workspaces/${workspaceId}/upload-zip`, {
            method: "POST",
            credentials: "include",
            body: fd,
          });
          if (!res.ok) {
            let msg = res.statusText;
            try {
              const body = await res.json();
              msg = body?.error ?? JSON.stringify(body);
            } catch {
              try { msg = await res.text(); } catch {}
            }
            throw new Error(msg);
          }
        } else {
          // Keep the original binary bytes and send each file once. The old
          // create+FileReader+PUT flow doubled API traffic and corrupted
          // non-text files such as PNGs and fonts.
          const fd = new FormData();
          fd.append("path", file.name);
          fd.append("file", file);
          const res = await fetch(`/api/workspaces/${workspaceId}/files/upload`, {
            method: "POST",
            credentials: "include",
            body: fd,
          });
          if (!res.ok) {
            let message = res.statusText;
            try { message = (await res.json())?.error ?? message; } catch {}
            throw new Error(message);
          }
        }
      } catch (e: any) {
        failures.push(`${file.name}: ${e?.message ?? String(e)}`);
      } finally {
        setUploadingCount((n) => Math.max(0, n - 1));
      }
    }
    fileInputRef.current && (fileInputRef.current.value = "");
    scheduleTreeRefresh();
    if (failures.length) alert(`Some uploads failed:\n${failures.join("\n")}`);
  }

  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`flex h-full flex-col bg-bg-panel ${dragOver ? "ring-2 ring-inset ring-accent/40" : ""}`}
      onDragEnter={() => setDragOver(true)}
      onDragLeave={() => setDragOver(false)}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files); }}
    >
      <div
        className="flex items-center justify-between border-b border-bg-border bg-bg-subtle/45 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-text-muted"
        title="Click to open • Ctrl/Cmd-click to add to selection • Shift-click to select a range • Drag onto a folder to move"
      >
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-lg bg-accent/10 text-accent"><Folder size={13} /></span>
          <div>
            <div className="text-[10px] font-semibold tracking-[0.16em] text-text">Explorer</div>
            <div className="mt-0.5 text-[9px] font-normal normal-case tracking-normal text-text-subtle">Project files</div>
          </div>
        </div>
        <div className="flex gap-0.5">
          <button
            className="btn-ghost p-1"
            title="New file"
            onClick={() => setInlineCreate({ type: "file", value: "" })}
          >
            <Plus size={12} />
          </button>
          <button
            className="btn-ghost p-1"
            title="New folder"
            onClick={() => setInlineCreate({ type: "dir", value: "" })}
          >
            <FolderPlus size={12} />
          </button>
          <button
            className="btn-ghost p-1"
            title={uploadingCount ? `Uploading ${uploadingCount} file…` : "Upload files"}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingCount > 0}
          >
            <span className="text-[10px]">{uploadingCount ? "…" : "⇪"}</span>
          </button>
          <button
            className="btn-ghost p-1"
            title="Download as zip"
            onClick={downloadZip}
          >
            <Download size={12} />
          </button>
          <button
            className={`btn-ghost p-1 ${showHidden ? "text-accent" : ""}`}
            title={showHidden ? "Hide hidden files (.env, .gitignore, ...)" : "Show hidden files (.env, .gitignore, ...)"}
            onClick={toggleShowHidden}
          >
            {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            className="btn-ghost p-1"
            title="Refresh"
            onClick={() => refetch()}
          >
            <RefreshCw size={12} />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => uploadFiles(e.target.files)}
        />
      </div>
      {/* Search box */}
      <div className="border-b border-bg-border px-2 py-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-bg-border/70 bg-bg px-2.5 py-1.5 text-xs transition focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/20">
          <Search size={11} className="shrink-0 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search files…"
          className="flex-1 bg-transparent text-xs text-text outline-none placeholder:text-text-subtle"
          />
          {searchQuery && <button onClick={() => setSearchQuery("")} className="text-text-muted hover:text-text"><X size={10}/></button>}
        </div>
      </div>
      {/* Inline file/folder creation */}
      {inlineCreate && (
        <div className="flex items-center gap-1 border-b border-bg-border bg-bg-subtle px-2 py-1">
          {inlineCreate.type === "dir" ? <FolderPlus size={11} className="shrink-0 text-accent" /> : <FileIcon size={11} className="shrink-0 text-text-muted" />}
          <input
            ref={inlineInputRef}
            type="text"
            className="flex-1 bg-transparent text-xs text-text outline-none placeholder:text-text-muted"
            placeholder={inlineCreate.type === "dir" ? "folder/name" : "path/to/file.ts"}
            value={inlineCreate.value}
            onChange={(e) => setInlineCreate({ ...inlineCreate, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = inlineCreate.value.trim();
                if (v) create.mutate({ path: v, type: inlineCreate.type });
                setInlineCreate(null);
              }
              if (e.key === "Escape") setInlineCreate(null);
            }}
          />
          <button className="btn-ghost p-0.5" title="Cancel" onClick={() => setInlineCreate(null)}>
            <X size={10} />
          </button>
        </div>
      )}
      <div
        className="flex-1 overflow-auto py-1 text-sm"
        // Drop on empty area / root container → move to workspace root.
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DND_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(DND_MIME);
          if (!raw) return;
          e.preventDefault();
          handleMove(raw.split("\n").filter(Boolean), "");
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
        {isLoading ? (
          <div className="px-3 py-2 text-text-muted">Loading…</div>
        ) : searchQuery.trim() ? (
          /* ── Flat search results ─────────────────────────────── */
          <FlatSearch
            nodes={data?.tree ?? []}
            query={searchQuery.trim()}
            onSelect={onSelect}
            activePath={activePath}
          />
        ) : (
          /* ── Grouped tree ────────────────────────────────────── */
          <GroupedTree
            nodes={data?.tree ?? []}
            onSelect={onSelect}
            activePath={activePath}
            onDelete={handleDelete}
            onRename={handleRename}
            onMove={handleMove}
            selected={selectedPaths}
            onToggleSelect={toggleSelect}
            onClearSelection={clearSelection}
            onRangeSelect={rangeSelect}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            workspaceId={workspaceId}
          />
        )}
      </div>
    </div>
  );
}

function WorkspaceSidePanel({
  workspaceId,
  tab,
  onTabChange,
  onSelect,
  activePath,
  confirm,
  onOpenTool,
}: {
  workspaceId: string;
  tab: "files" | "library";
  onTabChange: (tab: "files" | "library") => void;
  onSelect: (path: string) => void;
  activePath: string | null;
  confirm: (options: any) => Promise<boolean>;
  onOpenTool: (tool: WorkspaceTool) => void;
}) {
  const libraryItems: Array<{ id: WorkspaceTool; label: string; description: string; icon: React.ReactNode }> = [
    { id: "console", label: "Tools", description: "Workflows and logs", icon: <Layers size={14} /> },
    { id: "preview", label: "Preview", description: "Live app preview", icon: <Eye size={14} /> },
    { id: "terminal", label: "Shell", description: "Workspace terminal", icon: <Terminal size={14} /> },
    { id: "database", label: "Database", description: "Workspace data", icon: <Database size={14} /> },
    { id: "cron", label: "Cron Jobs", description: "Scheduled tasks", icon: <Clock size={14} /> },
    { id: "git", label: "Git", description: "Changes and history", icon: <GitBranch size={14} /> },
    { id: "secrets", label: "Secrets", description: "Environment variables", icon: <Lock size={14} /> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-panel">
      <div className="flex shrink-0 items-center gap-1 border-b border-bg-border bg-bg-subtle/80 px-2 py-1.5">
        <button
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition ${
            tab === "library" ? "bg-bg text-text shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text"
          }`}
          onClick={() => onTabChange("library")}
        >
          <LayoutGrid size={12} /> Tools
        </button>
        <button
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition ${
            tab === "files" ? "bg-bg text-text shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text"
          }`}
          onClick={() => onTabChange("files")}
        >
          <FileSearch size={12} /> Files
        </button>
      </div>
      {tab === "files" ? (
        <div className="min-h-0 flex-1">
          <FileTree
            workspaceId={workspaceId}
            confirm={confirm}
            onSelect={onSelect}
            activePath={activePath}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="mb-2 px-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
            Workspace tools
          </div>
          <div className="space-y-1">
            {libraryItems.map((item) => (
              <button
                key={item.id}
                className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-2.5 py-2.5 text-left transition hover:border-bg-border hover:bg-bg-hover"
                onClick={() => onOpenTool(item.id)}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/10 text-accent transition group-hover:bg-accent/20">
                  {item.icon}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-text">{item.label}</span>
                  <span className="block truncate text-[10px] text-text-muted">{item.description}</span>
                </span>
                <ChevronRight size={12} className="ml-auto shrink-0 text-text-subtle opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-bg-border/70 bg-bg-subtle/60 p-3 text-[10px] leading-relaxed text-text-muted">
             Semua tool dibuka sebagai tab workspace. Gunakan Files untuk tree, atau pilih tool untuk menampilkannya di area kerja utama.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Image preview with error handling ────────────────────────────────────────
function ImagePreview({ workspaceId, path: filePath }: { workspaceId: string; path: string }) {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const src = `/api/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(filePath)}`;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto bg-[#1e1e1e] p-6">
      {status === "error" ? (
        <div className="flex flex-col items-center gap-2 text-center">
          <FileIcon size={36} className="text-text-subtle" />
          <p className="text-sm text-danger">Gambar gagal dimuat</p>
          <p className="text-xs text-text-muted">{filePath}</p>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="mt-1 text-xs text-accent underline"
          >
            Coba buka langsung →
          </a>
        </div>
      ) : (
        <img
          src={src}
          alt={filePath}
          className={`max-h-full max-w-full rounded object-contain shadow-lg transition-opacity ${status === "ok" ? "opacity-100" : "opacity-0"}`}
          style={{ imageRendering: "pixelated" }}
          onLoad={() => setStatus("ok")}
          onError={() => setStatus("error")}
        />
      )}
      {status === "ok" && (
        <p className="text-xs text-text-muted">{filePath.split("/").pop()}</p>
      )}
    </div>
  );
}

function PdfPreview({ workspaceId, path: filePath }: { workspaceId: string; path: string }) {
  const src = `/api/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(filePath)}`;
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#202124]">
      <div className="flex shrink-0 items-center gap-2 border-b border-bg-border bg-bg-subtle px-3 py-2 text-xs">
        <span className="font-medium text-text">{filePath.split("/").pop()}</span>
        <a href={src} target="_blank" rel="noreferrer" className="ml-auto text-accent hover:underline">
          Open externally
        </a>
      </div>
      <iframe title={filePath} src={src} className="min-h-0 flex-1 bg-white" />
    </div>
  );
}

function BinaryFilePreview({ workspaceId, path: filePath }: { workspaceId: string; path: string }) {
  const rawUrl = `/api/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(filePath)}`;
  return (
    <div className="grid h-full place-items-center bg-bg text-center">
      <div className="max-w-sm px-6">
        <Package size={36} className="mx-auto mb-3 text-text-subtle" />
        <p className="text-sm font-medium text-text">File binary tidak dibuka sebagai teks</p>
        <p className="mt-1 break-all text-xs text-text-muted">{filePath}</p>
        <p className="mt-3 text-xs leading-relaxed text-text-muted">
          File ini tetap aman di workspace. Gunakan download atau viewer khusus jika tersedia.
        </p>
        <a
          href={`${rawUrl}&download=1`}
          download={filePath.split("/").pop()}
          className="mt-4 inline-flex rounded-md border border-bg-border px-3 py-1.5 text-xs text-text-muted transition hover:border-accent/50 hover:text-text"
        >
          Download file
        </a>
      </div>
    </div>
  );
}

function SplitFilePane({
  workspaceId,
  path: filePath,
  active,
  onActivate,
  onClose,
  onOpenMain,
  editorTheme,
  fontSize,
  wordWrap,
}: {
  workspaceId: string;
  path: string;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onOpenMain: () => void;
  editorTheme: "vs-dark" | "vs";
  fontSize: number;
  wordWrap: "off" | "on";
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["workspace-file-split", workspaceId, filePath],
    queryFn: () => API.get<{ content: string }>(
      `/workspaces/${workspaceId}/files?path=${encodeURIComponent(filePath)}`,
    ),
  });

  return (
    <div className={`flex h-full min-h-0 flex-col ${active ? "ring-1 ring-inset ring-accent/40" : ""}`} onClick={onActivate}>
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-bg-border bg-bg-subtle px-2 py-1.5">
        {getFileIcon(filePath.split("/").pop() ?? filePath, 11)}
        <span className="min-w-0 flex-1 truncate text-[11px] text-text" title={filePath}>{filePath}</span>
        <button className="btn-ghost shrink-0 p-1" onClick={(event) => { event.stopPropagation(); onOpenMain(); }} title="Open in main editor">
          <ExternalLink size={11} />
        </button>
        <button className="btn-ghost shrink-0 p-1" onClick={(event) => { event.stopPropagation(); onClose(); }} title="Close pane">
          <X size={11} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {isImageFile(filePath) ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-[#1e1e1e] p-4">
            <img
              src={`/api/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(filePath)}`}
              alt={filePath}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : isPdfFile(filePath) ? (
          <PdfPreview workspaceId={workspaceId} path={filePath} />
        ) : isBinaryFile(filePath) ? (
          <BinaryFilePreview workspaceId={workspaceId} path={filePath} />
        ) : isLoading ? (
          <div className="grid h-full place-items-center text-xs text-text-muted">
            <Loader2 size={14} className="mr-2 inline animate-spin text-accent" /> Loading…
          </div>
        ) : (
          <Editor
            height="100%"
            theme={editorTheme}
            path={`split:${filePath}`}
            value={data?.content ?? ""}
            options={{
              fontSize,
              fontFamily: "JetBrains Mono, Fira Code, Menlo, monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              readOnly: true,
              wordWrap,
            }}
          />
        )}
      </div>
    </div>
  );
}

const DND_MIME = "application/x-premdev-path";

// ── File-type icon helpers ────────────────────────────────────────────────────
function LangIcon({ text, bg, fg = "#fff", size = 12 }: { text: string; bg: string; fg?: string; size?: number }) {
  const fs = Math.max(5, Math.floor(size * 0.52));
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: size, height: size, borderRadius: 2,
      backgroundColor: bg, color: fg,
      fontSize: fs, fontWeight: 700,
      fontFamily: "ui-monospace,monospace",
      lineHeight: 1, flexShrink: 0, letterSpacing: "-0.5px",
      userSelect: "none",
    }}>
      {text}
    </span>
  );
}

function PremDevIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
      <rect x="0.5" y="0.5" width="11" height="4.5" rx="1.2" fill="#444" stroke="#777" strokeWidth="0.6"/>
      <circle cx="9" cy="2.75" r="0.85" fill="#aaa"/>
      <circle cx="7" cy="2.75" r="0.85" fill="#888"/>
      <rect x="1.5" y="2.2" width="3.5" height="1.1" rx="0.5" fill="#666"/>
      <rect x="0.5" y="7" width="11" height="4.5" rx="1.2" fill="#444" stroke="#777" strokeWidth="0.6"/>
      <circle cx="9" cy="9.25" r="0.85" fill="#aaa"/>
      <circle cx="7" cy="9.25" r="0.85" fill="#888"/>
      <rect x="1.5" y="8.7" width="3.5" height="1.1" rx="0.5" fill="#666"/>
    </svg>
  );
}

function getFileIcon(filename: string, size = 12): React.ReactNode {
  const lower = filename.toLowerCase();
  const dotIdx = lower.lastIndexOf(".");
  const ext = dotIdx >= 0 ? lower.slice(dotIdx) : "";
  if (lower === ".premdev") return <PremDevIcon size={size} />;
  switch (ext) {
    case ".py":     return <LangIcon text="py"  bg="#3776AB" size={size} />;
    case ".php":    return <LangIcon text="php" bg="#8892BF" size={size} />;
    case ".js": case ".mjs": case ".cjs":
                    return <LangIcon text="JS"  bg="#F7DF1E" fg="#000" size={size} />;
    case ".ts": case ".mts": case ".cts":
                    return <LangIcon text="TS"  bg="#3178C6" size={size} />;
    case ".jsx":    return <LangIcon text="JSX" bg="#61DAFB" fg="#000" size={size} />;
    case ".tsx":    return <LangIcon text="TSX" bg="#61DAFB" fg="#000" size={size} />;
    case ".json": case ".jsonc":
                    return <LangIcon text="{}"  bg="#F7A800" fg="#000" size={size} />;
    case ".html": case ".htm":
                    return <LangIcon text="HTM" bg="#E44D26" size={size} />;
    case ".css":    return <LangIcon text="CSS" bg="#264DE4" size={size} />;
    case ".scss": case ".sass":
                    return <LangIcon text="SCS" bg="#CC6699" size={size} />;
    case ".md": case ".mdx":
                    return <LangIcon text="MD"  bg="#555"    size={size} />;
    case ".sh": case ".bash": case ".zsh": case ".fish":
                    return <LangIcon text="SH"  bg="#4EAA25" size={size} />;
    case ".sql":    return <LangIcon text="SQL" bg="#00758F" size={size} />;
    case ".yml": case ".yaml":
                    return <LangIcon text="YML" bg="#CB171E" size={size} />;
    case ".toml":   return <LangIcon text="TML" bg="#9C4121" size={size} />;
    case ".env":    return <LangIcon text="ENV" bg="#7C3AED" size={size} />;
    case ".xml":    return <LangIcon text="XML" bg="#F56640" size={size} />;
    case ".go":     return <LangIcon text="Go"  bg="#00ACD7" size={size} />;
    case ".rs":     return <LangIcon text="RS"  bg="#CE422B" size={size} />;
    case ".java":   return <LangIcon text="JAV" bg="#007396" size={size} />;
    case ".rb":     return <LangIcon text="RB"  bg="#CC342D" size={size} />;
    case ".lua":    return <LangIcon text="LUA" bg="#2C2D72" size={size} />;
    case ".dart":   return <LangIcon text="DRT" bg="#0175C2" size={size} />;
    case ".vue":    return <LangIcon text="VUE" bg="#42B883" size={size} />;
    case ".svelte": return <LangIcon text="SVL" bg="#FF3E00" size={size} />;
    case ".log":    return <LangIcon text="LOG" bg="#666"    size={size} />;
    case ".txt":    return <LangIcon text="TXT" bg="#888"    size={size} />;
    case ".png": case ".jpg": case ".jpeg": case ".gif":
    case ".webp": case ".svg": case ".ico": case ".bmp": case ".tiff":
                    return <LangIcon text="IMG" bg="#8B5CF6" size={size} />;
    case ".zip": case ".tar": case ".gz": case ".rar": case ".7z":
                    return <LangIcon text="ZIP" bg="#F59E0B" fg="#000" size={size} />;
    case ".pdf":    return <LangIcon text="PDF" bg="#E53E3E" size={size} />;
    default:
      return <FileIcon size={size} className="text-text-muted" style={{ flexShrink: 0 }} />;
  }
}

function Tree({
  nodes, depth, onSelect, activePath, onDelete, onRename, onMove,
  selected, onToggleSelect, onClearSelection, onRangeSelect,
  expanded, onToggleExpand, workspaceId,
}: any) {
  return (
    <ul>
      {nodes.map((n: FileNode) => (
        <NodeRow
          key={n.path}
          node={n}
          depth={depth}
          onSelect={onSelect}
          activePath={activePath}
          onDelete={onDelete}
          onRename={onRename}
          onMove={onMove}
          selected={selected}
          onToggleSelect={onToggleSelect}
          onClearSelection={onClearSelection}
          onRangeSelect={onRangeSelect}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          workspaceId={workspaceId}
        />
      ))}
    </ul>
  );
}

function NodeRow({
  node, depth, onSelect, activePath, onDelete, onRename, onMove,
  selected, onToggleSelect, onClearSelection, onRangeSelect,
  expanded, onToggleExpand, workspaceId,
}: any) {
  const open: boolean = expanded?.has(node.path) ?? false;
  const [dragOver, setDragOver] = useState(false);
  const isActive = activePath === node.path;
  const isSelected: boolean = selected?.has(node.path) ?? false;

  // ── Inline rename ──────────────────────────────────────────────────────────
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) renameInputRef.current?.focus(); }, [renaming]);

  function startRename(e: React.MouseEvent) {
    e.stopPropagation();
    setRenameVal(node.name);
    setRenaming(true);
  }
  async function commitRename() {
    const trimmed = renameVal.trim();
    setRenaming(false);
    if (!trimmed || trimmed === node.name) return;
    const lastSlash = node.path.lastIndexOf("/");
    const dirPrefix = lastSlash >= 0 ? node.path.slice(0, lastSlash + 1) : "";
    await onRename(node.path, dirPrefix + trimmed);
  }
  function onRenameKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") { e.stopPropagation(); setRenaming(false); }
  }

  function startDrag(e: React.DragEvent) {
    e.stopPropagation();
    // If the dragged item is part of the multi-selection, transfer ALL
    // selected paths (newline-separated). Otherwise transfer just this one
    // and clear any prior selection so behaviour stays predictable.
    let payload: string;
    if (isSelected && selected && selected.size > 1) {
      payload = Array.from(selected as Set<string>).join("\n");
    } else {
      payload = node.path;
      onClearSelection?.();
    }
    e.dataTransfer.setData(DND_MIME, payload);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleRowClick(e: React.MouseEvent, primary: () => void) {
    // Shift takes priority over Ctrl/Cmd so that Shift+Cmd still extends the
    // range (matching Finder/Explorer/VSCode behaviour).
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      // Block the browser's native text selection that Shift-click would draw.
      window.getSelection?.()?.removeAllRanges();
      onRangeSelect?.(node.path);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect?.(node.path, true);
      return;
    }
    onClearSelection?.();
    primary();
  }

  if (node.type === "dir") {
    return (
      <li>
        <div
          draggable
          onDragStart={startDrag}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DND_MIME)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            if (!dragOver) {
              setDragOver(true);
              // Auto-expand closed folder after hovering 600 ms so the user
              // can drag into a subfolder without having to expand it first.
              if (!open) {
                const t = window.setTimeout(() => onToggleExpand?.(node.path), 600);
                (e.currentTarget as HTMLElement).dataset.expandTimer = String(t);
              }
            }
          }}
          onDragLeave={(e) => {
            setDragOver(false);
            const t = (e.currentTarget as HTMLElement).dataset.expandTimer;
            if (t) { clearTimeout(Number(t)); delete (e.currentTarget as HTMLElement).dataset.expandTimer; }
          }}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData(DND_MIME);
            setDragOver(false);
            const t = (e.currentTarget as HTMLElement).dataset.expandTimer;
            if (t) { clearTimeout(Number(t)); delete (e.currentTarget as HTMLElement).dataset.expandTimer; }
            if (!raw) return;
            e.preventDefault();
            e.stopPropagation();
            onMove(raw.split("\n").filter(Boolean), node.path);
          }}
          className={`group mx-1 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 hover:bg-bg-hover ${
            isActive ? "bg-bg-hover text-text" : ""
          } ${isSelected ? "bg-accent/15" : ""} ${
            dragOver ? "ring-1 ring-accent bg-accent/10" : ""
          }`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={(e) => handleRowClick(e, () => onToggleExpand?.(node.path))}
        >
          {open ? (
            <ChevronDown size={12} className="text-text-muted" />
          ) : (
            <ChevronRight size={12} className="text-text-muted" />
          )}
          <Folder size={12} className="text-accent shrink-0" />
          {renaming ? (
            <input
              ref={renameInputRef}
              className="flex-1 min-w-0 bg-bg border border-accent rounded px-1 text-xs text-text outline-none"
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={onRenameKeyDown}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="truncate">{node.name}</span>
          )}
          <div className="ml-auto hidden gap-0.5 group-hover:flex">
            <button
              className="p-0.5 text-text-muted hover:text-accent"
              title="Pindahkan (move)"
              onClick={(e) => {
                e.stopPropagation();
                const parent = node.path.includes("/") ? node.path.split("/").slice(0, -1).join("/") + "/" : "";
                const dest = window.prompt(`Pindahkan "${node.name}" ke path tujuan:\n(Contoh: folder-lain/${node.name})`, parent + node.name);
                if (dest !== null && dest.trim() && dest.trim() !== node.path) {
                  onRename(node.path, dest.trim());
                }
              }}
            >
              <FolderInput size={10} />
            </button>
            <button
              className="p-0.5 text-text-muted hover:text-text"
              title="Rename (F2)"
              onClick={startRename}
            >
              <Pencil size={10} />
            </button>
            <button
              className="p-0.5 text-text-muted hover:text-danger"
              title="Delete"
              onClick={(e) => { e.stopPropagation(); onDelete(node.path); }}
            >
              <Trash2 size={10} />
            </button>
          </div>
        </div>
        {open && node.children && (
          <Tree
            nodes={node.children}
            depth={depth + 1}
            onSelect={onSelect}
            activePath={activePath}
            onDelete={onDelete}
            onRename={onRename}
            onMove={onMove}
            selected={selected}
            onToggleSelect={onToggleSelect}
            onClearSelection={onClearSelection}
            onRangeSelect={onRangeSelect}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
          />
        )}
      </li>
    );
  }
  return (
    <li>
      <div
        draggable
        onDragStart={startDrag}
          className={`group mx-1 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 hover:bg-bg-hover ${
            isActive ? "bg-accent/15 text-accent" : ""
        } ${isSelected ? "bg-accent/15" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 + 12 }}
        onClick={(e) => handleRowClick(e, () => onSelect(node.path))}
      >
        {getFileIcon(node.name, 12)}
        {renaming ? (
          <input
            ref={renameInputRef}
            className="flex-1 min-w-0 bg-bg border border-accent rounded px-1 text-xs text-text outline-none"
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={onRenameKeyDown}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
        <div className="ml-auto hidden gap-0.5 group-hover:flex">
          <button
            className="p-0.5 text-text-muted hover:text-accent"
            title="Explain this file with AI"
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent("premdev:ai:prefill", {
                detail: {
                  text: `Explain what \`${node.path}\` does, its public API, and how it interacts with the rest of the project. Don't change anything.`,
                  send: true,
                },
              }));
            }}
          >
            <Sparkles size={10} />
          </button>
          <a
            href={`/api/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(node.path)}&download=1`}
            download={node.name}
            className="p-0.5 text-text-muted hover:text-text"
            title="Download file"
            onClick={(e) => e.stopPropagation()}
          >
            <Download size={10} />
          </a>
          <button
            className="p-0.5 text-text-muted hover:text-accent"
            title="Pindahkan (move)"
            onClick={(e) => {
              e.stopPropagation();
              const parent = node.path.includes("/") ? node.path.split("/").slice(0, -1).join("/") + "/" : "";
              const dest = window.prompt(`Pindahkan "${node.name}" ke path tujuan:\n(Contoh: folder-lain/${node.name})`, parent + node.name);
              if (dest !== null && dest.trim() && dest.trim() !== node.path) {
                onRename(node.path, dest.trim());
              }
            }}
          >
            <FolderInput size={10} />
          </button>
          <button
            className="p-0.5 text-text-muted hover:text-text"
            title="Rename (F2)"
            onClick={startRename}
          >
            <Pencil size={10} />
          </button>
          <button
            className="p-0.5 text-text-muted hover:text-danger"
            title="Delete"
            onClick={(e) => { e.stopPropagation(); onDelete(node.path); }}
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
    </li>
  );
}

// ── Constant sets for Config / Packager file grouping ──────────────────────
const PACKAGER_FILES = new Set([
  "package.json","package-lock.json","yarn.lock","pnpm-lock.yaml","bun.lockb",
  "requirements.txt","Pipfile","Pipfile.lock","pyproject.toml","uv.lock","setup.py","setup.cfg",
  "go.mod","go.sum","Cargo.toml","Cargo.lock",
  "Gemfile","Gemfile.lock","composer.json","composer.lock",
  "pom.xml","build.gradle","build.gradle.kts","settings.gradle","settings.gradle.kts",
  "pubspec.yaml","pubspec.lock","mix.exs","mix.lock",
]);

const PACKAGER_DIRS = new Set([
  "node_modules","vendor",".bundle","venv",".venv",".pythonlibs",
  "__pycache__",".cargo","bower_components",
]);

const CONFIG_FILES = new Set([
  ".replit",".env",".env.local",".env.example",".env.production",
  ".gitignore",".gitattributes",".gitmodules",
  "tsconfig.json","tsconfig.base.json","jsconfig.json",
  ".eslintrc",".eslintrc.json",".eslintrc.js",".eslintrc.cjs",
  ".prettierrc",".prettierrc.json",".prettierrc.js",".prettierignore",
  ".babelrc","babel.config.js","babel.config.ts",
  "vite.config.ts","vite.config.js","vite.config.mts",
  "webpack.config.js","webpack.config.ts",
  "Dockerfile","docker-compose.yml","docker-compose.yaml",".dockerignore",
  ".premdev","alur.md","README.md","LICENSE",
  "tailwind.config.js","tailwind.config.ts","postcss.config.js","postcss.config.ts",
  "next.config.js","next.config.ts","nuxt.config.ts","svelte.config.js",
  ".editorconfig",".nvmrc",".tool-versions","Makefile","makefile",
]);

function isPackagerItem(name: string, type: "file" | "dir"): boolean {
  if (type === "dir") return PACKAGER_DIRS.has(name);
  if (PACKAGER_FILES.has(name)) return true;
  // any .lock file
  if (name.endsWith(".lock") || name.endsWith(".lockb")) return true;
  return false;
}

function isConfigItem(name: string, type: "file" | "dir"): boolean {
  if (type === "dir") return false;
  if (isPackagerItem(name, type)) return false;
  if (CONFIG_FILES.has(name)) return true;
  // *.config.{js,ts,mjs,cjs,mts}
  if (/\.config\.(js|ts|mjs|cjs|mts)$/.test(name)) return true;
  // any dotenv file: .env, .env.staging, .env.prod.local, etc.
  if (/^\.env/.test(name)) return true;
  return false;
}

// ── Flatten a file tree into a flat list (for search) ──────────────────────
function flattenNodes(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  function walk(ns: FileNode[]) {
    for (const n of ns) {
      result.push(n);
      if (n.children) walk(n.children);
    }
  }
  walk(nodes);
  return result;
}

// ── FlatSearch — shows filtered flat list when search query is active ───────
function FlatSearch({
  nodes, query, onSelect, activePath,
}: { nodes: FileNode[]; query: string; onSelect: (p: string) => void; activePath: string | null }) {
  const q = query.toLowerCase();
  const all = flattenNodes(nodes);
  const matches = all.filter((n) => n.type === "file" && n.name.toLowerCase().includes(q));
  if (matches.length === 0) {
    return <div className="px-3 py-2 text-xs text-text-muted">No files matching "{query}"</div>;
  }
  return (
    <ul>
      {matches.map((n) => (
        <li
          key={n.path}
          className={`flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-bg-hover ${activePath===n.path?"bg-bg-hover text-accent":""}`}
          onClick={() => onSelect(n.path)}
        >
          {getFileIcon(n.name, 11)}
          <span className="min-w-0 truncate text-text">{n.name}</span>
          <span className="ml-auto shrink-0 truncate text-[10px] text-text-muted">{n.path}</span>
        </li>
      ))}
    </ul>
  );
}

// ── GroupedTree — root-level files split into main / config / packager ──────
function GroupedTree({
  nodes, onSelect, activePath, onDelete, onRename, onMove,
  selected, onToggleSelect, onClearSelection, onRangeSelect,
  expanded, onToggleExpand, workspaceId,
}: any) {
  const packagerItems = nodes.filter((n: FileNode) => isPackagerItem(n.name, n.type));
  const configItems   = nodes.filter((n: FileNode) => isConfigItem(n.name, n.type));
  const mainItems     = nodes.filter((n: FileNode) => !isPackagerItem(n.name, n.type) && !isConfigItem(n.name, n.type));

  const treeProps = { onSelect, activePath, onDelete, onRename, onMove, selected, onToggleSelect, onClearSelection, onRangeSelect, expanded, onToggleExpand, workspaceId };

  function Section({ label, icon, items }: { label: string; icon: React.ReactNode; items: FileNode[] }) {
    const [open, setOpen] = useState(true);
    if (items.length === 0) return null;
    return (
      <div className="mt-1">
        <button
          className="flex w-full items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted hover:text-text"
          onClick={() => setOpen(v=>!v)}
        >
          {open ? <ChevronDown size={9}/> : <ChevronRight size={9}/>}
          {icon}
          {label}
        </button>
        {open && (
          <Tree nodes={items} depth={0} {...treeProps} />
        )}
      </div>
    );
  }

  return (
    <>
      <Tree nodes={mainItems} depth={0} {...treeProps} />
      <Section label="Config files" icon={<SlidersHorizontal size={9}/>} items={configItems} />
      <Section label="Packager files" icon={<Package size={9}/>} items={packagerItems} />
    </>
  );
}

// ── NewTabPage — Replit-style launcher shown when "+" tab is clicked ────────
function NewTabPage({
  workspaceId, openTabs, activePath, onOpenFile, onOpenTool, bottomTab, recentFiles,
}: {
  workspaceId: string;
  openTabs: string[];
  activePath: string | null;
  onOpenFile: (p: string) => void;
  onOpenTool: (t: WorkspaceTool) => void;
  bottomTab: "console" | "terminal" | "preview" | "database";
  recentFiles?: string[];
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery({
    queryKey: ["files", workspaceId, false],
    queryFn: () => API.get<{ tree: FileNode[] }>(`/workspaces/${workspaceId}/tree`),
    staleTime: 30_000,
  });

  useEffect(() => { inputRef.current?.focus(); }, []);

  const allFiles = flattenNodes(data?.tree ?? []).filter((n) => n.type === "file");
  const lower = q.toLowerCase();
  const fileResults = lower.length > 0
    ? allFiles.filter((n) => n.path.toLowerCase().includes(lower)).slice(0, 12)
    : [];

  const TOOLS: { id: WorkspaceTool; label: string; desc: string; icon: React.ReactNode }[] = [
    { id: "console",  label: "Tools", desc: "Workflows and logs",                    icon: <Layers size={18} /> },
    { id: "preview",  label: "Preview", desc: "Live preview of your running app",    icon: <Eye size={18} /> },
    { id: "terminal", label: "Shell", desc: "Shell akses langsung ke workspace",      icon: <Terminal size={18} /> },
    { id: "database", label: "Database", desc: "Query your workspace database",       icon: <Database size={18} /> },
    { id: "cron",     label: "Cron Jobs", desc: "Scheduled workspace tasks",          icon: <Clock size={18} /> },
    { id: "git",      label: "Git", desc: "Changes, commits, and history",            icon: <GitBranch size={18} /> },
    { id: "secrets",  label: "Secrets", desc: "Workspace environment variables",     icon: <Lock size={18} /> },
  ];

  return (
    <div className="flex h-full flex-col items-center overflow-auto bg-bg px-4 py-10">
      <div className="w-full max-w-xl">
        {/* Search box */}
        <div className="flex items-center gap-2 rounded-lg border border-bg-border bg-bg-subtle px-3 py-2 shadow-sm focus-within:border-accent">
          <Search size={15} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search for tools & files…"
            className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
          />
          {q && (
            <button onClick={() => setQ("")} className="text-text-muted hover:text-text">
              <X size={13} />
            </button>
          )}
        </div>

        {/* File search results */}
        {fileResults.length > 0 && (
          <section className="mt-5">
            <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Files</h3>
            <div className="rounded-lg border border-bg-border overflow-hidden">
              {fileResults.map((n, i) => (
                <button
                  key={n.path}
                  onClick={() => onOpenFile(n.path)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-sm hover:bg-bg-hover ${i > 0 ? "border-t border-bg-border" : ""}`}
                >
                  <FileIcon size={14} className="shrink-0 text-text-muted" />
                  <span className="font-medium text-text">{n.name}</span>
                  <span className="ml-auto truncate text-xs text-text-muted">{n.path}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* No results */}
        {q && fileResults.length === 0 && (
          <p className="mt-6 text-center text-sm text-text-muted">No files found matching "{q}"</p>
        )}

        {/* Recent files */}
        {!q && recentFiles && recentFiles.length > 0 && (
          <section className="mt-6">
            <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Recent files</h3>
            <div className="rounded-lg border border-bg-border overflow-hidden">
              {recentFiles.filter((f) => !openTabs.includes(f) || f !== activePath).slice(0, 8).map((t, i) => (
                <button
                  key={t}
                  onClick={() => onOpenFile(t)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-sm hover:bg-bg-hover ${i > 0 ? "border-t border-bg-border" : ""}`}
                >
                  {getFileIcon(t.split("/").pop() ?? t, 14)}
                  <span className="font-medium text-text">{t.split("/").pop()}</span>
                  <span className="ml-auto truncate text-xs text-text-muted">{t}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Jump to existing tab */}
        {!q && openTabs.length > 0 && (
          <section className="mt-6">
            <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Jump to existing tab</h3>
            <div className="rounded-lg border border-bg-border overflow-hidden">
              {openTabs.map((t, i) => {
                const isAct = t === activePath;
                return (
                  <button
                    key={t}
                    onClick={() => onOpenFile(t)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-sm hover:bg-bg-hover ${i > 0 ? "border-t border-bg-border" : ""} ${isAct ? "bg-bg-hover" : ""}`}
                  >
                    <FileIcon size={14} className="shrink-0 text-text-muted" />
                    <span className="font-medium text-text">{t.split("/").pop()}</span>
                    <span className="ml-auto truncate text-xs text-text-muted">{t}</span>
                    {isAct && <span className="ml-2 shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">active</span>}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Suggested tools */}
        {!q && (
          <section className="mt-6">
            <h3 className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Suggested</h3>
            <div className="rounded-lg border border-bg-border overflow-hidden">
              {TOOLS.map((tool, i) => {
                const isActive = bottomTab === tool.id;
                return (
                  <button
                    key={tool.id}
                    onClick={() => onOpenTool(tool.id)}
                    className={`flex w-full items-center gap-4 px-4 py-3 text-sm hover:bg-bg-hover ${i > 0 ? "border-t border-bg-border" : ""} ${isActive ? "bg-bg-hover" : ""}`}
                  >
                    <span className={`shrink-0 ${isActive ? "text-accent" : "text-text-muted"}`}>{tool.icon}</span>
                    <div className="flex flex-col items-start gap-0.5">
                      <span className="font-semibold text-text">{tool.label}</span>
                      <span className="text-xs text-text-muted">{tool.desc}</span>
                    </div>
                    {isActive && <Zap size={12} className="ml-auto shrink-0 text-accent" />}
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function WorkspaceTabBar({
  openTabs,
  activePath,
  newTabOpen,
  bottomTab,
  sidePanelTab,
  showAI,
  showCronJobs,
  onOpenFiles,
  onOpenAI,
  onOpenCron,
  onOpenSplit,
  onOpenTool,
  onOpenFile,
  onCloseFile,
  onNewTab,
  onCloseNewTab,
  dirty,
}: {
  openTabs: string[];
  activePath: string | null;
  newTabOpen: boolean;
  bottomTab: "console" | "terminal" | "preview" | "database";
  sidePanelTab: "files" | "library";
  showAI: boolean;
  showCronJobs: boolean;
  onOpenFiles: () => void;
  onOpenAI: () => void;
  onOpenCron: () => void;
  onOpenSplit: (path: string) => void;
  onOpenTool: (tool: WorkspaceTool) => void;
  onOpenFile: (path: string) => void;
  onCloseFile: (path: string, event: React.MouseEvent) => void;
  onNewTab: () => void;
  onCloseNewTab: () => void;
  dirty: boolean;
}) {
  const workspaceTabs: Array<{
    id: string;
    label: string;
    icon: React.ReactNode;
    active: boolean;
    onClick: () => void;
  }> = [
    { id: "ai", label: "AI", icon: <Sparkles size={11} />, active: showAI, onClick: onOpenAI },
    { id: "files", label: "Files", icon: <FileSearch size={11} />, active: sidePanelTab === "files", onClick: onOpenFiles },
  ];
  const toolTabs: Array<{ id: WorkspaceTool; label: string; icon: React.ReactNode; active: boolean }> = [
    { id: "console", label: "Tools", icon: <Layers size={11} />, active: bottomTab === "console" },
    { id: "preview", label: "Preview", icon: <Eye size={11} />, active: bottomTab === "preview" },
    { id: "terminal", label: "Shell", icon: <Terminal size={11} />, active: bottomTab === "terminal" },
    { id: "database", label: "Database", icon: <Database size={11} />, active: bottomTab === "database" },
  ];
  return (
    <div className="flex min-w-0 shrink-0 overflow-x-auto border-b border-bg-border bg-bg-subtle/80" style={{ scrollbarWidth: "thin" }}>
      {workspaceTabs.map((tab) => (
        <button
          key={tab.id}
          onClick={tab.onClick}
          className={`flex shrink-0 items-center gap-1.5 border-r border-bg-border px-3 py-2 text-[11px] font-medium transition ${
            tab.active ? "bg-bg text-text" : "text-text-muted hover:bg-bg-hover hover:text-text"
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
      <button
        onClick={onOpenCron}
        className={`flex shrink-0 items-center gap-1.5 border-r border-bg-border px-3 py-2 text-[11px] font-medium transition ${
          showCronJobs ? "bg-bg text-text" : "text-text-muted hover:bg-bg-hover hover:text-text"
        }`}
      >
        <Clock size={11} />
        Cron Jobs
      </button>
      <div className="mx-1 my-1 w-px shrink-0 bg-bg-border" />
      {toolTabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onOpenTool(tab.id)}
          className={`flex shrink-0 items-center gap-1.5 border-r border-bg-border px-3 py-2 text-[11px] font-medium transition ${
            tab.active ? "bg-bg text-text" : "text-text-muted hover:bg-bg-hover hover:text-text"
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
      <div className="mx-1 my-1 w-px shrink-0 bg-bg-border" />
      {openTabs.map((tab) => {
        const fileName = tab.split("/").pop() ?? tab;
        const isActive = activePath === tab && !newTabOpen;
        const isDirtyTab = activePath === tab && dirty;
        return (
          <button
            key={tab}
            onClick={() => onOpenFile(tab)}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(DND_MIME, tab);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source = event.dataTransfer.getData(DND_MIME);
              if (source && source !== tab) onOpenSplit(source);
            }}
            title={tab}
            className={`group flex min-w-0 max-w-[190px] shrink-0 items-center gap-1.5 border-r border-bg-border border-t-2 px-3 py-2 text-[11px] transition-colors ${
              isActive ? "border-t-accent bg-bg text-text" : "border-t-transparent text-text-muted hover:bg-bg hover:text-text"
            }`}
          >
            {isDirtyTab && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}
            {getFileIcon(fileName, 11)}
            <span className="max-w-[140px] truncate">{fileName}</span>
            <span
              role="button"
              onClick={(event) => onCloseFile(tab, event)}
              className="ml-0.5 shrink-0 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:bg-bg-border hover:text-text group-hover:opacity-100"
              title="Tutup tab"
            >
              <X size={10} />
            </span>
          </button>
        );
      })}
      {newTabOpen && (
        <button className="group flex shrink-0 items-center gap-1.5 border-r border-bg-border border-t-2 border-t-accent bg-bg px-3 py-2 text-[11px] text-text">
          <Plus size={10} className="text-text-muted" />
          New Tab
          <span
            role="button"
            onClick={onCloseNewTab}
            className="ml-0.5 rounded p-0.5 text-text-muted opacity-0 hover:bg-bg-border hover:text-text group-hover:opacity-100"
          >
            <X size={10} />
          </span>
        </button>
      )}
      <button
        onClick={onNewTab}
        className="flex shrink-0 items-center border-t-2 border-t-transparent px-2.5 py-2 text-text-muted hover:bg-bg-hover hover:text-text"
        title="New Tab"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

// ── CommandPalette — Ctrl+K / Ctrl+P quick-open overlay ────────────────────
function CommandPalette({
  workspaceId, activePath, onSelect, onClose,
}: { workspaceId: string; activePath: string | null; onSelect: (p: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery({
    queryKey: ["files", workspaceId, true],
    queryFn: () => API.get<{ tree: FileNode[] }>(`/workspaces/${workspaceId}/tree?showHidden=1`),
  });
  const all = flattenNodes(data?.tree ?? []).filter((n) => n.type === "file");
  const q = query.toLowerCase();
  const results = q
    ? all.filter((n) => n.path.toLowerCase().includes(q))
    : all.filter((n) => n.path !== activePath).slice(0, 30);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setCursor(0); }, [query]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === "Enter" && results[cursor]) onSelect(results[cursor].path);
    if (e.key === "Escape") onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-bg-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-bg-border px-3 py-2">
          <Search size={14} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search files… (Ctrl+K)"
            className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
          />
          <kbd className="rounded bg-bg-subtle px-1 py-0.5 text-[10px] text-text-muted">Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-auto py-1">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-text-muted">No files found</li>
          ) : results.map((n, i) => (
            <li
              key={n.path}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs ${i===cursor?"bg-accent/10 text-accent":"hover:bg-bg-hover"}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onSelect(n.path)}
            >
              <FileIcon size={11} className="shrink-0 text-text-muted" />
              <span className="text-text">{n.name}</span>
              <span className="ml-auto truncate text-[10px] text-text-muted">{n.path}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3 border-t border-bg-border px-3 py-1.5 text-[10px] text-text-muted">
          <span><kbd className="rounded bg-bg-subtle px-1">↑↓</kbd> navigate</span>
          <span><kbd className="rounded bg-bg-subtle px-1">↵</kbd> open</span>
          <span><kbd className="rounded bg-bg-subtle px-1">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function BottomTabs({
  workspaceId, workspace, tab, setTab, hideTabs = false,
}: {
  workspaceId: string;
  workspace?: Workspace;
  tab: "console" | "terminal" | "preview" | "database";
  setTab: (t: "console" | "terminal" | "preview" | "database") => void;
  hideTabs?: boolean;
}) {
  const status = workspace?.status ?? "stopped";
  const [previewViewportLocal, setPreviewViewportLocal] = useState<"full" | "tablet" | "mobile">("full");
  const [previewKey, setPreviewKey] = useState(0);
  const tabs: { id: "console" | "terminal" | "preview" | "database"; label: string; icon?: JSX.Element }[] = [
    { id: "console",  label: "Workflows", icon: <Layers size={11} /> },
    { id: "terminal", label: "Shell", icon: <Terminal size={11} /> },
    { id: "preview",  label: "Run", icon: <Play size={11} /> },
    { id: "database", label: "Database", icon: <Database size={11} /> },
  ];
  return (
    <div className="flex h-full flex-col bg-bg-panel">
      {!hideTabs && (
        <div className="flex border-b border-bg-border bg-bg-subtle/55 px-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`relative flex items-center gap-1.5 rounded-t-lg px-4 py-2.5 text-xs font-medium transition ${
                tab === t.id
                  ? "bg-bg text-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
                  : "text-text-muted hover:bg-bg-hover/70 hover:text-text"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          {workspace?.previewUrl && (
            <a
              className="ml-auto my-1 flex items-center gap-1.5 rounded-lg px-3 text-xs text-text-muted transition hover:bg-bg-hover hover:text-text"
              href={workspace.previewUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={12} /> Open
            </a>
          )}
        </div>
      )}
      {/*
        Keep all panes mounted at all times so the terminal session and
        preview iframe survive tab switches. We use `hidden` instead of
        conditional render — switching tabs no longer drops the WS or
        wipes scrollback.
      */}
      <div className="relative flex-1 overflow-hidden">
        <div className={`absolute inset-0 ${tab === "console" ? "" : "hidden"}`}>
          <ConsolePane workspaceId={workspaceId} status={status} />
        </div>
        <div className={`absolute inset-0 ${tab === "terminal" ? "" : "hidden"}`}>
          <TerminalPane workspaceId={workspaceId} />
        </div>
        <div className={`absolute inset-0 flex flex-col ${tab === "preview" ? "" : "hidden"}`}>
          {workspace?.previewUrl && (
            <div className="flex shrink-0 items-center gap-1 border-b border-bg-border bg-bg-subtle/80 px-2 py-1.5">
              <button onClick={() => setPreviewViewportLocal("full")} className={`btn-ghost p-1 ${previewViewportLocal==="full"?"text-accent":""}`} title="Desktop"><Monitor size={13}/></button>
              <button onClick={() => setPreviewViewportLocal("tablet")} className={`btn-ghost p-1 ${previewViewportLocal==="tablet"?"text-accent":""}`} title="Tablet (768px)"><Tablet size={13}/></button>
              <button onClick={() => setPreviewViewportLocal("mobile")} className={`btn-ghost p-1 ${previewViewportLocal==="mobile"?"text-accent":""}`} title="Mobile (375px)"><Smartphone size={13}/></button>
              <div className="flex-1"/>
              <button className="btn-ghost p-1 text-text-muted hover:text-text" title="Refresh" onClick={() => setPreviewKey(k=>k+1)}><RefreshCw size={13}/></button>
            </div>
          )}
          <div className="flex flex-1 items-start justify-center overflow-auto bg-[radial-gradient(circle_at_top,rgba(124,92,255,0.08),transparent_45%)] bg-bg-subtle p-2">
            {workspace?.previewUrl ? (
              <iframe
                key={`${workspace.previewUrl}-${previewKey}`}
                src={workspace.previewUrl}
                className="h-full bg-white shadow-lg"
                style={{
                  width: previewViewportLocal==="mobile"?"375px":previewViewportLocal==="tablet"?"768px":"100%",
                  minHeight:"100%",
                  transition:"width 0.3s ease",
                }}
                title="preview"
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-text-muted text-sm">
                Klik <strong className="mx-1 text-text">Run</strong> untuk memulai — preview akan muncul di sini.
              </div>
            )}
          </div>
        </div>
        <div className={`absolute inset-0 ${tab === "database" ? "" : "hidden"}`}>
          <DatabasePane workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflows (Console) panel — Replit-style multi-process log viewer.
// Detects [processname] prefixes and color-codes each process. Includes
// "Show Only Latest", "Clear Past Runs", and "Ask Agent" controls.
// ---------------------------------------------------------------------------

// Palette of colors assigned to unique process names in log lines.
const PROC_COLORS = [
  "#22d3ee", // cyan
  "#4ade80", // green
  "#fbbf24", // yellow
  "#c084fc", // purple
  "#f472b6", // pink
  "#60a5fa", // blue
  "#fb923c", // orange
  "#34d399", // teal
];

/** Strip ANSI terminal color/style escape codes (e.g. PHP server's [32m … [0m). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[mGKHF]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function parseLogLine(line: string): { proc: string | null; content: string } {
  const clean = stripAnsi(line);
  // Matches lines like "[web] 200 GET /" or "[runner ] start: ..."
  const m = clean.match(/^\[([^\]]{1,20})\]\s*(.*)/s);
  if (m) return { proc: m[1].trim(), content: m[2] };
  return { proc: null, content: clean };
}

function ConsolePane({
  workspaceId,
  status,
}: {
  workspaceId: string;
  status: "stopped" | "starting" | "running" | "error";
}) {
  const [logs, setLogs] = useState("");
  const [clearedSnapshot, setClearedSnapshot] = useState<string>("");
  const [showOnlyLatest, setShowOnlyLatest] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Map from process name → color hex string (stable within mount).
  const procColorMap = useRef<Map<string, string>>(new Map());

  const refetchInterval = status === "running" || status === "starting" ? 1500 : 5000;
  const { data } = useQuery({
    queryKey: ["logs", workspaceId],
    queryFn: () => API.get<{ logs: string }>(`/workspaces/${workspaceId}/logs`),
    refetchInterval,
  });

  useEffect(() => {
    if (data?.logs === undefined || data.logs === logs) return;
    const el = ref.current;
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setLogs(data.logs);
    if (nearBottom) {
      requestAnimationFrame(() => {
        const e2 = ref.current;
        if (e2) e2.scrollTop = e2.scrollHeight;
      });
    }
  }, [data, logs]);

  // Drop cleared snapshot if logs have rotated / workspace restarted.
  let visible =
    clearedSnapshot && logs.startsWith(clearedSnapshot)
      ? logs.slice(clearedSnapshot.length)
      : logs;

  // "Show Only Latest" — show only the last 200 lines.
  const allLines = visible.split("\n");
  const displayLines = showOnlyLatest && allLines.length > 200
    ? allLines.slice(-200)
    : allLines;

  // Render lines with process-prefix color-coding.
  // Uses map size as index so assignments are stable across re-renders.
  function getProcColor(proc: string): string {
    if (!procColorMap.current.has(proc)) {
      const idx = procColorMap.current.size;
      procColorMap.current.set(proc, PROC_COLORS[idx % PROC_COLORS.length]);
    }
    return procColorMap.current.get(proc)!;
  }

  const statusMeta: Record<typeof status, { label: string; dot: string }> = {
    running: { label: "Running", dot: "bg-success" },
    starting: { label: "Starting", dot: "bg-warning" },
    error:   { label: "Error",   dot: "bg-danger" },
    stopped: { label: "Stopped", dot: "bg-text-muted" },
  };
  const sm = statusMeta[status];

  function askAgent() {
    // Take last 80 lines of visible output and prefill the AI chat.
    const snippet = allLines.slice(-80).join("\n").trim();
    if (!snippet) return;
    const ev = new CustomEvent("premdev:ai:prefill", {
      detail: { text: `Ini log output dari workspace:\n\`\`\`\n${snippet}\n\`\`\`\n\nTolong analisis dan jelaskan apa yang terjadi.` },
    });
    window.dispatchEvent(ev);
  }

  return (
    <div className="flex h-full flex-col bg-bg text-[12px]">
      {/* ── Header bar ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-bg-border px-3 py-1.5">
        {/* Status pill */}
        <span className="flex items-center gap-1.5 font-medium text-text">
          <span className={`inline-block h-2 w-2 rounded-full ${sm.dot}`} />
          {sm.label}
        </span>
        <span className="text-text-muted">workflow output</span>

        {/* Show Only Latest toggle */}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-text-muted hover:text-text select-none">
          <div
            className={`relative h-4 w-7 rounded-full transition ${showOnlyLatest ? "bg-accent" : "bg-bg-border"}`}
            onClick={() => setShowOnlyLatest((v) => !v)}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${showOnlyLatest ? "left-3.5" : "left-0.5"}`}
            />
          </div>
          <span>Terbaru</span>
        </label>

        {/* Ask Agent */}
        <button
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-panel hover:text-text transition"
          onClick={askAgent}
          title="Kirim log ini ke AI untuk dianalisis"
        >
          <Bot size={11} />
          Ask Agent
        </button>

        {/* Clear Past Runs */}
        <button
          className="rounded px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-panel hover:text-text transition"
          onClick={() => { setClearedSnapshot(logs); procColorMap.current.clear(); }}
          title="Sembunyikan output lama (buffer server tetap ada)"
        >
          Clear
        </button>
      </div>

      {/* ── Log body ───────────────────────────────────────────────── */}
      <div
        ref={ref}
        className="flex-1 overflow-auto p-2 font-mono text-[11.5px] leading-relaxed"
      >
        {displayLines.length === 0 || (displayLines.length === 1 && !displayLines[0]) ? (
          <span className="text-text-muted italic">
            (Console kosong. Klik Run untuk memulai proyek — output akan muncul di sini.)
          </span>
        ) : (
          displayLines.map((line, i) => {
            const { proc, content } = parseLogLine(line);
            if (!proc) {
              return (
                <div key={i} className="text-text whitespace-pre-wrap break-all">
                  {content || "\u00a0"}
                </div>
              );
            }
            const color = getProcColor(proc);
            return (
              <div key={i} className="flex gap-0 whitespace-pre-wrap break-all">
                <span
                  className="mr-2 shrink-0 font-semibold"
                  style={{ color }}
                >
                  [{proc}]
                </span>
                <span className="text-text">{content}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function CheckpointsModal({
  workspaceId,
  onClose,
  confirm,
}: {
  workspaceId: string;
  onClose: () => void;
  confirm: (o: any) => Promise<boolean>;
}) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  // When set, opens a child modal listing files inside the chosen checkpoint
  // (the "Changes" button). Stays mounted on top of CheckpointsModal so the
  // user can flip back to the timeline without losing scroll position.
  const [filesFor, setFilesFor] = useState<Checkpoint | null>(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["checkpoints", workspaceId],
    queryFn: () => API.get<{ checkpoints: Checkpoint[] }>(`/workspaces/${workspaceId}/checkpoints`),
  });
  const create = useMutation({
    mutationFn: () => API.post(`/workspaces/${workspaceId}/checkpoints`, { message: msg || "Manual checkpoint" }),
    onSuccess: () => { setMsg(""); refetch(); },
  });
  const restore = useMutation({
    mutationFn: (cid: string) => API.post(`/workspaces/${workspaceId}/checkpoints/${cid}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", workspaceId] }),
  });
  const del = useMutation({
    mutationFn: (cid: string) => API.delete(`/workspaces/${workspaceId}/checkpoints/${cid}`),
    onSuccess: () => refetch(),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Checkpoints</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="mb-4 flex gap-2">
          <input
            className="input flex-1"
            placeholder="Checkpoint message (optional)"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
          />
          <button
            className="btn-primary"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            Save checkpoint
          </button>
        </div>
        <div className="max-h-[50vh] overflow-auto">
          {isLoading ? (
            <div className="text-text-muted">Loading…</div>
          ) : data?.checkpoints?.length ? (
            <ul className="divide-y divide-bg-border">
              {data.checkpoints.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2">
                  <div className="flex-1">
                    <div className="text-sm">{c.message}</div>
                    <div className="text-[11px] text-text-muted">
                      {new Date(c.created_at).toLocaleString()} · {(c.size_bytes / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <button
                    className="btn-ghost text-xs"
                    title="Lihat daftar file di checkpoint ini"
                    onClick={() => setFilesFor(c)}
                  >
                    Changes
                  </button>
                  <button
                    className="btn-secondary text-xs"
                    title="Kembalikan workspace ke kondisi waktu checkpoint ini"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Rollback ke checkpoint ini?",
                        message: "File workspace akan ditimpa dengan isi checkpoint ini. Backup otomatis dibuat sebelum rollback.",
                        confirmLabel: "Rollback here",
                        cancelLabel: "Batal",
                        danger: true,
                      });
                      if (ok) restore.mutate(c.id);
                    }}
                  >
                    Rollback here
                  </button>
                  <button
                    className="btn-ghost text-danger text-xs"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete checkpoint?",
                        message: c.message,
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (ok) del.mutate(c.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-text-muted">No checkpoints yet.</div>
          )}
        </div>
      </div>
      {filesFor && (
        <CheckpointFilesModal
          workspaceId={workspaceId}
          checkpoint={filesFor}
          onClose={() => setFilesFor(null)}
        />
      )}
    </div>
  );
}

/**
 * Read-only listing of files captured inside a single checkpoint snapshot.
 * Backed by `GET /workspaces/:id/checkpoints/:cid/files` which `tar -tzf`s
 * the .tar.gz on disk. No download/diff yet — just "what's in here".
 */
function CheckpointFilesModal({
  workspaceId,
  checkpoint,
  onClose,
}: {
  workspaceId: string;
  checkpoint: Checkpoint;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["checkpoint-files", workspaceId, checkpoint.id],
    queryFn: () =>
      API.get<{ files: string[] }>(
        `/workspaces/${workspaceId}/checkpoints/${checkpoint.id}/files`,
      ),
  });
  const files = data?.files ?? [];
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4"
      // stopPropagation on the backdrop too — this modal is rendered inside
      // CheckpointsModal, which closes on its OWN backdrop click. Without
      // this guard, clicking the child backdrop bubbles up and closes both.
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        className="card w-full max-w-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-semibold">Changes in checkpoint</div>
            <div className="truncate text-xs text-text-muted">
              {checkpoint.message} · {new Date(checkpoint.created_at).toLocaleString()}
            </div>
          </div>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="max-h-[50vh] overflow-auto rounded-md border border-bg-border bg-bg-subtle/50 p-3 font-mono text-xs">
          {isLoading ? (
            <div className="text-text-muted">Loading…</div>
          ) : error ? (
            <div className="text-danger">
              {(error as any)?.message ?? "Failed to load file list"}
            </div>
          ) : files.length === 0 ? (
            <div className="text-text-muted">(empty)</div>
          ) : (
            <ul className="space-y-0.5">
              {files.map((f) => (
                <li key={f} className="truncate" title={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-3 text-right text-[11px] text-text-muted">
          {files.length > 0 && `${files.length} file${files.length === 1 ? "" : "s"}`}
        </div>
      </div>
    </div>
  );
}

// ── Database Browser ──────────────────────────────────────────────────────────
// Mirip phpMyAdmin: panel kiri daftar tabel, panel kanan hasil query + SQL editor.

type DbQueryResult =
  | { ok: true; kind: "rows"; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; database: string }
  | { ok: true; kind: "info"; affectedRows: number; insertId: number; changedRows: number; database: string }
  | { ok: false; error: string; database?: string };

type DbInfo = { host: string; port: string; user: string; database: string; url: string; hasPassword: boolean; publicHost: string; publicPort: string; externalUrl: string };

const DB_HISTORY_KEY = "premdev:db:history";
const DB_HISTORY_MAX = 30;

function saveQueryHistory(workspaceId: string, q: string) {
  try {
    const key = `${DB_HISTORY_KEY}:${workspaceId}`;
    const prev: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
    const next = [q, ...prev.filter((h) => h !== q)].slice(0, DB_HISTORY_MAX);
    localStorage.setItem(key, JSON.stringify(next));
  } catch { /* ignore */ }
}

function loadQueryHistory(workspaceId: string): string[] {
  try {
    const key = `${DB_HISTORY_KEY}:${workspaceId}`;
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch { return []; }
}

function exportResultCsv(columns: string[], rows: Record<string, unknown>[], filename: string) {
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    columns.map(escape).join(","),
    ...rows.map((row) => columns.map((c) => escape(row[c])).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function DatabasePane({ workspaceId }: { workspaceId: string }) {
  const [tables, setTables] = useState<string[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [dbName, setDbName] = useState<string>("");
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [showConnInfo, setShowConnInfo] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [queryHistory, setQueryHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  // Schema mode — DESCRIBE tableName instead of SELECT *
  const [schemaMode, setSchemaMode] = useState(false);
  // DB engine detection — tries to detect postgres vs mysql via query result
  const [dbEngine, setDbEngine] = useState<"mysql" | "postgres" | "unknown">("unknown");
  // phpMyAdmin URL (stored per-workspace in localStorage)
  const PMA_KEY = `premdev:pma:${workspaceId}`;
  const [pmaUrl, setPmaUrl] = useState<string>(() => {
    try { return localStorage.getItem(PMA_KEY) ?? ""; } catch { return ""; }
  });
  const [editPma, setEditPma] = useState(false);

  // Load query history on mount
  useEffect(() => {
    setQueryHistory(loadQueryHistory(workspaceId));
  }, [workspaceId]);

  // Close history dropdown when clicking outside
  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    }
    if (showHistory) document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [showHistory]);

  async function loadDbInfo(revealPw = false) {
    try {
      const r = await API.get<DbInfo>(`/workspaces/${workspaceId}/db/info${revealPw ? "?showPassword=1" : ""}`);
      setDbInfo(r);
    } catch { /* ignore */ }
  }

  function copyText(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  }

  async function runQuery(querySql: string) {
    setRunning(true);
    setResult(null);
    try {
      const r = await API.post<DbQueryResult>(`/workspaces/${workspaceId}/db/query`, {
        sql: querySql,
        rowLimit: 200,
      });
      setResult(r);
      if (r.database) setDbName(r.database);
      // Save to history on success or info
      if (r.ok) {
        saveQueryHistory(workspaceId, querySql.trim());
        setQueryHistory(loadQueryHistory(workspaceId));
      }
    } catch (e: any) {
      setResult({ ok: false, error: e?.message ?? String(e) });
    } finally {
      setRunning(false);
    }
  }

  // Helpers that pick the right SQL based on detected engine
  function tablesQuery(engine: typeof dbEngine) {
    if (engine === "postgres") {
      return `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    }
    return "SHOW TABLES";
  }
  function schemaQuery(engine: typeof dbEngine, table: string) {
    if (engine === "postgres") {
      return `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_name = '${table.replace(/'/g, "''")}'\nORDER BY ordinal_position`;
    }
    return `DESCRIBE \`${table}\``;
  }
  function dataQuery(engine: typeof dbEngine, table: string) {
    if (engine === "postgres") {
      return `SELECT * FROM "${table}" LIMIT 200`;
    }
    return `SELECT * FROM \`${table}\` LIMIT 200`;
  }

  async function detectEngine(): Promise<typeof dbEngine> {
    // Try postgres-specific query; if it fails assume mysql
    try {
      const r = await API.post<DbQueryResult>(`/workspaces/${workspaceId}/db/query`, {
        sql: "SELECT version()",
        rowLimit: 1,
      });
      if (r.ok && r.kind === "rows") {
        const val = Object.values(r.rows[0] ?? {})[0];
        if (typeof val === "string" && val.toLowerCase().includes("postgresql")) {
          setDbEngine("postgres");
          return "postgres";
        }
      }
    } catch {}
    setDbEngine("mysql");
    return "mysql";
  }

  async function loadTables() {
    setLoadingTables(true);
    let engine = dbEngine;
    if (engine === "unknown") engine = await detectEngine();
    try {
      const r = await API.post<DbQueryResult>(`/workspaces/${workspaceId}/db/query`, {
        sql: tablesQuery(engine),
        rowLimit: 500,
      });
      if (r.database) setDbName(r.database);
      if (r.ok && r.kind === "rows") {
        setTables(r.rows.map((row) => Object.values(row)[0] as string));
      } else {
        setTables([]);
      }
    } catch {
      setTables([]);
    } finally {
      setLoadingTables(false);
    }
  }

  function openTable(table: string) {
    setSelectedTable(table);
    if (schemaMode) {
      const q = schemaQuery(dbEngine, table);
      setSql(q);
      runQuery(q);
    } else {
      const q = dataQuery(dbEngine, table);
      setSql(q);
      runQuery(q);
    }
  }

  function toggleSchemaMode() {
    setSchemaMode((prev) => {
      const next = !prev;
      if (selectedTable) {
        const q = next ? schemaQuery(dbEngine, selectedTable) : dataQuery(dbEngine, selectedTable);
        setSql(q);
        runQuery(q);
      }
      return next;
    });
  }

  useEffect(() => {
    loadTables();
    loadDbInfo();
  }, [workspaceId]);

  return (
    <div className="flex h-full overflow-hidden text-xs">
      {/* Sidebar — daftar tabel */}
      <div className="flex w-44 flex-shrink-0 flex-col border-r border-bg-border bg-bg-subtle">
        <div className="flex items-center justify-between border-b border-bg-border px-2 py-1.5">
          <span className="font-semibold text-text-muted uppercase tracking-wide">Tabel</span>
          <div className="flex items-center gap-1">
            <button
              className={`text-text-muted hover:text-text ${showConnInfo ? "text-accent" : ""}`}
              onClick={() => { setShowConnInfo((v) => !v); if (!dbInfo) loadDbInfo(); }}
              title="Info koneksi database"
            >
              <Link size={11} />
            </button>
            <button
              className="text-text-muted hover:text-text"
              onClick={loadTables}
              title="Refresh daftar tabel"
            >
              <RefreshCw size={11} className={loadingTables ? "animate-spin" : ""} />
            </button>
          </div>
        </div>
        {/* Info koneksi — expandable */}
        {showConnInfo && dbInfo && (
          <div className="border-b border-bg-border bg-bg px-2 py-2 space-y-2 text-[10px]">
            {/* Internal connection (inside Docker) */}
            <div>
              <div className="font-semibold uppercase tracking-wide text-text-muted mb-1 flex items-center gap-1">
                <Server size={9} />Internal (Docker)
              </div>
              {[
                { label: "Host", val: dbInfo.host || "-", key: "host" },
                { label: "Port", val: dbInfo.port || "3306", key: "port" },
                { label: "User", val: dbInfo.user || "-", key: "user" },
                { label: "DB",   val: dbInfo.database || "-", key: "database" },
              ].map(({ label, val, key }) => (
                <div key={key} className="flex items-center justify-between gap-1 py-0.5">
                  <span className="text-text-muted shrink-0 w-8">{label}</span>
                  <span className="truncate font-mono text-text flex-1 text-right" title={val}>{val}</span>
                  <button className="shrink-0 text-text-muted hover:text-text" onClick={() => copyText(val, key)} title={`Copy ${label}`}>
                    {copiedKey === key ? <CheckIcon size={10} className="text-success" /> : <Copy size={10} />}
                  </button>
                </div>
              ))}
            </div>

            {/* External connection (VPS / public) */}
            {dbInfo.publicHost && (
              <div>
                <div className="font-semibold uppercase tracking-wide text-text-muted mb-1 flex items-center gap-1">
                  <Globe size={9} />Eksternal (VPS/DBeaver)
                </div>
                {[
                  { label: "Host", val: dbInfo.publicHost, key: "ext-host" },
                  { label: "Port", val: dbInfo.publicPort || "3306", key: "ext-port" },
                  { label: "User", val: dbInfo.user || "-", key: "ext-user" },
                  { label: "DB",   val: dbInfo.database || "-", key: "ext-db" },
                ].map(({ label, val, key }) => (
                  <div key={key} className="flex items-center justify-between gap-1 py-0.5">
                    <span className="text-text-muted shrink-0 w-8">{label}</span>
                    <span className="truncate font-mono text-text flex-1 text-right" title={val}>{val}</span>
                    <button className="shrink-0 text-text-muted hover:text-text" onClick={() => copyText(val, key)} title={`Copy ${label}`}>
                      {copiedKey === key ? <CheckIcon size={10} className="text-success" /> : <Copy size={10} />}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Reveal/hide password toggle */}
            {dbInfo.hasPassword && (
              <button
                className="flex w-full items-center gap-1 rounded border border-bg-border px-2 py-1 text-text-muted hover:text-text hover:bg-bg-subtle transition"
                onClick={async () => {
                  const next = !showPw;
                  setShowPw(next);
                  await loadDbInfo(next);
                }}
              >
                {showPw ? <EyeOff size={10} /> : <Eye size={10} />}
                {showPw ? "Sembunyikan password" : "Tampilkan password dalam URL"}
              </button>
            )}

            {/* DATABASE_URL (internal) */}
            {dbInfo.url && (
              <div className="rounded border border-bg-border bg-bg-subtle p-1.5">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-text-muted">DATABASE_URL (internal)</span>
                  <button className="text-text-muted hover:text-text" onClick={() => copyText(dbInfo.url, "url")} title="Copy URL">
                    {copiedKey === "url" ? <CheckIcon size={10} className="text-success" /> : <Copy size={10} />}
                  </button>
                </div>
                <div className="font-mono text-text break-all leading-relaxed">{dbInfo.url}</div>
              </div>
            )}

            {/* DATABASE_URL (external) */}
            {dbInfo.externalUrl && (
              <div className="rounded border border-accent/30 bg-accent/5 p-1.5">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-accent/80">DATABASE_URL (eksternal)</span>
                  <button className="text-text-muted hover:text-text" onClick={() => copyText(dbInfo.externalUrl, "ext-url")} title="Copy External URL">
                    {copiedKey === "ext-url" ? <CheckIcon size={10} className="text-success" /> : <Copy size={10} />}
                  </button>
                </div>
                <div className="font-mono text-text break-all leading-relaxed">{dbInfo.externalUrl}</div>
              </div>
            )}
          </div>
        )}
        {dbName && !showConnInfo && (
          <div className="truncate border-b border-bg-border px-2 py-1 text-[10px] text-accent" title={dbName}>
            <Database size={9} className="mr-1 inline" />{dbName}
            {dbEngine !== "unknown" && (
              <span className={`ml-1 rounded px-1 py-0.5 text-[9px] font-semibold ${dbEngine === "postgres" ? "bg-blue-500/20 text-blue-400" : "bg-orange-500/20 text-orange-400"}`}>
                {dbEngine === "postgres" ? "PG" : "MY"}
              </span>
            )}
          </div>
        )}
        {/* Mode toggle: Data vs Schema */}
        <div className="flex border-b border-bg-border">
          <button
            className={`flex-1 py-1 text-[10px] font-medium transition ${!schemaMode ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text"}`}
            onClick={() => { if (schemaMode) toggleSchemaMode(); }}
            title="Tampilkan data tabel"
          >
            Data
          </button>
          <button
            className={`flex-1 py-1 text-[10px] font-medium transition ${schemaMode ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text"}`}
            onClick={() => { if (!schemaMode) toggleSchemaMode(); }}
            title="Tampilkan struktur tabel (DESCRIBE)"
          >
            Skema
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingTables ? (
            <div className="p-2 text-text-muted">Loading…</div>
          ) : tables.length === 0 ? (
            <div className="p-2 text-text-muted">Belum ada tabel</div>
          ) : (
            tables.map((t) => (
              <button
                key={t}
                onClick={() => openTable(t)}
                className={`flex w-full items-center gap-1 truncate px-2 py-1.5 text-left hover:bg-bg-border transition ${
                  selectedTable === t ? "bg-bg-border text-text" : "text-text-muted"
                }`}
                title={t}
              >
                <Table2 size={10} className="flex-shrink-0" />
                {t}
              </button>
            ))
          )}
        </div>
        {/* phpMyAdmin/pgAdmin link at bottom of sidebar */}
        <div className="border-t border-bg-border p-1.5 space-y-1">
          {pmaUrl && !editPma ? (
            <div className="flex items-center gap-1">
              <a
                href={pmaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-1 items-center gap-1 truncate rounded px-1.5 py-1 text-[10px] text-accent hover:bg-accent/10"
                title={`Buka DB Admin UI: ${pmaUrl}`}
              >
                <ExternalLink size={9} className="shrink-0" />
                {dbEngine === "postgres" ? "pgAdmin" : "phpMyAdmin"}
              </a>
              <button
                className="shrink-0 text-text-muted hover:text-text"
                title="Edit URL phpMyAdmin"
                onClick={() => setEditPma(true)}
              >
                <Pencil size={9} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <input
                type="text"
                className="flex-1 min-w-0 rounded border border-bg-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text outline-none focus:border-accent placeholder:text-text-muted"
                placeholder="phpMyAdmin URL…"
                defaultValue={pmaUrl}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  setPmaUrl(v);
                  setEditPma(false);
                  try { localStorage.setItem(PMA_KEY, v); } catch {}
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") { setEditPma(false); }
                }}
                autoFocus={editPma}
              />
              {pmaUrl && (
                <button className="shrink-0 text-text-muted hover:text-danger" title="Hapus" onClick={() => { setPmaUrl(""); setEditPma(false); try { localStorage.removeItem(PMA_KEY); } catch {} }}>
                  <X size={9} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Panel kanan — SQL editor + hasil */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* SQL editor */}
        <div className="flex items-start gap-2 border-b border-bg-border bg-bg p-2">
          <textarea
            className="flex-1 resize-none rounded border border-bg-border bg-bg-subtle px-2 py-1 font-mono text-[11px] leading-relaxed text-text outline-none focus:border-accent"
            rows={2}
            placeholder="SELECT * FROM tabel LIMIT 100"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                if (sql.trim()) runQuery(sql);
              }
            }}
          />
          <div className="flex flex-col gap-1">
            <button
              className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-white hover:opacity-90 disabled:opacity-50"
              disabled={running || !sql.trim()}
              onClick={() => runQuery(sql)}
              title="Jalankan (Ctrl+Enter)"
            >
              <Play size={11} />
              {running ? "…" : "Run"}
            </button>
            {/* Query history dropdown */}
            <div className="relative" ref={historyRef}>
              <button
                className="flex w-full items-center gap-1 rounded border border-bg-border bg-bg-subtle px-2 py-0.5 text-[10px] text-text-muted hover:text-text"
                onClick={() => setShowHistory((v) => !v)}
                title="Riwayat query (terakhir 30)"
                disabled={queryHistory.length === 0}
              >
                <Clock size={9} /> History
              </button>
              {showHistory && queryHistory.length > 0 && (
                <div className="absolute right-0 top-full z-20 mt-1 w-80 overflow-hidden rounded-md border border-bg-border bg-bg shadow-xl">
                  <div className="border-b border-bg-border px-2 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-wide">
                    Riwayat Query
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {queryHistory.map((h, i) => (
                      <button
                        key={i}
                        className="block w-full truncate px-2 py-1.5 text-left font-mono text-[10px] text-text hover:bg-bg-subtle"
                        title={h}
                        onClick={() => { setSql(h); setShowHistory(false); }}
                      >
                        {h}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Hasil query */}
        <div className="flex-1 overflow-auto">
          {!result && !running && (
            <div className="grid h-full place-items-center text-text-muted">
              Pilih tabel di kiri atau ketik SQL lalu klik Run
            </div>
          )}
          {running && (
            <div className="grid h-full place-items-center text-text-muted">
              <Loader2 size={18} className="animate-spin" />
            </div>
          )}
          {result && !result.ok && (
            <div className="p-3 text-danger">
              <span className="font-semibold">Error: </span>{result.error}
            </div>
          )}
          {result && result.ok && result.kind === "info" && (
            <div className="p-3 text-success">
              Berhasil — {result.affectedRows} baris terpengaruh
              {result.insertId > 0 && `, insert ID: ${result.insertId}`}
            </div>
          )}
          {result && result.ok && result.kind === "rows" && (
            <div className="min-w-max">
              <div className="sticky top-0 flex items-center justify-between border-b border-bg-border bg-bg-subtle px-3 py-1">
                <span className="text-[10px] text-text-muted">
                  {result.truncated
                    ? `Menampilkan 200 dari ${result.rowCount} baris ⚠`
                    : `${result.rows.length} baris`}
                </span>
                <button
                  className="flex items-center gap-1 rounded border border-bg-border bg-bg px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text"
                  title="Export hasil sebagai CSV"
                  onClick={() =>
                    exportResultCsv(
                      result.columns,
                      result.rows,
                      `${selectedTable ?? "query"}_${Date.now()}.csv`,
                    )
                  }
                >
                  <Download size={9} /> CSV
                </button>
              </div>
              {result.rows.length === 0 ? (
                <div className="p-3 text-text-muted">(tidak ada data)</div>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="sticky top-[25px] bg-bg-subtle">
                      {result.columns.map((col) => (
                        <th
                          key={col}
                          className="border-b border-r border-bg-border px-2 py-1 text-left font-semibold text-text-muted whitespace-nowrap"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="hover:bg-bg-subtle/60">
                        {result.columns.map((col) => {
                          const val = row[col];
                          const display = val === null ? <span className="text-text-muted/50 italic">NULL</span> : String(val);
                          return (
                            <td
                              key={col}
                              className="max-w-[240px] truncate border-b border-r border-bg-border px-2 py-1 text-text"
                              title={val === null ? "NULL" : String(val)}
                            >
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── WorkspaceSearch — Ctrl+Shift+F full-text grep across workspace ──────────
function WorkspaceSearch({
  workspaceId, onSelect, onClose,
}: { workspaceId: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ path: string; line: number; text: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await API.post<{ results: { path: string; line: number; text: string }[] }>(
          `/workspaces/${workspaceId}/search`, { query: q.trim() }
        );
        setResults(res.results ?? []);
      } catch { setResults([]); } finally { setLoading(false); }
    }, 350);
  }, [q, workspaceId]);

  const grouped: Record<string, { line: number; text: string }[]> = {};
  for (const r of results) {
    if (!grouped[r.path]) grouped[r.path] = [];
    grouped[r.path].push({ line: r.line, text: r.text });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]" onClick={onClose}>
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-bg-border bg-bg shadow-2xl"
        style={{ maxHeight: "70vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-bg-border px-3 py-2">
          <FileSearch size={14} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search across all files… (min 2 chars)"
            className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
          />
          {loading && <Loader2 size={13} className="animate-spin text-text-muted" />}
          <button onClick={onClose} className="text-text-muted hover:text-text"><X size={13} /></button>
        </div>
        <div className="flex-1 overflow-auto">
          {q.trim().length < 2 ? (
            <p className="px-4 py-8 text-center text-sm text-text-muted">Type at least 2 characters to search</p>
          ) : loading && results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-text-muted">Searching…</p>
          ) : Object.keys(grouped).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-text-muted">No results for "{q}"</p>
          ) : (
            Object.entries(grouped).map(([path, hits]) => (
              <div key={path} className="border-b border-bg-border last:border-none">
                <div className="flex items-center gap-2 bg-bg-subtle px-3 py-1.5">
                  <FileIcon size={11} className="shrink-0 text-text-muted" />
                  <span className="text-xs font-semibold text-text">{path}</span>
                  <span className="ml-auto text-[10px] text-text-muted">{hits.length} match{hits.length > 1 ? "es" : ""}</span>
                </div>
                {hits.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => onSelect(path)}
                    className="flex w-full items-start gap-3 px-4 py-1.5 text-left text-xs hover:bg-bg-hover"
                  >
                    <span className="w-8 shrink-0 text-right font-mono text-text-muted">{h.line}</span>
                    <span className="min-w-0 truncate font-mono text-text">{h.text.trim()}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-bg-border px-3 py-1.5 text-[10px] text-text-muted">
          {Object.keys(grouped).length > 0 && `${results.length} result${results.length !== 1 ? "s" : ""} in ${Object.keys(grouped).length} file${Object.keys(grouped).length !== 1 ? "s" : ""}`}
          <span className="ml-4"><kbd className="rounded bg-bg-subtle px-1">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

// ── ShareModal — generate read-only share links for workspace ───────────────
function ShareModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [tokens, setTokens] = useState<{ token: string; label: string; created_at: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    API.get<{ tokens: any[] }>(`/workspaces/${workspaceId}/share`)
      .then((r) => setTokens(r.tokens ?? []))
      .catch(() => {});
  }, [workspaceId]);

  async function createLink() {
    setCreating(true);
    try {
      const res = await API.post<{ token: string; label: string; created_at: string }>(
        `/workspaces/${workspaceId}/share`, { label: "Shared link" }
      );
      setTokens((prev) => [res, ...prev]);
    } finally { setCreating(false); }
  }

  async function revokeLink(token: string) {
    await API.post(`/workspaces/${workspaceId}/share/revoke`, { token });
    setTokens((prev) => prev.filter((t) => t.token !== token));
  }

  function copyLink(token: string) {
    const url = `${window.location.origin}/share/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(token);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-bg-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Share2 size={15} className="text-text-muted" />
            <span className="font-semibold text-text">Share Workspace</span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text"><X size={15} /></button>
        </div>
        <div className="p-4">
          <p className="mb-4 text-sm text-text-muted">Share a read-only preview link. Anyone with the link can view your running app.</p>
          <button
            onClick={createLink}
            disabled={creating}
            className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={13} /> {creating ? "Creating…" : "Create share link"}
          </button>
          {tokens.length > 0 ? (
            <div className="mt-4 space-y-2">
              {tokens.map((t) => {
                const url = `${window.location.origin}/share/${t.token}`;
                return (
                  <div key={t.token} className="flex items-center gap-2 rounded-lg border border-bg-border p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-text">{url}</p>
                      <p className="text-[10px] text-text-muted">{t.label} · {new Date(t.created_at).toLocaleDateString()}</p>
                    </div>
                    <button
                      onClick={() => copyLink(t.token)}
                      className={`shrink-0 rounded p-1.5 transition ${copied === t.token ? "text-success" : "text-text-muted hover:text-text"}`}
                      title="Copy link"
                    >
                      {copied === t.token ? <CheckIcon size={13} /> : <Copy size={13} />}
                    </button>
                    <button
                      onClick={() => revokeLink(t.token)}
                      className="shrink-0 rounded p-1.5 text-text-muted hover:text-danger"
                      title="Revoke link"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-center text-sm text-text-muted">No active share links</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ActivityLogModal — workspace event timeline ──────────────────────────────
function ActivityLogModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["workspace-events", workspaceId],
    queryFn: () => API.get<{ events: { id: string; kind: string; detail?: string; created_at: string }[] }>(
      `/workspaces/${workspaceId}/events`
    ),
    refetchInterval: 5000,
  });

  const KIND_ICON: Record<string, React.ReactNode> = {
    start:   <Play size={12} className="text-success" />,
    stop:    <Square size={12} className="text-danger" />,
    restart: <RotateCw size={12} className="text-warning" />,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-bg-border bg-bg shadow-2xl"
        style={{ maxHeight: "70vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Activity size={15} className="text-text-muted" />
            <span className="font-semibold text-text">Activity Log</span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text"><X size={15} /></button>
        </div>
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="grid h-32 place-items-center"><Loader2 size={18} className="animate-spin text-text-muted" /></div>
          ) : (data?.events ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-text-muted">No activity yet</p>
          ) : (
            <ul className="divide-y divide-bg-border">
              {(data?.events ?? []).map((ev) => (
                <li key={ev.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 shrink-0">{KIND_ICON[ev.kind] ?? <Clock size={12} className="text-text-muted" />}</span>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium capitalize text-text">{ev.kind}</span>
                    {ev.detail && <p className="truncate text-xs text-text-muted">{ev.detail}</p>}
                  </div>
                  <span className="shrink-0 text-[10px] text-text-muted">
                    {new Date(ev.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── WorkspaceReplace — Ctrl+Shift+H Find & Replace across workspace ──────────
function WorkspaceReplace({
  workspaceId, onClose, onFileOpen,
}: { workspaceId: string; onClose: () => void; onFileOpen: (p: string) => void }) {
  const [findQ, setFindQ] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState<{ path: string; hits: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [done, setDone] = useState<{ replaced: number; files: number } | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => { findRef.current?.focus(); }, []);

  async function search() {
    if (findQ.trim().length < 2) return;
    setLoading(true);
    setDone(null);
    try {
      const res = await API.post<{ results: { path: string; line: number }[] }>(
        `/workspaces/${workspaceId}/search`, { query: findQ.trim() }
      );
      const byFile: Record<string, number> = {};
      for (const r of res.results ?? []) {
        byFile[r.path] = (byFile[r.path] ?? 0) + 1;
      }
      setResults(Object.entries(byFile).map(([path, hits]) => ({ path, hits })));
    } catch { setResults([]); } finally { setLoading(false); }
  }

  async function replaceAll() {
    if (!findQ.trim() || !results.length) return;
    setReplacing(true);
    let totalReplaced = 0;
    let filesChanged = 0;
    for (const { path } of results) {
      try {
        const content = await API.get<string>(
          `/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(path)}`
        );
        const src = typeof content === "string" ? content : JSON.stringify(content);
        let newContent: string;
        if (useRegex) {
          newContent = src.replace(new RegExp(findQ, "g"), replaceWith);
        } else {
          newContent = src.split(findQ).join(replaceWith);
          totalReplaced += src.split(findQ).length - 1;
        }
        if (newContent !== src) {
          await API.put(`/workspaces/${workspaceId}/files`, { path, content: newContent });
          filesChanged++;
        }
      } catch {}
    }
    setReplacing(false);
    setDone({ replaced: totalReplaced, files: filesChanged });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]" onClick={onClose}>
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-bg-border bg-bg shadow-2xl"
        style={{ maxHeight: "70vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Replace size={14} className="text-text-muted" />
            <span className="font-semibold text-text">Find & Replace</span>
            <span className="text-[10px] text-text-muted">semua file di workspace</span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text"><X size={14} /></button>
        </div>
        <div className="flex flex-col gap-2 border-b border-bg-border p-3">
          <div className="flex items-center gap-2">
            <input
              ref={findRef}
              className="input flex-1 text-sm"
              placeholder="Cari…"
              value={findQ}
              onChange={(e) => setFindQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") search(); if (e.key === "Escape") onClose(); }}
            />
            <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-text-muted select-none">
              <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} className="accent-accent" />
              Regex
            </label>
            <button
              className="btn-secondary shrink-0 text-xs"
              onClick={search}
              disabled={loading || findQ.trim().length < 2}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="input flex-1 text-sm"
              placeholder="Ganti dengan…"
              value={replaceWith}
              onChange={(e) => setReplaceWith(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            />
            <button
              className="btn-primary shrink-0 text-xs"
              onClick={replaceAll}
              disabled={replacing || results.length === 0}
            >
              {replacing ? <Loader2 size={12} className="animate-spin" /> : "Replace All"}
            </button>
          </div>
          {done && (
            <p className="text-[11px] text-success">
              ✓ Diganti di {done.files} file ({done.replaced} kejadian)
            </p>
          )}
        </div>
        <div className="flex-1 overflow-auto">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-text-muted">
              {findQ.trim().length < 2 ? "Masukkan minimal 2 karakter lalu tekan Enter atau klik 🔍" : "Tidak ada hasil"}
            </p>
          ) : (
            <>
              <div className="border-b border-bg-border bg-bg-subtle px-4 py-1.5 text-[10px] text-text-muted">
                {results.length} file · {results.reduce((s, r) => s + r.hits, 0)} kecocokan
              </div>
              {results.map(({ path, hits }) => (
                <div
                  key={path}
                  className="flex cursor-pointer items-center gap-3 border-b border-bg-border px-4 py-2 hover:bg-bg-hover last:border-none"
                  onClick={() => onFileOpen(path)}
                >
                  <FileIcon size={11} className="shrink-0 text-text-muted" />
                  <span className="flex-1 truncate text-xs text-text">{path}</span>
                  <span className="text-[10px] text-text-muted">{hits}×</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ShortcutModal — Ctrl+? keyboard shortcuts reference ──────────────────────
function ShortcutModal({ onClose }: { onClose: () => void }) {
  const groups: { title: string; items: { key: string; desc: string }[] }[] = [
    {
      title: "Editor",
      items: [
        { key: "Ctrl+S", desc: "Simpan file" },
        { key: "Ctrl+K / Ctrl+P", desc: "Command palette (buka file cepat)" },
        { key: "Ctrl+Shift+F", desc: "Cari di semua file" },
        { key: "Ctrl+Shift+H", desc: "Find & Replace di semua file" },
        { key: "Ctrl+Shift+O", desc: "Code outline — daftar simbol file" },
        { key: "Ctrl+I / Cmd+I", desc: "Tanya AI tentang seleksi kode" },
        { key: "Ctrl+J", desc: "Toggle panel AI" },
        { key: "Ctrl+?", desc: "Referensi shortcut ini" },
        { key: "Esc", desc: "Tutup panel / modal aktif" },
      ],
    },
    {
      title: "AI Chat",
      items: [
        { key: "Enter", desc: "Kirim pesan" },
        { key: "Shift+Enter", desc: "Baris baru di chat" },
        { key: "Ctrl+V", desc: "Paste screenshot/gambar ke chat" },
      ],
    },
    {
      title: "Terminal",
      items: [
        { key: "Ctrl+Enter", desc: "Jalankan perintah" },
        { key: "Ctrl+F", desc: "Cari di output terminal" },
      ],
    },
    {
      title: "Database",
      items: [
        { key: "Ctrl+Enter", desc: "Jalankan SQL query" },
      ],
    },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-bg-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Keyboard size={14} className="text-text-muted" />
            <span className="font-semibold text-text">Keyboard Shortcuts</span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text"><X size={14} /></button>
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="bg-bg-subtle px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                {g.title}
              </div>
              <ul className="divide-y divide-bg-border">
                {g.items.map((s) => (
                  <li key={s.key} className="flex items-center justify-between px-4 py-2">
                    <span className="text-xs text-text-muted">{s.desc}</span>
                    <kbd className="ml-4 shrink-0 rounded bg-bg-subtle px-2 py-0.5 font-mono text-[10px] text-text">{s.key}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-bg-border px-4 py-2 text-center text-[10px] text-text-muted">
          Ctrl = Ctrl di Windows/Linux · Cmd di macOS
        </div>
      </div>
    </div>
  );
}
