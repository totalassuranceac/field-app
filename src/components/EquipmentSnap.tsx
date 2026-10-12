import { useMemo, useState } from "react";
import { api } from "../api";
import { decodeEquipment } from "../../worker/equipmentDecode";
import { ocrNameplateImage, type NameplateParseResult } from "../nameplateOcr";
import { PhotoCapture } from "./PhotoCapture";

const ROLES = [
  ["outdoor", "Outdoor"],
  ["indoor", "Indoor"],
  ["furnace", "Furnace"],
  ["air_handler", "Air handler"],
  ["package", "Package"],
] as const;

export function EquipmentSnap({ stJobId, onSaved }: { stJobId: string; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<(typeof ROLES)[number][0]>("outdoor");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const [ocr, setOcr] = useState<NameplateParseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const decoded = useMemo(() => decodeEquipment(make || null, model || null, serial || null), [make, model, serial]);

  async function onPhoto(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const parsed = await ocrNameplateImage(file);
      setOcr(parsed);
      if (parsed.manufacturer) setMake(parsed.manufacturer);
      if (parsed.model_number) setModel(parsed.model_number);
      if (parsed.serial_number) setSerial(parsed.serial_number);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the nameplate");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    setOk("");
    try {
      const body: Record<string, unknown> = {
        st_job_id: stJobId,
        unit_role: role,
        manufacturer: make.trim() || null,
        model_number: model.trim() || null,
        serial_number: serial.trim() || null,
        source: ocr ? "ocr" : "typed",
        raw_ocr: ocr?.raw_text ? ocr.raw_text.slice(0, 2000) : null,
      };
      if (ocr) {
        const plateKey = ocr.manufacturer ? `nameplate_${ocr.manufacturer}` : "nameplate";
        body.ocr_feedback = {
          raw_text: ocr.raw_text,
          ocr: { model_number: ocr.model_number, serial_number: ocr.serial_number, store_number: plateKey },
          final: { model_number: model.trim(), serial_number: serial.trim(), store_number: plateKey },
        };
      }
      await api("/tech/equipment", { method: "POST", body: JSON.stringify(body) });
      setOk("Saved for the next tech.");
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn secondary" style={{ marginTop: "0.5rem" }} onClick={() => setOpen(true)}>
        Add equipment
      </button>
    );
  }

  return (
    <div className="card" style={{ marginTop: "0.6rem", padding: "0.7rem" }}>
      <strong>Add equipment</strong>
      <p className="muted">Photo stays on this phone. Only the make, model, and serial are saved.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", margin: "0.4rem 0" }}>
        {ROLES.map(([id, label]) => (
          <button key={id} type="button" className={`btn secondary${role === id ? " primary" : ""}`} onClick={() => setRole(id)}>
            {label}
          </button>
        ))}
      </div>
      <PhotoCapture label="Nameplate photo" tip="Fill the frame with the model and serial. The photo is not uploaded." onPick={(file) => void onPhoto(file)} />
      <label>Make <input value={make} onChange={(e) => setMake(e.target.value)} maxLength={40} /></label>
      <label>Model <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={40} /></label>
      <label>Serial <input value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={40} /></label>
      <p className="muted">
        {decoded.mfg_year ? `Made ${decoded.mfg_year}${decoded.mfg_month ? ` / ${decoded.mfg_month}` : ""}. ` : "Year not read. "}
        {decoded.tonnage ? `${decoded.tonnage} ton. ` : ""}
        {decoded.refrigerant_hint || "Refrigerant not guessed."}
        {ocr ? ` OCR ${ocr.confidence}.` : ""}
      </p>
      {error ? <p className="muted">{error}</p> : null}
      {ok ? <p>{ok}</p> : null}
      <div style={{ display: "flex", gap: "0.4rem" }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? "Saving..." : "Save"}</button>
        <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Close</button>
      </div>
    </div>
  );
}
