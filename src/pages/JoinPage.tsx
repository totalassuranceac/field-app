import { FormEvent, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, User } from "../api";
import { useAuth } from "../auth";
import { PasswordField } from "../components/PasswordField";

type InviteInfo = {
  ok: boolean;
  username: string;
  display_name: string;
  expires_at: string;
};

export function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading, refresh } = useAuth();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const logoSrc = "/logo-light.png";

  useEffect(() => {
    if (!token) {
      setLoadError("This invite link is missing a token.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api<InviteInfo>(`/auth/invite/${encodeURIComponent(token)}`);
        if (cancelled) return;
        setInfo(data);
        setUsername(data.username || "");
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Could not load invite";
        setLoadError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Already signed in (e.g. completed invite in another tab)
  if (!authLoading && user && !loading && !loadError) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError("");
    if (!username.trim()) {
      setError("Enter the username your admin gave you.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== password2) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const data = await api<{ ok: boolean; user: User }>("/auth/invite/complete", {
        method: "POST",
        body: JSON.stringify({
          token,
          username: username.trim().toLowerCase(),
          password,
        }),
      });
      // Cookie is set by the API; refresh auth context then go home
      if (data.user) {
        await refresh();
      } else {
        await refresh();
      }
      navigate("/", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not finish setup"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img className="login-logo" src={logoSrc} alt="Total Assurance A/C & Heating" />
        <h1>Join Field App</h1>

        {loading && <p className="sub">Loading your invite…</p>}

        {!loading && loadError && (
          <>
            <div className="error" style={{ marginBottom: "0.85rem" }}>
              {loadError}
            </div>
            <p className="muted" style={{ textAlign: "center", marginBottom: "1rem" }}>
              Ask your admin for a new link, or sign in if you already set a password.
            </p>
            <Link className="btn secondary" to="/login" style={{ width: "100%", display: "block", textAlign: "center" }}>
              Go to sign in
            </Link>
          </>
        )}

        {!loading && !loadError && info && (
          <>
            <p className="sub">
              Welcome{info.display_name ? `, ${info.display_name}` : ""}. Enter the username your
              admin gave you, choose a password, and you&apos;ll be signed in right away.
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
                  placeholder="the username they gave you"
                  disabled={busy}
                  spellCheck={false}
                />
              </label>
              <p className="muted" style={{ margin: "-0.35rem 0 0.65rem", fontSize: "0.8rem" }}>
                Must match exactly (usually all lowercase).
              </p>
              <PasswordField
                label="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
                disabled={busy}
                placeholder="At least 8 characters"
              />
              <PasswordField
                label="Confirm password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
                disabled={busy}
              />
              <button className="btn" disabled={busy} type="submit">
                {busy ? "Setting up…" : "Create password & sign in"}
              </button>
            </form>
            <p className="muted" style={{ marginTop: "1rem", fontSize: "0.8rem", textAlign: "center" }}>
              Already finished? <Link to="/login">Sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
