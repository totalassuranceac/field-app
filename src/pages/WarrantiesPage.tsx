import { FormEvent, useEffect, useState } from "react";
import { api, OfflineQueuedError } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";
import { PhotoCapture } from "../components/PhotoCapture";

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
  const [needsReturn, setNeedsReturn] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

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
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  function onPhotoPick(file: File | null) {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file);
    setPhotoPreview(file ? URL.createObjectURL(file) : null);
  }

  async function submitDropoff(e: FormEvent) {
    e.preventDefault();
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
      // Single multipart request = photo + form stay together if queued offline
      const compressed = await compressPhoto(photoFile);
      const fd = new FormData();
      fd.append("part_name", partName);
      if (partCode) fd.append("part_code", partCode);
      if (model) fd.append("model_number", model);
      if (serial) fd.append("serial_number", serial);
      if (address) fd.append("service_address", address);
      if (customer) fd.append("customer_name", customer);
      if (vendor) fd.append("vendor_name", vendor);
      if (notes) fd.append("notes", notes);
      if (needsReturn) fd.append("needs_vendor_return", "1");
      fd.append("photo", compressed, compressed.name || "dropoff.jpg");

      const r = await api<{ warranty: { log_number: string } }>("/warranties", {
        method: "POST",
        body: fd,
      });
      setOk(
        `Logged ${r.warranty.log_number} with drop-off photo. Warehouse & admin notified.`
      );
      setPartName("");
      setPartCode("");
      setModel("");
      setSerial("");
      setAddress("");
      setCustomer("");
      setVendor("");
      setNotes("");
      setNeedsReturn(false);
      onPhotoPick(null);
      await load();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        setOk(err.message);
        setPartName("");
        setPartCode("");
        setModel("");
        setSerial("");
        setAddress("");
        setCustomer("");
        setVendor("");
        setNotes("");
        setNeedsReturn(false);
        onPhotoPick(null);
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
            Drop off warranty parts with a photo of where you left them · track claims · return to
            vendor when needed.
          </p>
        </div>
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <form className="card warranty-form" onSubmit={submitDropoff}>
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Log warranty part drop-off</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          Field techs: enter unit model/serial + service address, then{" "}
          <strong>photo the shelf/bin/counter</strong> where you leave the part. Creates a log # and
          notifies warehouse + admin. Works offline — sends when you have signal.
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
            Unit model #
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model" />
          </label>
          <label>
            Unit serial #
            <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="Serial" />
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
            required
            label="Drop-off location photo"
            hint="Tap Take photo — picture the shelf, bin, or counter where you left the part so warehouse can find it and see who delivered it."
            previewUrl={photoPreview}
            onPick={(f) => onPhotoPick(f)}
            onClear={() => onPhotoPick(null)}
            disabled={busy}
          />
        </div>

        <label className="warranty-check">
          <input
            type="checkbox"
            checked={needsReturn}
            onChange={(e) => setNeedsReturn(e.target.checked)}
          />
          Needs to go back to vendor
        </label>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Drop off & notify warehouse"}
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
