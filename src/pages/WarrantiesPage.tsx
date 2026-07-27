import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, OfflineQueuedError } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";
import { PhotoCapture } from "../components/PhotoCapture";
import {
  loadOcrHints,
  ocrNameplateImage,
  warmOcrEngine,
  type NameplateParseResult,
  type OcrHints,
} from "../nameplateOcr";

type WStatus =
  | "dropped_off"
  | "claim_submitted"
  | "processed"
  | "return_to_vendor"
  | "cancelled";

interface Warranty {
  id: number;
  log_number: string;
  status: WStatus;
  part_name: string;
  part_code: string | null;
  model_number: string | null;
  serial_number: string | null;
  service_address: string | null;
  customer_name: string | null;
  vendor_name: string | null;
  notes: string | null;
  needs_vendor_return: number;
  dropped_off_at: string;
  claim_submitted_at: string | null;
  processed_at: string | null;
  dropped_off_by_name?: string | null;
  processed_by_name?: string | null;
  dropoff_photo_key?: string | null;
  nameplate_photo_key?: string | null;
  days_open: number;
  overdue?: boolean;
  urgent?: boolean;
}

const STATUS_LABEL: Record<WStatus, string> = {
  dropped_off: "Dropped off",
  claim_submitted: "Claim submitted",
  processed: "Processed ✓",
  return_to_vendor: "Return to vendor",
  cancelled: "Cancelled",
};

/** Shrink phone photos for D1 blob storage (~900KB). */
async function compressPhoto(file: File, maxBytes = 850_000): Promise<File> {
  if (file.size <= maxBytes && file.type.startsWith("image/")) return file;
  try {
    const bmp = await createImageBitmap(file);
    const maxW = 1600;
    let w = bmp.width;
    let h = bmp.height;
    if (w > maxW) {
      h = Math.round((h * maxW) / w);
      w = maxW;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    let quality = 0.82;
    let blob: Blob | null = await new Promise((res) =>
      canvas.toBlob(res, "image/jpeg", quality)
    );
    while (blob && blob.size > maxBytes && quality > 0.45) {
      quality -= 0.12;
      blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    }
    if (!blob) return file;
    return new File([blob], "dropoff.jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function WarrantiesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canProcess =
    user?.role === "admin" ||
    user?.role === "warehouse" ||
    user?.role === "office" ||
    user?.role === "mechanic";

  const [list, setList] = useState<Warranty[]>([]);
  const [filter, setFilter] = useState<"open" | "all" | "processed">("open");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  const [partName, setPartName] = useState("");
  const [partCode, setPartCode] = useState("");
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const [address, setAddress] = useState("");
  const [customer, setCustomer] = useState("");
  const [vendor, setVendor] = useState("");
  const [notes, setNotes] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [nameplateFile, setNameplateFile] = useState<File | null>(null);
  const [nameplatePreview, setNameplatePreview] = useState<string | null>(null);
  const [nameplateScanning, setNameplateScanning] = useState(false);
  const [nameplateNote, setNameplateNote] = useState("");
  const [lastNameplateOcr, setLastNameplateOcr] = useState<NameplateParseResult | null>(null);
  const [ocrHints, setOcrHints] = useState<OcrHints | null>(null);
  /** After drop-off: show log # to write on the box */
  const [writeOnBox, setWriteOnBox] = useState<string | null>(null);

  async function load() {
    const status =
      filter === "open" ? "open" : filter === "processed" ? "processed" : "";
    const d = await api<{ warranties: Warranty[] }>(
      `/warranties${status ? `?status=${status}` : ""}`
    );
    setList(d.warranties || []);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [filter]);

  useEffect(() => {
    void warmOcrEngine();
    loadOcrHints((path) => api(path)).then(setOcrHints).catch(() => null);
  }, []);

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  useEffect(() => {
    return () => {
      if (nameplatePreview) URL.revokeObjectURL(nameplatePreview);
    };
  }, [nameplatePreview]);

  function onPhotoPick(file: File | null) {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file);
    setPhotoPreview(file ? URL.createObjectURL(file) : null);
  }

  function onNameplatePick(file: File | null) {
    if (nameplatePreview) URL.revokeObjectURL(nameplatePreview);
    setNameplateFile(file);
    setNameplatePreview(file ? URL.createObjectURL(file) : null);
    setNameplateNote("");
    setLastNameplateOcr(null);
    if (file) void runNameplateOcr(file);
  }

  async function runNameplateOcr(file: File) {
    setNameplateScanning(true);
    setNameplateNote("Reading nameplate…");
    try {
      const hints =
        ocrHints ||
        (await loadOcrHints((path) => api(path)).catch(() => null));
      if (hints) setOcrHints(hints);
      const parsed = await ocrNameplateImage(file, hints);
      setLastNameplateOcr(parsed);
      // Fill empty fields only so manual entry wins if already typed
      if (parsed.model_number && !model.trim()) setModel(parsed.model_number);
      if (parsed.serial_number && !serial.trim()) setSerial(parsed.serial_number);
      const parts = [
        parsed.model_number && `model ${parsed.model_number}`,
        parsed.serial_number && `S/N ${parsed.serial_number}`,
      ].filter(Boolean);
      if (parts.length) {
        setNameplateNote(
          `Read from nameplate (${parsed.confidence}): ${parts.join(" · ")}. Check & fix if needed — the app learns from corrections.`
        );
      } else {
        setNameplateNote(
          "Couldn’t read model/serial clearly — enter them from the nameplate, then save. Photo still helps warehouse."
        );
      }
    } catch {
      setNameplateNote("Nameplate scan unavailable — type model and serial, then save.");
    } finally {
      setNameplateScanning(false);
    }
  }

  function resetForm() {
    setPartName("");
    setPartCode("");
    setModel("");
    setSerial("");
    setAddress("");
    setCustomer("");
    setVendor("");
    setNotes("");
    onPhotoPick(null);
    onNameplatePick(null);
    setLastNameplateOcr(null);
    setNameplateNote("");
  }

  async function submitDropoff(e: FormEvent) {
    e.preventDefault();
    if (!model.trim()) {
      setError("Unit model number is required (equipment the part was removed from).");
      return;
    }
    if (!serial.trim()) {
      setError("Unit serial number is required (equipment the part was removed from).");
      return;
    }
    if (!photoFile) {
      setError(
        "Photo required: take a picture of where you left the part (shelf, bin, counter) so warehouse can find it."
      );
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      // Single multipart request = photos + form stay together if queued offline
      const compressed = await compressPhoto(photoFile);
      const fd = new FormData();
      fd.append("part_name", partName);
      if (partCode) fd.append("part_code", partCode);
      fd.append("model_number", model.trim());
      fd.append("serial_number", serial.trim());
      if (address) fd.append("service_address", address);
      if (customer) fd.append("customer_name", customer);
      if (vendor) fd.append("vendor_name", vendor);
      if (notes) fd.append("notes", notes);
      fd.append("photo", compressed, compressed.name || "dropoff.jpg");
      if (nameplateFile) {
        const np = await compressPhoto(nameplateFile);
        fd.append("nameplate", np, np.name || "nameplate.jpg");
      }
      if (lastNameplateOcr) {
        fd.append(
          "ocr_feedback",
          JSON.stringify({
            raw_text: lastNameplateOcr.raw_text,
            ocr: {
              model_number: lastNameplateOcr.model_number,
              serial_number: lastNameplateOcr.serial_number,
              store_number: "nameplate",
            },
            final: {
              model_number: model.trim(),
              serial_number: serial.trim(),
              store_number: "nameplate",
            },
          })
        );
      }

      const r = await api<{
        warranty: { log_number: string };
        write_on_box?: string;
        instruction?: string;
      }>("/warranties", {
        method: "POST",
        body: fd,
      });
      const logNo = r.write_on_box || r.warranty.log_number;
      setWriteOnBox(logNo);
      setOk(
        `Logged ${logNo}. Write this number on the box now, then leave the part where you photographed.`
      );
      resetForm();
      loadOcrHints((path) => api(path)).then(setOcrHints).catch(() => null);
      await load();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        setOk(err.message);
        resetForm();
      } else {
        setError(err instanceof Error ? err.message : "Could not log drop-off");
      }
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: number, status: WStatus) {
    setBusy(true);
    setError("");
    try {
      await api(`/warranties/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setOk(status === "processed" ? "Marked processed." : `Updated → ${STATUS_LABEL[status]}`);
      await load();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        setOk(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Update failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="warranty-page">
      <div className="page-header">
        <div>
          <h1>Warranties</h1>
          <p>
            Drop off warranty parts with a photo of where you left them · you get a log number to{" "}
            <strong>write on the box</strong> · track claims · return to vendor when needed.
          </p>
        </div>
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {ok && !writeOnBox && <div className="success inv-flash">{ok}</div>}

      {/* Full-screen popup: write log # on the box → Got it returns home */}
      {writeOnBox && (
        <div
          className="modal-backdrop warranty-log-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="warranty-log-title"
        >
          <div className="card warranty-log-modal-inner">
            <div className="muted" id="warranty-log-title" style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
              Write this warranty log number on the box
            </div>
            <div className="warranty-log-modal-number">{writeOnBox}</div>
            <p style={{ margin: "0 0 1.25rem", fontSize: "1rem", lineHeight: 1.4 }}>
              Use a marker on the box or tag <strong>before you leave</strong>. Warehouse uses this
              number to match the part to your drop-off photo.
            </p>
            <button
              type="button"
              className="btn"
              style={{ width: "100%", fontSize: "1.05rem", padding: "0.85rem 1rem" }}
              onClick={() => {
                setWriteOnBox(null);
                setOk("");
                navigate("/");
              }}
            >
              Got it — take me home
            </button>
          </div>
        </div>
      )}

      <form className="card warranty-form" onSubmit={submitDropoff}>
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Log warranty part drop-off</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          <strong>Model # and serial # of the unit</strong> the part came off are required. Photo the
          nameplate when you can — the app tries to fill them in. Then{" "}
          <strong>photo the shelf/bin</strong> where you leave the part. You get a{" "}
          <strong>log number to write on the box</strong>.
        </p>
        <div className="warranty-form-grid">
          <label>
            Part name *
            <input
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
              required
              placeholder="e.g. Contactor 40A"
            />
          </label>
          <label>
            Part code
            <input value={partCode} onChange={(e) => setPartCode(e.target.value)} placeholder="SKU" />
          </label>
          <label>
            Unit model # *
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
              placeholder="From unit nameplate"
              autoComplete="off"
            />
          </label>
          <label>
            Unit serial # *
            <input
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              required
              placeholder="From unit nameplate"
              autoComplete="off"
            />
          </label>
          <label className="span-2">
            Service address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Job site address"
            />
          </label>
          <label>
            Customer
            <input value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </label>
          <label>
            Vendor
            <input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="e.g. Johnstone"
            />
          </label>
          <label className="span-2">
            Notes
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. left on blue shelf by door"
            />
          </label>
        </div>

        <div className="warranty-photo-block">
          <PhotoCapture
            label="Unit nameplate photo (optional — speeds up model/serial)"
            hint={
              nameplateScanning
                ? "Reading nameplate…"
                : "Picture the equipment data plate (MODEL / SERIAL). The app fills model & serial when it can."
            }
            previewUrl={nameplatePreview}
            onPick={(f) => onNameplatePick(f)}
            onClear={() => onNameplatePick(null)}
            disabled={busy || nameplateScanning}
          />
          {nameplateNote ? <div className="info-banner">{nameplateNote}</div> : null}
        </div>

        <div className="warranty-photo-block">
          <PhotoCapture
            required
            label="Drop-off location photo *"
            hint="Picture the shelf, bin, or counter where you left the part so warehouse can find it."
            previewUrl={photoPreview}
            onPick={(f) => onPhotoPick(f)}
            onClear={() => onPhotoPick(null)}
            disabled={busy}
          />
        </div>

        <button className="btn" type="submit" disabled={busy || nameplateScanning}>
          {busy ? "Saving…" : nameplateScanning ? "Still reading nameplate…" : "Drop off & notify warehouse"}
        </button>
      </form>

      <div className="warranty-filters no-print">
        {(
          [
            ["open", "Open"],
            ["all", "All"],
            ["processed", "Processed"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`inv-tab${filter === id ? " active" : ""}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <LogList className="warranty-list" empty="No warranties in this filter.">
        {list.map((w) => {
          const tone = w.urgent
            ? "urgent"
            : w.overdue
              ? "overdue"
              : w.status === "processed"
                ? "done"
                : undefined;
          return (
            <LogItem
              key={w.id}
              tone={tone}
              defaultOpen={false}
              summary={
                <>
                  <strong className="warranty-log">{w.log_number}</strong>
                  <span className="log-item-badge">{STATUS_LABEL[w.status] || w.status}</span>
                  <span className="log-item-meta">
                    {w.part_name}
                    {w.days_open != null
                      ? ` · ${w.days_open}d${w.urgent ? "!" : w.overdue ? " aging" : ""}`
                      : ""}
                  </span>
                </>
              }
            >
              <div className="warranty-meta muted">
                {w.part_code ? `${w.part_code} · ` : ""}
                {w.model_number ? `Model ${w.model_number}` : ""}
                {w.serial_number ? ` · S/N ${w.serial_number}` : ""}
              </div>
              {w.service_address ? <div className="warranty-meta">{w.service_address}</div> : null}
              {w.customer_name ? (
                <div className="muted">Customer: {w.customer_name}</div>
              ) : null}
              {w.needs_vendor_return ? (
                <div className="warranty-vendor-flag">↩ Return to vendor</div>
              ) : null}
              {w.notes ? <div className="muted">{w.notes}</div> : null}
              <div className="warranty-photos-row">
                {w.nameplate_photo_key ? (
                  <div className="warranty-dropoff-photo">
                    <a
                      href={`/api/uploads/${encodeURIComponent(w.nameplate_photo_key)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={`/api/uploads/${encodeURIComponent(w.nameplate_photo_key)}`}
                        alt={`Nameplate for ${w.part_name}`}
                      />
                    </a>
                    <span className="muted" style={{ fontSize: "0.75rem" }}>
                      Nameplate · tap to enlarge
                    </span>
                  </div>
                ) : null}
                {w.dropoff_photo_key ? (
                  <div className="warranty-dropoff-photo">
                    <a
                      href={`/api/uploads/${encodeURIComponent(w.dropoff_photo_key)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={`/api/uploads/${encodeURIComponent(w.dropoff_photo_key)}`}
                        alt={`Where ${w.part_name} was left`}
                      />
                    </a>
                    <span className="muted" style={{ fontSize: "0.75rem" }}>
                      Drop-off location · tap to enlarge
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="muted">
                Dropped off {w.dropped_off_at?.replace("T", " ").slice(0, 16)}
                {w.dropped_off_by_name ? ` by ${w.dropped_off_by_name}` : ""}
                {w.processed_at
                  ? ` · processed ${w.processed_at.replace("T", " ").slice(0, 16)}`
                  : ""}
              </div>
              {canProcess && w.status !== "processed" && w.status !== "cancelled" && (
                <div className="log-item-actions warranty-actions">
                  {w.status === "dropped_off" && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => void setStatus(w.id, "claim_submitted")}
                    >
                      Claim submitted
                    </button>
                  )}
                  {(w.status === "dropped_off" || w.status === "claim_submitted") && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => void setStatus(w.id, "return_to_vendor")}
                    >
                      Return to vendor
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void setStatus(w.id, "processed")}
                  >
                    Mark processed
                  </button>
                </div>
              )}
            </LogItem>
          );
        })}
      </LogList>
    </div>
  );
}
