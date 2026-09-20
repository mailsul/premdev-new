import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import {
  Code2,
  LayoutDashboard,
  Settings,
  Shield,
  LogOut,
  Menu,
  X,
  ChevronRight,
} from "lucide-react";
import { clsx } from "clsx";
import { useState } from "react";

export function Sidebar() {
  const loc = useLocation();
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);

  const items = [
    { to: "/", label: "Workspaces", icon: LayoutDashboard },
    { to: "/settings", label: "Settings", icon: Settings },
  ];
  if (user?.role === "admin") {
    items.push({ to: "/admin", label: "Admin", icon: Shield });
  }

  const sidebar = (
    <aside className="flex h-full w-72 flex-col border-r border-bg-border/80 bg-bg-panel/95 shadow-2xl shadow-black/20 backdrop-blur">
      <div className="flex items-center gap-3 border-b border-bg-border/80 px-5 py-5">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-accent text-white">
          <Code2 size={18} />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">PremDev</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
            Developer cloud
          </div>
        </div>
        <button className="btn-ghost ml-auto md:hidden" aria-label="Close navigation" onClick={() => setOpen(false)}>
          <X size={17} />
        </button>
      </div>

      <nav className="flex-1 space-y-1 p-4">
        <div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-subtle">Workspace</div>
        {items.map((it) => {
          const active = it.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(it.to);
          return (
            <Link
              key={it.to}
              to={it.to}
              onClick={() => setOpen(false)}
              className={clsx(
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all",
                active
                  ? "bg-accent/12 text-text shadow-inner shadow-accent/10"
                  : "text-text-muted hover:bg-bg-hover hover:text-text"
              )}
            >
              <it.icon size={17} className={active ? "text-accent" : "text-text-subtle group-hover:text-text"} />
              {it.label}
              {active && <ChevronRight size={14} className="ml-auto text-accent" />}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-bg-border/80 p-4">
        <div className="mb-3 flex items-center gap-3 rounded-xl bg-bg-subtle p-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/15 text-xs font-bold text-accent">
            {(user?.username || "U").slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium text-text">{user?.username}</div>
            <div className="truncate text-text-muted">{user?.email}</div>
          </div>
        </div>
        <button
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-text-muted transition hover:bg-danger/10 hover:text-danger"
          onClick={async () => {
            await logout();
            nav("/login", { replace: true });
          }}
        >
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </aside>
  );

  return (
    <>
      <button
        className="fixed left-4 top-4 z-30 grid h-10 w-10 place-items-center rounded-xl border border-bg-border bg-bg-panel/95 text-text shadow-lg backdrop-blur md:hidden"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
      >
        <Menu size={18} />
      </button>
      {open && <button className="fixed inset-0 z-40 bg-black/60 md:hidden" aria-label="Close navigation" onClick={() => setOpen(false)} />}
      <div className={clsx(
        "fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:static md:z-auto md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}>
        {sidebar}
      </div>
    </>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-auto pt-16 md:pt-0">{children}</main>
    </div>
  );
}
