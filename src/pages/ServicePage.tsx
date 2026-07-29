import { FormEvent, useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { VehicleQuickPick, type VehicleMatch } from "../components/VehicleQuickPick";
import type { Vehicle } from "./VehiclesPage";

interface DueRow {
  vehicle_id: number;
  unit_number: string;
  current_odometer: number | null;
  assigned_driver: string | null;
  last_service_date: string | null;
  last_service_odometer: number | null;
  interval_miles: number | null;
  next_due_odometer: number | null;
  due_soon: number;
}

interface ServiceRecord {
  id: number;
  vehicle_id: number;
  unit_number: string;
  service_date: string;
  odometer: number | null;
  interval_miles: number;
  next_due_odometer: number | null;
  performed_by_name: string | null;
  notes: string | null;
}

export function ServicePage() {
  const { user } = useAuth();
  const [due, setDue] = useState<DueRow[]>([]);
  const [recent, setRecent] = useState<ServiceRecord[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [show, setShow] = useState(false);

  const [vehicleId, setVehicleId] = useState("");
  const [serviceDate, setServiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [odometer, setOdometer] = useState("");
  const [interval, setIntervalMiles] = useState("5000");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [d, r, v] = await Promise.all([
      api<{ vehicles: DueRow[] }>("/service/due"),
      api<{ records: ServiceRecord[] }>("/service?type=oil_change"),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
    ]);
    setDue(d.vehicles || []);
    setRecent(r.records || []);
    setVehicles(v.vehicles || []);
  }

  useEffect(() => {
    if (!can(user, "manageIssues")) return;
    load().catch((e) => setError(e.message));
  }, []);

  function openFor(v: DueRow) {
    setVehicleId(String(v.vehicle_id));
    setOdometer(v.current_odometer != null ? String(v.current_odometer) : "");
    setIntervalMiles(String(v.interval_miles || 5000));
    setServiceDate(new Date().toISOString().slice(0, 10));
    setNotes("");
    setShow(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      const odo = odometer === "" ? null : Number(odometer);
      const intv = Number(interval) || 5000;
      await api("/service", {
        method: "POST",
        body: JSON.stringify({
          vehicle_id: Number(vehicleId),
          service_type: "oil_change",
          service_date: serviceDate,
          odometer: odo,
          interval_miles: intv,
          notes: notes || null,
        }),
      });
      const next = odo != null ? Math.round(odo + intv) : null;
      setOk(
        next != null
          ? `Oil change saved. Next due around ${next.toLocaleString()} mi.`
          : "Oil change saved."
      );
      setShow(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!can(user, "manageIssues")) {
    return <div className="error">Mechanic / office access required for oil change tracking.</div>;
  }

  const dueList = due.filter((d) => d.due_soon);
  const okList = due.filter((d) => !d.due_soon);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Oil changes</h1>
          <p>
            Log each oil change with miles — next service is scheduled by interval (default 5,000
            mi).
          </p>
        </div>
        <button className="btn" type="button" onClick={() => setShow(true)}>
          Log oil change
        </button>
      </div>

      {ok && <div className="success" style={{ marginBottom: "1rem" }}>{ok}</div>}
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Due / due soon</h2>
        {!dueList.length ? (
          <p className="muted">No units overdue based on current odometer &amp; last service.</p>
        ) : (
          <div className="service-due-list">
            {dueList.map((v) => (
              <div key={v.vehicle_id} className="service-due-card due">
                <div>
                  <strong>Unit {v.unit_number}</strong>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {v.assigned_driver || "—"} · now{" "}
                    {v.current_odometer != null ? v.current_odometer.toLocaleString() : "?"} mi
                  </div>
                  <div className="muted" style={{ fontSize: "0.82rem" }}>
                    Last: {v.last_service_date || "N/A"}
                    {v.last_service_odometer != null
                      ? ` @ ${v.last_service_odometer.toLocaleString()} mi`
                      : ""}
                    {v.next_due_odometer != null
                      ? ` · next ${v.next_due_odometer.toLocaleString()} mi`
                      : ""}
                  </div>
                </div>
                <button className="btn" type="button" onClick={() => openFor(v)}>
                  Log change
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>On schedule</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Current mi</th>
                <th>Last change</th>
                <th>Next due mi</th>
              </tr>
            </thead>
            <tbody>
              {okList.map((v) => (
                <tr key={v.vehicle_id}>
                  <td>
                    <strong>{v.unit_number}</strong>
                  </td>
                  <td>{v.current_odometer != null ? v.current_odometer.toLocaleString() : "—"}</td>
                  <td>
                    {v.last_service_date || "N/A"}
                    {v.last_service_odometer != null
                      ? ` @ ${Number(v.last_service_odometer).toLocaleString()}`
                      : ""}
                  </td>
                  <td>
                    {v.next_due_odometer != null ? Number(v.next_due_odometer).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!okList.length && <div className="empty">No other active units.</div>}
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recent oil changes</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Unit</th>
                <th>Odometer</th>
                <th>Next due</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 30).map((r) => (
                <tr key={r.id}>
                  <td>{r.service_date}</td>
                  <td>
                    <strong>{r.unit_number}</strong>
                  </td>
                  <td>{r.odometer != null ? r.odometer.toLocaleString() : "—"}</td>
                  <td>
                    {r.next_due_odometer != null ? r.next_due_odometer.toLocaleString() : "—"}
                  </td>
                  <td>{r.performed_by_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!recent.length && <div className="empty">No oil changes logged yet.</div>}
        </div>
      </div>

      {show && (
        <div className="modal-backdrop" onClick={() => setShow(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Log oil change</h2>
            <form className="form" onSubmit={onSubmit}>
              <VehicleQuickPick
                value={vehicleId}
                vehicles={vehicles as VehicleMatch[]}
                onChange={(id, v) => {
                  setVehicleId(id);
                  if (v?.current_odometer != null && !odometer) {
                    setOdometer(String(v.current_odometer));
                  }
                }}
                required
                label="License plate or unit #"
                placeholder="Type plate to auto-fill unit…"
              />
              <label>
                Date of change
                <input
                  type="date"
                  value={serviceDate}
                  onChange={(e) => setServiceDate(e.target.value)}
                  required
                />
              </label>
              <label>
                Odometer at change
                <input
                  type="number"
                  value={odometer}
                  onChange={(e) => setOdometer(e.target.value)}
                  required
                  inputMode="decimal"
                />
              </label>
              <label>
                Interval (miles until next)
                <input
                  type="number"
                  value={interval}
                  onChange={(e) => setIntervalMiles(e.target.value)}
                  required
                />
              </label>
              {odometer && interval && (
                <p className="muted" style={{ margin: 0 }}>
                  Next due ≈ {(Number(odometer) + Number(interval)).toLocaleString()} mi
                </p>
              )}
              <label>
                Notes
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Oil type, filter, etc."
                />
              </label>
              <div className="toolbar">
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save oil change"}
                </button>
                <button className="btn secondary" type="button" onClick={() => setShow(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
