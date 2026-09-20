import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Code2, Loader2, Eye, EyeOff, ShieldCheck, Zap, LockKeyhole } from "lucide-react";

export default function LoginPage() {
  const nav = useNavigate();
  const { login } = useAuth();
  const [u, setU] = useState(() => localStorage.getItem("premdev:lastUsername") || "");
  const [p, setP] = useState("");
  const [remember, setRemember] = useState(() => localStorage.getItem("premdev:remember") === "1");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await login(u, p, remember);
      // Persist the username so the field is pre-filled next visit; also
      // remember the checkbox state so the toggle stays on across sessions.
      // We never store the password in localStorage — the browser's own
      // password manager handles that via autoComplete.
      if (remember) {
        localStorage.setItem("premdev:lastUsername", u);
        localStorage.setItem("premdev:remember", "1");
      } else {
        localStorage.removeItem("premdev:lastUsername");
        localStorage.removeItem("premdev:remember");
      }
      nav("/", { replace: true });
    } catch (e: any) {
      setErr(e.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4 sm:p-8">
      <div className="pointer-events-none absolute -left-32 top-[-20%] h-96 w-96 rounded-full bg-accent/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-20 h-[28rem] w-[28rem] rounded-full bg-cyan-500/10 blur-3xl" />
      <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-bg-border/80 bg-bg-panel/80 shadow-2xl shadow-black/30 backdrop-blur-xl lg:grid-cols-[1.05fr_0.95fr]">
        <div className="hidden flex-col justify-between bg-gradient-to-br from-accent/20 via-bg-panel to-cyan-500/10 p-10 lg:flex">
          <div>
            <div className="mb-14 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-white shadow-lg shadow-accent/30">
                <Code2 size={22} />
              </div>
              <div>
                <div className="text-lg font-semibold">PremDev</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-text-muted">Developer cloud</div>
              </div>
            </div>
            <div className="eyebrow mb-4">Ship faster</div>
            <h2 className="max-w-sm text-4xl font-semibold leading-tight tracking-tight text-text">
              Your workspace, ready when you are.
            </h2>
            <p className="mt-5 max-w-sm text-sm leading-6 text-text-muted">
              Build, run, and manage every project from one focused cloud IDE.
            </p>
          </div>
          <div className="grid gap-3 text-xs text-text-muted">
            <div className="flex items-center gap-3"><ShieldCheck size={16} className="text-success" /> Private workspace isolation</div>
            <div className="flex items-center gap-3"><Zap size={16} className="text-warning" /> Fast project startup</div>
          </div>
        </div>

        <div className="p-6 sm:p-10">
        <div className="mb-8 flex items-center gap-3 lg:hidden">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-white">
            <Code2 size={22} />
          </div>
          <div>
            <div className="text-lg font-semibold">PremDev</div>
            <div className="text-xs text-text-muted">Developer cloud</div>
          </div>
        </div>

        <div className="mb-8">
        <div className="eyebrow mb-2">Welcome back</div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to PremDev</h1>
        <p className="mb-6 text-sm text-text-muted">
          Continue to your workspaces and projects.
        </p>
        </div>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="label" htmlFor="username">Username</label>
            <input
              id="username"
              className="input"
              value={u}
              onChange={(e) => setU(e.target.value)}
              autoFocus
              autoComplete="username"
              required
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="label" htmlFor="password">Password</label>
              <span className="mb-1.5 flex items-center gap-1 text-[10px] text-text-subtle"><LockKeyhole size={11} /> Secure session</span>
            </div>
            <div className="relative">
              <input
                id="password"
                className="input pr-11"
                type={showPassword ? "text" : "password"}
                value={p}
                onChange={(e) => setP(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button type="button" className="btn-ghost absolute right-1 top-1/2 -translate-y-1/2 px-2 py-1.5" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-muted select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-bg-elev text-accent focus:ring-accent focus:ring-offset-0"
            />
            Remember me on this device (30 days)
          </label>
          {err && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {err}
            </div>
          )}
          <button className="btn-primary h-11 w-full" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-8 text-center text-xs leading-5 text-text-subtle">
          Use the account created during installation. Need help? Contact your administrator.
        </p>
      </div>
      </div>
    </div>
  );
}
