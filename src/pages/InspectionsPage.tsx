import { FormEvent, useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

interface Vehicle {
  id: number;
  unit_number: string;
}

interface Inspection {
  id: number;
  vehicle_id: number;
  unit_number: string;
  inspector_name: string;
  inspection_date: string;
  odometer: number | null;
  overall_status: string;
  notes: string | null;
  created_issue_id: number | null;
  created_at: string;
}

const CHECK_ITEMS = [
  { key: "tires", label: "Tires / tread / pressure" },
  { key: "lights", label: "Lights / signals / hazards" },
  { key: "brakes", label: "Brakes / parking brake" },
  { key: "fluids", label: "Oil / coolant / washer fluid" },
  { key: "body", label: "Body damage / glass" },
  { key: "interior", label: "Interior / seatbelts" },
  { key: "dash_cam", label: "Dash cam working" },
  { key: "gps", label: "GPS unit present / powered" },
  { key: "registration", label: "Registration / inspection stickers current" },
  { key: "tools", label: "Tools / ladder / equipment secure" },
];

export function InspectionsPage() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [list, setList] = useState<Inspection[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [show, setShow] = useState(false);

  const [vehicleId, setVehicleId] = useState("");
  const [odometer, setOdometer] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [checks, setChecks] = useState<Record<string, string>>(
    Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"]))
  );
  const [createIssue, setCreateIssue] = useState(true);

  async function load() {
    const [v, i] = await Promise.all([
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
      api<{ inspections: Inspection[] }>("/inspections"),
    ]);
    setVehicles(v.vehicles);
    setList(i.inspections);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  function overallFromChecks(): "pass" | "pass_with_notes" | "fail" {
    const vals = Object.values(checks);
    if (vals.some((v) => v === "fail")) return "fail";
    if (vals.some((v) => v === "attention") || notes.trim()) return "pass_with_notes";
    return "pass";
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    try {
      const overall = overallFromChecks();
      await api("/inspections", {
        method: "POST",
        body: JSON.stringify({
          vehicle_id: Number(vehicleId),
          inspection_date: date,
          odometer: odometer === "" ? null : Number(odometer),
          overall_status: overall,
          checklist: checks,
          notes: notes || null,
          create_issue_on_fail: createIssue,
        }),
      });
      setOk(
        overall === "fail"
          ? "Inspection saved. A repair issue was opened for the fleet manager."
          : "Inspection saved."
      );
      setShow(false);
      setNotes("");
      setOdometer("");
      setChecks(Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"])));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Vehicle inspections</h1>
          <p>Quick walk-around checks — catch issues before they become downtime</p>
        </div>
        <button className="btn no-print" type="button" onClick={() => setShow(true)}>
          New inspection
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="success">{ok}</div>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Unit</th>
                <th>Result</th>
                <th>Odometer</th>
                <th>Inspector</th>
                <th>Notes</th>
                <th>Issue</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td>{i.inspection_date}</td>
                  <td>
                    <strong>{i.unit_number}</strong>
                  </td>
                  <td>
                    <span className={`badge ${i.overall_status}`}>{i.overall_status}</span>
                  </td>
                  <td>{i.odometer != null ? i.odometer.toLocaleString() : "—"}</td>
                  <td>{i.inspector_name}</td>
                  <td>{i.notes || "—"}</td>
                  <td>{i.created_issue_id ? `#${i.created_issue_id}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <div className="empty">No inspections yet.</div>}
        </div>
      </div>

      {show && (
        <div className="modal-backdrop" onClick={() => setShow(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Inspection report</h2>
            <form className="form" onSubmit={onSubmit}>
              <label>
                Vehicle
                <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} required>
                  <option value="">Select…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.unit_number}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form row">
                <label>
                  Date
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
                </label>
                <label>
                  Odometer
                  <input
                    type="number"
                    value={odometer}
                    onChange={(e) => setOdometer(e.target.value)}
                    inputMode="decimal"
                  />
                </label>
              </div>
              <div className="checklist">
                {CHECK_ITEMS.map((c) => (
                  <div className="checklist-item" key={c.key}>
                    <div style={{ flex: 1 }}>
                      <strong>{c.label}</strong>
                    </div>
                    <select
                      value={checks[c.key]}
                      onChange={(e) => setChecks({ ...checks, [c.key]: e.target.value })}
                    >
                      <option value="ok">OK</option>
                      <option value="attention">Attention</option>
                      <option value="fail">Fail</option>
                    </select>
                  </div>
                ))}
              </div>
              <label>
                Notes
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              {can(user, "reportIssues") && (
                <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={createIssue}
                    onChange={(e) => setCreateIssue(e.target.checked)}
                  />
                  Open repair ticket if any item fails
                </label>
              )}
              <div className="toolbar">
                <button className="btn" type="submit">
                  Submit inspection
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
