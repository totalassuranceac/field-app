import { useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";

interface Log {
  id: number;
  user_display: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  created_at: string;
}

export function AuditPage() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!can(user, "viewAudit")) return;
    api<{ logs: Log[] }>("/audit")
      .then((d) => setLogs(d.logs))
      .catch((e) => setError(e.message));
  }, [user]);

  if (!can(user, "viewAudit")) {
    return <div className="error">Admin only.</div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Change history</h1>
          <p>Who changed what, and when — tap a row for the full summary.</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <LogList empty="No audit events yet.">
        {logs.map((l) => (
          <LogItem
            key={l.id}
            summary={
              <>
                <span className="log-item-badge">{l.action}</span>
                <strong>{l.entity_type}</strong>
                {l.entity_id ? (
                  <span className="log-item-meta">#{l.entity_id}</span>
                ) : null}
                <span className="log-item-meta">{l.user_display}</span>
                <span className="log-item-meta">
                  {String(l.created_at || "").replace("T", " ").slice(0, 16)}
                </span>
              </>
            }
          >
            <div>{l.summary}</div>
            <div className="muted">
              {l.entity_type}
              {l.entity_id ? ` #${l.entity_id}` : ""} · {l.user_display}
            </div>
          </LogItem>
        ))}
      </LogList>
    </div>
  );
}
