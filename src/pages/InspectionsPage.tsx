import { FormEvent, useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

interface Vehicle {
  id: number;
  unit_number: string;
  assigned_driver?: string | null;
}

interface WeeklyRow {
  vehicle_id: number;
  unit_number: string;
  assigned_driver: string | null;
  status: string;
  last_check_date: string | null;
  last_status: string | null;
  due: number;
  open_repairs: number;
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

/** Last check as MM/YY, or N/A if never checked */
function formatCheckWhen(dateStr: string | null | undefined): string {
  if (!dateStr) return "N/A";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (m) return `${m[2]}/${m[1].slice(2)}`;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "N/A";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${mm}/${yy}`;
}

type StatusTone = "good" | "repair" | "down";

/** Green = good, yellow = needs repair, red = down */
function unitStatus(w: WeeklyRow): { tone: StatusTone; label: string } {
  if (w.status === "out_of_service") {
    return { tone: "down", label: "Down" };
  }
  if (w.last_status === "fail") {
    return { tone: "down", label: "Down" };
  }
  if (
    (w.open_repairs && w.open_repairs > 0) ||
    w.last_status === "pass_with_notes"
  ) {
    return { tone: "repair", label: "Repair" };
  }
  if (w.due || !w.last_check_date) {
    // Due for weekly check or never checked — still needs attention (yellow)
    return { tone: "repair", label: w.last_check_date ? "Due" : "Due" };
  }
  if (w.last_status === "pass" || !w.last_status) {
    return { tone: "good", label: "Good" };
  }
  return { tone: "repair", label: "Check" };
}

export function InspectionsPage() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [weekly, setWeekly] = useState<WeeklyRow[]>([]);
  const [list, setList] = useState<Inspection[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<"full" | "ok" | "issue">("full");

  const [vehicleId, setVehicleId] = useState("");
  const [odometer, setOdometer] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [checks, setChecks] = useState<Record<string, string>>(
    Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"]))
  );
  const [createIssue, setCreateIssue] = useState(true);

  async function load() {
    const [v, i, w] = await Promise.all([
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
      api<{ inspections: Inspection[] }>("/inspections"),
      api<{ vehicles: WeeklyRow[] }>("/inspections/weekly-status"),
    ]);
    setVehicles(v.vehicles);
    setList(i.inspections);
    setWeekly(w.vehicles);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  function openQuick(vehicleIdNum: number, kind: "ok" | "issue") {
    setVehicleId(String(vehicleIdNum));
    setMode(kind);
    setNotes("");
    setChecks(Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, kind === "ok" ? "ok" : "attention"])));
    setCreateIssue(kind === "issue");
    setDate(new Date().toISOString().slice(0, 10));
    setShow(true);
  }

  function overallFromChecks(): "pass" | "pass_with_notes" | "fail" {
    if (mode === "ok") return "pass";
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
      const checklist =
        mode === "ok"
          ? Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"]))
          : checks;
      const res = await api<{ created_issue_id: number | null }>("/inspections", {
        method: "POST",
        body: JSON.stringify({
          vehicle_id: Number(vehicleId),
          inspection_date: date,
          odometer: odometer === "" ? null : Number(odometer),
          overall_status: overall,
          checklist,
          notes: notes || null,
          create_issue_on_fail: createIssue,
        }),
      });
      if (overall === "pass") {
        setOk("Weekly check saved — everything reported in working order.");
      } else if (res.created_issue_id) {
        setOk(`Check saved. Repair ticket #${res.created_issue_id} opened for the fleet manager.`);
      } else {
        setOk("Weekly check saved with notes.");
      }
      setShow(false);
      setMode("full");
      setNotes("");
      setOdometer("");
      setChecks(Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"])));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  const counts = {
    good: weekly.filter((w) => unitStatus(w).tone === "good").length,
    repair: weekly.filter((w) => unitStatus(w).tone === "repair").length,
    down: weekly.filter((w) => unitStatus(w).tone === "down").length,
  };

  return (
    <div className="weekly-page">
      <div className="page-header">
        <div>
          <h1>Weekly checks</h1>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            Green good · yellow repair/due · red down. Compact list — tap All good or Issue.
          </p>
        </div>
        {can(user, "reportIssues") && (
          <button
            className="btn secondary no-print"
            type="button"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.82rem" }}
            onClick={() => {
              setMode("full");
              setShow(true);
            }}
          >
            Full checklist
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="success">{ok}</div>}

      <div className="weekly-legend" aria-label="Status colors">
        <span className="weekly-legend-item">
          <span className="weekly-dot tone-good" /> Good
        </span>
        <span className="weekly-legend-item">
          <span className="weekly-dot tone-repair" /> Repair / due
        </span>
        <span className="weekly-legend-item">
          <span className="weekly-dot tone-down" /> Down
        </span>
      </div>

      <div className="weekly-summary">
        <span className="weekly-summary-chip tone-good">{counts.good} good</span>
        <span className="weekly-summary-chip tone-repair">{counts.repair} repair</span>
        <span className="weekly-summary-chip tone-down">{counts.down} down</span>
      </div>

      <div className="weekly-list">
        {weekly.map((w) => {
          const st = unitStatus(w);
          const when = formatCheckWhen(w.last_check_date);
          return (
            <article key={w.vehicle_id} className={`weekly-card tone-${st.tone}`}>
              <div className="weekly-card-top">
                <div className="weekly-card-id">
                  <strong className="weekly-unit">{w.unit_number}</strong>
                  <span className="weekly-driver muted">
                    {w.assigned_driver || "Unassigned"}
                  </span>
                </div>
                <div className="weekly-card-status">
                  <span className="weekly-when" title="Last check">
                    {when}
                  </span>
                  <span className={`weekly-status-btn tone-${st.tone}`}>{st.label}</span>
                </div>
              </div>
              {can(user, "reportIssues") && (
                <div className="weekly-card-actions no-print">
                  <button
                    className="weekly-act good"
                    type="button"
                    onClick={() => openQuick(w.vehicle_id, "ok")}
                  >
                    Good
                  </button>
                  <button
                    className="weekly-act issue"
                    type="button"
                    onClick={() => openQuick(w.vehicle_id, "issue")}
                  >
                    Issue
                  </button>
                </div>
              )}
            </article>
          );
        })}
        {!weekly.length && <div className="empty">No vehicles to show.</div>}
      </div>

      <div className="card weekly-recent">
        <h2 style={{ marginTop: 0 }}>Recent</h2>
        {!list.length ? (
          <div className="empty">No checks yet.</div>
        ) : (
          <ul className="weekly-recent-list">
            {list.slice(0, 12).map((i) => {
              const tone: StatusTone =
                i.overall_status === "fail"
                  ? "down"
                  : i.overall_status === "pass_with_notes"
                    ? "repair"
                    : "good";
              return (
                <li key={i.id} className="weekly-recent-row">
                  <span className={`weekly-status-btn sm tone-${tone}`}>
                    {tone === "good" ? "Good" : tone === "down" ? "Down" : "Repair"}
                  </span>
                  <div className="weekly-recent-meta">
                    <strong>{i.unit_number}</strong>
                    <span className="muted">
                      {formatCheckWhen(i.inspection_date)} · {i.inspector_name}
                      {i.notes ? ` · ${i.notes.slice(0, 40)}` : ""}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {show && (
        <div className="modal-backdrop" onClick={() => setShow(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              {mode === "ok"
                ? "All good — weekly check"
                : mode === "issue"
                  ? "Report an issue"
                  : "Full inspection checklist"}
            </h2>
            <form className="form" onSubmit={onSubmit}>
              <label>
                Vehicle
                <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} required>
                  <option value="">Select…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.unit_number}
                      {v.assigned_driver ? ` — ${v.assigned_driver}` : ""}
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
                  Odometer (optional)
                  <input
                    type="number"
                    value={odometer}
                    onChange={(e) => setOdometer(e.target.value)}
                    inputMode="decimal"
                  />
                </label>
              </div>

              {mode === "ok" && (
                <p className="muted">
                  Marks this unit green for the week — everything in working order.
                </p>
              )}

              {(mode === "full" || mode === "issue") && (
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
              )}

              <label>
                {mode === "ok" ? "Notes (optional)" : "Describe the issue"}
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  required={mode === "issue"}
                  placeholder={
                    mode === "issue" ? "What is wrong? When did you notice it?" : undefined
                  }
                />
              </label>

              {mode !== "ok" && can(user, "reportIssues") && (
                <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={createIssue}
                    onChange={(e) => setCreateIssue(e.target.checked)}
                  />
                  Open repair ticket for the fleet manager
                </label>
              )}

              <div className="toolbar">
                <button className="btn" type="submit">
                  {mode === "ok" ? "Confirm all good" : "Submit check"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => {
                    setShow(false);
                    setMode("full");
                  }}
                >
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
