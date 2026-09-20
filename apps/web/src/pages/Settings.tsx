import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { API } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { Loader2, Save, Copy, ExternalLink, Eye, EyeOff, ShieldCheck, Database, UserRound } from "lucide-react";

export default function SettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => API.get<{ user: any }>("/auth/me"),
  });

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [showPw2, setShowPw2] = useState(false);

  async function changePw(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setMsg("Passwords don't match");
    setBusy(true);
    setMsg("");
    try {
      await API.post("/auth/change-password", { password: pw });
      setMsg("Password changed");
      setPw("");
      setPw2("");
    } catch (e: any) {
      setMsg(e.message || "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <div className="page-shell max-w-5xl">
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <div className="eyebrow mb-2">Account</div>
            <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-2 text-sm text-text-muted">Manage your identity, database access, and security.</p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-success/20 bg-success/10 px-3 py-1.5 text-xs text-success">
            <ShieldCheck size={14} /> Account protected
          </div>
        </div>

        <section className="card mb-5 p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/15 text-accent"><UserRound size={18} /></div>
            <div><h2 className="font-semibold">Profile</h2><p className="text-xs text-text-muted">Your PremDev account details</p></div>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between border-b border-bg-border/70 pb-3">
              <span className="text-text-muted">Username</span>
              <span className={isLoading ? "skeleton h-4 w-28" : "font-medium"}>{isLoading ? "" : data?.user?.username}</span>
            </div>
            <div className="flex items-center justify-between border-b border-bg-border/70 pb-3">
              <span className="text-text-muted">Email</span>
              <span className={isLoading ? "skeleton h-4 w-40" : ""}>{isLoading ? "" : data?.user?.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Role</span>
              <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium capitalize text-accent">{data?.user?.role || "user"}</span>
            </div>
          </div>
        </section>

        <section className="card mb-5 p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-400/10 text-cyan-300"><Database size={18} /></div>
            <div><h2 className="font-semibold">Database access</h2><p className="text-xs text-text-muted">Workspace databases are isolated automatically.</p></div>
          </div>
          <p className="mb-3 text-sm text-text-muted">
            Setiap workspace otomatis mendapat database MySQL sendiri. Env var
            <code className="mx-1 rounded bg-bg-subtle px-1 font-mono text-xs">DATABASE_URL</code>,
            <code className="mx-1 rounded bg-bg-subtle px-1 font-mono text-xs">DB_NAME</code>,
            <code className="mx-1 rounded bg-bg-subtle px-1 font-mono text-xs">DB_USER</code>, dan
            <code className="mx-1 rounded bg-bg-subtle px-1 font-mono text-xs">DB_PASS</code>
            langsung tersedia di terminal dan kode.
          </p>
          <div className="grid gap-2 rounded-xl border border-bg-border/70 bg-bg-subtle p-4 font-mono text-xs sm:grid-cols-2">
            <DbValue label="HOST" value="mysql" />
            <DbValue label="USER" value={data?.user?.username || "—"} />
            <DbValue label="PASSWORD" value="(env: DB_PASS)" />
            <DbValue label="DB FORMAT" value={`${data?.user?.username || "user"}_<project-name>`} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href="/api/db/adminer-redirect"
              target="_blank"
              rel="noreferrer"
              className="btn-primary"
            >
              <ExternalLink size={14} /> Open Adminer
            </a>
            <a
              href="/api/db/phpmyadmin-redirect"
              target="_blank"
              rel="noreferrer"
              className="btn-secondary"
            >
              <ExternalLink size={14} /> phpMyAdmin
            </a>
          </div>
        </section>

        <section className="card p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-warning/10 text-warning"><ShieldCheck size={18} /></div>
            <div><h2 className="font-semibold">Change password</h2><p className="text-xs text-text-muted">Use at least 8 characters for a stronger account.</p></div>
          </div>
          <form onSubmit={changePw} className="space-y-3">
            <div>
              <label className="label" htmlFor="new-password">New password</label>
              <div className="relative">
                <input id="new-password" type={showPw ? "text" : "password"} className="input pr-11" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} />
                <button type="button" className="btn-ghost absolute right-1 top-1/2 -translate-y-1/2 px-2 py-1.5" aria-label="Toggle new password visibility" onClick={() => setShowPw((value) => !value)}>{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="confirm-password">Confirm password</label>
              <div className="relative">
                <input id="confirm-password" type={showPw2 ? "text" : "password"} className="input pr-11" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={8} />
                <button type="button" className="btn-ghost absolute right-1 top-1/2 -translate-y-1/2 px-2 py-1.5" aria-label="Toggle confirmation visibility" onClick={() => setShowPw2((value) => !value)}>{showPw2 ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </div>
            </div>
            {msg && <div className={`rounded-lg border px-3 py-2 text-sm ${msg === "Password changed" ? "border-success/30 bg-success/10 text-success" : "border-danger/30 bg-danger/10 text-danger"}`}>{msg}</div>}
            <button className="btn-primary" disabled={busy || pw.length < 8 || pw !== pw2}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {busy ? "Saving…" : "Save password"}
            </button>
          </form>
        </section>
      </div>
    </Layout>
  );
}

function DbValue({ label, value }: { label: string; value: string }) {
  const copy = () => navigator.clipboard?.writeText(value);
  return (
    <div className="group flex min-w-0 items-center justify-between gap-3 rounded-lg border border-transparent px-2 py-1.5 hover:border-bg-border">
      <span className="text-text-muted">{label}</span>
      <button type="button" className="flex min-w-0 items-center gap-2 text-right text-accent hover:text-accent-hover" onClick={copy} title={`Copy ${label}`}>
        <span className="truncate">{value}</span><Copy size={12} className="shrink-0 opacity-0 transition group-hover:opacity-100" />
      </button>
    </div>
  );
}
