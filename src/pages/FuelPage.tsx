import { FormEvent, useEffect, useRef, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { ocrReceiptImage } from "../receiptOcr";

interface Employee {
  id: number;
  name: string;
}
interface Vehicle {
  id: number;
  unit_number: string;
}
interface FuelEntry {
  id: number;
  fuel_date: string;
  unit_number: string;
  employee_name: string;
  odometer: number;
  gallons: number | null;
  total_cost: number | null;
  station_notes: string | null;
  entered_by_name: string;
  receipt_key: string | null;
}
interface AlertDraft {
  alert_type: string;
  message: string;
  severity: string;
}

export function FuelPage() {
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [entries, setEntries] = useState<FuelEntry[]>([]);
  const [totals, setTotals] = useState<{ gallons: number; total_cost: number; count: number } | null>(
    null
  );
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [ocrNote, setOcrNote] = useState("");
  const [alerts, setAlerts] = useState<AlertDraft[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

  const [employeeId, setEmployeeId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [odometer, setOdometer] = useState("");
  const [gallons, setGallons] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [fuelDate, setFuelDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const isDriver = user?.role === "driver";

  async function load() {
    const [emps, vehs, fuel] = await Promise.all([
      api<{ employees: Employee[] }>("/employees"),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
      api<{ entries: FuelEntry[]; totals: { gallons: number; total_cost: number; count: number } }>(
        "/fuel"
      ),
    ]);
    setEmployees(emps.employees);
    setVehicles(vehs.vehicles);
    setEntries(fuel.entries);
    setTotals(fuel.totals);
    if (user?.employee_id) setEmployeeId(String(user.employee_id));
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function handleReceipt(f: File | null) {
    setFile(f);
    setOcrNote("");
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
    if (!f) return;

    setScanning(true);
    try {
      const parsed = await ocrReceiptImage(f);
      if (parsed.gallons != null) setGallons(String(parsed.gallons));
      if (parsed.total_cost != null) setTotalCost(String(parsed.total_cost));
      if (parsed.fuel_date) {
        setFuelDate(parsed.fuel_date);
      }
      if (parsed.station_notes && !notes) setNotes(parsed.station_notes);

      const parts: string[] = [];
      if (parsed.fuel_date) parts.push(`date ${parsed.fuel_date}`);
      if (parsed.gallons != null) parts.push(`${parsed.gallons} gal`);
      if (parsed.total_cost != null) parts.push(`$${Number(parsed.total_cost).toFixed(2)}`);
      if (parts.length) {
        setOcrNote(
          `Receipt scanned (${parsed.confidence} confidence): ${parts.join(" · ")}. Confirm fields, then enter odometer.`
        );
      } else {
        setOcrNote(
          "Could not auto-read date/gallons/total clearly — enter them if needed. Odometer is still required."
        );
      }
    } catch (e) {
      setOcrNote(
        e instanceof Error
          ? `Scan note: ${e.message}. You can still enter gallons/cost manually.`
          : "Scan failed — enter gallons/cost manually."
      );
    } finally {
      setScanning(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!can(user, "logFuel")) return;
    setBusy(true);
    setError("");
    setOk("");
    setAlerts([]);
    try {
      let receipt_key: string | undefined;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("folder", "fuel-receipts");
        const up = await api<{ key: string }>("/uploads/receipt", { method: "POST", body: fd });
        receipt_key = up.key;
      }
      const res = await api<{ entry: FuelEntry; alerts: AlertDraft[] }>("/fuel", {
        method: "POST",
        body: JSON.stringify({
          employee_id: Number(employeeId),
          vehicle_id: Number(vehicleId),
          odometer: Number(odometer),
          gallons: gallons === "" ? undefined : Number(gallons),
          total_cost: totalCost === "" ? undefined : Number(totalCost),
          fuel_date: fuelDate,
          station_notes: notes || undefined,
          receipt_key,
        }),
      });
      setAlerts(res.alerts || []);
      setOk("Fuel entry saved. Receipt stored when upload is enabled.");
      setOdometer("");
      setGallons("");
      setTotalCost("");
      setNotes("");
      setFile(null);
      setOcrNote("");
      if (preview) URL.revokeObjectURL(preview);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Fuel log</h1>
          <p>Scan the receipt — we fill gallons &amp; total. You enter current mileage.</p>
        </div>
        {totals && (
          <div className="muted">
            {totals.count} entries · {Number(totals.gallons).toFixed(1)} gal · $
            {Number(totals.total_cost).toFixed(2)}
          </div>
        )}
      </div>

      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}
      {ok && (
        <div className="success" style={{ marginBottom: "1rem" }}>
          {ok}
        </div>
      )}
      {!!alerts.length && (
        <div className="card" style={{ marginBottom: "1rem", borderColor: "var(--warning)" }}>
          <h3>Mileage checks</h3>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {alerts.map((a, i) => (
              <li key={i}>
                <span className={`badge ${a.severity}`}>{a.severity}</span> {a.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {can(user, "logFuel") && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2>New fuel stop</h2>
          <div className="info-banner" style={{ marginBottom: "1rem" }}>
            <strong>Technician flow:</strong> 1) Photo of receipt 2) Confirm auto-filled gallons/$ 3)
            Type <strong>odometer only</strong> 4) Save
          </div>
          <form className="form" onSubmit={onSubmit}>
            <div
              className="receipt-drop"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
              role="button"
              tabIndex={0}
            >
              <strong>{scanning ? "Reading receipt…" : "Tap to scan / take receipt photo"}</strong>
              <span className="muted">Camera or gallery · PNG/JPG · auto-fills gallons &amp; total</span>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => handleReceipt(e.target.files?.[0] || null)}
              />
              {preview && <img className="receipt-preview" src={preview} alt="Receipt preview" />}
            </div>
            {ocrNote && <div className="info-banner">{ocrNote}</div>}

            <label>
              Current odometer (required)
              <input
                className="input-hero"
                type="number"
                step="0.1"
                value={odometer}
                onChange={(e) => setOdometer(e.target.value)}
                required
                inputMode="decimal"
                placeholder="e.g. 45210"
                autoFocus
              />
            </label>

            <div className="form row">
              <label>
                Vehicle unit
                <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} required>
                  <option value="">Select…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.unit_number}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Employee
                <select
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  required
                  disabled={isDriver && !!user?.employee_id}
                >
                  <option value="">Select…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Fuel date (from receipt)
                <input type="date" value={fuelDate} onChange={(e) => setFuelDate(e.target.value)} required />
              </label>
              <label>
                Gallons {scanning ? "(scanning…)" : "(from receipt)"}
                <input
                  type="number"
                  step="0.001"
                  value={gallons}
                  onChange={(e) => setGallons(e.target.value)}
                  inputMode="decimal"
                />
              </label>
              <label>
                Total cost ($)
                <input
                  type="number"
                  step="0.01"
                  value={totalCost}
                  onChange={(e) => setTotalCost(e.target.value)}
                  inputMode="decimal"
                />
              </label>
            </div>
            <label>
              Station / notes
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </label>
            <button className="btn" disabled={busy || scanning} type="submit">
              {busy ? "Saving…" : "Save fuel entry"}
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>Recent entries</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Unit</th>
                <th>Employee</th>
                <th>Miles</th>
                <th>Gal</th>
                <th>$</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.fuel_date}</td>
                  <td>{e.unit_number}</td>
                  <td>{e.employee_name}</td>
                  <td>{e.odometer.toLocaleString()}</td>
                  <td>{e.gallons ?? "—"}</td>
                  <td>{e.total_cost != null ? `$${Number(e.total_cost).toFixed(2)}` : "—"}</td>
                  <td>
                    {e.receipt_key ? (
                      <a href={`/api/uploads/${e.receipt_key}`} target="_blank" rel="noreferrer">
                        View
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!entries.length && <div className="empty">No entries yet.</div>}
        </div>
      </div>
    </div>
  );
}
