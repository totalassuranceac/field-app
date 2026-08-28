import { FormEvent, type ReactNode, useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { suggestTankCapacity } from "../tankCapacity";

export interface Vehicle {
  id: number;
  unit_number: string;
  plate: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  tank_capacity_gallons?: number | null;
  status: string;
  current_odometer: number | null;
  assigned_driver: string | null;
  assigned_employee_id?: number | null;
  helper_employee_id?: number | null;
  phone: string | null;
  insurance_card: string | null;
  dash_cam_status: string;
  cam_type: string | null;
  gps_tracker: string | null;
  registration_expires: string | null;
  inspection_expires: string | null; // legacy DB field; not used in Texas UI
  insurance_expires: string | null;
  gps_status: string | null;
  modifications: string | null;
  notes: string | null;
  /** P101-style personal unit (own insurance) */
  is_personal?: boolean;
  insurance_is_fleet?: boolean;
}

/** Personal units (P101, P-12…) — own insurance; all others share company fleet plan. */
export function isPersonalVehicleUnit(unit: string | null | undefined): boolean {
  const u = String(unit || "")
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  return /^P\d/.test(u);
}

interface EmployeeOpt {
  id: number;
  name: string;
  rides_with_employee_id?: number | null;
}

const emptyForm = {
  unit_number: "",
  plate: "",
  year: "",
  make: "",
  model: "",
  vin: "",
  tank_capacity_gallons: "",
  status: "active",
  assigned_driver: "",
  phone: "",
  insurance_card: "",
  dash_cam_status: "n/a",
  cam_type: "",
  gps_tracker: "",
  registration_expires: "",
  insurance_expires: "",
  gps_status: "n/a",
  modifications: "",
  notes: "",
};

/** N/A is fine. Only missing / not_working need shop work. */
function equipmentNotes(v: Vehicle): string[] {
  const notes: string[] = [];
  if (v.dash_cam_status === "missing") notes.push("Install dash cam");
  else if (v.dash_cam_status === "not_working") notes.push("Repair dash cam");
  if (v.gps_status === "missing") notes.push("Install GPS");
  else if (v.gps_status === "not_working") notes.push("Repair GPS");
  return notes;
}

function equipBadgeClass(status: string | null | undefined): string {
  const s = status || "n/a";
  return s === "working" || s === "n/a" ? "ok" : "danger";
}

function equipLabel(status: string | null | undefined): string {
  const s = status || "n/a";
  if (s === "n/a") return "N/A";
  return s.replace(/_/g, " ");
}

function vehicleTitle(v: Vehicle): string {
  return [v.year, v.make, v.model].filter(Boolean).join(" ") || "—";
}

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`vehicle-field${wide ? " vehicle-field-wide" : ""}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function VehiclesPage() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [employees, setEmployees] = useState<EmployeeOpt[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<Vehicle | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [assignVehicle, setAssignVehicle] = useState<Vehicle | null>(null);
  const [assignEmpId, setAssignEmpId] = useState("");
  const [assignHelperId, setAssignHelperId] = useState("");
  const [assignNote, setAssignNote] = useState("");
  /** Clear tech and label as Warehouse truck on the live map */
  const [assignAsWarehouse, setAssignAsWarehouse] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [fleetInsurance, setFleetInsurance] = useState("");
  const [fleetBusy, setFleetBusy] = useState(false);

  async function load() {
    const data = await api<{ vehicles: Vehicle[]; fleet_insurance_expires?: string | null }>(
      "/vehicles"
    );
    setVehicles(data.vehicles);
    setFleetInsurance(data.fleet_insurance_expires || "");
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!can(user, "manageVehicles")) return;
    api<{ employees: EmployeeOpt[] }>("/employees")
      .then((d) => setEmployees(d.employees || []))
      .catch(() => setEmployees([]));
  }, [user]);

  function openAssign(v: Vehicle) {
    setAssignVehicle(v);
    setAssignEmpId(v.assigned_employee_id ? String(v.assigned_employee_id) : "");
    setAssignHelperId(v.helper_employee_id ? String(v.helper_employee_id) : "");
    setAssignNote("");
    setAssignAsWarehouse(false);
    setError("");
    setOk("");
  }

  async function submitAssign(e: FormEvent) {
    e.preventDefault();
    if (!assignVehicle) return;
    setAssignBusy(true);
    setError("");
    setOk("");
    try {
      const asWarehouse = assignAsWarehouse && !assignEmpId;
      const clear = !assignEmpId;
      await api(`/vehicles/${assignVehicle.id}/assign`, {
        method: "POST",
        body: JSON.stringify({
          clear,
          employee_id: clear ? null : Number(assignEmpId),
          helper_employee_id: assignHelperId ? Number(assignHelperId) : null,
          note: assignNote.trim() || null,
          pool_label: asWarehouse ? "Warehouse truck" : null,
        }),
      });
      setOk(
        asWarehouse
          ? `Unit ${assignVehicle.unit_number} marked Warehouse truck — unassigned, still on the live map`
          : clear
            ? `Cleared assignment on unit ${assignVehicle.unit_number}`
            : `Unit ${assignVehicle.unit_number} reassigned — map will track this unit for that crew`
      );
      setAssignVehicle(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assign failed");
    } finally {
      setAssignBusy(false);
    }
  }

  const helpersForAssign = employees.filter(
    (e) => !assignEmpId || e.id !== Number(assignEmpId)
  );

  function openCreate() {
    setEdit(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(v: Vehicle) {
    setEdit(v);
    const cap =
      v.tank_capacity_gallons != null && Number(v.tank_capacity_gallons) > 0
        ? String(v.tank_capacity_gallons)
        : suggestTankCapacity(v.make, v.model) != null
          ? String(suggestTankCapacity(v.make, v.model))
          : "";
    setForm({
      unit_number: v.unit_number,
      plate: v.plate || "",
      year: v.year != null ? String(v.year) : "",
      make: v.make || "",
      model: v.model || "",
      vin: v.vin || "",
      tank_capacity_gallons: cap,
      status: v.status,
      assigned_driver: v.assigned_driver || "",
      phone: v.phone || "",
      insurance_card: v.insurance_card || "",
      dash_cam_status: v.dash_cam_status,
      cam_type: (() => {
        const c = (v.cam_type || "").toLowerCase();
        if (/verizon/.test(c)) return "Verizon";
        if (c) return "Third-party";
        return "";
      })(),
      gps_tracker: (() => {
        const g = (v.gps_tracker || "").toLowerCase();
        if (/verizon/.test(g)) return "Verizon";
        if (/one\s*step|onestep/.test(g)) return "One Step";
        return v.gps_tracker || "";
      })(),
      registration_expires: v.registration_expires || "",
      insurance_expires: v.insurance_expires || "",
      gps_status: v.gps_status === "unknown" || !v.gps_status ? "n/a" : v.gps_status,
      modifications: v.modifications || "",
      notes: v.notes || "",
    });
    setShowForm(true);
  }

  function setMakeModel(next: { make?: string; model?: string }) {
    setForm((prev) => {
      const make = next.make !== undefined ? next.make : prev.make;
      const model = next.model !== undefined ? next.model : prev.model;
      const suggested = suggestTankCapacity(make, model);
      const keepCap = prev.tank_capacity_gallons.trim() !== "";
      return {
        ...prev,
        make,
        model,
        // Auto-fill only when capacity is blank so we don't overwrite manual edits
        tank_capacity_gallons:
          keepCap || suggested == null ? prev.tank_capacity_gallons : String(suggested),
      };
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const personal = isPersonalVehicleUnit(form.unit_number);
    const tankRaw = form.tank_capacity_gallons.trim();
    const payload: Record<string, unknown> = {
      ...form,
      year: form.year ? Number(form.year) : null,
      gps_status: form.gps_status || "n/a",
      tank_capacity_gallons: tankRaw ? Number(tankRaw) : null,
    };
    if (canCompliance) {
      payload.registration_expires = form.registration_expires || null;
      // Personal: per-unit insurance. Company: use fleet endpoint, not per-van field.
      if (personal) {
        payload.insurance_expires = form.insurance_expires || null;
      } else {
        delete payload.insurance_expires;
      }
    } else {
      delete payload.registration_expires;
      delete payload.insurance_expires;
      delete payload.insurance_card;
    }
    try {
      if (edit) {
        await api(`/vehicles/${edit.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/vehicles", { method: "POST", body: JSON.stringify(payload) });
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  const canEdit = can(user, "manageVehicles");
  const canCompliance = can(user, "manageVehicleCompliance");
  const formIsPersonal = isPersonalVehicleUnit(form.unit_number || edit?.unit_number || "");

  async function saveFleetInsurance(e: FormEvent) {
    e.preventDefault();
    if (!canCompliance) return;
    setFleetBusy(true);
    setError("");
    setOk("");
    try {
      const r = await api<{ fleet_insurance_expires?: string | null; units_updated?: number }>(
        "/vehicles/fleet-insurance",
        {
          method: "PUT",
          body: JSON.stringify({ insurance_expires: fleetInsurance || null }),
        }
      );
      setFleetInsurance(r.fleet_insurance_expires || "");
      setOk(
        `Company fleet insurance saved${
          r.units_updated != null ? ` · ${r.units_updated} company units updated` : ""
        }. Personal (P…) units keep their own dates.`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save fleet insurance");
    } finally {
      setFleetBusy(false);
    }
  }

  return (
    <div className="vehicles-page">
      <div className="page-header">
        <div>
          <h1>Vehicles</h1>
          <p>
            Fleet registry and equipment. Use <strong>Assign</strong> when a tech moves to another
            unit so live map and their app follow the right truck. Registration stickers are
            per-unit (office). Insurance: one company plan for all non-P units; personal units
            (P101…) keep their own policy.
          </p>
        </div>
        {canEdit && (
          <button className="btn no-print" onClick={openCreate}>
            Add vehicle
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {ok && <div className="success">{ok}</div>}

      {canCompliance && (
        <form className="card fleet-insurance-card no-print" onSubmit={saveFleetInsurance}>
          <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>Company fleet insurance</h3>
          <p className="muted" style={{ margin: "0 0 0.55rem", fontSize: "0.85rem" }}>
            One expiration for every company van (not personal P-units). Office or shop.
          </p>
          <div className="form row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 12rem" }}>
              Insurance expires
              <input
                type="date"
                value={fleetInsurance}
                onChange={(e) => setFleetInsurance(e.target.value)}
              />
            </label>
            <button className="btn" type="submit" disabled={fleetBusy}>
              {fleetBusy ? "Saving…" : "Save fleet insurance"}
            </button>
          </div>
        </form>
      )}

      {!canCompliance && fleetInsurance && (
        <div className="card muted" style={{ marginBottom: "0.75rem", fontSize: "0.9rem" }}>
          Company fleet insurance expires: <strong>{fleetInsurance}</strong>
          {" · "}
          Personal units (P…) list their own policy below.
        </div>
      )}

      {/* Desktop / wide: compact table */}
      <div className="card vehicles-wide">
        <div className="table-wrap vehicles-table-wrap">
          <table className="vehicles-table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>Driver</th>
                <th>Vehicle</th>
                <th>Plate / VIN</th>
                <th>Dash cam</th>
                <th>GPS</th>
                <th>Registration</th>
                <th>Insurance</th>
                <th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => {
                const needs = equipmentNotes(v);
                return (
                  <tr key={v.id}>
                    <td>
                      <strong>{v.unit_number}</strong>
                      <div className="muted">{v.status}</div>
                    </td>
                    <td>
                      {v.assigned_driver || "—"}
                      {v.phone && <div className="muted">{v.phone}</div>}
                    </td>
                    <td>
                      {vehicleTitle(v)}
                      {v.modifications && <div className="muted">{v.modifications}</div>}
                    </td>
                    <td>
                      {v.plate || "—"}
                      {v.vin && (
                        <div className="muted vehicles-vin">{v.vin}</div>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${equipBadgeClass(v.dash_cam_status)}`}>
                        {equipLabel(v.dash_cam_status)}
                      </span>
                      {v.cam_type && <div className="muted vehicles-sub">{v.cam_type}</div>}
                    </td>
                    <td>
                      <span className={`badge ${equipBadgeClass(v.gps_status)}`}>
                        {equipLabel(v.gps_status)}
                      </span>
                      {v.gps_tracker && (
                        <div className="muted vehicles-sub">{v.gps_tracker}</div>
                      )}
                      {needs.length > 0 && (
                        <div className="vehicles-needs">{needs.join(" · ")}</div>
                      )}
                    </td>
                    <td>{v.registration_expires || "—"}</td>
                    <td>
                      {v.insurance_expires || "—"}
                      {v.is_personal || isPersonalVehicleUnit(v.unit_number) ? (
                        <div className="muted vehicles-sub">personal policy</div>
                      ) : (
                        <div className="muted vehicles-sub">fleet plan</div>
                      )}
                      {v.insurance_card && (
                        <div className="muted vehicles-sub">card: {v.insurance_card}</div>
                      )}
                    </td>
                    <td className="no-print vehicles-actions">
                      {canEdit && (
                        <>
                          <button className="btn secondary btn-sm" onClick={() => openAssign(v)}>
                            Assign
                          </button>
                          <button className="btn ghost btn-sm" onClick={() => openEdit(v)}>
                            Edit
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Phone: readable cards — no mid-word column crush */}
      <ul className="vehicles-narrow">
        {vehicles.map((v) => {
          const needs = equipmentNotes(v);
          return (
            <li
              key={v.id}
              className={`vehicle-card${v.status !== "active" ? " is-off" : ""}`}
            >
              <div className="vehicle-card-header">
                <div className="vehicle-card-title">
                  <strong className="vehicle-card-unit">Unit {v.unit_number}</strong>
                  <div className="vehicle-card-badges">
                    <span className="badge">{v.status.replace(/_/g, " ")}</span>
                    {needs.length > 0 && <span className="badge danger">needs work</span>}
                  </div>
                </div>
                {canEdit && (
                  <div className="vehicle-card-actions no-print">
                    <button type="button" className="btn secondary btn-sm" onClick={() => openAssign(v)}>
                      Assign
                    </button>
                    <button type="button" className="btn ghost btn-sm" onClick={() => openEdit(v)}>
                      Edit
                    </button>
                  </div>
                )}
              </div>
              <dl className="vehicle-fields">
                <Field label="Driver / crew">
                  {v.assigned_driver || "—"}
                  {v.phone ? (
                    <>
                      <br />
                      <a className="vehicle-phone" href={`tel:${v.phone.replace(/\D/g, "")}`}>
                        {v.phone}
                      </a>
                    </>
                  ) : null}
                </Field>
                <Field label="Vehicle">{vehicleTitle(v)}</Field>
                <Field label="Tank">
                  {v.tank_capacity_gallons != null && Number(v.tank_capacity_gallons) > 0
                    ? `${Number(v.tank_capacity_gallons)} gal`
                    : "—"}
                </Field>
                <Field label="Plate">{v.plate || "—"}</Field>
                <Field label="VIN">{v.vin || "—"}</Field>
                <Field label="Dash cam">
                  <span className={`badge ${equipBadgeClass(v.dash_cam_status)}`}>
                    {equipLabel(v.dash_cam_status)}
                  </span>
                  {v.cam_type ? ` · ${v.cam_type}` : ""}
                </Field>
                <Field label="GPS">
                  <span className={`badge ${equipBadgeClass(v.gps_status)}`}>
                    {equipLabel(v.gps_status)}
                  </span>
                  {v.gps_tracker ? ` · ${v.gps_tracker}` : ""}
                </Field>
                <Field label="Registration">{v.registration_expires || "—"}</Field>
                <Field label="Insurance">
                  {v.insurance_expires || "—"}
                  {v.insurance_card ? (
                    <span className="muted"> · card: {v.insurance_card}</span>
                  ) : null}
                </Field>
                {v.modifications ? (
                  <Field label="Mods" wide>
                    {v.modifications}
                  </Field>
                ) : null}
                {needs.length > 0 ? (
                  <Field label="Shop notes" wide>
                    <span className="vehicles-needs">{needs.join(" · ")}</span>
                  </Field>
                ) : null}
                {v.notes ? (
                  <Field label="Notes" wide>
                    {v.notes}
                  </Field>
                ) : null}
              </dl>
            </li>
          );
        })}
      </ul>
      {!vehicles.length && (
        <div className="card empty">No vehicles yet.</div>
      )}

      {assignVehicle && (
        <div className="modal-backdrop" onClick={() => setAssignVehicle(null)}>
          <div className="modal vehicle-assign-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Assign unit {assignVehicle.unit_number}</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Put a tech (and helper if they ride together) on this truck. They are cleared off any
              other unit so live map search and their fuel/checks follow this GPS unit. Warehouse /
              pool trucks can stay unassigned and still show on the map.
            </p>
            <form className="form" onSubmit={submitAssign}>
              <label>
                Tech / primary driver
                <select
                  value={assignEmpId}
                  onChange={(e) => {
                    setAssignEmpId(e.target.value);
                    if (e.target.value) setAssignAsWarehouse(false);
                  }}
                >
                  <option value="">— Unassigned —</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                      {e.rides_with_employee_id
                        ? ` (rides with #${e.rides_with_employee_id})`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Helper (optional)
                <select
                  value={assignHelperId}
                  onChange={(e) => setAssignHelperId(e.target.value)}
                  disabled={!assignEmpId}
                >
                  <option value="">— None / auto from crew link —</option>
                  {helpersForAssign.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              {!assignEmpId && (
                <label
                  className="checkbox-row"
                  style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}
                >
                  <input
                    type="checkbox"
                    checked={assignAsWarehouse}
                    onChange={(e) => setAssignAsWarehouse(e.target.checked)}
                    style={{ marginTop: "0.2rem" }}
                  />
                  <span>
                    <strong>Warehouse / pool truck</strong>
                    <span className="muted" style={{ display: "block", fontSize: "0.85rem" }}>
                      No tech assigned — live map shows “Warehouse truck” and keeps the GPS pin.
                    </span>
                  </span>
                </label>
              )}
              <label>
                Note (optional)
                <input
                  value={assignNote}
                  onChange={(e) => setAssignNote(e.target.value)}
                  placeholder="e.g. Unit 12 in shop — temp on 08"
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn secondary" onClick={() => setAssignVehicle(null)}>
                  Cancel
                </button>
                <button className="btn" type="submit" disabled={assignBusy}>
                  {assignBusy
                    ? "Saving…"
                    : assignEmpId
                      ? "Assign to this unit"
                      : assignAsWarehouse
                        ? "Mark warehouse truck"
                        : "Clear assignment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{edit ? `Edit unit ${edit.unit_number}` : "Add vehicle"}</h2>
            <form className="form" onSubmit={onSubmit}>
              <div className="form row">
                <label>
                  Unit number
                  <input
                    value={form.unit_number}
                    onChange={(e) => setForm({ ...form, unit_number: e.target.value })}
                    required
                  />
                </label>
                <label>
                  Assigned driver
                  <input
                    value={form.assigned_driver}
                    onChange={(e) => setForm({ ...form, assigned_driver: e.target.value })}
                  />
                </label>
                <label>
                  Phone
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </label>
                <label>
                  Plate
                  <input value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} />
                </label>
                <label>
                  VIN
                  <input value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} />
                </label>
                <label>
                  Year
                  <input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} />
                </label>
                <label>
                  Make
                  <input
                    value={form.make}
                    onChange={(e) => setMakeModel({ make: e.target.value })}
                  />
                </label>
                <label>
                  Model
                  <input
                    value={form.model}
                    onChange={(e) => setMakeModel({ model: e.target.value })}
                  />
                </label>
                <label>
                  Tank capacity (gal)
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={form.tank_capacity_gallons}
                    onChange={(e) =>
                      setForm({ ...form, tank_capacity_gallons: e.target.value })
                    }
                    placeholder="e.g. 31"
                  />
                  <span className="muted" style={{ fontSize: "0.78rem" }}>
                    Used to flag fills bigger than the tank. Suggested from make/model when blank
                    {suggestTankCapacity(form.make, form.model) != null
                      ? ` (suggest ${suggestTankCapacity(form.make, form.model)} gal)`
                      : ""}
                    .
                  </span>
                </label>
                <label>
                  Status
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option value="active">active</option>
                    <option value="out_of_service">out_of_service</option>
                    <option value="retired">retired</option>
                  </select>
                </label>
                {canCompliance && (
                  <label>
                    Insurance card on vehicle?
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
                )}
                {canCompliance && formIsPersonal && (
                  <label>
                    Insurance expires (personal policy)
                    <input
                      type="date"
                      value={form.insurance_expires}
                      onChange={(e) => setForm({ ...form, insurance_expires: e.target.value })}
                    />
                  </label>
                )}
                {canCompliance && !formIsPersonal && (
                  <label>
                    Insurance expires (company fleet)
                    <input type="date" value={fleetInsurance || form.insurance_expires} disabled />
                    <span className="muted" style={{ fontSize: "0.78rem" }}>
                      Set once under Company fleet insurance above — not per van.
                    </span>
                  </label>
                )}
                <label>
                  Dash cam status
                  <select
                    value={form.dash_cam_status === "unknown" ? "n/a" : form.dash_cam_status}
                    onChange={(e) => setForm({ ...form, dash_cam_status: e.target.value })}
                  >
                    <option value="working">Working</option>
                    <option value="not_working">Not working</option>
                    <option value="missing">Missing</option>
                    <option value="n/a">N/A</option>
                  </select>
                </label>
                <label>
                  Cam type
                  <select
                    value={form.cam_type}
                    onChange={(e) => setForm({ ...form, cam_type: e.target.value })}
                  >
                    <option value="">—</option>
                    <option value="Verizon">Verizon (monthly)</option>
                    <option value="Third-party">Third-party (installed, no fee)</option>
                  </select>
                </label>
                <label>
                  GPS status
                  <select
                    value={form.gps_status === "unknown" ? "n/a" : form.gps_status}
                    onChange={(e) => setForm({ ...form, gps_status: e.target.value })}
                  >
                    <option value="working">Working</option>
                    <option value="not_working">Not working</option>
                    <option value="missing">Missing</option>
                    <option value="n/a">N/A (no paid tracker)</option>
                  </select>
                </label>
                <label>
                  GPS system
                  <select
                    value={form.gps_tracker}
                    onChange={(e) => {
                      const gps_tracker = e.target.value;
                      // Suggest cam pairing when system changes
                      let cam_type = form.cam_type;
                      if (gps_tracker === "Verizon" && !cam_type) cam_type = "Verizon";
                      if (gps_tracker === "One Step" && (!cam_type || cam_type === "Verizon")) {
                        cam_type = "Third-party";
                      }
                      setForm({ ...form, gps_tracker, cam_type });
                    }}
                  >
                    <option value="">— none / cancelled —</option>
                    <option value="One Step">One Step</option>
                    <option value="Verizon">Verizon</option>
                  </select>
                </label>
                {(form.gps_tracker === "Verizon" || form.gps_tracker === "One Step") && (
                  <p className="muted" style={{ gridColumn: "1 / -1", margin: 0, fontSize: "0.85rem" }}>
                    {form.gps_tracker === "Verizon"
                      ? "Policy: Verizon GPS units should use a Verizon dash cam and show on the live map."
                      : "Policy: OneStep GPS units should use the third-party installed cam (no monthly fee) and show on the live map."}
                  </p>
                )}
                {canCompliance ? (
                  <label>
                    Registration sticker expires
                    <input
                      type="date"
                      value={form.registration_expires}
                      onChange={(e) => setForm({ ...form, registration_expires: e.target.value })}
                    />
                  </label>
                ) : (
                  <label>
                    Registration sticker expires
                    <input type="date" value={form.registration_expires} disabled />
                    <span className="muted" style={{ fontSize: "0.78rem" }}>
                      Office sets registration dates.
                    </span>
                  </label>
                )}
              </div>
              <label>
                Modifications
                <input
                  value={form.modifications}
                  onChange={(e) => setForm({ ...form, modifications: e.target.value })}
                />
              </label>
              <label>
                Notes
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </label>
              <div className="toolbar">
                <button className="btn" type="submit">
                  Save
                </button>
                <button className="btn secondary" type="button" onClick={() => setShowForm(false)}>
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
