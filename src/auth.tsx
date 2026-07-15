import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, User } from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  googleEnabled: boolean;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: User | null; googleEnabled?: boolean }>("/auth/me");
      setUser(data.user);
      setGoogleEnabled(Boolean(data.googleEnabled));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (username: string, password: string) => {
    const data = await api<{ user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setUser(data.user);
  };

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, googleEnabled, refresh, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
