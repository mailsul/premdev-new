import { create } from "zustand";
import { API } from "./api";

export type User = {
  id: string;
  username: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
};

type AuthState = {
  user: User | null;
  loading: boolean;
  check: () => Promise<void>;
  login: (username: string, password: string, remember?: boolean) => Promise<void>;
  logout: () => Promise<void>;
};

const AUTH_CACHE_KEY = "premdev:auth-user";
let checkPromise: Promise<void> | null = null;

function readCachedUser(): User | null {
  try {
    const raw = sessionStorage.getItem(AUTH_CACHE_KEY);
    return raw ? JSON.parse(raw) as User : null;
  } catch {
    return null;
  }
}

function cacheUser(user: User | null) {
  try {
    if (user) sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(AUTH_CACHE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browsers.
  }
}

export const useAuth = create<AuthState>((set) => ({
  user: readCachedUser(),
  loading: !readCachedUser(),
  async check() {
    if (checkPromise) return checkPromise;
    checkPromise = (async () => {
      try {
        // Keep a dead/cold API from holding the protected-route boot screen
        // for the full generic request timeout.
        const res = await API.get<{ user: User }>("/auth/me", { timeoutMs: 3_000, silent: true });
        cacheUser(res.user);
        set({ user: res.user, loading: false });
      } catch {
        cacheUser(null);
        set({ user: null, loading: false });
      } finally {
        checkPromise = null;
      }
    })();
    return checkPromise;
  },
  async login(username, password, remember = false) {
    const res = await API.post<{ user: User }>("/auth/login", {
      username,
      password,
      remember,
    });
    try { sessionStorage.removeItem("premdev:workspaces-cache"); } catch {}
    cacheUser(res.user);
    set({ user: res.user });
  },
  async logout() {
    await API.post("/auth/logout");
    try { sessionStorage.removeItem("premdev:workspaces-cache"); } catch {}
    cacheUser(null);
    set({ user: null });
  },
}));
