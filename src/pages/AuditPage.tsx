import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { plainAuditSummary } from "../lib/utf8Mojibake";
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

/** Links use employee, vehicle, and writeup. Audit rows store hr_writeup. */
function entityAliases(raw: string): string[] {
  const key = raw.trim().toLowerCase();
  if (!key) return [];
  if (key === "writeup" || key === "write-up" || key === "hr_writeup" || key === "hr-writeup") {
    return ["hr_writeup", "writeup"];
  }
  if (key === "vehicle" || key === "vehicles" || key === "unit" || key === "fleet") return ["vehicle"];
  if (key === "employee" || key === "employees") return ["employee"];
  return [key];
}

export function AuditPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const entityParam = (params.get("entity") || "").trim();
  const idParam = (params.get("id") || params.get("entity_id") || "").trim();
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!can(user, "viewAudit")) return;
    api<{ logs: Log[] }>("/audit")
      .then((d) => setLogs(d.logs))
      .catch((e) => setError(e.message));
  }, [user]);

  const shown = useMemo(() => {
    const aliases = entityAliases(entityParam);
    return logs.filter((row) => {
      if (aliases.length) {
        const kind = String(row.entity_type || "").toLowerCase();
        if (!aliases.includes(kind)) return false;
      }
      if (idParam && String(row.entity_id || "") !== idParam) return false;
      return true;
    });
  }, [logs, entityParam, idParam]);

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
      {(entityParam || idParam) && (
        <p className="muted">
          Filtered to {entityParam || "record"}
          {idParam ? ` #${idParam}` : ""}. Latest loaded history only.{" "}
          <Link to="/audit">Show all</Link>
        </p>
      )}
      {error && <div className="error">{error}</div>}
      <LogList empty={entityParam || idParam ? "No changes for this record in the latest history." : "No audit events yet."}>
        {shown.map((l) => (
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
            <div>{plainAuditSummary(l.summary)}</div>
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
