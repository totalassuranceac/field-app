import { FormEvent, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, OfflineQueuedError } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";
import { PhotoCapture, PHOTO_TIPS } from "../components/PhotoCapture";
import {
  loadOcrHints,
  ocrNameplateImage,
  warmOcrEngine,
  type NameplateParseResult,
  type OcrHints,
} from "../nameplateOcr";
import {
  isCompressorPartName,
  suggestWarrantyParts,
} from "../warrantyPartSuggestions";

/**
 * Flow:
 * Dropped off → Claim submitted → (optional) Return to vendor [→ Delivered]
 * → Approved | Rejected (credit decision only — closes the log)
 * OR → Not a warranty — sent to job (closes when it was never a warranty claim)
 * Submitted claims stay quiet for 3 working days, then need approve/reject follow-up.
 */
type WStatus =
  | "dropped_off"
  | "claim_submitted"
  | "return_to_vendor"
  | "delivered"
  | "approved"
  | "rejected"
  | "not_warranty";

interface Warranty {
  id: number;
  log_number: string;
  status: WStatus | string;
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
  dropped_off_by_user_id?: number | null;
  dropped_off_by_name?: string | null;
  processed_by_name?: string | null;
  dropoff_photo_key?: string | null;
  nameplate_photo_key?: string | null;
  rma_number?: string | null;
  credit_amount?: number | null;
  tracking_number?: string | null;
  days_open: number;
  working_days_since_submit?: number;
  needs_attention?: boolean;
  overdue?: boolean;
  urgent?: boolean;
  claim_submitted_by_user_id?: number | null;
  claim_submitted_by_name?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  dropped_off: "Dropped off",
  claim_submitted: "Claim submitted",
  return_to_vendor: "Return to vendor",
  delivered: "Delivered",
  approved: "Approved",
  rejected: "Rejected",
  not_warranty: "Removed · not a claim",
  // legacy
  processed: "Approved",
  cancelled: "Rejected",
  sent_to_job: "Removed · not a claim",
};

const OPEN_STATUSES: WStatus[] = [
  "dropped_off",
  "claim_submitted",
  "return_to_vendor",
  "delivered",
];

function normalizeStatus(s: string): WStatus {
  if (s === "processed") return "approved";
  if (s === "cancelled") return "rejected";
  if (
    s === "not_a_warranty" ||
    s === "sent_to_job" ||
    s === "repurposed" ||
    s === "used_on_job"
  ) {
    return "not_warranty";
  }
  if (
    s === "dropped_off" ||
    s === "claim_submitted" ||
    s === "return_to_vendor" ||
    s === "delivered" ||
    s === "approved" ||
    s === "rejected" ||
    s === "not_warranty"
  ) {
    return s;
  }
  return "dropped_off";
}

function isOpenStatus(s: string): boolean {
  return OPEN_STATUSES.includes(normalizeStatus(s));
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
  const [attentionCount, setAttentionCount] = useState(0);
  const [filter, setFilter] = useState<"open" | "all" | "vendor" | "decided">("open");
  const [searchQ, setSearchQ] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  /** Per-claim vendor credit form draft */
  const [vendorDraft, setVendorDraft] = useState<
    Record<
      number,
      { rma: string; tracking: string; credit: string; vendor: string; address: string }
    >
  >({});
  /** Per-claim status note draft (append) */
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});

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
  const [partSuggestOpen, setPartSuggestOpen] = useState(false);
  const [compressorSealsOk, setCompressorSealsOk] = useState(false);
  const [oldCompSerial, setOldCompSerial] = useState("");
  const [newCompSerial, setNewCompSerial] = useState("");
  const [oldCompFile, setOldCompFile] = useState<File | null>(null);
  const [oldCompPreview, setOldCompPreview] = useState<string | null>(null);
  const [newCompFile, setNewCompFile] = useState<File | null>(null);
  const [newCompPreview, setNewCompPreview] = useState<string | null>(null);

  const isCompressor = isCompressorPartName(partName);
  const learnedPartNames = useMemo(() => {
    const names = list.map((w) => w.part_name).filter(Boolean);
    return [...new Set(names)];
  }, [list]);
  const partSuggestions = useMemo(
    () => suggestWarrantyParts(partName, learnedPartNames, 6),
    [partName, learnedPartNames]
  );
  const [ocrHints, setOcrHints] = useState<OcrHints | null>(null);
  /** After drop-off: show log # to write on the box */
  const [writeOnBox, setWriteOnBox] = useState<string | null>(null);

  async function load() {
    const params = new URLSearchParams();
    if (filter === "open") params.set("status", "open");
    else if (filter === "decided") params.set("status", "decided");
    else if (filter === "vendor") params.set("status", "vendor");
    if (searchQ.trim()) params.set("q", searchQ.trim());
    const qs = params.toString();
    const d = await api<{
      warranties: Warranty[];
      attention_count?: number;
      open_count?: number;
    }>(`/warranties${qs ? `?${qs}` : ""}`);
    setList(d.warranties || []);
    if (typeof d.attention_count === "number") setAttentionCount(d.attention_count);
  }

  const sections = useMemo(() => {
    const dropped: Warranty[] = [];
    const submitted: Warranty[] = [];
    const vendor: Warranty[] = [];
    const approved: Warranty[] = [];
    const rejected: Warranty[] = [];
    const other: Warranty[] = [];
    for (const w of list) {
      const st = normalizeStatus(String(w.status));
      if (st === "dropped_off") dropped.push(w);
      else if (st === "claim_submitted") submitted.push(w);
      else if (st === "return_to_vendor" || st === "delivered") vendor.push(w);
      else if (st === "approved") approved.push(w);
      else if (st === "rejected") rejected.push(w);
      else other.push(w);
    }
    return { dropped, submitted, vendor, approved, rejected, other };
  }, [list]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      load().catch((e) => setError(e.message));
    }, searchQ.trim() ? 200 : 0);
    return () => window.clearTimeout(t);
  }, [filter, searchQ]);

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

  useEffect(() => {
    return () => {
      if (oldCompPreview) URL.revokeObjectURL(oldCompPreview);
    };
  }, [oldCompPreview]);

  useEffect(() => {
    return () => {
      if (newCompPreview) URL.revokeObjectURL(newCompPreview);
    };
  }, [newCompPreview]);

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

  function onOldCompPick(file: File | null) {
    if (oldCompPreview) URL.revokeObjectURL(oldCompPreview);
    setOldCompFile(file);
    setOldCompPreview(file ? URL.createObjectURL(file) : null);
  }

  function onNewCompPick(file: File | null) {
    if (newCompPreview) URL.revokeObjectURL(newCompPreview);
    setNewCompFile(file);
    setNewCompPreview(file ? URL.createObjectURL(file) : null);
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
        const brand = parsed.manufacturer ? ` · ${parsed.manufacturer}` : "";
        setNameplateNote(
          `Filled from nameplate (${parsed.confidence}${brand}): ${parts.join(" · ")}. Fix anything wrong — corrections teach the app.`
        );
      } else {
        setNameplateNote(
          "Couldn’t read clearly — type model & serial from the nameplate (that still helps the app learn)."
        );
      }
    } catch {
      setNameplateNote("Scan unavailable — type model & serial from the nameplate.");
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
    setPartSuggestOpen(false);
    setCompressorSealsOk(false);
    setOldCompSerial("");
    setNewCompSerial("");
    onOldCompPick(null);
    onNewCompPick(null);
  }

  async function submitDropoff(e: FormEvent) {
    e.preventDefault();
    if (!model.trim()) {
      setError(
        "Equipment model # is required — from the unit the part was removed from (not the part itself)."
      );
      return;
    }
    if (!serial.trim()) {
      setError(
        "Equipment serial # is required — from the unit the part was removed from (not the part itself)."
      );
      return;
    }
    if (!photoFile) {
      setError(
        "Photo required: take a picture of where you left the part (shelf, bin, counter) so warehouse can find it."
      );
      return;
    }
    if (isCompressorPartName(partName)) {
      if (!compressorSealsOk) {
        setError(
          "Compressors must have seals intact — vendors reject leaking / unsealed compressors. Check the box to confirm."
        );
        return;
      }
      if (!oldCompFile) {
        setError("Compressor warranty needs a photo of the OLD compressor serial number.");
        return;
      }
      if (!newCompFile) {
        setError("Compressor warranty needs a photo of the NEW compressor serial number.");
        return;
      }
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      await postDropoff({ confirmDuplicate: false });
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        setOk(err.message);
        resetForm();
      } else if (err instanceof ApiError && err.status === 409) {
        const data = err.data as {
          error?: string;
          message?: string;
          matches?: Array<{
            log_number: string;
            part_name: string;
            status: string;
            dropped_off_at: string;
            serial_number?: string | null;
          }>;
        } | null;
        if (data?.error === "duplicate_serial" && data.matches?.length) {
          const lines = data.matches
            .slice(0, 5)
            .map((m) => {
              const when = String(m.dropped_off_at || "").replace("T", " ").slice(0, 16);
              return `• ${m.log_number} — ${m.part_name} (${m.status.replace(/_/g, " ")}${when ? ` · ${when}` : ""})`;
            })
            .join("\n");
          const okDup = window.confirm(
            `Possible duplicate warranty\n\n` +
              `Equipment serial “${serial.trim()}” already has ${data.matches.length} claim(s) in the last 30 days:\n\n` +
              `${lines}\n\n` +
              `Only continue if this is a NEW claim (not the same drop-off logged twice).\n\n` +
              `Create another warranty log anyway?`
          );
          if (okDup) {
            try {
              await postDropoff({ confirmDuplicate: true });
            } catch (err2) {
              if (err2 instanceof OfflineQueuedError) {
                setOk(err2.message);
                resetForm();
              } else {
                setError(err2 instanceof Error ? err2.message : "Could not log drop-off");
              }
            }
          } else {
            setError(
              "Not saved — same serial already logged recently. Fix the existing claim or confirm if this is truly new."
            );
          }
        } else {
          setError(data?.message || err.message || "Could not log drop-off");
        }
      } else {
        setError(err instanceof Error ? err.message : "Could not log drop-off");
      }
    } finally {
      setBusy(false);
    }
  }

  async function postDropoff(opts: { confirmDuplicate: boolean }) {
    if (!photoFile) throw new Error("Photo required");
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
    if (opts.confirmDuplicate) fd.append("confirm_duplicate", "1");
    const compressor = isCompressorPartName(partName);
    if (compressor) {
      fd.append("compressor_seals_ok", "1");
      if (oldCompSerial.trim()) fd.append("old_compressor_serial", oldCompSerial.trim());
      if (newCompSerial.trim()) fd.append("new_compressor_serial", newCompSerial.trim());
    }
    fd.append("photo", compressed, compressed.name || "dropoff.jpg");
    if (nameplateFile) {
      const np = await compressPhoto(nameplateFile);
      fd.append("nameplate", np, np.name || "nameplate.jpg");
    }
    if (compressor && oldCompFile) {
      const oc = await compressPhoto(oldCompFile);
      fd.append("old_compressor_photo", oc, oc.name || "old-compressor.jpg");
    }
    if (compressor && newCompFile) {
      const nc = await compressPhoto(newCompFile);
      fd.append("new_compressor_photo", nc, nc.name || "new-compressor.jpg");
    }
    // Always send OCR feedback when we scanned — corrections teach brand layouts
    if (lastNameplateOcr) {
      const plateKey = lastNameplateOcr.manufacturer
        ? `nameplate_${lastNameplateOcr.manufacturer}`
        : "nameplate";
      fd.append(
        "ocr_feedback",
        JSON.stringify({
          raw_text: lastNameplateOcr.raw_text,
          ocr: {
            model_number: lastNameplateOcr.model_number,
            serial_number: lastNameplateOcr.serial_number,
            store_number: plateKey,
          },
          final: {
            model_number: model.trim(),
            serial_number: serial.trim(),
            store_number: plateKey,
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
  }

  function draftFor(w: Warranty) {
    return (
      vendorDraft[w.id] || {
        rma: w.rma_number || "",
        tracking: w.tracking_number || "",
        credit: w.credit_amount != null ? String(w.credit_amount) : "",
        vendor: w.vendor_name || "",
        address: w.service_address || "",
      }
    );
  }

  function patchDraft(
    id: number,
    w: Warranty,
    patch: Partial<{ rma: string; tracking: string; credit: string; vendor: string; address: string }>
  ) {
    setVendorDraft((p) => ({
      ...p,
      [id]: { ...draftFor(w), ...patch },
    }));
  }

  async function setStatus(id: number, status: WStatus, extra?: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const w = list.find((x) => x.id === id);
      const d = w ? draftFor(w) : vendorDraft[id];
      const body: Record<string, unknown> = { status, ...extra };
      if (d) {
        if (d.rma.trim()) body.rma_number = d.rma.trim();
        if (d.tracking.trim()) body.tracking_number = d.tracking.trim();
        if (d.credit.trim() !== "") body.credit_amount = Number(d.credit);
        if (d.vendor.trim()) body.vendor_name = d.vendor.trim();
        if (d.address.trim()) body.service_address = d.address.trim();
      }
      await api(`/warranties/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setOk(`Updated → ${STATUS_LABEL[status] || status}`);
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

  /**
   * Close without a claim outcome — part back to shelves, another job, not a warranty, etc.
   * No reason required; just leaves the open list.
   */
  async function markNotWarranty(w: Warranty) {
    if (
      !window.confirm(
        `Remove ${w.log_number} from open warranties?\n\nUse this when it is not a warranty claim (back to shelves, another job, etc.). It will not show as Approved or Rejected.`
      )
    ) {
      return;
    }
    await setStatus(w.id, "not_warranty");
  }

  async function saveVendorDetails(w: Warranty) {
    const d = draftFor(w);
    setBusy(true);
    setError("");
    try {
      await api(`/warranties/${w.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          vendor_name: d.vendor.trim() || null,
          service_address: d.address.trim() || null,
          rma_number: d.rma.trim() || null,
          tracking_number: d.tracking.trim() || null,
          credit_amount: d.credit.trim() === "" ? null : Number(d.credit),
        }),
      });
      setOk(`Saved claim details for ${w.log_number}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save claim details");
    } finally {
      setBusy(false);
    }
  }

  function noteDraftFor(id: number): string {
    return noteDraft[id] ?? "";
  }

  /** Latest status line for collapsed list preview */
  function latestNotePreview(notes: string | null | undefined): string {
    const t = (notes || "").trim();
    if (!t) return "";
    const blocks = t.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
    const last = blocks[blocks.length - 1] || t;
    const lines = last.split("\n").map((l) => l.trim()).filter(Boolean);
    // Prefer body line over [timestamp · who] header
    const body =
      lines.find((l) => !/^\[.+·.+\]$/.test(l) && !/^\[.+\]$/.test(l)) || lines[lines.length - 1];
    const s = (body || "").replace(/\s+/g, " ");
    return s.length > 72 ? `${s.slice(0, 70)}…` : s;
  }

  async function addStatusNote(w: Warranty) {
    const text = noteDraftFor(w.id).trim();
    if (!text) {
      setError("Type a status note first (e.g. Working with Lennox — waiting on RMA).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/warranties/${w.id}`, {
        method: "PATCH",
        body: JSON.stringify({ append_note: text }),
      });
      setNoteDraft((p) => {
        const next = { ...p };
        delete next[w.id];
        return next;
      });
      setOk(`Status note added on ${w.log_number}`);
      await load();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        setOk(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Could not save note");
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
            Stages: <strong>Dropped off</strong> → <strong>Claim submitted</strong> →{" "}
            <strong>Approved / Rejected</strong>. Submitted claims stay quiet for{" "}
            <strong>3 working days</strong>, then need approve/reject. Dashboard focus only counts
            dropped-off parts plus aging submitted claims
            {attentionCount > 0 ? ` · ${attentionCount} need attention now` : ""}.
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

        <div className="warranty-form-grid">
          {/* 1 — Equipment first (unit the part came off) */}
          <section className="span-2 warranty-section warranty-section-equipment">
            <header className="warranty-section-head">
              <span className="warranty-section-num" aria-hidden>
                1
              </span>
              <div>
                <h3 className="warranty-section-title">Equipment this part came off</h3>
                <p className="warranty-section-sub">
                  Furnace, condenser, or air handler nameplate — photo helps the app learn each brand
                </p>
              </div>
            </header>
            <div className="warranty-ms-row">
              <div className="warranty-ms-fields">
                <label>
                  Model #
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    required
                    placeholder="M/N"
                    autoComplete="off"
                    autoFocus
                  />
                </label>
                <label>
                  Serial #
                  <input
                    value={serial}
                    onChange={(e) => setSerial(e.target.value)}
                    required
                    placeholder="S/N"
                    autoComplete="off"
                  />
                </label>
              </div>
              <div className="warranty-ms-upload">
                <span className="warranty-ms-upload-label muted">Nameplate photo</span>
                <PhotoCapture
                  compact
                  label="Nameplate"
                  hint={
                    nameplateScanning
                      ? "Reading…"
                      : "Recommended — auto-fills M/N & S/N; fixes teach the app"
                  }
                  tip={PHOTO_TIPS.nameplate}
                  previewUrl={nameplatePreview}
                  onPick={(f) => onNameplatePick(f)}
                  onClear={() => onNameplatePick(null)}
                  disabled={busy || nameplateScanning}
                />
              </div>
            </div>
            {nameplateNote ? (
              <div className="info-banner" style={{ marginTop: "0.5rem" }}>
                {nameplateNote}
              </div>
            ) : null}
          </section>

          {/* 2 — Failed part being left for warranty */}
          <section className="span-2 warranty-section warranty-section-part">
            <header className="warranty-section-head">
              <span className="warranty-section-num" aria-hidden>
                2
              </span>
              <div>
                <h3 className="warranty-section-title">Warranty part you are dropping off</h3>
                <p className="warranty-section-sub">The failed part on the box</p>
              </div>
            </header>
            <div className="warranty-part-fields">
              <label className="warranty-part-suggest-wrap">
                Part name *
                <input
                  value={partName}
                  onChange={(e) => {
                    setPartName(e.target.value);
                    setPartSuggestOpen(true);
                  }}
                  onFocus={() => setPartSuggestOpen(true)}
                  onBlur={() => window.setTimeout(() => setPartSuggestOpen(false), 180)}
                  required
                  placeholder="Start typing — e.g. comp → Compressor"
                  autoComplete="off"
                />
                {partSuggestOpen && partSuggestions.length > 0 ? (
                  <ul className="warranty-part-suggest" role="listbox">
                    {partSuggestions.map((s) => (
                      <li key={s}>
                        <button
                          type="button"
                          className="warranty-part-suggest-item"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setPartName(s);
                            setPartSuggestOpen(false);
                          }}
                        >
                          {s}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </label>
              <label>
                Part code
                <input
                  value={partCode}
                  onChange={(e) => setPartCode(e.target.value)}
                  placeholder="SKU (optional)"
                />
              </label>
            </div>

            {isCompressor ? (
              <div className="warranty-compressor-box">
                <h4 className="warranty-compressor-title">Compressor requirements</h4>
                <p className="muted warranty-compressor-lead">
                  Vendors reject compressors that are not sealed (leakage). Also photograph{" "}
                  <strong>both</strong> serial numbers — old (failed) and new (replacement).
                </p>
                <label className="warranty-compressor-check">
                  <input
                    type="checkbox"
                    checked={compressorSealsOk}
                    onChange={(e) => setCompressorSealsOk(e.target.checked)}
                  />
                  <span>
                    I confirm the compressor <strong>seals are sealed / intact</strong> (not open to
                    atmosphere)
                  </span>
                </label>
                <div className="warranty-compressor-photos">
                  <div>
                    <label>
                      Old compressor S/N (optional type)
                      <input
                        value={oldCompSerial}
                        onChange={(e) => setOldCompSerial(e.target.value)}
                        placeholder="Failed compressor serial"
                        autoComplete="off"
                      />
                    </label>
                    <PhotoCapture
                      compact
                      required
                      label="Old compressor S/N"
                      hint={!oldCompFile ? "Required" : "Attached"}
                      tip="Clear photo of the serial on the failed compressor"
                      previewUrl={oldCompPreview}
                      onPick={(f) => onOldCompPick(f)}
                      onClear={() => onOldCompPick(null)}
                      disabled={busy}
                    />
                  </div>
                  <div>
                    <label>
                      New compressor S/N (optional type)
                      <input
                        value={newCompSerial}
                        onChange={(e) => setNewCompSerial(e.target.value)}
                        placeholder="Replacement compressor serial"
                        autoComplete="off"
                      />
                    </label>
                    <PhotoCapture
                      compact
                      required
                      label="New compressor S/N"
                      hint={!newCompFile ? "Required" : "Attached"}
                      tip="Clear photo of the serial on the new compressor"
                      previewUrl={newCompPreview}
                      onPick={(f) => onNewCompPick(f)}
                      onClear={() => onNewCompPick(null)}
                      disabled={busy}
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          {/* 3 — Job context */}
          <section className="span-2 warranty-section warranty-section-job">
            <header className="warranty-section-head">
              <span className="warranty-section-num" aria-hidden>
                3
              </span>
              <div>
                <h3 className="warranty-section-title">Job details</h3>
                <p className="warranty-section-sub">Optional but helps warehouse</p>
              </div>
            </header>
            <div className="warranty-job-fields">
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
          </section>

          {/* 4 — Where you left it */}
          <div className="span-2 warranty-location-row">
            <div className="warranty-location-text">
              <strong>
                <span className="warranty-section-num warranty-section-num-inline" aria-hidden>
                  4
                </span>{" "}
                Where you left the part *
                {!photoFile ? (
                  <span className="warranty-need-photo"> — photo required</span>
                ) : (
                  <span className="muted"> — attached</span>
                )}
              </strong>
              <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.82rem" }}>
                Shelf, bin, or counter
              </p>
            </div>
            <PhotoCapture
              compact
              required
              label="Location"
              tip={PHOTO_TIPS.dropoff}
              previewUrl={photoPreview}
              onPick={(f) => onPhotoPick(f)}
              onClear={() => onPhotoPick(null)}
              disabled={busy}
            />
          </div>
        </div>

        <button
          className="btn warranty-submit-btn"
          type="submit"
          disabled={
            busy ||
            nameplateScanning ||
            !photoFile ||
            (isCompressor && (!compressorSealsOk || !oldCompFile || !newCompFile))
          }
        >
          {busy
            ? "Saving…"
            : nameplateScanning
              ? "Still reading nameplate…"
              : isCompressor && (!compressorSealsOk || !oldCompFile || !newCompFile)
                ? "Finish compressor checklist…"
                : "Drop off & notify warehouse"}
        </button>
      </form>

      <div className="warranty-filters no-print">
        {(
          [
            ["open", "Open (by stage)"],
            ["vendor", "Waiting on vendor"],
            ["all", "All"],
            ["decided", "Approved / Rejected"],
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
        <input
          className="warranty-search"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          placeholder="Search…"
          title="Search log #, job address, part, vendor, RMA"
          aria-label="Search warranties by address, vendor, log #, part"
        />
      </div>
      {searchQ.trim() ? (
        <p className="muted warranty-search-hint">
          All statuses · “{searchQ.trim()}”
        </p>
      ) : null}

      {(() => {
        function renderWarrantyItem(w: Warranty) {
          const st = normalizeStatus(String(w.status));
          const tone =
            st === "approved"
              ? "done"
              : st === "not_warranty"
                ? "done"
                : st === "rejected"
                  ? "urgent"
                  : w.urgent
                    ? "urgent"
                    : w.overdue
                      ? "overdue"
                      : undefined;
          const ageLabel = (() => {
            if (!isOpenStatus(st)) return "";
            if (st === "dropped_off") {
              return ` · ${w.days_open}d${w.urgent ? "!" : w.overdue ? " aging" : ""}`;
            }
            const wd = w.working_days_since_submit ?? 0;
            if (wd >= 3) return ` · ${wd} working days since submit — needs approval`;
            if (wd > 0) return ` · submitted ${wd} working day${wd === 1 ? "" : "s"} ago`;
            return " · submitted (quiet until 3 working days)";
          })();
          return (
            <LogItem
              key={w.id}
              tone={tone}
              defaultOpen={false}
              summary={
                <>
                  <strong className="warranty-log">{w.log_number}</strong>
                  <span className={`log-item-badge warranty-status-${st}`}>
                    {STATUS_LABEL[st] || st}
                  </span>
                  <span className="log-item-meta">
                    {w.part_name}
                    {ageLabel}
                  </span>
                  <span className="warranty-summary-facts">
                    <span className="warranty-fact">
                      <span className="warranty-fact-label">Address</span>{" "}
                      {w.service_address?.trim() || (
                        <em className="warranty-fact-missing">not set</em>
                      )}
                    </span>
                    <span className="warranty-fact">
                      <span className="warranty-fact-label">Vendor</span>{" "}
                      {w.vendor_name?.trim() || (
                        <em className="warranty-fact-missing">not set</em>
                      )}
                    </span>
                  </span>
                </>
              }
            >
              <div className="warranty-key-facts">
                <div className="warranty-key-fact">
                  <span className="warranty-fact-label">Job address</span>
                  <strong>{w.service_address?.trim() || "—"}</strong>
                </div>
                <div className="warranty-key-fact">
                  <span className="warranty-fact-label">Vendor claim submitted to</span>
                  <strong>{w.vendor_name?.trim() || "—"}</strong>
                </div>
                {w.customer_name?.trim() ? (
                  <div className="warranty-key-fact">
                    <span className="warranty-fact-label">Customer</span>
                    <strong>{w.customer_name.trim()}</strong>
                  </div>
                ) : null}
              </div>
              <div className="warranty-meta muted">
                {w.part_code ? `Part ${w.part_code} · ` : ""}
                {w.model_number ? `Unit model ${w.model_number}` : ""}
                {w.serial_number ? ` · Unit S/N ${w.serial_number}` : ""}
              </div>

              <div className="warranty-status-notes">
                <div className="warranty-status-notes-label">Status notes</div>
                {w.notes?.trim() ? (
                  <pre className="warranty-status-notes-body">{w.notes.trim()}</pre>
                ) : (
                  <p className="muted warranty-status-notes-empty">
                    No updates yet. Add a note so the team knows this claim is being worked
                    (vendor help, waiting on RMA, etc.).
                  </p>
                )}
                {(canProcess ||
                  (w.dropped_off_by_user_id != null &&
                    w.dropped_off_by_user_id === user?.id)) && (
                  <div className="warranty-status-notes-add">
                    <label>
                      Add update
                      <textarea
                        rows={2}
                        value={noteDraftFor(w.id)}
                        onChange={(e) =>
                          setNoteDraft((p) => ({ ...p, [w.id]: e.target.value }))
                        }
                        placeholder="e.g. Working with Lennox on this claim — waiting for them to issue RMA"
                        disabled={busy}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={busy || !noteDraftFor(w.id).trim()}
                      onClick={() => void addStatusNote(w)}
                    >
                      Save status note
                    </button>
                  </div>
                )}
              </div>
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
                      Unit nameplate · tap to enlarge
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
                  ? ` · ${
                      st === "rejected"
                        ? "rejected"
                        : st === "approved"
                          ? "approved"
                          : st === "not_warranty"
                            ? "not warranty"
                            : "closed"
                    } ${w.processed_at.replace("T", " ").slice(0, 16)}`
                  : ""}
                {w.processed_by_name ? ` by ${w.processed_by_name}` : ""}
              </div>
              {canProcess && isOpenStatus(st) && (
                  <div className="warranty-vendor-fields">
                    <label className="span-2">
                      Job address
                      <input
                        value={draftFor(w).address}
                        onChange={(e) => patchDraft(w.id, w, { address: e.target.value })}
                        placeholder="e.g. 5804 S Oso Parkway"
                        autoComplete="street-address"
                      />
                    </label>
                    <label className="span-2">
                      Vendor (claim submitted to)
                      <input
                        value={draftFor(w).vendor}
                        onChange={(e) => patchDraft(w.id, w, { vendor: e.target.value })}
                        placeholder="e.g. Lennox, Carrier, Johnstone"
                        autoComplete="organization"
                      />
                    </label>
                    {(st === "return_to_vendor" ||
                      st === "delivered" ||
                      st === "claim_submitted") && (
                      <>
                        <label>
                          RMA #
                          <input
                            value={draftFor(w).rma}
                            onChange={(e) => patchDraft(w.id, w, { rma: e.target.value })}
                            placeholder="Vendor RMA"
                          />
                        </label>
                        <label>
                          Tracking #
                          <input
                            value={draftFor(w).tracking}
                            onChange={(e) => patchDraft(w.id, w, { tracking: e.target.value })}
                            placeholder="Shipment tracking"
                          />
                        </label>
                        <label>
                          Credit $
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={draftFor(w).credit}
                            onChange={(e) => patchDraft(w.id, w, { credit: e.target.value })}
                            placeholder="0.00"
                          />
                        </label>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={busy}
                      onClick={() => void saveVendorDetails(w)}
                    >
                      Save address &amp; vendor
                    </button>
                  </div>
                )}
              {(w.rma_number || w.tracking_number || w.credit_amount != null) && (
                <div className="muted" style={{ fontSize: "0.82rem" }}>
                  {w.rma_number ? `RMA ${w.rma_number}` : ""}
                  {w.tracking_number ? ` · Track ${w.tracking_number}` : ""}
                  {w.credit_amount != null ? ` · Credit $${Number(w.credit_amount).toFixed(2)}` : ""}
                </div>
              )}
              {canProcess && isOpenStatus(st) && (
                <div className="log-item-actions warranty-actions">
                  {st === "dropped_off" && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => void setStatus(w.id, "claim_submitted")}
                    >
                      Claim submitted
                    </button>
                  )}
                  {(st === "dropped_off" || st === "claim_submitted") && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => void setStatus(w.id, "return_to_vendor")}
                    >
                      Return to vendor
                    </button>
                  )}
                  {st === "return_to_vendor" && (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => void setStatus(w.id, "delivered")}
                    >
                      Delivered
                    </button>
                  )}
                  {/* Credit outcome closes the claim — after claim or vendor return */}
                  {(st === "claim_submitted" ||
                    st === "return_to_vendor" ||
                    st === "delivered") && (
                    <>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => void setStatus(w.id, "approved")}
                      >
                        Approved
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => void setStatus(w.id, "rejected")}
                      >
                        Rejected
                      </button>
                    </>
                  )}
                  {/* Not a claim outcome — shelves, another job, etc. No reason required. */}
                  <button
                    type="button"
                    className="btn ghost warranty-not-warranty-btn"
                    disabled={busy}
                    title="Take this off the open warranty list (not approved/rejected — no reason required)"
                    onClick={() => void markNotWarranty(w)}
                  >
                    Remove from open list
                  </button>
                </div>
              )}
            </LogItem>
          );
        }

        function section(
          title: string,
          hint: string,
          rows: Warranty[],
          opts?: { emptyOk?: boolean }
        ): ReactNode {
          if (!rows.length && !opts?.emptyOk) return null;
          return (
            <section className="warranty-stage" key={title}>
              <div className="warranty-stage-head">
                <h2 className="warranty-stage-title">
                  {title}
                  <span className="warranty-stage-count">{rows.length}</span>
                </h2>
                <p className="muted warranty-stage-hint">{hint}</p>
              </div>
              {rows.length ? (
                <LogList className="warranty-list">{rows.map(renderWarrantyItem)}</LogList>
              ) : (
                <p className="muted warranty-stage-empty">None</p>
              )}
            </section>
          );
        }

        if (!list.length) {
          return (
            <LogList className="warranty-list" empty="No warranties in this filter.">
              {[]}
            </LogList>
          );
        }

        if (filter === "open" && !searchQ.trim()) {
          return (
            <div className="warranty-stages">
              {section(
                "1 · Dropped off",
                "Parts at the shop — file the vendor claim, then mark Claim submitted.",
                sections.dropped,
                { emptyOk: true }
              )}
              {section(
                "2 · Claim submitted",
                "Your part is done until 3 working days pass — then approve or reject the credit.",
                sections.submitted,
                { emptyOk: true }
              )}
              {section(
                "3 · Waiting on vendor",
                "Returned / delivered to vendor — still open until approved or rejected.",
                sections.vendor,
                { emptyOk: true }
              )}
            </div>
          );
        }

        if (filter === "decided" && !searchQ.trim()) {
          return (
            <div className="warranty-stages">
              {section("Approved", "Credit approved — closed.", sections.approved, {
                emptyOk: true,
              })}
              {section("Rejected", "Claim rejected — closed.", sections.rejected, {
                emptyOk: true,
              })}
              {section(
                "Removed · not a claim",
                "Taken off the open list (shelves / another job).",
                sections.other,
                { emptyOk: true }
              )}
            </div>
          );
        }

        if (filter === "all" && !searchQ.trim()) {
          return (
            <div className="warranty-stages">
              {section("Dropped off", "Needs claim filed.", sections.dropped)}
              {section(
                "Claim submitted",
                "Quiet until 3 working days, then approval.",
                sections.submitted
              )}
              {section("Waiting on vendor", "Return / delivered.", sections.vendor)}
              {section("Approved", "Closed.", sections.approved)}
              {section("Rejected", "Closed.", sections.rejected)}
              {section("Other closed", "Not a warranty claim.", sections.other)}
            </div>
          );
        }

        // Vendor tab or search — flat list
        return (
          <LogList className="warranty-list" empty="No warranties in this filter.">
            {list.map(renderWarrantyItem)}
          </LogList>
        );
      })()}
    </div>
  );
}
