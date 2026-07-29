import { FormEvent, useState } from "react";
import { useAuth } from "../auth";
import { PasswordField } from "../components/PasswordField";

export function LoginPage() {
  // Keep entry obvious for staff bookmarks / support
  const { login, googleEnabled } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const logoSrc = "/logo-light.png";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!username.trim() || !password) {
        throw new Error("Enter your username and password.");
      }
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img className="login-logo" src={logoSrc} alt="Total Assurance A/C & Heating" />
        <h1>Field App</h1>
        <p className="sub">
          Trucks, warehouse, repairs, and parts — one place for the team. Sign in with your
          username and password. First time? Open the invite link your admin sent you — enter
          the username they gave you and create your password.
        </p>
        {error && (
          <div className="error" style={{ marginBottom: "0.85rem" }}>
            {error}
          </div>
        )}
        <form className="form" onSubmit={onSubmit}>
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              placeholder="your.username"
              disabled={busy}
            />
          </label>
          <PasswordField
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
          <button className="btn" disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {googleEnabled && (
          <>
            <div className="muted" style={{ textAlign: "center", margin: "1rem 0 0.75rem" }}>
              or
            </div>
            <a className="btn secondary" href="/api/auth/google" style={{ width: "100%" }}>
              Continue with Google Workspace
            </a>
          </>
        )}
        <p className="muted" style={{ marginTop: "1rem", fontSize: "0.8rem", textAlign: "center" }}>
          Forgot password? Ask your admin for a new join link (Admin → Invite).
        </p>
        <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.72rem", textAlign: "center" }}>
          Open: total-assurance-fleet.totalassurance.workers.dev
        </p>
      </div>
    </div>
  );
}
