import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

function hardReload() {
  // Drop stuck shell/JS caches, then load a fresh shell
  const go = () => {
    window.location.replace(`/?reload=${Date.now()}`);
  };
  try {
    if (window.caches) {
      void caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).finally(go);
      return;
    }
  } catch {
    /* ignore */
  }
  go();
}

export class ErrorBoundary extends Component<{ children: ReactNode; title?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI error:", error, info);
  }

  render() {
    if (this.state.error) {
      const msg = this.state.error.message || "Unknown error";
      const looksLikeStaleBundle =
        /React is not defined|Cannot find module|Failed to fetch dynamically imported|Loading chunk|ChunkLoadError/i.test(
          msg
        );
      return (
        <div className="card" style={{ margin: "1rem 0" }}>
          <h2>{this.props.title || "Something went wrong"}</h2>
          <p className="muted">
            {looksLikeStaleBundle
              ? "This phone is running an old copy of the app. Tap Reload fresh copy — that usually fixes it."
              : "The app hit an unexpected error on this screen. Your data is safe — try again or go back to the dashboard."}
          </p>
          <div className="error" style={{ margin: "0.75rem 0" }}>
            {msg}
          </div>
          <div className="toolbar">
            <button className="btn" type="button" onClick={hardReload}>
              Reload fresh copy
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => {
                this.setState({ error: null });
                window.location.assign("/");
              }}
            >
              Back to dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
