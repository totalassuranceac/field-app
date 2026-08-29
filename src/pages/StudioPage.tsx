import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, canOpenStudio, STUDIO_LIVE_URL } from "../api";
import { useAuth } from "../auth";

/**
 * Studio door — same-tab handoff to the live Studio worker.
 * Uses a short-lived SSO token so users already in Field App skip Studio's password.
 */
export function StudioPage() {
  const { user } = useAuth();
  const allowed = canOpenStudio(user);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    (async () => {
      try {
        const { url } = await api<{ url: string }>("/studio/handoff", {
          timeoutMs: 15_000,
        });
        if (cancelled) return;
        if (url) {
          window.location.assign(url);
          return;
        }
        setError("Could not open Studio. Try again.");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "";
        // Soft fallback only if SSO is not configured yet
        if (/not configured|503/i.test(msg)) {
          window.location.assign(STUDIO_LIVE_URL);
          return;
        }
        setError(msg || "Could not open Studio. Try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (!allowed) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="studio-handoff card" role="status">
      <div className="studio-handoff-brand">
        <img src="/logo-mark.png" alt="" className="studio-handoff-mark" width={40} height={40} />
        <div>
          <h1 className="studio-handoff-title">Studio</h1>
          <p className="muted" style={{ margin: 0 }}>
            {error || "Opening…"}
          </p>
        </div>
      </div>
      {error ? (
        <p className="muted" style={{ marginTop: "1rem" }}>
          <a href={STUDIO_LIVE_URL}>Open Studio login</a>
        </p>
      ) : null}
    </div>
  );
}
