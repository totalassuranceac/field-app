import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
import "./styles.css";

function showBootError(err: unknown) {
  const root = document.getElementById("root");
  const message = err instanceof Error ? err.message : String(err);
  if (root) {
    root.innerHTML = `
      <div style="min-height:100vh;display:grid;place-items:center;padding:1.5rem;font-family:Segoe UI,system-ui,sans-serif;background:#f0f3f6;color:#122033;text-align:center;box-sizing:border-box">
        <div style="max-width:28rem">
          <h1 style="margin:0 0 .5rem;font-size:1.25rem">Could not start Fleet Tracker</h1>
          <p style="color:#5a6b7d;line-height:1.4">${message.replace(/</g, "&lt;")}</p>
          <p style="color:#5a6b7d;font-size:.85rem">Open this exact address, then hard-refresh (Ctrl+Shift+R).</p>
          <a href="/?reload=${Date.now()}" style="display:inline-block;margin-top:.85rem;padding:.5rem .9rem;border-radius:10px;background:#c8102e;color:#fff;text-decoration:none;font-weight:700">Retry</a>
          <p style="margin-top:1rem;font-size:.75rem;color:#5a6b7d">https://total-assurance-fleet.totalassurance.workers.dev</p>
        </div>
      </div>`;
  }
  console.error("Fleet boot error:", err);
}

try {
  // Offline queue is optional — never block first paint
  import("./offlineQueue")
    .then((m) => {
      try {
        m.bootstrapOfflineQueue();
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      /* ignore */
    });

  const rootEl = document.getElementById("root");
  if (!rootEl) {
    throw new Error("Missing #root element in HTML.");
  }

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </React.StrictMode>
  );
} catch (err) {
  showBootError(err);
}

// Catch async import failures that would otherwise leave a blank page
window.addEventListener("error", (e) => {
  if (document.getElementById("boot-shell")) {
    showBootError(e.error || e.message || "Script error");
  }
});
window.addEventListener("unhandledrejection", (e) => {
  if (document.getElementById("boot-shell")) {
    showBootError(e.reason || "Unhandled promise rejection");
  }
});
