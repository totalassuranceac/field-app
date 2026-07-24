import { FormEvent, useEffect, useState } from "react";
import { api, OfflineQueuedError, can } from "../api";
import { useAuth } from "../auth";
import { PhotoCapture } from "../components/PhotoCapture";
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
  const canLog = can(user, "logPartsPurchase");

  const [kind, setKind] = useState<"vendor" | "other">("vendor");
  const [vendorName, setVendorName] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [totalCost, setTotalCost] = useState("");
  const [cardLast4, setCardLast4] = useState("");
  const [notes, setNotes] = useState("");
  const [vendors, setVendors] = useState<string[]>([]);

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
    const d = await api<{ receipts: PartsReceipt[] }>("/parts-purchases?mine=1");
    setList(d.receipts || []);
  }

  useEffect(() => {
    loadList().catch((e) => setError(e.message));
    if (canLog) {
      api<{ vendors: string[] }>("/parts-purchases/vendors")
        .then((d) => setVendors(d.vendors || []))
        .catch(() => {});
      loadOcrHints((path) => api(path)).then(setHints).catch(() => {});
    }
  }, [canLog]);

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
          ocr_feedback,
        }),
      });

      setOk(
        kind === "vendor"
          ? `Saved ${vendorName.trim()} invoice ${invoiceNumber.trim()} with photo. Thanks — no paper turn-in needed.`
          : `Saved ${vendorName.trim()} purchase receipt. Thanks — no paper turn-in needed.`
      );
      resetForm();
      await loadList();
      // Refresh OCR hints after learning
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
            Photo company-card purchases and vendor packing slips here instead of turning paper in.
            The app reads invoice # and vendor when it can — and gets smarter when you correct it.
          </p>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {canLog && (
        <form className="card warranty-form" onSubmit={submit}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Submit a purchase receipt</h2>

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
              ? "Picking up at Johnstone, Ferguson, etc.? Enter vendor + invoice or packing slip #, then photo the slip."
              : "Home Depot, Lowe’s, Ace, etc.? Enter the store name (and total if you want), then photo the receipt."}
          </p>

          <div className="warranty-form-grid">
            <label className="span-2">
              {kind === "vendor" ? "Vendor name *" : "Store / merchant *"}
              <input
                list="parts-vendor-list"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                required
                placeholder={kind === "vendor" ? "e.g. Johnstone" : "e.g. Home Depot"}
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
                placeholder="Job / truck / why purchased"
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
                  : "Take photo of the full invoice or packing slip. Whole page in frame works best."
              }
              previewUrl={preview}
              onPick={(f) => onPhotoPick(f)}
              onClear={() => onPhotoPick(null)}
              disabled={busy || scanning}
            />
          </div>
          {ocrNote && <div className="info-banner">{ocrNote}</div>}

          <button className="btn" type="submit" disabled={busy || scanning || !photoFile}>
            {busy ? "Saving…" : scanning ? "Still reading…" : "Save receipt photo"}
          </button>
        </form>
      )}

      <h2 style={{ fontSize: "1rem", marginTop: "1.25rem" }}>Your recent submissions</h2>
      {list.length === 0 ? (
        <p className="muted">No parts receipts yet.</p>
      ) : (
        <ul className="log-list" style={{ listStyle: "none", padding: 0 }}>
          {list.map((r) => (
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
              </div>
              {r.notes ? <div style={{ fontSize: "0.85rem" }}>{r.notes}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
