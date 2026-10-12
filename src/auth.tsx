import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, Role, User, VIEW_AS_ROLES, type ViewAsInfo } from "./api";

const VIEW_AS_KEY = "fleet_view_as_role";
/** Last known real session user — paints the app shell instantly while /auth/me revalidates. */
const USER_CACHE_KEY = "fleet_user_cache_v1";
/** Effective viewed user while server person view-as is active. */
const VIEW_AS_USER_KEY = "fleet_view_as_person_user_v1";

interface AuthState {
  user: User | null;
  /** Real logged-in account (never the preview role / viewed person) */
  realUser: User | null;
  loading: boolean;
  googleEnabled: boolean;
  /** Client-only role preview (UI chrome). Cleared while server person view-as is active. */
  viewAsRole: Role | null;
  setViewAsRole: (role: Role | null) => void;
  /** Server person impersonation (Home/board/clock as that user) */
  viewAsPerson: ViewAsInfo | null;
  startViewAs: (userId: number) => Promise<void>;
  endViewAs: () => Promise<void>;
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

function readCachedViewedUser(): User | null {
  try {
    const raw = sessionStorage.getItem(VIEW_AS_USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as User;
    if (!u || typeof u.id !== "number" || !u.role) return null;
    return u;
  } catch {
    return null;
  }
}

function writeCachedViewedUser(user: User | null) {
  try {
    if (!user) sessionStorage.removeItem(VIEW_AS_USER_KEY);
    else sessionStorage.setItem(VIEW_AS_USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const cached = typeof window !== "undefined" ? readCachedUser() : null;
  const cachedViewed = typeof window !== "undefined" ? readCachedViewedUser() : null;
  const [realUser, setRealUser] = useState<User | null>(cached);
  const [viewedUser, setViewedUser] = useState<User | null>(cachedViewed);
  const [viewAsPerson, setViewAsPerson] = useState<ViewAsInfo | null>(() =>
    cachedViewed
      ? {
          user_id: cachedViewed.id,
          display_name: cachedViewed.display_name,
          role: cachedViewed.role,
        }
      : null
  );
  // If we already know who they are, don't block the whole app on /auth/me
  const [loading, setLoading] = useState(!cached);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [viewAsRole, setViewAsRoleState] = useState<Role | null>(() =>
    cachedViewed ? null : readViewAs()
  );

  const setViewAsRole = useCallback((role: Role | null) => {
    setViewAsRoleState(role);
    try {
      if (role) sessionStorage.setItem(VIEW_AS_KEY, role);
      else sessionStorage.removeItem(VIEW_AS_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const clearRolePreview = useCallback(() => {
    setViewAsRoleState(null);
    try {
      sessionStorage.removeItem(VIEW_AS_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{
        user: User | null;
        real_user?: User | null;
        view_as?: ViewAsInfo | null;
        googleEnabled?: boolean;
      }>("/auth/me", {
        timeoutMs: 6000,
      });
      const next = data?.user ?? null;
      const viewing = Boolean(data?.view_as?.user_id && next);
      const real = viewing ? data?.real_user ?? null : next;
      setRealUser(real);
      writeCachedUser(real);
      setGoogleEnabled(Boolean(data?.googleEnabled));
      if (viewing && next && data?.view_as) {
        setViewedUser(next);
        writeCachedViewedUser(next);
        setViewAsPerson(data.view_as);
        clearRolePreview();
      } else {
        setViewedUser(null);
        writeCachedViewedUser(null);
        setViewAsPerson(null);
        const isAdmin = real?.role === "admin";
        if (real && !isAdmin) clearRolePreview();
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
  }, [clearRolePreview]);

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
    // Server person view-as wins over client role preview
    if (viewAsPerson && viewedUser) {
      return {
        ...viewedUser,
        real_role: "admin" as Role,
        viewing_as: true,
      };
    }
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
  }, [realUser, viewAsRole, viewAsPerson, viewedUser]);

  const startViewAs = useCallback(
    async (userId: number) => {
      const data = await api<{
        user: User;
        real_user: User;
        view_as: ViewAsInfo;
      }>("/auth/view-as", {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
        timeoutMs: 12_000,
      });
      setRealUser(data.real_user);
      writeCachedUser(data.real_user);
      setViewedUser(data.user);
      writeCachedViewedUser(data.user);
      setViewAsPerson(data.view_as);
      clearRolePreview();
    },
    [clearRolePreview]
  );

  const endViewAs = useCallback(async () => {
    const data = await api<{ user: User; view_as: null }>("/auth/view-as/exit", {
      method: "POST",
      timeoutMs: 12_000,
    });
    setRealUser(data.user);
    writeCachedUser(data.user);
    setViewedUser(null);
    writeCachedViewedUser(null);
    setViewAsPerson(null);
  }, []);

  const login = async (username: string, password: string) => {
    const data = await api<{ user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      timeoutMs: 15_000,
    });
    setRealUser(data.user);
    writeCachedUser(data.user);
    setViewedUser(null);
    writeCachedViewedUser(null);
    setViewAsPerson(null);
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
    setViewedUser(null);
    writeCachedViewedUser(null);
    setViewAsPerson(null);
    setViewAsRole(null);
  };

  const isTrueAdmin =
    Boolean(realUser?.role === "admin" && !realUser?.is_warehouse) ||
    user?.real_role === "admin";

  return (
    <AuthContext.Provider
      value={{
        user,
        realUser,
        loading,
        googleEnabled,
        viewAsRole: isTrueAdmin && !viewAsPerson ? viewAsRole : null,
        setViewAsRole,
        viewAsPerson: isTrueAdmin ? viewAsPerson : null,
        startViewAs,
        endViewAs,
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
