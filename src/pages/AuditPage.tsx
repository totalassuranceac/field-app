import { useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

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
          <h1>Audit log</h1>
          <p>Who changed what, and when</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td>{l.created_at}</td>
                  <td>{l.user_display}</td>
                  <td>{l.action}</td>
                  <td>
                    {l.entity_type}
                    {l.entity_id ? ` #${l.entity_id}` : ""}
                  </td>
                  <td>{l.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!logs.length && <div className="empty">No audit events yet.</div>}
        </div>
      </div>
    </div>
  );
}
