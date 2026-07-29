import { useEffect, useMemo, useState } from "react";
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

/** N/A = ignore. Only missing / not_working need shop work. Working = good. */
function camNeedsWork(v: Vehicle): boolean {
  return v.dash_cam_status === "missing" || v.dash_cam_status === "not_working";
}

function gpsNeedsWork(v: Vehicle): boolean {
  const s = v.gps_status || "n/a";
  return s === "missing" || s === "not_working";
}

function equipmentNeedsWork(v: Vehicle): boolean {
  return camNeedsWork(v) || gpsNeedsWork(v);
}

function equipmentAction(v: Vehicle): string {
  const parts: string[] = [];
  if (v.dash_cam_status === "missing") parts.push("Install dash cam");
  else if (v.dash_cam_status === "not_working") parts.push("Repair / replace dash cam");
  if (v.gps_status === "missing") parts.push("Install GPS tracker");
  else if (v.gps_status === "not_working") parts.push("Repair / re-enable GPS");
  return parts.join(" · ") || "—";
}

function statusLabel(status: string | null | undefined): string {
  if (!status || status === "n/a" || status === "unknown") return "N/A";
  return status.replace(/_/g, " ");
}

function equipmentCondition(v: Vehicle): "needs_work" | "good" | "n/a_only" {
  if (equipmentNeedsWork(v)) return "needs_work";
  const camOk = v.dash_cam_status === "working" || v.dash_cam_status === "n/a";
  const gpsOk =
    !v.gps_status || v.gps_status === "working" || v.gps_status === "n/a" || v.gps_status === "unknown";
  if (camOk && gpsOk) {
    // At least one is actively working, or both intentionally N/A
    if (v.dash_cam_status === "working" || v.gps_status === "working") return "good";
    return "n/a_only";
  }
  return "needs_work";
}

export function ReportsPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [expired, setExpired] = useState<Vehicle[]>([]);
  const [equipment, setEquipment] = useState<Vehicle[]>([]);
  const [allActive, setAllActive] = useState<Vehicle[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ issues: Issue[] }>("/issues?report=schedule"),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=expired"),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=equipment"),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
    ])
      .then(([iss, exp, eq, active]) => {
        setIssues(iss.issues);
        setExpired(exp.vehicles);
        setEquipment(eq.vehicles);
        setAllActive(active.vehicles);
      })
      .catch((e) => setError(e.message));
  }, []);

  const equipSorted = useMemo(() => {
    return [...equipment]
      .filter((v) => v.status !== "retired" && equipmentNeedsWork(v))
      .sort((a, b) => {
        // Missing dash cam first (install priority), then not working, then GPS-only
        const score = (v: Vehicle) => {
          let s = 0;
          if (v.dash_cam_status === "missing") s += 0;
          else if (v.dash_cam_status === "not_working") s += 1;
          else s += 3;
          if (v.gps_status === "missing") s += 0;
          else if (v.gps_status === "not_working") s += 1;
          else s += 2;
          return s;
        };
        return score(a) - score(b) || a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true });
      });
  }, [equipment]);

  const goodCount = useMemo(
    () => allActive.filter((v) => v.status === "active" && equipmentCondition(v) === "good").length,
    [allActive]
  );
  const needsWorkCount = equipSorted.length;
  const activeCount = allActive.filter((v) => v.status === "active").length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p>Printable work and compliance lists · CSV export for the office</p>
        </div>
        <div className="toolbar no-print">
          <a className="btn secondary btn-sm" href="/api/reports/fuel.csv">
            Fuel CSV
          </a>
          <a className="btn secondary btn-sm" href="/api/reports/issues.csv">
            Repairs CSV
          </a>
          <button className="btn btn-sm" type="button" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      {/* Mechanic priority: install / repair cams and GPS */}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2>Dash cam &amp; GPS — schedule installs / repairs</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.9rem" }}>
          Units that need a <strong>working dash cam</strong> and/or <strong>working GPS</strong>.{" "}
          <strong>N/A</strong> means we do not track that unit (skip). Good condition = both working
          (or N/A where not required).
        </p>
        <div className="toolbar no-print" style={{ marginBottom: "0.75rem", gap: "0.5rem", flexWrap: "wrap" }}>
          <span className="badge danger">{needsWorkCount} need work</span>
          <span className="badge ok">{goodCount} good (cam + GPS working)</span>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {activeCount} active units total
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Driver</th>
                <th>Dash cam</th>
                <th>Cam type</th>
                <th>GPS</th>
                <th>GPS system</th>
                <th>Action for shop</th>
              </tr>
            </thead>
            <tbody>
              {equipSorted.map((v) => (
                <tr key={v.id}>
                  <td>
                    <strong>{v.unit_number}</strong>
                  </td>
                  <td>{v.assigned_driver || "—"}</td>
                  <td>
                    <span
                      className={`badge ${
                        camNeedsWork(v) ? "danger" : v.dash_cam_status === "working" ? "ok" : ""
                      }`}
                    >
                      {statusLabel(v.dash_cam_status)}
                    </span>
                  </td>
                  <td>{v.cam_type || "—"}</td>
                  <td>
                    <span
                      className={`badge ${
                        gpsNeedsWork(v) ? "danger" : v.gps_status === "working" ? "ok" : ""
                      }`}
                    >
                      {statusLabel(v.gps_status)}
                    </span>
                  </td>
                  <td>{v.gps_tracker || "—"}</td>
                  <td>
                    <strong>{equipmentAction(v)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!equipSorted.length && (
            <div className="empty">
              No units with missing or broken dash cams / GPS. Fleet equipment looks good (N/A units
              are excluded).
            </div>
          )}
        </div>
      </div>

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
        <h2>Compliance — expired registration / insurance</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Plate</th>
                <th>Registration</th>
                <th>Insurance</th>
                <th>Dash cam</th>
                <th>GPS</th>
              </tr>
            </thead>
            <tbody>
              {expired.map((v) => (
                <tr key={v.id}>
                  <td>{v.unit_number}</td>
                  <td>{v.plate}</td>
                  <td>{v.registration_expires || "—"}</td>
                  <td>{v.insurance_expires || "—"}</td>
                  <td>
                    <span className={`badge ${camNeedsWork(v) ? "danger" : v.dash_cam_status === "working" ? "ok" : ""}`}>
                      {statusLabel(v.dash_cam_status)}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${gpsNeedsWork(v) ? "danger" : v.gps_status === "working" ? "ok" : ""}`}>
                      {statusLabel(v.gps_status)}
                    </span>
                    {v.gps_tracker ? ` (${v.gps_tracker})` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!expired.length && <div className="empty">No expired registration/insurance currently.</div>}
        </div>
      </div>
    </div>
  );
}
