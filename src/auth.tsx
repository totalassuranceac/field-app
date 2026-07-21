import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, Role, User, VIEW_AS_ROLES } from "./api";

const VIEW_AS_KEY = "fleet_view_as_role";

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [realUser, setRealUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
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
      const data = await api<{ user: User | null; googleEnabled?: boolean }>("/auth/me");
      setRealUser(data?.user ?? null);
      setGoogleEnabled(Boolean(data?.googleEnabled));
      // Only true admins may keep view-as preview
      const isAdmin =
        data?.user?.role === "admin" || data?.user?.real_role === "admin";
      if (data?.user && !isAdmin) {
        setViewAsRoleState(null);
        try {
          sessionStorage.removeItem(VIEW_AS_KEY);
        } catch {
          /* ignore */
        }
      }
    } catch {
      setRealUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Hard cap so UI never stays blank if /auth/me hangs
    const t = window.setTimeout(() => setLoading(false), 8000);
    void refresh().finally(() => window.clearTimeout(t));
    return () => window.clearTimeout(t);
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
    });
    setRealUser(data.user);
    setViewAsRole(null);
  };

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setRealUser(null);
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
