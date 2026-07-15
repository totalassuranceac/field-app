import { useEffect, useState } from "react";
import { api } from "../api";
import type { Vehicle } from "./VehiclesPage";

interface Issue {
  id: number;
  unit_number: string;
  severity: string;
  title: string;
  status: string;
  scheduled_date: string | null;
  reporter_name: string;
  description: string | null;
}

export function ReportsPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ issues: Issue[] }>("/issues?report=schedule"),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=expired"),
    ])
      .then(([iss, vehs]) => {
        setIssues(iss.issues);
        setVehicles(vehs.vehicles);
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p>Printable work and compliance lists · CSV export for the office</p>
        </div>
        <div className="toolbar no-print">
          <a className="btn secondary" href="/api/reports/fuel.csv">
            Download fuel CSV
          </a>
          <button className="btn" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2>Vehicles needing scheduled work</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Severity</th>
                <th>Issue</th>
                <th>Status</th>
                <th>Scheduled</th>
                <th>Reporter</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.id}>
                  <td>{i.unit_number}</td>
                  <td>{i.severity}</td>
                  <td>
                    {i.title}
                    {i.description ? ` — ${i.description}` : ""}
                  </td>
                  <td>{i.status}</td>
                  <td>{i.scheduled_date || "—"}</td>
                  <td>{i.reporter_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!issues.length && <div className="empty">Nothing pending.</div>}
        </div>
      </div>

      <div className="card">
        <h2>Compliance — expired stickers / dates</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Plate</th>
                <th>Registration</th>
                <th>Inspection</th>
                <th>Insurance</th>
                <th>Emissions</th>
                <th>Dash cam</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id}>
                  <td>{v.unit_number}</td>
                  <td>{v.plate}</td>
                  <td>{v.registration_expires || "—"}</td>
                  <td>{v.inspection_expires || "—"}</td>
                  <td>{v.insurance_expires || "—"}</td>
                  <td>{v.emissions_expires || "—"}</td>
                  <td>{v.dash_cam_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!vehicles.length && <div className="empty">No expired items currently.</div>}
        </div>
      </div>
    </div>
  );
}
