import { useEffect, useState } from "react";
import { api } from "../api";

interface Downtime {
  id: number;
  vehicle_id: number;
  unit_number: string;
  issue_id: number | null;
  issue_title: string | null;
  reason: string | null;
  started_at: string;
  ended_at: string | null;
  hours_down: number | null;
  started_by_name: string | null;
  ended_by_name: string | null;
  notes: string | null;
}

interface SummaryRow {
  vehicle_id: number;
  unit_number: string;
  open_events: number;
  total_hours_30d: number;
  currently_down: number;
}

function fmtHours(h: number | null) {
  if (h == null) return "—";
  if (h < 24) return `${h.toFixed(1)} hrs`;
  return `${(h / 24).toFixed(1)} days`;
}

export function DowntimePage() {
  const [events, setEvents] = useState<Downtime[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ events: Downtime[] }>("/downtime"),
      api<{ summary: SummaryRow[] }>("/downtime/summary"),
    ])
      .then(([e, s]) => {
        setEvents(e.events);
        setSummary(s.summary);
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Trucks down</h1>
          <p>Accountability for units out of service — duration, reason, and ownership</p>
        </div>
        <button className="btn secondary no-print" type="button" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="grid stats" style={{ marginBottom: "1rem" }}>
        <div className="card">
          <div className="stat-value">{summary.filter((s) => s.currently_down).length}</div>
          <div className="stat-label">Currently down</div>
        </div>
        <div className="card">
          <div className="stat-value">
            {summary.reduce((a, s) => a + Number(s.total_hours_30d || 0), 0).toFixed(0)}
          </div>
          <div className="stat-label">Fleet hours down (30 days)</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2>By vehicle (30 days)</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Status</th>
                <th>Open events</th>
                <th>Hours down</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.vehicle_id}>
                  <td>
                    <strong>{s.unit_number}</strong>
                  </td>
                  <td>
                    {s.currently_down ? (
                      <span className="badge warning">Down now</span>
                    ) : (
                      <span className="badge ok">Up</span>
                    )}
                  </td>
                  <td>{s.open_events}</td>
                  <td className="downtime-pill">{fmtHours(Number(s.total_hours_30d))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!summary.length && <div className="empty">No downtime recorded yet.</div>}
        </div>
      </div>

      <div className="card">
        <h2>Event log</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Reason / issue</th>
                <th>Started</th>
                <th>Ended</th>
                <th>Duration</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{e.unit_number}</td>
                  <td>
                    {e.issue_title || e.reason || "—"}
                    {e.notes && <div className="muted">{e.notes}</div>}
                  </td>
                  <td>{e.started_at}</td>
                  <td>{e.ended_at || <span className="badge warning">open</span>}</td>
                  <td>{fmtHours(e.hours_down)}</td>
                  <td>
                    {e.started_by_name || "—"}
                    {e.ended_by_name ? ` → ${e.ended_by_name}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
