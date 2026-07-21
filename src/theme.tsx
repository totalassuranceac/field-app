import React, { createContext, useContext, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

interface ThemeCtx {
  theme: ThemeMode;
  toggle: () => void;
  setTheme: (t: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeCtx | null>(null);

function preferInitial(): ThemeMode {
  try {
    const saved = localStorage.getItem("ta_fleet_theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(preferInitial);

  // Apply theme attribute immediately so first paint is not stuck on light defaults
  useEffect(() => {
    const initial = preferInitial();
    document.documentElement.setAttribute("data-theme", initial);
    document.documentElement.style.colorScheme = initial;
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
    document.body.style.backgroundColor = "";
    document.documentElement.style.backgroundColor = "";
    try {
      localStorage.setItem("ta_fleet_theme", theme);
    } catch {
      /* ignore */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0b1220" : "#f4f6f8");
  }, [theme]);

  const setTheme = (t: ThemeMode) => setThemeState(t);
  const toggle = () => setThemeState((t) => (t === "dark" ? "light" : "dark"));

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme outside provider");
  return ctx;
}
