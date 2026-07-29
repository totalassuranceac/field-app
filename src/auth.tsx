import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, Role, User, VIEW_AS_ROLES } from "./api";

const VIEW_AS_KEY = "fleet_view_as_role";
/** Last known session user — paints the app shell instantly while /auth/me revalidates. */
const USER_CACHE_KEY = "fleet_user_cache_v1";

interface AuthState {
  user: User | null;
  /** Real logged-in account (never the preview role) */
  realUser: User | null;
  loading: boolean;
  googleEnabled: boolean;
  viewAsRole: Role | null;
  setViewAsRole: (role: Role | null) => void;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function readViewAs(): Role | null {
  try {
    const v = sessionStorage.getItem(VIEW_AS_KEY);
    if (v && (VIEW_AS_ROLES as string[]).includes(v)) return v as Role;
  } catch {
    /* ignore */
  }
  return null;
}

function readCachedUser(): User | null {
  try {
    const raw = sessionStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as User;
    if (!u || typeof u.id !== "number" || !u.role) return null;
    return u;
  } catch {
    return null;
  }
}

function writeCachedUser(user: User | null) {
  try {
    if (!user) sessionStorage.removeItem(USER_CACHE_KEY);
    else sessionStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  } catch {
    /* private mode / quota */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const cached = typeof window !== "undefined" ? readCachedUser() : null;
  const [realUser, setRealUser] = useState<User | null>(cached);
  // If we already know who they are, don't block the whole app on /auth/me
  const [loading, setLoading] = useState(!cached);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [viewAsRole, setViewAsRoleState] = useState<Role | null>(() => readViewAs());

  const setViewAsRole = useCallback((role: Role | null) => {
    setViewAsRoleState(role);
    try {
      if (role) sessionStorage.setItem(VIEW_AS_KEY, role);
      else sessionStorage.removeItem(VIEW_AS_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: User | null; googleEnabled?: boolean }>("/auth/me", {
        timeoutMs: 6000,
      });
      const next = data?.user ?? null;
      setRealUser(next);
      writeCachedUser(next);
      setGoogleEnabled(Boolean(data?.googleEnabled));
      // Only true admins may keep view-as preview
      const isAdmin =
        next?.role === "admin" || next?.real_role === "admin";
      if (next && !isAdmin) {
        setViewAsRoleState(null);
        try {
          sessionStorage.removeItem(VIEW_AS_KEY);
        } catch {
          /* ignore */
        }
      }
    } catch {
      // Keep cached user on blip so field staff can keep working; only clear if no cache
      setRealUser((prev) => {
        if (prev) return prev;
        writeCachedUser(null);
        return null;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Hard cap so UI never stays blank if /auth/me hangs (shorter when we have a cache)
    const cap = cached ? 5000 : 4000;
    const t = window.setTimeout(() => setLoading(false), cap);
    void refresh().finally(() => window.clearTimeout(t));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const user = useMemo(() => {
    if (!realUser) return null;
    // Only true admins can preview other roles (warehouse stored as is_warehouse)
    const isTrueAdmin = realUser.role === "admin" && !realUser.is_warehouse;
    if (!isTrueAdmin || !viewAsRole || viewAsRole === "admin") {
      return realUser;
    }
    return {
      ...realUser,
      role: viewAsRole,
      real_role: "admin" as Role,
    };
  }, [realUser, viewAsRole]);

  const login = async (username: string, password: string) => {
    const data = await api<{ user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      timeoutMs: 15_000,
    });
    setRealUser(data.user);
    writeCachedUser(data.user);
    setViewAsRole(null);
    setLoading(false);
  };

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST", timeoutMs: 5000 });
    } catch {
      /* still clear local session */
    }
    setRealUser(null);
    writeCachedUser(null);
    setViewAsRole(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        realUser,
        loading,
        googleEnabled,
        viewAsRole: user?.real_role === "admin" ? viewAsRole : null,
        setViewAsRole,
        refresh,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
