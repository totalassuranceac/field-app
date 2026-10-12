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

/** Nearby /downtime/summary row. Hours down over 30 days, not a day count. */
interface DownSummary {
  vehicle_id: number;
  unit_number: string;
  total_hours_30d: number | string | null;
  currently_down: number | string | null;
}

/** Nearby /inspections/weekly-status row. */
interface WeeklyFleet {
  vehicle_id: number;
  unit_number: string;
  status: string;
  open_repairs: number | string | null;
}

interface FleetExportRow {
  unit_number: string;
  status: string;
  out_of_service_days_30d: number | null;
  open_repair_count: number | null;
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildFleetExport(weekly: WeeklyFleet[] | null, down: DownSummary[] | null): FleetExportRow[] {
  const map = new Map<string, FleetExportRow>();
  const keyOf = (id: number | null | undefined, unit: string) =>
    id != null && Number.isFinite(Number(id)) ? `id:${Number(id)}` : `u:${unit}`;

  for (const row of weekly || []) {
    const unit = String(row.unit_number || "").trim();
    if (!unit) continue;
    map.set(keyOf(row.vehicle_id, unit), {
      unit_number: unit,
      status: String(row.status || ""),
      out_of_service_days_30d: null,
      open_repair_count: numOrNull(row.open_repairs),
    });
  }

  for (const row of down || []) {
    const unit = String(row.unit_number || "").trim();
    if (!unit) continue;
    const key = keyOf(row.vehicle_id, unit);
    const prev = map.get(key) || {
      unit_number: unit,
      status: "",
      out_of_service_days_30d: null,
      open_repair_count: null,
    };
    const hours = numOrNull(row.total_hours_30d);
    if (hours != null) prev.out_of_service_days_30d = Math.round((hours / 24) * 10) / 10;
    if (!prev.status && numOrNull(row.currently_down)) prev.status = "out_of_service";
    map.set(key, prev);
  }

  return [...map.values()].sort((a, b) =>
    a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true })
  );
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
  const [weeklyFleet, setWeeklyFleet] = useState<WeeklyFleet[] | null>(null);
  const [downSummary, setDownSummary] = useState<DownSummary[] | null>(null);
  const [fleetExtras, setFleetExtras] = useState<"loading" | "ready" | "missing">("loading");
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
    Promise.allSettled([
      api<{ vehicles: WeeklyFleet[] }>("/inspections/weekly-status"),
      api<{ summary: DownSummary[] }>("/downtime/summary"),
    ]).then(([weekly, down]) => {
      const weeklyRows = weekly.status === "fulfilled" ? weekly.value.vehicles || [] : null;
      const downRows = down.status === "fulfilled" ? down.value.summary || [] : null;
      setWeeklyFleet(weeklyRows);
      setDownSummary(downRows);
      setFleetExtras(weeklyRows || downRows ? "ready" : "missing");
    });
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
  const fleetRows = useMemo(
    () => buildFleetExport(weeklyFleet, downSummary),
    [weeklyFleet, downSummary]
  );
  const fleetHasDays = fleetRows.some((row) => row.out_of_service_days_30d != null);
  const fleetHasRepairs = fleetRows.some((row) => row.open_repair_count != null);
  const fleetAttention = fleetRows.filter(
    (row) =>
      row.status === "out_of_service" ||
      (row.out_of_service_days_30d != null && row.out_of_service_days_30d > 0) ||
      (row.open_repair_count != null && row.open_repair_count > 0)
  );

  function downloadFleetCsv() {
    const headers = ["unit_number", "status"];
    if (fleetHasDays) headers.push("out_of_service_days_30d");
    if (fleetHasRepairs) headers.push("open_repair_count");
    const lines = [
      headers.join(","),
      ...fleetRows.map((row) => {
        const cells = [csvCell(row.unit_number), csvCell(row.status)];
        if (fleetHasDays) cells.push(csvCell(row.out_of_service_days_30d));
        if (fleetHasRepairs) cells.push(csvCell(row.open_repair_count));
        return cells.join(",");
      }),
    ];
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fleet-oos-repairs.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Fuel &amp; fleet exports</h1>
          <p>Printable work and compliance lists · CSV export for the office</p>
        </div>
        <div className="toolbar no-print">
          <a className="btn secondary btn-sm" href="/api/reports/fuel.csv">
            Fuel CSV
          </a>
          <a className="btn secondary btn-sm" href="/api/reports/issues.csv">
            Repairs CSV
          </a>
          {fleetRows.length > 0 && (
            <button className="btn secondary btn-sm" type="button" onClick={downloadFleetCsv}>
              Fleet CSV
            </button>
          )}
          <button className="btn btn-sm" type="button" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>
      {fleetExtras === "missing" && (
        <p className="muted" style={{ marginTop: 0 }}>
          Out-of-service days and open repair count are included in the fleet export only when
          those lists are already loaded.
        </p>
      )}
      {error && <div className="error">{error}</div>}

      {fleetRows.length > 0 && (fleetHasDays || fleetHasRepairs) && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2>Out of service and open repairs</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.9rem" }}>
            Days are the last 30 days from downtime hours. Open repairs are the current shop
            count. Fleet CSV includes every non-retired unit when that list loaded.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Unit</th>
                  <th>Status</th>
                  {fleetHasDays ? <th>Out-of-service days (30d)</th> : null}
                  {fleetHasRepairs ? <th>Open repairs</th> : null}
                </tr>
              </thead>
              <tbody>
                {fleetAttention.map((row) => (
                  <tr key={row.unit_number}>
                    <td>
                      <strong>{row.unit_number}</strong>
                    </td>
                    <td>{row.status ? row.status.replace(/_/g, " ") : "-"}</td>
                    {fleetHasDays ? <td>{row.out_of_service_days_30d ?? ""}</td> : null}
                    {fleetHasRepairs ? <td>{row.open_repair_count ?? ""}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {!fleetAttention.length && (
              <div className="empty">No units down and no open repairs in the loaded lists.</div>
            )}
          </div>
        </div>
      )}

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
