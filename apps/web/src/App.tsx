import { Routes, Route, Navigate } from "react-router-dom";
import { useEffect, Component, type ReactNode } from "react";
import { useAuth } from "./lib/auth";
import { Loader2, RefreshCw } from "lucide-react";
import LoginPage from "./pages/Login";
import DashboardPage from "./pages/Dashboard";
import EditorPage from "./pages/Editor";
import AdminPage from "./pages/Admin";
import SettingsPage from "./pages/Settings";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-bg text-text-muted p-8">
           <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger/10 text-2xl">!</span>
          <p className="text-sm font-medium text-text">Terjadi kesalahan tak terduga</p>
          <p className="max-w-md text-center text-xs font-mono text-danger bg-danger/10 rounded px-3 py-2">
            {this.state.error.message}
          </p>
          <button
            className="btn-secondary text-xs"
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
          >
             <RefreshCw size={14} /> Muat Ulang
          </button>
          <a className="text-xs text-accent underline" href="/">← Kembali ke dashboard</a>
        </div>
      );
    }
    return this.props.children;
  }
}

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="app-boot">
        <div className="boot-mark"><Loader2 size={20} className="animate-spin" /></div>
        <div>
          <div className="font-semibold text-text">Preparing your workspace</div>
          <div className="mt-1 text-xs text-text-muted">Restoring your secure session…</div>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AdminOnly({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="app-boot">
        <div className="boot-mark"><Loader2 size={20} className="animate-spin" /></div>
        <div>
          <div className="font-semibold text-text">Loading admin console</div>
          <div className="mt-1 text-xs text-text-muted">Checking permissions…</div>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { check } = useAuth();
  useEffect(() => {
    check();
  }, [check]);

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<Protected><DashboardPage /></Protected>} />
        <Route path="/workspace/:id" element={<Protected><ErrorBoundary><EditorPage /></ErrorBoundary></Protected>} />
        <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
        <Route path="/admin" element={<AdminOnly><AdminPage /></AdminOnly>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}
