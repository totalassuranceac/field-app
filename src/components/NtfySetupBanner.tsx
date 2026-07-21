import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { DEFAULT_NTFY_TOPIC } from "../ntfyClient";

export interface SubItem {
  id: string;
  kind: "channel" | "setup";
  title: string;
  why: string;
  how: string;
  topic: string | null;
  done: boolean;
  done_at: string | null;
}

type Props = {
  /**
   * compact = collapsible Settings drawer (default)
   * card = always-open full card (legacy)
   */
  variant?: "compact" | "card";
  /** Start collapsed (default true for compact) */
  defaultOpen?: boolean;
};

/**
 * Per-user ntfy channel checklist — lives in Settings, compact & collapsible.
 */
export function NtfySetupBanner({ variant = "compact", defaultOpen = false }: Props) {
  const [items, setItems] = useState<SubItem[]>([]);
  const [fleetTopic, setFleetTopic] = useState(DEFAULT_NTFY_TOPIC);
  const [allDone, setAllDone] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const d = await api<{
        fleet_topic: string;
        items: SubItem[];
        all_done: boolean;
        remaining: number;
      }>("/alerts/my-subscriptions");
      setFleetTopic(d.fleet_topic || DEFAULT_NTFY_TOPIC);
      setItems(d.items || []);
      setAllDone(Boolean(d.all_done));
      setRemaining(d.remaining || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load alert checklist");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setDone(id: string, done: boolean) {
    setBusyId(id);
    setError("");
    try {
      const d = await api<{
        fleet_topic: string;
        items: SubItem[];
        all_done: boolean;
        remaining: number;
      }>("/alerts/my-subscriptions/ack", {
        method: "POST",
        body: JSON.stringify({ id, done }),
      });
      setFleetTopic(d.fleet_topic || DEFAULT_NTFY_TOPIC);
      setItems(d.items || []);
      setAllDone(Boolean(d.all_done));
      setRemaining(d.remaining || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return variant === "card" ? (
      <div className="card muted">Loading phone alert checklist…</div>
    ) : null;
  }

  const list = (
    <ul className="ntfy-check-list ntfy-check-list-compact">
      {items.map((item) => (
        <li key={item.id} className={`ntfy-check-item${item.done ? " is-done" : ""}`}>
          <div className="ntfy-check-main">
            <div className="ntfy-check-title-row">
              <strong>{item.title}</strong>
              {item.kind === "channel" && item.topic ? (
                <code className="ntfy-topic-code">{item.topic}</code>
              ) : null}
              {item.done ? <span className="ntfy-done-pill">Done</span> : null}
            </div>
            <p className="ntfy-check-how muted">{item.how}</p>
          </div>
          <div className="ntfy-check-actions">
            {item.done ? (
              <button
                type="button"
                className="btn ghost"
                disabled={busyId === item.id}
                onClick={() => void setDone(item.id, false)}
              >
                Undo
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busyId === item.id}
                onClick={() => void setDone(item.id, true)}
              >
                {busyId === item.id ? "…" : "Done"}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );

  const links = (
    <p className="muted ntfy-store-links">
      App:{" "}
      <a href="https://ntfy.sh" target="_blank" rel="noreferrer">
        ntfy.sh
      </a>
      {" · "}
      <a
        href="https://play.google.com/store/apps/details?id=io.heckel.ntfy"
        target="_blank"
        rel="noreferrer"
      >
        Android
      </a>
      {" · "}
      <a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noreferrer">
        iPhone
      </a>
    </p>
  );

  const body = (
    <>
      {allDone ? (
        <p className="ntfy-drawer-status success-inline">
          All set · fleet <code className="ntfy-topic-code">{fleetTopic}</code>
        </p>
      ) : (
        <p className="ntfy-drawer-status muted">
          {remaining} left · subscribe in ntfy, then mark Done
        </p>
      )}
      {error && (
        <div className="error" style={{ marginBottom: "0.5rem", fontSize: "0.82rem" }}>
          {error}
        </div>
      )}
      {list}
      {links}
    </>
  );

  if (variant === "card") {
    return (
      <div className="card ntfy-setup-card">
        <h2 style={{ marginTop: 0 }}>Phone alert checklist</h2>
        {body}
      </div>
    );
  }

  // Compact collapsible drawer for Settings
  return (
    <details className="ntfy-drawer card" open={defaultOpen || undefined}>
      <summary className="ntfy-drawer-summary">
        <span className="ntfy-drawer-title">Phone alerts setup</span>
        <span className={`ntfy-drawer-badge${allDone ? " is-done" : ""}`}>
          {allDone ? "Done" : `${remaining} left`}
        </span>
      </summary>
      <div className="ntfy-drawer-body">{body}</div>
    </details>
  );
}
