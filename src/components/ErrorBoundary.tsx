import React from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; title?: string },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("UI error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ margin: "1rem 0" }}>
          <h2>{this.props.title || "Something went wrong"}</h2>
          <p className="muted">
            The app hit an unexpected error on this screen. Your data is safe — try again or go back
            to the dashboard.
          </p>
          <div className="error" style={{ margin: "0.75rem 0" }}>
            {this.state.error.message || "Unknown error"}
          </div>
          <div className="toolbar">
            <button
              className="btn"
              type="button"
              onClick={() => {
                this.setState({ error: null });
                window.location.assign("/");
              }}
            >
              Back to dashboard
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
