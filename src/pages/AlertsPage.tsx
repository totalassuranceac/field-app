import { useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

interface Alert {
  id: number;
  unit_number: string;
  employee_name: string;
  odometer: number;
  fuel_date: string;
  alert_type: string;
  message: string;
  severity: string;
  status: string;
}

function typeLabel(t: string): string {
  return (t || "").replace(/_/g, " ");
}

export function AlertsPage() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [status, setStatus] = useState("open");
  const [error, setError] = useState("");
  const [note, setNote] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const canManage = can(user, "manageAlerts");
  const showActions = canManage && status === "open";

  async function load(s = status) {
    const data = await api<{ alerts: Alert[] }>(`/alerts?status=${s}`);
    setAlerts(data.alerts);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [status]);

  async function ack(id: number, next: "acknowledged" | "dismissed") {
    setBusyId(id);
    setError("");
    try {
      await api(`/alerts/${id}/ack`, {
        method: "POST",
        body: JSON.stringify({ status: next, note: note[id] || undefined }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusyId(null);
    }
  }

  function ActionBlock({ a }: { a: Alert }) {
    return (
      <div className="alert-actions no-print">
        <input
          className="alert-note-input"
          placeholder="Note (optional)"
          value={note[a.id] || ""}
          onChange={(e) => setNote((n) => ({ ...n, [a.id]: e.target.value }))}
          disabled={busyId === a.id}
        />
        <div className="alert-action-btns">
          <button
            type="button"
            className="btn secondary btn-sm"
            disabled={busyId === a.id}
            onClick={() => ack(a.id, "acknowledged")}
          >
            {busyId === a.id ? "…" : "Ack"}
          </button>
          <button
            type="button"
            className="btn secondary btn-sm"
            disabled={busyId === a.id}
            onClick={() => ack(a.id, "dismissed")}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="alerts-page">
      <div className="page-header">
        <div>
          <h1>Mileage red flags</h1>
          <p>Automatic checks when odometer readings look wrong</p>
        </div>
        <div className="filters no-print">
          {["open", "acknowledged", "dismissed"].map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${status === s ? "active" : ""}`}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      {!alerts.length && (
        <div className="card empty">No {status} alerts.</div>
      )}

      {/* Desktop: table */}
      {alerts.length > 0 && (
        <div className="card alerts-wide">
          <div className="table-wrap alerts-table-wrap">
            <table className="alerts-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Unit</th>
                  <th>Date</th>
                  <th>Employee</th>
                  <th>Miles</th>
                  <th>Message</th>
                  {showActions && <th className="no-print">Action</th>}
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className={`badge ${a.severity}`}>{a.severity}</span>
                    </td>
                    <td>
                      <strong className="alert-unit">{a.unit_number}</strong>
                    </td>
                    <td>{a.fuel_date}</td>
                    <td>{a.employee_name}</td>
                    <td>{a.odometer.toLocaleString()}</td>
                    <td>
                      <div className="alert-msg">{a.message}</div>
                      <div className="muted alert-type">{typeLabel(a.alert_type)}</div>
                    </td>
                    {showActions && (
                      <td className="no-print">
                        <ActionBlock a={a} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Phone: readable cards */}
      {alerts.length > 0 && (
        <ul className="alerts-narrow">
          {alerts.map((a) => (
            <li key={a.id} className={`alert-card severity-${a.severity}`}>
              <div className="alert-card-header">
                <div className="alert-card-title">
                  <strong className="alert-unit">Unit {a.unit_number}</strong>
                  <div className="alert-card-badges">
                    <span className={`badge ${a.severity}`}>{a.severity}</span>
                    <span className="badge">{typeLabel(a.alert_type)}</span>
                  </div>
                </div>
              </div>
              <p className="alert-card-message">{a.message}</p>
              <dl className="alert-fields">
                <div className="alert-field">
                  <dt>Date</dt>
                  <dd>{a.fuel_date || "—"}</dd>
                </div>
                <div className="alert-field">
                  <dt>Employee</dt>
                  <dd>{a.employee_name || "—"}</dd>
                </div>
                <div className="alert-field">
                  <dt>Odometer</dt>
                  <dd>{a.odometer.toLocaleString()} mi</dd>
                </div>
                <div className="alert-field">
                  <dt>Status</dt>
                  <dd>{a.status}</dd>
                </div>
              </dl>
              {showActions && <ActionBlock a={a} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
