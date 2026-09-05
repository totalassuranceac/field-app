import { FormEvent, useEffect, useMemo, useState } from "react";
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
 * Shop piles:
 * File (dropped_off, not parked) → Hold (claim_submitted, waiting credit)
 * Return (return_to_vendor / delivered) · Parked · Closed (approved + rejected)
 * Solar Supply closeout = invoice deleted (Approved $0). Never scrap Solar.
 */
type WStatus =
  | "dropped_off"
  | "claim_submitted"
  | "return_to_vendor"
  | "delivered"
  | "approved"
  | "rejected"
  | "not_warranty";

type PileFilter = "file" | "hold" | "return" | "parked" | "closed";

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
  old_compressor_photo_key?: string | null;
  new_compressor_photo_key?: string | null;
  old_compressor_serial?: string | null;
  new_compressor_serial?: string | null;
  compressor_seals_ok?: number | null;
  rma_number?: string | null;
  credit_amount?: number | null;
  tracking_number?: string | null;
  parked?: number | null;
  parked_reason?: string | null;
  days_open: number;
  working_days_since_submit?: number;
  needs_attention?: boolean;
  overdue?: boolean;
  urgent?: boolean;
  claim_submitted_by_user_id?: number | null;
  claim_submitted_by_name?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  dropped_off: "File",
  claim_submitted: "Hold · waiting on vendor",
  return_to_vendor: "Return to vendor",
  delivered: "Return · delivered",
  approved: "Approved",
  rejected: "Rejected",
  not_warranty: "Removed · not a claim",
  // legacy
  processed: "Approved",
  cancelled: "Rejected",
  sent_to_job: "Removed · not a claim",
};

function normVendor(s: string | null | undefined): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[.,'"_/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSolarSupply(name: string | null | undefined): boolean {
  const n = normVendor(name);
  if (!n) return false;
  return n === "solar" || n === "solar supply" || n.startsWith("solar supply") || /\bsolar\s+supply\b/.test(n);
}

function isJohnstone(name: string | null | undefined): boolean {
  const n = normVendor(name);
  if (!n) return false;
  return n === "johnstone" || n.startsWith("johnstone ") || /\bjohnstone\b/.test(n);
}

/** Short street for warehouse walk sheet. */
function shortStreet(addr: string | null | undefined): string {
  const raw = String(addr || "").trim();
  if (!raw) return "—";
  return (raw.split(/[\n,]/)[0] || raw).trim().slice(0, 60);
}

function notesSuggestReturn(notes: string | null | undefined): boolean {
  const n = String(notes || "").toLowerCase();
  if (!n) return false;
  return (
    /\breturn\b/.test(n) ||
    /\bsend[\s-]?back\b/.test(n) ||
    /\bsend it back\b/.test(n) ||
    /\bdelivered for credit\b/.test(n) ||
    /\btake back\b/.test(n) ||
    /\bfor credit\b/.test(n)
  );
}

/** Sort key so W0826-004 < W0826-014 < W0926-001 */
function logNumberSortKey(log: string | null | undefined): string {
  const raw = String(log || "").trim().toUpperCase();
  const m = raw.match(/^W?(\d{2})(\d{2})-?(\d+)$/i) || raw.match(/^W(\d+)-(\d+)$/i);
  if (m && m.length >= 4 && m[3] != null) {
    // WMMYY-NNN style: year-month + seq
    return `${m[1]}${m[2]}-${String(m[3]).padStart(4, "0")}`;
  }
  if (m && m.length >= 3) {
    return `${String(m[1]).padStart(4, "0")}-${String(m[2]).padStart(4, "0")}`;
  }
  return raw;
}

/** Filed? No = File pile / not submitted. Yes = Hold or Closed (claim already in). */
function filedLabel(w: Warranty): "Yes" | "No" {
  const st = normalizeStatus(String(w.status));
  if (st === "dropped_off") return "No";
  if (st === "claim_submitted" || st === "approved" || st === "rejected") return "Yes";
  // Return pile: past drop-off into send-back workflow
  if (st === "return_to_vendor" || st === "delivered") return "Yes";
  return "No";
}

/**
 * Warehouse box action.
 * SAVE = File only (not filed) / Parked.
 * HOLD = claim submitted waiting credit, or rejected (filed, no toss).
 * TOSS = approved (credit $ not required).
 * RETURN = Return pile / Johnstone / Solar / send-back notes.
 */
function boxDisposition(w: Warranty): "TOSS" | "RETURN" | "SAVE" | "HOLD" {
  const st = normalizeStatus(String(w.status));
  const parked = !!w.parked;

  // Return first — never toss send-backs
  if (st === "return_to_vendor" || st === "delivered") return "RETURN";
  if (isJohnstone(w.vendor_name) || isSolarSupply(w.vendor_name)) return "RETURN";
  if (notesSuggestReturn(w.notes)) return "RETURN";

  if (parked) return "SAVE";
  if (st === "dropped_off") return "SAVE";
  if (st === "claim_submitted") return "HOLD";
  if (st === "rejected") return "HOLD";
  if (st === "approved") return "TOSS";
  return "SAVE";
}

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
  const [filter, setFilter] = useState<PileFilter>("file");
  const [searchQ, setSearchQ] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  /** Process roles: form collapsed so File list is visible without long scroll */
  const [showDropoffForm, setShowDropoffForm] = useState(() => !canProcess);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxLabel, setLightboxLabel] = useState("");
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
    () => suggestWarrantyParts(partName, learnedPartNames, 8),
    [partName, learnedPartNames]
  );
  const [ocrHints, setOcrHints] = useState<OcrHints | null>(null);
  /** After drop-off: show log # to write on the box */
  const [writeOnBox, setWriteOnBox] = useState<string | null>(null);
  /** Print sheet: last 10 Closed claims for warehouse box pull */
  const [processedPrintRows, setProcessedPrintRows] = useState<Warranty[]>([]);
  const [processedPrintBusy, setProcessedPrintBusy] = useState(false);

  async function load() {
    const params = new URLSearchParams();
    params.set("status", filter);
    if (searchQ.trim()) params.set("q", searchQ.trim());
    const qs = params.toString();
    const d = await api<{
      warranties: Warranty[];
      attention_count?: number;
      file_count?: number;
      open_count?: number;
    }>(`/warranties${qs ? `?${qs}` : ""}`);
    setList(d.warranties || []);
    if (typeof d.file_count === "number") setAttentionCount(d.file_count);
    else if (typeof d.attention_count === "number") setAttentionCount(d.attention_count);
  }

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
    if (isSolarSupply(w.vendor_name)) {
      setError("Never scrap Solar Supply parts — use invoice deleted on Return.");
      return;
    }
    const st = normalizeStatus(String(w.status));
    if (st === "claim_submitted") {
      setError(
        "Hold = waiting on the vendor — do not scrap. If they ask for a return for credit, tap Return to vendor."
      );
      return;
    }
    if (st === "return_to_vendor" || st === "delivered") {
      setError("Return pile — do not scrap. Solar uses invoice deleted; Johnstone is counter return only.");
      return;
    }
    if (st === "approved" && (w.credit_amount == null || !Number.isFinite(Number(w.credit_amount)))) {
      setError("Enter credit $ on the card before completing an approved claim.");
      return;
    }
    if (
      !window.confirm(
        `Remove ${w.log_number} from open warranties?\n\nOnly after Approved with credit (not returns / not Solar).`
      )
    ) {
      return;
    }
    await setStatus(w.id, "not_warranty");
  }

  async function parkClaim(w: Warranty) {
    const why = window.prompt(
      `Park ${w.log_number}?\n\nWhy? (required — e.g. new purchase, do not file)`
    );
    if (why == null) return;
    if (why.trim().length < 3) {
      setError("Park needs a short why-note.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/warranties/${w.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parked: true, parked_reason: why.trim() }),
      });
      setOk(`Parked ${w.log_number} — off File badge`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not park");
    } finally {
      setBusy(false);
    }
  }

  async function unparkClaim(w: Warranty) {
    setBusy(true);
    setError("");
    try {
      await api(`/warranties/${w.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parked: false }),
      });
      setOk(`Unparked ${w.log_number} — back on File when status is dropped off`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unpark");
    } finally {
      setBusy(false);
    }
  }

  async function solarInvoiceDeleted(w: Warranty) {
    if (!isSolarSupply(w.vendor_name)) return;
    if (
      !window.confirm(
        `${w.log_number}: Solar received the return and deleted the invoice?\n\nThis sets Approved with credit $0. Never scrap Solar parts.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/warranties/${w.id}`, {
        method: "PATCH",
        body: JSON.stringify({ solar_invoice_deleted: true }),
      });
      setOk(`${w.log_number} · Solar invoice deleted (Approved $0)`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close Solar return");
    } finally {
      setBusy(false);
    }
  }

  function openLightbox(src: string, label: string) {
    setLightboxSrc(src);
    setLightboxLabel(label);
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

  async function printWarehouseList() {
    setProcessedPrintBusy(true);
    setError("");
    try {
      const [openRes, closedRes] = await Promise.all([
        api<{ warranties: Warranty[] }>("/warranties?status=open"),
        api<{ warranties: Warranty[] }>("/warranties?status=closed"),
      ]);

      // File + Hold + Return (exclude Parked — stay on shelf intentionally)
      const openRows = (openRes.warranties || []).filter((w) => {
        if (w.parked) return false;
        const st = normalizeStatus(String(w.status));
        return (
          st === "dropped_off" ||
          st === "claim_submitted" ||
          st === "return_to_vendor" ||
          st === "delivered"
        );
      });

      // Newest Closed first, cap 10 so the sheet stays short
      const closedRows = (closedRes.warranties || [])
        .filter((w) => {
          const st = normalizeStatus(String(w.status));
          return st === "approved" || st === "rejected";
        })
        .sort((a, b) =>
          String(b.processed_at || "").localeCompare(String(a.processed_at || ""))
        )
        .slice(0, 10);

      const byId = new Map<number, Warranty>();
      for (const w of [...openRows, ...closedRows]) byId.set(w.id, w);
      const sheet = [...byId.values()].sort((a, b) =>
        logNumberSortKey(a.log_number).localeCompare(logNumberSortKey(b.log_number))
      );

      if (!sheet.length) {
        setError("No warranty boxes to print (File / Hold / Return / recent Closed).");
        return;
      }
      setProcessedPrintRows(sheet);
      document.body.classList.add("print-warranty-processed");
      window.setTimeout(() => window.print(), 80);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load warranties for print");
    } finally {
      setProcessedPrintBusy(false);
    }
  }

  useEffect(() => {
    function onAfterPrint() {
      document.body.classList.remove("print-warranty-processed");
    }
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      window.removeEventListener("afterprint", onAfterPrint);
      document.body.classList.remove("print-warranty-processed");
    };
  }, []);

  const canPrintProcessed =
    user?.role === "admin" || user?.role === "office" || user?.role === "warehouse";

  return (
    <div className="warranty-page">
      <div className="page-header no-print">
        <div>
          <h1>Warranties</h1>
          <p>
            Piles: <strong>File</strong> (file the claim) · <strong>Hold</strong> (waiting on
            vendor — do not scrap) · <strong>Return</strong> (Johnstone / Solar / send-back) ·{" "}
            <strong>Parked</strong> (do not file) · <strong>Closed</strong> (approved + rejected).
            Badge / Home count = File only
            {attentionCount > 0 ? ` · ${attentionCount} to file` : ""}. ACES = email Victoria (never
            portal); Goodman/Daikin = Warranty Express; Lennox = LennoxPros; Ferguson = Ferguson.com.
          </p>
        </div>
        {canPrintProcessed ? (
          <div className="toolbar">
            <button
              type="button"
              className="btn secondary"
              disabled={processedPrintBusy}
              onClick={() => void printWarehouseList()}
              title="Sorted warehouse walk sheet — File, Hold, Return + recent Closed"
            >
              {processedPrintBusy ? "Loading…" : "Print warehouse list"}
            </button>
          </div>
        ) : null}
      </div>
      {lightboxSrc ? (
        <div
          className="warranty-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightboxLabel || "Photo"}
          onClick={() => setLightboxSrc(null)}
        >
          <img src={lightboxSrc} alt={lightboxLabel || "Warranty photo"} />
          <span className="warranty-lightbox-hint">Tap to close</span>
        </div>
      ) : null}
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

      {canProcess ? (
        <div className="warranty-dropoff-toggle no-print">
          <button
            type="button"
            className="btn secondary"
            onClick={() => setShowDropoffForm((v) => !v)}
          >
            {showDropoffForm ? "Hide drop-off form" : "New drop-off"}
          </button>
        </div>
      ) : null}

      {(showDropoffForm || !canProcess) && (
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
                  onBlur={() => window.setTimeout(() => setPartSuggestOpen(false), 200)}
                  required
                  placeholder="Keep typing — e.g. motor → Blower motor"
                  autoComplete="off"
                  aria-autocomplete="list"
                  aria-expanded={partSuggestOpen && partSuggestions.length > 0}
                />
                {partSuggestOpen && partSuggestions.length > 0 ? (
                  <>
                    <p className="warranty-part-suggest-hint">
                      Suggestions — tap one or keep typing (not required)
                    </p>
                    <ul className="warranty-part-suggest" role="listbox">
                      {partSuggestions.map((s) => (
                        <li key={s} role="option">
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
                  </>
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
                  placeholder="e.g. Johnstone, Solar Supply, ACES"
                />
                {isJohnstone(vendor) || isSolarSupply(vendor) ? (
                  <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 500 }}>
                    Defaults to <strong>Return</strong> pile (not File)
                    {isSolarSupply(vendor) ? " · Solar closeout = invoice deleted" : ""}.
                  </span>
                ) : null}
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
      )}

      <div className="warranty-filters no-print">
        {(
          [
            ["file", "File"],
            ["hold", "Hold"],
            ["return", "Return"],
            ["parked", "Parked"],
            ["closed", "Closed"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`inv-tab${filter === id ? " active" : ""}`}
            onClick={() => setFilter(id)}
          >
            {label}
            {id === "file" && attentionCount > 0 ? ` (${attentionCount})` : ""}
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
          const parked = !!w.parked;
          const solar = isSolarSupply(w.vendor_name);
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
            if (parked) return w.parked_reason ? ` · parked: ${w.parked_reason}` : " · parked";
            if (!isOpenStatus(st)) return "";
            if (st === "dropped_off") {
              return ` · ${w.days_open}d${w.urgent ? "!" : w.overdue ? " aging" : ""}`;
            }
            if (st === "claim_submitted") {
              const wd = w.working_days_since_submit ?? 0;
              if (wd >= 3) return ` · ${wd} working days — waiting on vendor, do not scrap`;
              if (wd > 0) return ` · Hold ${wd} working day${wd === 1 ? "" : "s"} — do not scrap`;
              return " · Hold — waiting on vendor, do not scrap";
            }
            return "";
          })();
          const canScrapComplete =
            st === "approved" &&
            w.credit_amount != null &&
            Number.isFinite(Number(w.credit_amount)) &&
            !solar;
          return (
            <LogItem
              key={w.id}
              tone={tone}
              defaultOpen={false}
              summary={
                <>
                  <strong className="warranty-log">{w.log_number}</strong>
                  <span className={`log-item-badge warranty-status-${st}`}>
                    {parked ? "Parked" : STATUS_LABEL[st] || st}
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
                {([
                  [w.nameplate_photo_key, "Unit nameplate"],
                  [w.dropoff_photo_key, "Drop-off location"],
                  [w.old_compressor_photo_key, "Old compressor S/N"],
                  [w.new_compressor_photo_key, "New compressor S/N"],
                ] as const).map(([key, label]) =>
                  key ? (
                    <button
                      key={label}
                      type="button"
                      className="warranty-dropoff-photo warranty-photo-btn"
                      onClick={() =>
                        openLightbox(`/api/uploads/${encodeURIComponent(key)}`, label)
                      }
                    >
                      <img
                        src={`/api/uploads/${encodeURIComponent(key)}`}
                        alt={`${label} for ${w.part_name}`}
                      />
                      <span className="muted" style={{ fontSize: "0.75rem" }}>
                        {label} · tap to enlarge
                      </span>
                    </button>
                  ) : null
                )}
              </div>
              {(w.old_compressor_serial || w.new_compressor_serial || w.compressor_seals_ok) && (
                <div className="muted" style={{ fontSize: "0.82rem" }}>
                  {w.compressor_seals_ok ? "Compressor seals confirmed" : null}
                  {w.old_compressor_serial
                    ? ` · Old S/N ${w.old_compressor_serial}`
                    : null}
                  {w.new_compressor_serial
                    ? ` · New S/N ${w.new_compressor_serial}`
                    : null}
                </div>
              )}
              {parked && w.parked_reason ? (
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  <strong>Parked:</strong> {w.parked_reason}
                </div>
              ) : null}
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
                  {w.credit_amount != null ? (
                    <>
                      {" · "}
                      <strong>Credit ${Number(w.credit_amount).toFixed(2)}</strong>
                    </>
                  ) : null}
                </div>
              )}
              {filter === "closed" && w.credit_amount != null ? (
                <div className="warranty-closed-credit">
                  Credit <strong>${Number(w.credit_amount).toFixed(2)}</strong>
                </div>
              ) : null}
              {canProcess && (
                <div className="log-item-actions warranty-actions">
                  {parked ? (
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => void unparkClaim(w)}
                    >
                      Unpark
                    </button>
                  ) : null}
                  {!parked && st === "dropped_off" && (
                    <>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => void setStatus(w.id, "claim_submitted")}
                      >
                        Claim submitted
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => void setStatus(w.id, "return_to_vendor")}
                      >
                        Return to vendor
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={busy}
                        onClick={() => void parkClaim(w)}
                      >
                        Park
                      </button>
                    </>
                  )}
                  {!parked && st === "claim_submitted" && (
                    <>
                      <span className="muted warranty-hold-banner">
                        Waiting on vendor — do not scrap
                      </span>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => void setStatus(w.id, "return_to_vendor")}
                      >
                        Return to vendor
                      </button>
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
                  {!parked && (st === "return_to_vendor" || st === "delivered") && (
                    <>
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
                      {solar ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => void solarInvoiceDeleted(w)}
                        >
                          Solar received return — invoice deleted
                        </button>
                      ) : (
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
                    </>
                  )}
                  {canScrapComplete ? (
                    <button
                      type="button"
                      className="btn ghost warranty-not-warranty-btn"
                      disabled={busy}
                      title="Complete after Approved with credit (not Solar / not returns)"
                      onClick={() => void markNotWarranty(w)}
                    >
                      Complete / scrap
                    </button>
                  ) : null}
                </div>
              )}
            </LogItem>
          );
        }

        const emptyMsg =
          filter === "file"
            ? "File pile clear — nothing waiting to file."
            : filter === "hold"
              ? "No claims waiting on the vendor."
              : filter === "return"
                ? "No returns in progress."
                : filter === "parked"
                  ? "Nothing parked."
                  : "No closed claims yet.";
        // Closed: Approved first, then Rejected (server also sorts; keep client stable)
        const rows =
          filter === "closed"
            ? [...list].sort((a, b) => {
                const sa = normalizeStatus(String(a.status));
                const sb = normalizeStatus(String(b.status));
                const rank = (s: WStatus) => (s === "approved" ? 0 : s === "rejected" ? 1 : 2);
                const d = rank(sa) - rank(sb);
                if (d !== 0) return d;
                return String(b.processed_at || "").localeCompare(String(a.processed_at || ""));
              })
            : list;
        return (
          <LogList className="warranty-list no-print" empty={emptyMsg}>
            {rows.map(renderWarrantyItem)}
          </LogList>
        );
      })()}

      {/* Print-only: warehouse walk list sorted by log # */}
      <div className="warranty-processed-print" aria-hidden={processedPrintRows.length === 0}>
        <header className="warranty-processed-print-head">
          <h1>Total Assurance — Warranty boxes</h1>
          <p className="warranty-processed-print-meta">
            Printed{" "}
            {new Date().toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
          <p className="warranty-processed-print-warn">
            SAVE = not filed. HOLD = submitted, waiting credit. RETURN = send back. TOSS =
            approved, box can go.
          </p>
        </header>
        {!processedPrintRows.length ? (
          <p className="muted">Nothing loaded for print.</p>
        ) : (
          <table className="warranty-processed-print-table">
            <thead>
              <tr>
                <th>Log #</th>
                <th>Street</th>
                <th>Part</th>
                <th>Vendor</th>
                <th>Filed?</th>
                <th>Box</th>
              </tr>
            </thead>
            <tbody>
              {processedPrintRows.map((w) => {
                const action = boxDisposition(w);
                return (
                  <tr key={w.id} className={`warranty-box-action-${action.toLowerCase()}`}>
                    <td className="warranty-print-log">{w.log_number}</td>
                    <td>{shortStreet(w.service_address)}</td>
                    <td>{w.part_name || "—"}</td>
                    <td>{w.vendor_name?.trim() || "—"}</td>
                    <td className="warranty-print-filed">{filedLabel(w)}</td>
                    <td className="warranty-print-action">
                      <strong>{action}</strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="warranty-processed-print-legend">
          Sorted by log # · File + Hold + Return + up to 10 newest Closed · Never TOSS File / HOLD /
          Parked / Return / Johnstone / Solar
        </p>
      </div>
    </div>
  );
}
