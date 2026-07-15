import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, can, roleLabel } from "../api";
import { useAuth } from "../auth";

interface Dash {
  stats: { open_alerts: number; open_issues: number; expiring_soon: number };
  recent_fuel: Array<{
    id: number;
    unit_number: string;
    employee_name: string;
    odometer: number;
    fuel_date: string;
    total_cost: number | null;
  }>;
  recent_alerts: Array<{
    id: number;
    unit_number: string;
    message: string;
    severity: string;
  }>;
}

export function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError("");
    api<Dash>("/dashboard")
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  if (loading && !data) {
    return <div className="muted">Loading home…</div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Home</h1>
          <p>
            Welcome{user?.display_name ? `, ${user.display_name}` : ""} · {roleLabel(user?.role)}
          </p>
        </div>
      </div>

      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}
          <div style={{ marginTop: "0.5rem" }}>
            <button className="btn secondary" type="button" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2>What do you need to do?</h2>
        <div className="quick-actions">
          {can(user, "logFuel") && (
            <Link className="quick-action" to="/fuel">
              <strong>Log fuel</strong>
              <span>Scan receipt · enter mileage</span>
            </Link>
          )}
          <Link className="quick-action" to="/inspections">
            <strong>Inspection</strong>
            <span>Walk-around check</span>
          </Link>
          {can(user, "reportIssues") && (
            <Link className="quick-action" to="/issues">
              <strong>{can(user, "manageIssues") ? "Repairs" : "Report issue"}</strong>
              <span>{can(user, "manageIssues") ? "Schedule & complete work" : "Something wrong with a unit"}</span>
            </Link>
          )}
          <Link className="quick-action" to="/live">
            <strong>Live map</strong>
            <span>Where the fleet is now</span>
          </Link>
          <Link className="quick-action" to="/yard">
            <strong>Yard walk</strong>
            <span>Stickers · insurance · cams</span>
          </Link>
          <Link className="quick-action" to="/settings">
            <strong>Settings</strong>
            <span>Theme & account help</span>
          </Link>
        </div>
      </div>

      {data && (
        <>
          <div className="grid stats" style={{ marginBottom: "1rem" }}>
            <div className="card">
              <div className="stat-value">{data.stats.open_alerts}</div>
              <div className="stat-label">Open mileage flags</div>
              <Link to="/alerts">Review flags →</Link>
            </div>
            <div className="card">
              <div className="stat-value">{data.stats.open_issues}</div>
              <div className="stat-label">Open / scheduled repairs</div>
              <Link to="/issues">View repairs →</Link>
            </div>
            <div className="card">
              <div className="stat-value">{data.stats.expiring_soon}</div>
              <div className="stat-label">Compliance due soon</div>
              <Link to="/yard">Yard walk →</Link>
            </div>
          </div>

          <div className="grid two">
            <div className="card">
              <h2>Recent fuel entries</h2>
              {!data.recent_fuel.length && <div className="empty">No fuel logged yet.</div>}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Unit</th>
                      <th>Employee</th>
                      <th>Miles</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent_fuel.map((f) => (
                      <tr key={f.id}>
                        <td>{f.fuel_date}</td>
                        <td>{f.unit_number}</td>
                        <td>{f.employee_name}</td>
                        <td>{f.odometer.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <h2>Open red flags</h2>
              {!data.recent_alerts.length && <div className="empty">No open flags — nice work.</div>}
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {data.recent_alerts.map((a) => (
                  <li key={a.id} style={{ marginBottom: "0.55rem" }}>
                    <span className={`badge ${a.severity}`}>{a.severity}</span>{" "}
                    <strong>Unit {a.unit_number}</strong> — {a.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
