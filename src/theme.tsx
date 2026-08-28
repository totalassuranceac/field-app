import React, { createContext, useContext, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

/** App text size — stored on this device; scales rem-based UI */
export type TextSize = "sm" | "md" | "lg" | "xl";

export const TEXT_SIZE_OPTIONS: Array<{
  id: TextSize;
  label: string;
  hint: string;
  /** Root html font-size */
  px: number;
}> = [
  { id: "sm", label: "Small", hint: "More on screen", px: 14 },
  { id: "md", label: "Default", hint: "Standard size", px: 16 },
  { id: "lg", label: "Large", hint: "Easier to read", px: 18 },
  { id: "xl", label: "Extra large", hint: "Biggest text", px: 20 },
];

interface ThemeCtx {
  theme: ThemeMode;
  toggle: () => void;
  setTheme: (t: ThemeMode) => void;
  textSize: TextSize;
  setTextSize: (s: TextSize) => void;
}

const ThemeContext = createContext<ThemeCtx | null>(null);

const THEME_KEY = "ta_fleet_theme";
const TEXT_SIZE_KEY = "ta_fleet_text_size";

function preferInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function preferInitialTextSize(): TextSize {
  try {
    const saved = localStorage.getItem(TEXT_SIZE_KEY);
    if (saved === "sm" || saved === "md" || saved === "lg" || saved === "xl") return saved;
  } catch {
    /* ignore */
  }
  return "md";
}

function applyTextSize(size: TextSize) {
  const opt = TEXT_SIZE_OPTIONS.find((o) => o.id === size) || TEXT_SIZE_OPTIONS[1];
  document.documentElement.setAttribute("data-text-size", opt.id);
  document.documentElement.style.fontSize = `${opt.px}px`;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(preferInitialTheme);
  const [textSize, setTextSizeState] = useState<TextSize>(preferInitialTextSize);

  // Apply theme + text size immediately so first paint matches preference
  useEffect(() => {
    const initialTheme = preferInitialTheme();
    const initialSize = preferInitialTextSize();
    document.documentElement.setAttribute("data-theme", initialTheme);
    document.documentElement.style.colorScheme = initialTheme;
    applyTextSize(initialSize);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
    document.body.style.backgroundColor = "";
    document.documentElement.style.backgroundColor = "";
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0b1220" : "#f4f6f8");
  }, [theme]);

  useEffect(() => {
    applyTextSize(textSize);
    try {
      localStorage.setItem(TEXT_SIZE_KEY, textSize);
    } catch {
      /* ignore */
    }
  }, [textSize]);

  const setTheme = (t: ThemeMode) => setThemeState(t);
  const toggle = () => setThemeState((t) => (t === "dark" ? "light" : "dark"));
  const setTextSize = (s: TextSize) => setTextSizeState(s);

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme, textSize, setTextSize }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme outside provider");
  return ctx;
}
