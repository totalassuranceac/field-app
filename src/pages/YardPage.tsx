import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
import type { Vehicle } from "./VehiclesPage";

type Filter = "all" | "expired" | "expiring" | "dash_cam";

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function worstStatus(v: Vehicle, soonDays: number): "ok" | "warn" | "bad" {
  const dates = [v.registration_expires, v.inspection_expires, v.insurance_expires, v.emissions_expires];
  let worst: "ok" | "warn" | "bad" = "ok";
  for (const d of dates) {
    const days = daysUntil(d);
    if (days == null) continue;
    if (days < 0) worst = "bad";
    else if (days <= soonDays && worst !== "bad") worst = "warn";
  }
  if (["not_working", "missing"].includes(v.dash_cam_status) && worst === "ok") worst = "warn";
  if (v.status === "out_of_service") worst = worst === "bad" ? "bad" : "warn";
  return worst;
}

export function YardPage() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [soonDays, setSoonDays] = useState(30);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [form, setForm] = useState({
    registration_expires: "",
    inspection_expires: "",
    insurance_expires: "",
    dash_cam_status: "unknown",
    insurance_card: "",
    notes: "",
  });

  async function load(f: Filter = filter) {
    const q = f === "all" ? "" : `?filter=${f}`;
    const data = await api<{ vehicles: Vehicle[]; expiring_soon_days: number }>(`/vehicles${q}`);
    setVehicles(data.vehicles);
    setSoonDays(data.expiring_soon_days || 30);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [filter]);

  const sorted = useMemo(() => {
    return [...vehicles].sort((a, b) => {
      const rank = { bad: 0, warn: 1, ok: 2 };
      return rank[worstStatus(a, soonDays)] - rank[worstStatus(b, soonDays)] || a.unit_number.localeCompare(b.unit_number);
    });
  }, [vehicles, soonDays]);

  function openVehicle(v: Vehicle) {
    setSelected(v);
    setForm({
      registration_expires: v.registration_expires || "",
      inspection_expires: v.inspection_expires || "",
      insurance_expires: v.insurance_expires || "",
      dash_cam_status: v.dash_cam_status,
      insurance_card: v.insurance_card || "",
      notes: v.notes || "",
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!selected || !can(user, "manageVehicles")) return;
    try {
      await api(`/vehicles/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          registration_expires: form.registration_expires || null,
          inspection_expires: form.inspection_expires || null,
          insurance_expires: form.insurance_expires || null,
          insurance_card: form.insurance_card || null,
          dash_cam_status: form.dash_cam_status,
          notes: form.notes,
        }),
      });
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Yard walk</h1>
          <p>Walk the lot and update stickers, registration, and dash cams</p>
        </div>
        <button className="btn secondary no-print" onClick={() => window.print()}>
          Print list
        </button>
      </div>

      <div className="filters no-print">
        {(
          [
            ["all", "All units"],
            ["expired", "Expired"],
            ["expiring", `Expiring ≤${soonDays}d`],
            ["dash_cam", "Dash cam issues"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="yard-grid">
        {sorted.map((v) => {
          const status = worstStatus(v, soonDays);
          return (
            <button key={v.id} className={`yard-card status-${status}`} onClick={() => openVehicle(v)}>
              <div className="unit">Unit {v.unit_number}</div>
              <div className="muted" style={{ marginBottom: "0.35rem" }}>
                {v.assigned_driver || "Unassigned"}
                {v.phone ? ` · ${v.phone}` : ""}
              </div>
              <div className="muted" style={{ marginBottom: "0.5rem" }}>
                {[v.year, v.make, v.model].filter(Boolean).join(" ") || "—"} · {v.plate || "no plate"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginBottom: "0.5rem" }}>
                <span className={`badge ${status === "bad" ? "expired" : status === "warn" ? "expiring" : "ok"}`}>
                  {status === "bad" ? "Needs attention" : status === "warn" ? "Due soon" : "Current"}
                </span>
                <span className={`badge ${v.dash_cam_status === "working" ? "ok" : "warning"}`}>
                  cam: {v.cam_type || v.dash_cam_status}
                </span>
                {v.gps_tracker && <span className="badge">GPS: {v.gps_tracker}</span>}
              </div>
              <div style={{ fontSize: "0.9rem" }}>
                <div>
                  <strong>Reg:</strong> {v.registration_expires || "—"}{" "}
                  {dateHint(v.registration_expires, soonDays)}
                </div>
                <div>
                  <strong>Insp:</strong> {v.inspection_expires || "—"}{" "}
                  {dateHint(v.inspection_expires, soonDays)}
                </div>
                <div>
                  <strong>Ins:</strong> {v.insurance_expires || "—"}{" "}
                  {dateHint(v.insurance_expires, soonDays)}
                  {v.insurance_card ? ` · card ${v.insurance_card}` : ""}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {!sorted.length && <div className="empty">No vehicles match this filter.</div>}

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Unit {selected.unit_number}</h2>
            <p className="muted">
              {[selected.year, selected.make, selected.model].filter(Boolean).join(" ")} · {selected.plate}
            </p>
            {can(user, "manageVehicles") ? (
              <form className="form" onSubmit={save}>
                <label>
                  Registration sticker expires
                  <input
                    type="date"
                    value={form.registration_expires}
                    onChange={(e) => setForm({ ...form, registration_expires: e.target.value })}
                  />
                </label>
                <label>
                  Inspection expires
                  <input
                    type="date"
                    value={form.inspection_expires}
                    onChange={(e) => setForm({ ...form, inspection_expires: e.target.value })}
                  />
                </label>
                <label>
                  Insurance expires
                  <input
                    type="date"
                    value={form.insurance_expires}
                    onChange={(e) => setForm({ ...form, insurance_expires: e.target.value })}
                  />
                </label>
                <label>
                  Insurance card on vehicle
                  <select
                    value={form.insurance_card}
                    onChange={(e) => setForm({ ...form, insurance_card: e.target.value })}
                  >
                    <option value="">—</option>
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                    <option value="N/A">N/A</option>
                  </select>
                </label>
                <label>
                  Dash cam
                  <select
                    value={form.dash_cam_status}
                    onChange={(e) => setForm({ ...form, dash_cam_status: e.target.value })}
                  >
                    <option value="working">working</option>
                    <option value="not_working">not_working</option>
                    <option value="missing">missing</option>
                    <option value="unknown">unknown</option>
                  </select>
                </label>
                <label>
                  Notes
                  <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </label>
                <div className="toolbar">
                  <button className="btn" type="submit">
                    Save update
                  </button>
                  <button className="btn secondary" type="button" onClick={() => setSelected(null)}>
                    Close
                  </button>
                </div>
              </form>
            ) : (
              <div>
                <p>Registration: {selected.registration_expires || "—"}</p>
                <p>Inspection: {selected.inspection_expires || "—"}</p>
                <p>Dash cam: {selected.dash_cam_status}</p>
                <button className="btn secondary" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function dateHint(dateStr: string | null, soonDays: number) {
  const d = daysUntil(dateStr);
  if (d == null) return null;
  if (d < 0) return <span className="badge expired">{Math.abs(d)}d overdue</span>;
  if (d <= soonDays) return <span className="badge expiring">{d}d left</span>;
  return null;
}
