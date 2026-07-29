import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, OfflineQueuedError, can } from "../api";
import { useAuth } from "../auth";
import { PhotoCapture } from "../components/PhotoCapture";
import { VehicleQuickPick, type VehicleMatch } from "../components/VehicleQuickPick";
import {
  ocrPartsReceiptImage,
  loadOcrHints,
  type PartsReceiptParseResult,
  type OcrHints,
} from "../partsReceiptOcr";

interface PartsReceipt {
  id: number;
  purchase_kind: "vendor" | "other";
  vendor_name: string;
  invoice_number: string | null;
  purchase_date: string | null;
  total_cost: number | null;
  card_last4: string | null;
  notes: string | null;
  receipt_key: string;
  vehicle_id?: number | null;
  issue_id?: number | null;
  parts_order_id?: number | null;
  vehicle_unit?: string | null;
  vehicle_plate?: string | null;
  vehicle_year?: number | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  purchased_by_name?: string | null;
  created_at: string;
}

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
    let blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    while (blob && blob.size > maxBytes && quality > 0.45) {
      quality -= 0.12;
      blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    }
    if (!blob) return file;
    return new File([blob], "parts-receipt.jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function PartsPurchasesPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const canLog = can(user, "logPartsPurchase");
  const isMechanic = user?.role === "mechanic" || user?.role === "driver";
  const canViewAll =
    user?.role === "admin" ||
    user?.role === "office" ||
    user?.role === "warehouse" ||
    user?.role === "viewer";

  const [kind, setKind] = useState<"vendor" | "other">("vendor");
  const [vendorName, setVendorName] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [totalCost, setTotalCost] = useState("");
  const [cardLast4, setCardLast4] = useState("");
  const [notes, setNotes] = useState("");
  const [vendors, setVendors] = useState<string[]>([]);
  const [vehicles, setVehicles] = useState<VehicleMatch[]>([]);
  const [vehicleId, setVehicleId] = useState(() => searchParams.get("vehicle") || "");
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleMatch | null>(null);
  const [issueId] = useState(() => searchParams.get("issue") || "");
  const [partsOrderId] = useState(() => searchParams.get("order") || "");
  const [listFilter, setListFilter] = useState<"mine" | "all" | "vehicle">("mine");

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [ocrNote, setOcrNote] = useState("");
  const [lastOcr, setLastOcr] = useState<PartsReceiptParseResult | null>(null);
  const [hints, setHints] = useState<OcrHints | null>(null);

  const [list, setList] = useState<PartsReceipt[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadList() {
    const q = new URLSearchParams();
    if (listFilter === "mine" || !canViewAll) q.set("mine", "1");
    if (listFilter === "vehicle" && vehicleId) q.set("vehicle_id", vehicleId);
    // Office viewing one unit's full parts history
    if (listFilter === "all" && vehicleId) q.set("vehicle_id", vehicleId);
    const d = await api<{ receipts: PartsReceipt[] }>(
      `/parts-purchases?${q.toString()}`
    );
    setList(d.receipts || []);
  }

  useEffect(() => {
    loadList().catch((e) => setError(e.message));
  }, [listFilter, vehicleId, canViewAll]);

  useEffect(() => {
    if (canLog) {
      api<{ vendors: string[] }>("/parts-purchases/vendors")
        .then((d) => setVendors(d.vendors || []))
        .catch(() => {});
      loadOcrHints((path) => api(path)).then(setHints).catch(() => {});
      api<{ vehicles: VehicleMatch[] }>("/vehicles?filter=active")
        .then((r) => setVehicles(r.vehicles || []))
        .catch(() => {});
    }
  }, [canLog]);

  // Prefill vehicle from deep link once list loads
  useEffect(() => {
    if (!vehicleId || selectedVehicle) return;
    const hit = vehicles.find((v) => String(v.id) === vehicleId);
    if (hit) setSelectedVehicle(hit);
  }, [vehicleId, vehicles, selectedVehicle]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function onPhotoPick(file: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    setPhotoFile(file);
    setPreview(file ? URL.createObjectURL(file) : null);
    setOcrNote("");
    setLastOcr(null);
    if (file) void runOcr(file);
  }

  async function runOcr(file: File) {
    setScanning(true);
    setOcrNote("Reading receipt…");
    try {
      const parsed = await ocrPartsReceiptImage(file, hints);
      setLastOcr(parsed);
      // Only fill empty fields so manual entry first is preserved
      if (parsed.vendor_name && !vendorName.trim()) setVendorName(parsed.vendor_name);
      if (parsed.invoice_number && !invoiceNumber.trim()) setInvoiceNumber(parsed.invoice_number);
      if (parsed.purchase_date) setPurchaseDate(parsed.purchase_date);
      if (parsed.total_cost != null && !totalCost.trim()) setTotalCost(String(parsed.total_cost));
      if (parsed.card_last4 && !cardLast4.trim()) setCardLast4(parsed.card_last4);

      const filled = [
        parsed.vendor_name && "vendor",
        parsed.invoice_number && "invoice #",
        parsed.total_cost != null && "total",
        parsed.card_last4 && "card",
      ].filter(Boolean);
      if (filled.length) {
        setOcrNote(
          `Read from photo (${parsed.confidence}): ${filled.join(", ")}. Check & fix if needed — the app learns from your fixes.`
        );
      } else {
        setOcrNote(
          kind === "vendor"
            ? "Couldn’t read invoice clearly — enter vendor + invoice/packing slip #, then save."
            : "Couldn’t auto-read this slip — enter store name (and total if you know it), then save."
        );
      }
    } catch {
      setOcrNote("OCR unavailable — enter the fields manually and save with the photo.");
    } finally {
      setScanning(false);
    }
  }

  function resetForm() {
    setVendorName("");
    setInvoiceNumber("");
    setPurchaseDate(new Date().toISOString().slice(0, 10));
    setTotalCost("");
    setCardLast4("");
    setNotes("");
    onPhotoPick(null);
    setOcrNote("");
    setLastOcr(null);
    // Keep vehicle if deep-linked from shop / order parts
    if (!searchParams.get("vehicle")) {
      setVehicleId("");
      setSelectedVehicle(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!photoFile) {
      setError("Photo of the receipt / packing slip is required.");
      return;
    }
    if (!vendorName.trim()) {
      setError(kind === "vendor" ? "Vendor name is required." : "Store / merchant name is required.");
      return;
    }
    if (kind === "vendor" && !invoiceNumber.trim()) {
      setError("Invoice or packing slip number is required for vendor pickups.");
      return;
    }
    if (isMechanic && !vehicleId) {
      setError("Select the vehicle this parts purchase was for.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const compressed = await compressPhoto(photoFile);
      const fd = new FormData();
      fd.append("file", compressed);
      fd.append("folder", "parts-receipts");
      const up = await api<{ key: string }>("/uploads/receipt", { method: "POST", body: fd });

      const ocr_feedback = lastOcr
        ? {
            raw_text: lastOcr.raw_text,
            ocr: {
              vendor_name: lastOcr.vendor_name,
              invoice_number: lastOcr.invoice_number,
              purchase_date: lastOcr.purchase_date,
              total_cost: lastOcr.total_cost,
              card_last4: lastOcr.card_last4,
              store_number: lastOcr.vendor_name,
              fuel_date: lastOcr.purchase_date,
            },
            final: {
              vendor_name: vendorName.trim(),
              invoice_number: invoiceNumber.trim() || null,
              purchase_date: purchaseDate || null,
              total_cost: totalCost.trim() ? Number(totalCost) : null,
              card_last4: cardLast4.replace(/\D/g, "").slice(-4) || null,
              store_number: vendorName.trim(),
              fuel_date: purchaseDate || null,
            },
          }
        : undefined;

      await api("/parts-purchases", {
        method: "POST",
        body: JSON.stringify({
          purchase_kind: kind,
          vendor_name: vendorName.trim(),
          invoice_number: invoiceNumber.trim() || null,
          purchase_date: purchaseDate || null,
          total_cost: totalCost.trim() ? Number(totalCost) : null,
          card_last4: cardLast4.replace(/\D/g, "").slice(-4) || null,
          notes: notes.trim() || null,
          receipt_key: up.key,
          vehicle_id: vehicleId ? Number(vehicleId) : null,
          issue_id: issueId ? Number(issueId) : null,
          parts_order_id: partsOrderId ? Number(partsOrderId) : null,
          ocr_feedback,
        }),
      });

      const unitBit = selectedVehicle
        ? ` for unit ${selectedVehicle.unit_number}`
        : vehicleId
          ? " (vehicle linked)"
          : "";
      setOk(
        kind === "vendor"
          ? `Saved ${vendorName.trim()} invoice ${invoiceNumber.trim()}${unitBit}.`
          : `Saved ${vendorName.trim()} receipt${unitBit}.`
      );
      resetForm();
      await loadList();
      loadOcrHints((path) => api(path)).then(setHints).catch(() => {});
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        setOk(err.message);
        resetForm();
      } else {
        setError(err instanceof Error ? err.message : "Could not save receipt");
      }
    } finally {
      setBusy(false);
    }
  }

  const byVehicle = useMemo(() => {
    const map = new Map<string, { label: string; receipts: PartsReceipt[]; total: number }>();
    for (const r of list) {
      const key = r.vehicle_id ? String(r.vehicle_id) : "none";
      const label = r.vehicle_unit
        ? `Unit ${r.vehicle_unit}${r.vehicle_plate ? ` · ${r.vehicle_plate}` : ""}`
        : "No vehicle linked";
      let g = map.get(key);
      if (!g) {
        g = { label, receipts: [], total: 0 };
        map.set(key, g);
      }
      g.receipts.push(r);
      if (r.total_cost != null) g.total += Number(r.total_cost);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [list]);

  if (!canLog && !can(user, "viewPartsPurchase")) {
    return (
      <div className="page-header">
        <h1>Parts receipts</h1>
        <p className="muted">You don’t have access to parts purchase receipts.</p>
      </div>
    );
  }

  return (
    <div className="parts-purchases-page">
      <div className="page-header">
        <div>
          <h1>Parts receipts</h1>
          <p>
            Photo the receipt after you buy parts. Link it to the vehicle so all parts for that unit
            stay together.
          </p>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {canLog && (
        <form className="card warranty-form" onSubmit={submit}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Submit a purchase receipt</h2>

          <div className="span-2" style={{ marginBottom: "0.75rem" }}>
            <VehicleQuickPick
              value={vehicleId}
              vehicles={vehicles}
              onChange={(id, v) => {
                setVehicleId(id);
                setSelectedVehicle(v);
              }}
              required={isMechanic}
              disabled={busy}
              label="Vehicle this purchase was for *"
              placeholder="Type plate or unit worked on…"
            />
            {selectedVehicle && (
              <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                Parts history will show under unit {selectedVehicle.unit_number}
                {selectedVehicle.plate ? ` · ${selectedVehicle.plate}` : ""}
              </p>
            )}
          </div>

          <div className="warranty-filters" style={{ marginBottom: "0.75rem" }}>
            <button
              type="button"
              className={kind === "vendor" ? "btn" : "btn secondary"}
              onClick={() => setKind("vendor")}
              disabled={busy}
            >
              Vendor pickup
            </button>
            <button
              type="button"
              className={kind === "other" ? "btn" : "btn secondary"}
              onClick={() => setKind("other")}
              disabled={busy}
            >
              Other store
            </button>
          </div>

          <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            {kind === "vendor"
              ? "Johnstone, AutoZone, First Call, etc. — vendor + invoice #, then photo the slip."
              : "Home Depot, Lowe’s, Ace — store name, then photo the receipt."}
          </p>

          <div className="warranty-form-grid">
            <label className="span-2">
              {kind === "vendor" ? "Vendor name *" : "Store / merchant *"}
              <input
                list="parts-vendor-list"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                required
                placeholder={kind === "vendor" ? "e.g. AutoZone / Johnstone" : "e.g. Home Depot"}
                disabled={busy}
              />
              <datalist id="parts-vendor-list">
                {vendors.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>

            <label className={kind === "vendor" ? "span-2" : undefined}>
              {kind === "vendor" ? "Invoice / packing slip # *" : "Invoice / receipt #"}
              <input
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                required={kind === "vendor"}
                placeholder="From packing slip or invoice"
                disabled={busy}
              />
            </label>

            <label>
              Date
              <input
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                disabled={busy}
              />
            </label>

            <label>
              Total $
              <input
                inputMode="decimal"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
                placeholder="Optional"
                disabled={busy}
              />
            </label>

            <label>
              Card last 4
              <input
                inputMode="numeric"
                maxLength={4}
                value={cardLast4}
                onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="Optional"
                disabled={busy}
              />
            </label>

            <label className="span-2">
              Notes
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What was purchased / job notes"
                disabled={busy}
              />
            </label>
          </div>

          <div className="warranty-photo-block">
            <PhotoCapture
              required
              label="Receipt / packing slip photo"
              hint={
                scanning
                  ? "Reading receipt…"
                  : "Take photo of the full invoice or packing slip."
              }
              previewUrl={preview}
              onPick={(f) => onPhotoPick(f)}
              onClear={() => onPhotoPick(null)}
              disabled={busy || scanning}
            />
          </div>
          {ocrNote && <div className="info-banner">{ocrNote}</div>}

          <button className="btn" type="submit" disabled={busy || scanning || !photoFile}>
            {busy ? "Saving…" : scanning ? "Still reading…" : "Save receipt"}
          </button>
        </form>
      )}

      <div className="filters no-print" style={{ margin: "1rem 0 0.5rem" }}>
        <button
          type="button"
          className={`chip ${listFilter === "mine" ? "active" : ""}`}
          onClick={() => setListFilter("mine")}
        >
          Mine
        </button>
        {canViewAll && (
          <button
            type="button"
            className={`chip ${listFilter === "all" ? "active" : ""}`}
            onClick={() => setListFilter("all")}
          >
            All
          </button>
        )}
        {vehicleId && (
          <button
            type="button"
            className={`chip ${listFilter === "vehicle" ? "active" : ""}`}
            onClick={() => setListFilter("vehicle")}
          >
            This unit
          </button>
        )}
      </div>

      <h2 style={{ fontSize: "1rem", marginTop: "0.5rem" }}>
        {listFilter === "vehicle" && selectedVehicle
          ? `Parts for unit ${selectedVehicle.unit_number}`
          : "Receipts by vehicle"}
      </h2>
      {list.length === 0 ? (
        <p className="muted">No parts receipts yet.</p>
      ) : (
        byVehicle.map((g) => (
          <section key={g.label} style={{ marginBottom: "1rem" }}>
            <h3
              style={{
                fontSize: "0.95rem",
                margin: "0 0 0.4rem",
                display: "flex",
                justifyContent: "space-between",
                gap: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <span>{g.label}</span>
              {g.total > 0 && (
                <span className="muted" style={{ fontWeight: 600 }}>
                  ${g.total.toFixed(2)} total
                </span>
              )}
            </h3>
            <ul className="log-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {g.receipts.map((r) => (
                <li key={r.id} className="card log-item" style={{ marginBottom: "0.5rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                    <strong>{r.vendor_name}</strong>
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      {r.purchase_kind === "vendor" ? "Vendor" : "Other"}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {r.invoice_number ? `Inv ${r.invoice_number}` : "No invoice #"}
                    {r.total_cost != null ? ` · $${Number(r.total_cost).toFixed(2)}` : ""}
                    {r.card_last4 ? ` · ••${r.card_last4}` : ""}
                    {r.purchase_date ? ` · ${r.purchase_date}` : ""}
                    {r.purchased_by_name ? ` · ${r.purchased_by_name}` : ""}
                  </div>
                  {r.notes ? <div style={{ fontSize: "0.85rem" }}>{r.notes}</div> : null}
                  {r.receipt_key ? (
                    <a
                      href={`/api/uploads/${encodeURIComponent(r.receipt_key)}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: "0.85rem" }}
                    >
                      View photo
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {isMechanic && (
        <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          Tip: on a shop job set status to <strong>Completed</strong> and upload receipts there
          before you finish the job. This page is for browsing history by vehicle.
        </p>
      )}
    </div>
  );
}
