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

export function AlertsPage() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [status, setStatus] = useState("open");
  const [error, setError] = useState("");
  const [note, setNote] = useState<Record<number, string>>({});

  async function load(s = status) {
    const data = await api<{ alerts: Alert[] }>(`/alerts?status=${s}`);
    setAlerts(data.alerts);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [status]);

  async function ack(id: number, next: "acknowledged" | "dismissed") {
    try {
      await api(`/alerts/${id}/ack`, {
        method: "POST",
        body: JSON.stringify({ status: next, note: note[id] || undefined }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Mileage red flags</h1>
          <p>Automatic checks when odometer readings look wrong</p>
        </div>
        <div className="filters no-print">
          {["open", "acknowledged", "dismissed"].map((s) => (
            <button key={s} className={`chip ${status === s ? "active" : ""}`} onClick={() => setStatus(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        {!alerts.length && <div className="empty">No {status} alerts.</div>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Unit</th>
                <th>Date</th>
                <th>Employee</th>
                <th>Miles</th>
                <th>Message</th>
                {can(user, "manageAlerts") && status === "open" && <th className="no-print">Action</th>}
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className={`badge ${a.severity}`}>{a.severity}</span>
                  </td>
                  <td>{a.unit_number}</td>
                  <td>{a.fuel_date}</td>
                  <td>{a.employee_name}</td>
                  <td>{a.odometer.toLocaleString()}</td>
                  <td>
                    <div>{a.message}</div>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {a.alert_type}
                    </div>
                  </td>
                  {can(user, "manageAlerts") && status === "open" && (
                    <td className="no-print">
                      <input
                        placeholder="Note (optional)"
                        value={note[a.id] || ""}
                        onChange={(e) => setNote((n) => ({ ...n, [a.id]: e.target.value }))}
                        style={{ marginBottom: "0.4rem" }}
                      />
                      <div className="toolbar">
                        <button className="btn secondary" onClick={() => ack(a.id, "acknowledged")}>
                          Ack
                        </button>
                        <button className="btn secondary" onClick={() => ack(a.id, "dismissed")}>
                          Dismiss
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
