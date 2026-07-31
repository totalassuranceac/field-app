import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, OfflineQueuedError } from "../api";
import { PhotoCapture } from "./PhotoCapture";
import {
  ocrPartsReceiptImage,
  loadOcrHints,
  type PartsReceiptParseResult,
  type OcrHints,
} from "../partsReceiptOcr";

export type LinkedPartsReceipt = {
  id: number;
  vendor_name: string;
  invoice_number: string | null;
  total_cost: number | null;
  purchase_date: string | null;
  receipt_key: string;
  created_at: string;
};

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

type Props = {
  vehicleId: number;
  unitNumber?: string;
  issueId?: number | null;
  /** Called after a receipt is saved */
  onSaved?: () => void;
  /** Report how many receipts are on file (for soft complete prompts) */
  onCountChange?: (count: number) => void;
};

/**
 * Compact upload panel for shop job completion — receipt is tied to vehicle + issue.
 */
export function PartsReceiptUploadPanel({
  vehicleId,
  unitNumber,
  issueId,
  onSaved,
  onCountChange,
}: Props) {
  const [receipts, setReceipts] = useState<LinkedPartsReceipt[]>([]);
  const [vendorName, setVendorName] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [kind, setKind] = useState<"vendor" | "other">("vendor");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [ocrNote, setOcrNote] = useState("");
  const [lastOcr, setLastOcr] = useState<PartsReceiptParseResult | null>(null);
  const [hints, setHints] = useState<OcrHints | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [showForm, setShowForm] = useState(false);

  const loadReceipts = useCallback(async () => {
    try {
      const d = await api<{ receipts: (LinkedPartsReceipt & { issue_id?: number })[] }>(
        `/parts-purchases?vehicle_id=${vehicleId}`
      );
      let list = d.receipts || [];
      if (issueId) {
        const forIssue = list.filter((r) => r.issue_id === issueId);
        // Prefer issue-linked; fall back to unit history so mechanic sees context
        list = forIssue.length ? forIssue : list;
      }
      const sliced = list.slice(0, 20);
      setReceipts(sliced);
      onCountChange?.(sliced.length);
    } catch {
      setReceipts([]);
      onCountChange?.(0);
    }
  }, [vehicleId, issueId, onCountChange]);

  useEffect(() => {
    void loadReceipts();
    loadOcrHints((path) => api(path)).then(setHints).catch(() => {});
  }, [loadReceipts]);

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
      if (parsed.vendor_name && !vendorName.trim()) setVendorName(parsed.vendor_name);
      if (parsed.invoice_number && !invoiceNumber.trim())
        setInvoiceNumber(parsed.invoice_number);
      if (parsed.total_cost != null && !totalCost.trim())
        setTotalCost(String(parsed.total_cost));
      const filled = [
        parsed.vendor_name && "vendor",
        parsed.invoice_number && "invoice #",
        parsed.total_cost != null && "total",
      ].filter(Boolean);
      setOcrNote(
        filled.length
          ? `Read: ${filled.join(", ")}. Check & fix if needed.`
          : "Couldn’t read clearly — enter fields, then save."
      );
    } catch {
      setOcrNote("Enter fields manually and save with the photo.");
    } finally {
      setScanning(false);
    }
  }

  function resetUpload() {
    setVendorName("");
    setInvoiceNumber("");
    setTotalCost("");
    onPhotoPick(null);
    setOcrNote("");
    setLastOcr(null);
    setShowForm(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!photoFile) {
      setError("Photo of the receipt is required.");
      return;
    }
    if (!vendorName.trim()) {
      setError("Vendor / store name is required.");
      return;
    }
    if (kind === "vendor" && !invoiceNumber.trim()) {
      setError("Invoice or packing slip # is required for vendor pickups.");
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
      const up = await api<{ key: string }>("/uploads/receipt", {
        method: "POST",
        body: fd,
      });

      const ocr_feedback = lastOcr
        ? {
            raw_text: lastOcr.raw_text,
            ocr: {
              vendor_name: lastOcr.vendor_name,
              invoice_number: lastOcr.invoice_number,
              total_cost: lastOcr.total_cost,
              store_number: lastOcr.vendor_name,
            },
            final: {
              vendor_name: vendorName.trim(),
              invoice_number: invoiceNumber.trim() || null,
              total_cost: totalCost.trim() ? Number(totalCost) : null,
              store_number: vendorName.trim(),
            },
          }
        : undefined;

      await api("/parts-purchases", {
        method: "POST",
        body: JSON.stringify({
          purchase_kind: kind,
          vendor_name: vendorName.trim(),
          invoice_number: invoiceNumber.trim() || null,
          purchase_date: new Date().toISOString().slice(0, 10),
          total_cost: totalCost.trim() ? Number(totalCost) : null,
          notes: unitNumber ? `Unit ${unitNumber}` : null,
          receipt_key: up.key,
          vehicle_id: vehicleId,
          issue_id: issueId || null,
          ocr_feedback,
        }),
      });

      setOk(`Receipt saved for unit ${unitNumber || vehicleId}.`);
      resetUpload();
      await loadReceipts();
      onSaved?.();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        setOk(err.message);
        resetUpload();
      } else {
        setError(err instanceof Error ? err.message : "Could not save receipt");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shop-receipt-panel">
      <div className="shop-receipt-panel-head">
        <strong>Parts receipts</strong>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          Tied to unit {unitNumber || vehicleId}
          {issueId ? ` · this job` : ""}
        </span>
      </div>

      {receipts.length > 0 && (
        <ul className="shop-receipt-list">
          {receipts.map((r) => (
            <li key={r.id}>
              <span>
                <strong>{r.vendor_name}</strong>
                {r.invoice_number ? ` · inv ${r.invoice_number}` : ""}
                {r.total_cost != null ? ` · $${Number(r.total_cost).toFixed(2)}` : ""}
              </span>
              {r.receipt_key ? (
                <a
                  href={`/api/uploads/${encodeURIComponent(r.receipt_key)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Photo
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!showForm ? (
        <button
          type="button"
          className="btn secondary btn-sm"
          onClick={() => setShowForm(true)}
        >
          {receipts.length ? "Add another receipt" : "Upload parts receipt"}
        </button>
      ) : (
        <form className="form shop-receipt-form" onSubmit={submit}>
          <div className="shop-receipt-kind">
            <button
              type="button"
              className={kind === "vendor" ? "btn btn-sm" : "btn secondary btn-sm"}
              onClick={() => setKind("vendor")}
              disabled={busy}
            >
              Vendor
            </button>
            <button
              type="button"
              className={kind === "other" ? "btn btn-sm" : "btn secondary btn-sm"}
              onClick={() => setKind("other")}
              disabled={busy}
            >
              Other store
            </button>
          </div>
          <label>
            {kind === "vendor" ? "Vendor *" : "Store *"}
            <input
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              required
              placeholder={kind === "vendor" ? "AutoZone, Johnstone…" : "Home Depot…"}
              disabled={busy}
            />
          </label>
          <label>
            {kind === "vendor" ? "Invoice # *" : "Receipt #"}
            <input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              required={kind === "vendor"}
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
          <PhotoCapture
            required
            compact
            label="Receipt photo"
            hint={scanning ? "Reading…" : "Invoice or packing slip"}
            previewUrl={preview}
            onPick={(f) => onPhotoPick(f)}
            onClear={() => onPhotoPick(null)}
            disabled={busy || scanning}
          />
          {ocrNote && <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>{ocrNote}</p>}
          {error && <div className="error inv-flash">{error}</div>}
          {ok && <div className="success inv-flash">{ok}</div>}
          <div className="toolbar">
            <button
              className="btn btn-sm"
              type="submit"
              disabled={busy || scanning || !photoFile}
            >
              {busy ? "Saving…" : "Save receipt"}
            </button>
            <button
              type="button"
              className="btn secondary btn-sm"
              onClick={() => resetUpload()}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
