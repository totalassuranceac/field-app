import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
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

/** Case-insensitive store key (ignore spacing / punctuation noise). */
function normStoreKey(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactStoreKey(s: string): string {
  return normStoreKey(s).replace(/\s+/g, "");
}

/** Block placeholders / noise; fold brand variants to one official name. */
function canonicalizeStoreName(raw: string): string | null {
  const n = String(raw || "").trim();
  if (!n) return null;
  const k = normStoreKey(n);
  if (!k) return null;
  if (k.includes("replenish")) return null;
  if (k.includes("default vendor") || k === "imported default vendor") return null;
  if (k.includes("alcapulco") || k.includes("acapulco")) return null;
  if (k === "carrier" || k.startsWith("carrier ")) return "Carrier Enterprise";
  if (k === "ferguson" || k.startsWith("ferguson ")) return "Ferguson Supply";
  if (k === "lennox" || k.startsWith("lennox ")) return "Lennox Industries";
  return n;
}

/** Prefer an existing store name when input matches ignoring case. */
function findExactStore(input: string, vendors: string[]): string | null {
  const canon = canonicalizeStoreName(input);
  if (!canon) return null;
  const key = normStoreKey(canon);
  if (!key) return null;
  // Prefer list match on canonical brand
  if (
    canon === "Carrier Enterprise" ||
    canon === "Ferguson Supply" ||
    canon === "Lennox Industries"
  ) {
    return canon;
  }
  return vendors.find((v) => normStoreKey(v) === key) || null;
}

/** Near-duplicates (e.g. "home depot" vs "Home Depot #42" / "HomeDepot"). */
function findSimilarStores(input: string, vendors: string[]): string[] {
  const canon = canonicalizeStoreName(input);
  if (!canon) return [];
  if (
    canon === "Carrier Enterprise" ||
    canon === "Ferguson Supply" ||
    canon === "Lennox Industries"
  ) {
    return [];
  }
  const key = normStoreKey(canon);
  const compact = compactStoreKey(canon);
  if (!key || compact.length < 3) return [];
  const out: string[] = [];
  for (const v of vendors) {
    const vk = normStoreKey(v);
    const vc = compactStoreKey(v);
    if (!vk || vk === key) continue; // exact handled elsewhere
    if (vc === compact) {
      out.push(v);
      continue;
    }
    // Shared start (min 5 chars) — "home depot" vs "home depot 123"
    if (compact.length >= 5 && vc.length >= 5) {
      if (vc.startsWith(compact) || compact.startsWith(vc)) {
        out.push(v);
      }
    }
  }
  return out.slice(0, 5);
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
  const canViewAll =
    user?.role === "admin" ||
    user?.role === "office" ||
    user?.role === "warehouse" ||
    user?.role === "viewer";

  const [vendorName, setVendorName] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [totalCost, setTotalCost] = useState("");
  const [notes, setNotes] = useState("");
  const [vendors, setVendors] = useState<string[]>([]);
  /** Optional deep-link context only (shop job / order) — not shown on the form */
  const [issueId] = useState(() => searchParams.get("issue") || "");
  const [partsOrderId] = useState(() => searchParams.get("order") || "");
  const [listFilter, setListFilter] = useState<"mine" | "all">("mine");

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
    const d = await api<{ receipts: PartsReceipt[] }>(
      `/parts-purchases?${q.toString()}`
    );
    setList(d.receipts || []);
  }

  useEffect(() => {
    loadList().catch((e) => setError(e.message));
  }, [listFilter, canViewAll]);

  useEffect(() => {
    if (canLog) {
      api<{ vendors: string[] }>("/parts-purchases/vendors")
        .then((d) => {
          // Dedupe + canonicalize (Carrier/Lennox/Ferguson; drop replenish / alcapulco)
          const byKey = new Map<string, string>();
          for (const v of d.vendors || []) {
            const t = canonicalizeStoreName(v);
            if (!t) continue;
            const k = normStoreKey(t);
            if (!k) continue;
            byKey.set(k, t);
          }
          // Always offer official brand names
          for (const brand of ["Carrier Enterprise", "Ferguson Supply", "Lennox Industries"]) {
            byKey.set(normStoreKey(brand), brand);
          }
          setVendors([...byKey.values()].sort((a, b) => a.localeCompare(b)));
        })
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
      if (parsed.purchase_date) setPurchaseDate(parsed.purchase_date);
      if (parsed.total_cost != null && !totalCost.trim()) setTotalCost(String(parsed.total_cost));

      const filled = [
        parsed.vendor_name && "store",
        parsed.total_cost != null && "total",
        parsed.purchase_date && "date",
      ].filter(Boolean);
      if (filled.length) {
        setOcrNote(
          `Read from photo (${parsed.confidence}): ${filled.join(", ")}. Check & fix if needed.`
        );
      } else {
        setOcrNote(
          "Couldn’t auto-read this slip — enter store, date, total, and what it was for, then save."
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
    setPurchaseDate(new Date().toISOString().slice(0, 10));
    setTotalCost("");
    setNotes("");
    onPhotoPick(null);
    setOcrNote("");
    setLastOcr(null);
  }

  /** Resolve store name: reuse existing casing, or confirm before creating a near-duplicate. */
  function resolveStoreName(raw: string): string | null {
    const typed = raw.trim();
    if (!typed) return null;

    const canon = canonicalizeStoreName(typed);
    if (!canon) {
      setError(
        "That store name isn’t allowed (replenishment placeholders / blocked names). Pick a real store."
      );
      return null;
    }
    if (canon !== typed) setVendorName(canon);

    const exact = findExactStore(canon, vendors);
    if (exact) {
      if (exact !== canon) setVendorName(exact);
      return exact;
    }

    const similar = findSimilarStores(canon, vendors);
    if (similar.length === 1) {
      const existing = similar[0];
      const useExisting = window.confirm(
        `“${canon}” looks like an existing store:\n\n“${existing}”\n\n` +
          `OK — use “${existing}” (recommended)\n` +
          `Cancel — keep “${canon}” as a new store name`
      );
      if (useExisting) {
        setVendorName(existing);
        return existing;
      }
      return canon;
    }
    if (similar.length > 1) {
      const list = similar.map((s, i) => `${i + 1}. ${s}`).join("\n");
      const useFirst = window.confirm(
        `“${canon}” may match an existing store:\n\n${list}\n\n` +
          `OK — use “${similar[0]}” (recommended)\n` +
          `Cancel — keep “${canon}” as a new store name`
      );
      if (useFirst) {
        setVendorName(similar[0]);
        return similar[0];
      }
      return canon;
    }

    return canon;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!photoFile) {
      setError("Photo of the receipt is required.");
      return;
    }
    if (!vendorName.trim()) {
      setError("Store name is required.");
      return;
    }
    if (!purchaseDate) {
      setError("Date is required.");
      return;
    }
    if (!totalCost.trim() || !Number.isFinite(Number(totalCost)) || Number(totalCost) < 0) {
      setError("Enter the receipt total.");
      return;
    }
    if (!notes.trim()) {
      setError("Say what the purchase was for.");
      return;
    }

    const storeName = resolveStoreName(vendorName);
    if (!storeName) {
      setError("Store name is required.");
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
              vendor_name: storeName,
              invoice_number: null,
              purchase_date: purchaseDate || null,
              total_cost: Number(totalCost),
              card_last4: null,
              store_number: storeName,
              fuel_date: purchaseDate || null,
            },
          }
        : undefined;

      await api("/parts-purchases", {
        method: "POST",
        body: JSON.stringify({
          purchase_kind: "other",
          vendor_name: storeName,
          invoice_number: null,
          purchase_date: purchaseDate || null,
          total_cost: Number(totalCost),
          card_last4: null,
          notes: notes.trim(),
          receipt_key: up.key,
          vehicle_id: null,
          issue_id: issueId ? Number(issueId) : null,
          parts_order_id: partsOrderId ? Number(partsOrderId) : null,
          ocr_feedback,
        }),
      });

      // Keep known list in sync with the name we saved
      setVendors((prev) => {
        const k = normStoreKey(storeName);
        if (prev.some((v) => normStoreKey(v) === k)) return prev;
        return [...prev, storeName].sort((a, b) => a.localeCompare(b));
      });

      setOk(`Saved receipt from ${storeName} · $${Number(totalCost).toFixed(2)}.`);
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

  if (!canLog && !can(user, "viewPartsPurchase")) {
    return (
      <div className="page-header">
        <h1>Bought parts</h1>
        <p className="muted">You don’t have access to log company-card parts purchases.</p>
      </div>
    );
  }

  return (
    <div className="parts-purchases-page">
      <div className="page-header">
        <div>
          <h1>Bought parts</h1>
          <p>Bought something with the company card? Photo the receipt and fill in store, date, total, and what it was for.</p>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {canLog && (
        <form className="card warranty-form" onSubmit={submit}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Log a purchase</h2>

          <div className="warranty-form-grid">
            <label className="span-2">
              Store name *
              <input
                list="parts-vendor-list"
                value={vendorName}
                onChange={(e) => {
                  const raw = e.target.value;
                  const exact = findExactStore(raw, vendors);
                  // Snap brand families + known stores as you type/pick
                  if (exact && (normStoreKey(raw) === normStoreKey(exact) || canonicalizeStoreName(raw) === exact)) {
                    setVendorName(exact);
                  } else {
                    setVendorName(raw);
                  }
                }}
                onBlur={() => {
                  const exact = findExactStore(vendorName, vendors);
                  if (exact) setVendorName(exact);
                  else {
                    const c = canonicalizeStoreName(vendorName);
                    if (c) setVendorName(c);
                  }
                }}
                required
                placeholder="e.g. Home Depot, AutoZone, Johnstone"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
              <datalist id="parts-vendor-list">
                {vendors.map((v) => (
                  <option key={normStoreKey(v)} value={v} />
                ))}
              </datalist>
            </label>

            <label>
              Date *
              <input
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                required
                disabled={busy}
              />
            </label>

            <label>
              Total $ *
              <input
                inputMode="decimal"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
                placeholder="0.00"
                required
                disabled={busy}
              />
            </label>

            <label className="span-2">
              What was it for? *
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. contactor for unit 12 · shop supplies"
                required
                disabled={busy}
              />
            </label>
          </div>

          <div className="warranty-photo-block">
            <PhotoCapture
              required
              label="Receipt photo *"
              hint={scanning ? "Reading receipt…" : "Take a photo of the full receipt."}
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
      </div>

      <h2 style={{ fontSize: "1rem", marginTop: "0.5rem" }}>Recent purchases</h2>
      {list.length === 0 ? (
        <p className="muted">No purchases logged yet.</p>
      ) : (
        <ul className="log-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {list.map((r) => (
            <li key={r.id} className="card log-item" style={{ marginBottom: "0.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                <strong>{r.vendor_name}</strong>
                <span className="muted" style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                  {r.total_cost != null ? `$${Number(r.total_cost).toFixed(2)}` : "—"}
                </span>
              </div>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {r.purchase_date || "No date"}
                {r.purchased_by_name ? ` · ${r.purchased_by_name}` : ""}
              </div>
              {r.notes ? (
                <div style={{ fontSize: "0.9rem", marginTop: "0.2rem" }}>{r.notes}</div>
              ) : null}
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
      )}
    </div>
  );
}
