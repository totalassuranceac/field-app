import { FormEvent, useEffect, useState } from "react";
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
  inspection_expires: string | null;
  insurance_expires: string | null;
  emissions_expires: string | null;
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
  dash_cam_status: "unknown",
  cam_type: "",
  gps_tracker: "",
  registration_expires: "",
  inspection_expires: "",
  insurance_expires: "",
  emissions_expires: "",
  modifications: "",
  notes: "",
};

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
      cam_type: v.cam_type || "",
      gps_tracker: v.gps_tracker || "",
      registration_expires: v.registration_expires || "",
      inspection_expires: v.inspection_expires || "",
      insurance_expires: v.insurance_expires || "",
      emissions_expires: v.emissions_expires || "",
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
      inspection_expires: form.inspection_expires || null,
      insurance_expires: form.insurance_expires || null,
      emissions_expires: form.emissions_expires || null,
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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Vehicles</h1>
          <p>Fleet registry, dash cams, and equipment notes</p>
        </div>
        {can(user, "manageVehicles") && (
          <button className="btn no-print" onClick={openCreate}>
            Add vehicle
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Driver</th>
                <th>Vehicle</th>
                <th>Plate / VIN</th>
                <th>Cam / GPS</th>
                <th>Registration</th>
                <th>Insurance</th>
                <th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
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
                    {[v.year, v.make, v.model].filter(Boolean).join(" ") || "—"}
                    {v.modifications && <div className="muted">{v.modifications}</div>}
                  </td>
                  <td>
                    {v.plate || "—"}
                    {v.vin && <div className="muted" style={{ fontSize: "0.78rem" }}>{v.vin}</div>}
                  </td>
                  <td>
                    <span className={`badge ${v.dash_cam_status === "working" ? "ok" : "warning"}`}>
                      {v.cam_type || v.dash_cam_status}
                    </span>
                    {v.gps_tracker && <div className="muted">GPS: {v.gps_tracker}</div>}
                  </td>
                  <td>{v.registration_expires || "—"}</td>
                  <td>
                    {v.insurance_expires || "—"}
                    {v.insurance_card && (
                      <div className="muted" style={{ fontSize: "0.78rem" }}>
                        card: {v.insurance_card}
                      </div>
                    )}
                  </td>
                  <td className="no-print">
                    {can(user, "manageVehicles") && (
                      <button className="btn secondary" onClick={() => openEdit(v)}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

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
                  Cam status
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
                  Cam type
                  <input
                    value={form.cam_type}
                    onChange={(e) => setForm({ ...form, cam_type: e.target.value })}
                    placeholder="Dash Cam / Verizon"
                  />
                </label>
                <label>
                  GPS tracker
                  <input
                    value={form.gps_tracker}
                    onChange={(e) => setForm({ ...form, gps_tracker: e.target.value })}
                    placeholder="One Step / Verizon"
                  />
                </label>
                <label>
                  Registration expires
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
                  Emissions expires
                  <input
                    type="date"
                    value={form.emissions_expires}
                    onChange={(e) => setForm({ ...form, emissions_expires: e.target.value })}
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
