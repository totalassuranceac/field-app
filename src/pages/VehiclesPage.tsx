import { FormEvent, type ReactNode, useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

export interface Vehicle {
  id: number;
  unit_number: string;
  plate: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  status: string;
  current_odometer: number | null;
  assigned_driver: string | null;
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
}

const emptyForm = {
  unit_number: "",
  plate: "",
  year: "",
  make: "",
  model: "",
  vin: "",
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
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [edit, setEdit] = useState<Vehicle | null>(null);
  const [form, setForm] = useState(emptyForm);

  async function load() {
    const data = await api<{ vehicles: Vehicle[] }>("/vehicles");
    setVehicles(data.vehicles);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  function openCreate() {
    setEdit(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(v: Vehicle) {
    setEdit(v);
    setForm({
      unit_number: v.unit_number,
      plate: v.plate || "",
      year: v.year != null ? String(v.year) : "",
      make: v.make || "",
      model: v.model || "",
      vin: v.vin || "",
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      year: form.year ? Number(form.year) : null,
      registration_expires: form.registration_expires || null,
      insurance_expires: form.insurance_expires || null,
      gps_status: form.gps_status || "n/a",
    };
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

  return (
    <div className="vehicles-page">
      <div className="page-header">
        <div>
          <h1>Vehicles</h1>
          <p>Fleet registry, dash cams, and equipment notes</p>
        </div>
        {canEdit && (
          <button className="btn no-print" onClick={openCreate}>
            Add vehicle
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}

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
                      {v.insurance_card && (
                        <div className="muted vehicles-sub">card: {v.insurance_card}</div>
                      )}
                    </td>
                    <td className="no-print">
                      {canEdit && (
                        <button className="btn secondary btn-sm" onClick={() => openEdit(v)}>
                          Edit
                        </button>
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
                  <button
                    type="button"
                    className="btn secondary btn-sm no-print"
                    onClick={() => openEdit(v)}
                  >
                    Edit
                  </button>
                )}
              </div>
              <dl className="vehicle-fields">
                <Field label="Driver">
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
                  <input value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} />
                </label>
                <label>
                  Model
                  <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
                </label>
                <label>
                  Status
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option value="active">active</option>
                    <option value="out_of_service">out_of_service</option>
                    <option value="retired">retired</option>
                  </select>
                </label>
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
                <label>
                  Insurance expires
                  <input
                    type="date"
                    value={form.insurance_expires}
                    onChange={(e) => setForm({ ...form, insurance_expires: e.target.value })}
                    required={false}
                  />
                </label>
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
                <label>
                  Registration sticker expires
                  <input
                    type="date"
                    value={form.registration_expires}
                    onChange={(e) => setForm({ ...form, registration_expires: e.target.value })}
                  />
                </label>
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
