import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { CollapsibleSection, LogItem, LogList } from "../components/CollapsibleLog";
import { PhotoCapture, PHOTO_TIPS } from "../components/PhotoCapture";
import { VehicleQuickPick, type VehicleMatch } from "../components/VehicleQuickPick";
import {
  applyOcrLearning,
  clearOcrHintsCache,
  formatGallonsDisplay,
  loadOcrHints,
  ocrReceiptImage,
  warmOcrEngine,
  type OcrHints,
  type ReceiptParseResult,
} from "../receiptOcr";

/** Snapshot of what OCR filled in (before the user edits) — used for learning. */
type OcrSnapshot = {
  raw_text: string;
  fuel_date?: string | null;
  fuel_time?: string | null;
  gallons?: number | null;
  total_cost?: number | null;
  store_number?: string | null;
  card_last4?: string | null;
};

interface Employee {
  id: number;
  name: string;
  /** Most-used gas card last-4 from their fuel history */
  gas_card_last4?: string | null;
}
interface Vehicle extends VehicleMatch {
  /** Server: this is the logged-in tech’s usual unit */
  is_my_default?: boolean;
  driver_employee_id?: number | null;
  driver_name?: string | null;
}
interface FuelEntry {
  id: number;
  vehicle_id?: number;
  fuel_date: string;
  fuel_time?: string | null;
  store_number?: string | null;
  card_last4?: string | null;
  unit_number: string;
  employee_name: string;
  odometer: number;
  gallons: number | null;
  total_cost: number | null;
  station_notes: string | null;
  entered_by_name: string;
  receipt_key: string | null;
}
type OcrField = "fuel_date" | "fuel_time" | "gallons" | "total_cost" | "store_number" | "card_last4";
type OcrSource = Partial<Record<OcrField, "scan" | "manual" | "missing" | "expected" | "mismatch">>;

/** Shrink phone camera photos so they save without R2 (D1 blob ~900KB limit). */
async function compressReceiptForUpload(file: File, maxBytes = 850_000): Promise<File> {
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
    return new File([blob], "receipt.jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function FuelPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const canReviewReceipts = can(user, "editFuel");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [entries, setEntries] = useState<FuelEntry[]>([]);
  const [totals, setTotals] = useState<{ gallons: number; total_cost: number; count: number } | null>(
    null
  );
  /** Filter recent entries by vehicle id ("" = all units) */
  const [unitFilter, setUnitFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Admin/office: open a recent entry to view receipt + jump to verify/edit */
  const [inspectId, setInspectId] = useState<number | null>(null);
  const [success, setSuccess] = useState<{
    unit: string;
    odometer: number;
    gallons: number | null;
    total: number | null;
    alertCount: number;
    learned: number;
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [ocrNote, setOcrNote] = useState("");
  const [ocrSource, setOcrSource] = useState<OcrSource>({});
  const [lastOcr, setLastOcr] = useState<OcrSnapshot | null>(null);
  const [needsRetake, setNeedsRetake] = useState(false);
  const [showReceiptDetails, setShowReceiptDetails] = useState(false);
  const [showPreviewFull, setShowPreviewFull] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const [employeeId, setEmployeeId] = useState("");
  const [crewNote, setCrewNote] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [odometer, setOdometer] = useState("");
  const [gallons, setGallons] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [fuelDate, setFuelDate] = useState(new Date().toISOString().slice(0, 10));
  const [fuelTime, setFuelTime] = useState("");
  const [storeNumber, setStoreNumber] = useState("");
  const [cardLast4, setCardLast4] = useState("");
  const [cardCheckNote, setCardCheckNote] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  /** Receipt is prepay / pre-auth — rare; require short reason */
  const [isPrepay, setIsPrepay] = useState(false);
  const [prepayReason, setPrepayReason] = useState("");
  /** Only when odometer looks fake (0, 1234, …) */
  const [odoExplain, setOdoExplain] = useState("");

  const isDriver = user?.role === "driver";

  /** Obvious placeholder / junk odometer readings — not normal fleet miles */
  function isSuspiciousOdometer(raw: string): boolean {
    const s = raw.trim();
    if (!s) return false;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return true;
    if (n === 0) return true;
    const digits = s.replace(/\D/g, "");
    if (!digits.length) return true;
    if (/^0+$/.test(digits)) return true;
    const placeholders = new Set([
      "1",
      "12",
      "123",
      "1234",
      "12345",
      "123456",
      "1234567",
      "1111",
      "11111",
      "2222",
      "0000",
      "9999",
      "99999",
      "1010",
      "1212",
      "0101",
    ]);
    if (placeholders.has(digits)) return true;
    // Same digit repeated (1111, 55555)
    if (digits.length >= 3 && /^(\d)\1+$/.test(digits)) return true;
    // Pure ascending 1234 / 2345 / 012345 (length 3–6 only — real high miles stay alone)
    if (digits.length >= 3 && digits.length <= 6) {
      let pureAsc = true;
      for (let i = 1; i < digits.length; i++) {
        if (Number(digits[i]) !== Number(digits[i - 1]) + 1) {
          pureAsc = false;
          break;
        }
      }
      if (pureAsc) return true;
    }
    return false;
  }

  const odoLooksFake = isSuspiciousOdometer(odometer);

  function expectedCardFor(empId: string): string | null {
    if (!empId) return null;
    const emp = employees.find((e) => String(e.id) === empId);
    const c = emp?.gas_card_last4?.replace(/\D/g, "").slice(-4);
    return c && c.length === 4 ? c : null;
  }

  /** Compare receipt last-4 to this driver's usual gas card. */
  function applyCardVerification(scanned: string | null | undefined, empId: string) {
    const expected = expectedCardFor(empId);
    const got = scanned?.replace(/\D/g, "").slice(-4) || "";
    if (got && expected) {
      if (got === expected) {
        setCardLast4(got);
        setCardCheckNote(`Card ••${got} matches this driver’s gas card.`);
        return "scan" as const;
      }
      setCardLast4(got);
      setCardCheckNote(
        `Card mismatch: receipt shows ••${got}, but ${
          employees.find((e) => String(e.id) === empId)?.name || "this driver"
        } usually uses ••${expected}. Check the receipt / who fueled.`
      );
      return "mismatch" as const;
    }
    if (got) {
      setCardLast4(got);
      setCardCheckNote(
        expected
          ? ""
          : `Card ••${got} from receipt (no prior card on file for this driver yet).`
      );
      return "scan" as const;
    }
    if (expected) {
      // OCR missed last-4 — pre-fill expected; driver still verifies
      setCardLast4(expected);
      setCardCheckNote(
        `Card ••${expected} filled from this driver’s usual gas card (not read clearly on photo — confirm).`
      );
      return "expected" as const;
    }
    setCardLast4("");
    setCardCheckNote("");
    return "missing" as const;
  }

  async function loadFuel(vehicleIdFilter?: string) {
    const q =
      vehicleIdFilter && vehicleIdFilter.trim()
        ? `?vehicle_id=${encodeURIComponent(vehicleIdFilter.trim())}`
        : "";
    const fuel = await api<{
      entries: FuelEntry[];
      totals: { gallons: number; total_cost: number; count: number };
    }>(`/fuel${q}`);
    setEntries(fuel.entries || []);
    setTotals(fuel.totals || null);
  }

  async function load() {
    // scope=fleet: every active van so helpers can pick another unit when covering
    const [emps, vehs] = await Promise.all([
      api<{ employees: Employee[] }>("/employees"),
      api<{
        vehicles: Vehicle[];
        default_vehicle_ids?: number[];
      }>("/vehicles?filter=active&scope=fleet"),
    ]);
    setEmployees(emps.employees);
    const list = vehs.vehicles || [];
    setVehicles(list);
    await loadFuel(unitFilter);
    if (user?.employee_id) setEmployeeId(String(user.employee_id));

    // Default to usual unit (first is_my_default / default_vehicle_ids)
    const defaults = new Set(
      (vehs.default_vehicle_ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
    );
    const preferred =
      list.find((v) => v.is_my_default) ||
      list.find((v) => defaults.has(v.id)) ||
      null;
    if (preferred) {
      // Defer crew note until vehicles state is set — apply directly
      setVehicleId(String(preferred.id));
      const driverLabel = preferred.driver_name || preferred.assigned_driver;
      if (preferred.is_my_default || defaults.has(preferred.id)) {
        setCrewNote(
          driverLabel
            ? `Your usual unit ${preferred.unit_number}${driverLabel ? ` (${driverLabel})` : ""}. Change below if you rode with someone else today.`
            : `Your usual unit ${preferred.unit_number}. Change below if you rode another van today.`
        );
      }
    }
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
    // Warm OCR while tech picks unit / waits — first photo is much faster
    void warmOcrEngine();
  }, []);

  const usualVehicles = useMemo(
    () => vehicles.filter((v) => v.is_my_default),
    [vehicles]
  );
  const otherVehicles = useMemo(
    () => vehicles.filter((v) => !v.is_my_default),
    [vehicles]
  );

  const vehiclesByUnit = useMemo(
    () =>
      [...vehicles].sort((a, b) =>
        String(a.unit_number || "").localeCompare(String(b.unit_number || ""), undefined, {
          numeric: true,
        })
      ),
    [vehicles]
  );

  const filterUnitLabel = useMemo(() => {
    if (!unitFilter) return null;
    return vehicles.find((v) => String(v.id) === unitFilter)?.unit_number || null;
  }, [unitFilter, vehicles]);

  /** When one unit is selected: gallons/cost + rough MPG from odometer gaps. */
  const unitUsage = useMemo(() => {
    if (!unitFilter || entries.length < 1) return null;
    const sorted = [...entries].sort((a, b) => {
      const d = String(a.fuel_date).localeCompare(String(b.fuel_date));
      if (d !== 0) return d;
      return a.id - b.id;
    });
    let miles = 0;
    let gallons = 0;
    let legs = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const dMiles = Number(cur.odometer) - Number(prev.odometer);
      const gal = Number(cur.gallons);
      if (
        Number.isFinite(dMiles) &&
        dMiles > 5 &&
        dMiles < 2500 &&
        Number.isFinite(gal) &&
        gal > 0
      ) {
        miles += dMiles;
        gallons += gal;
        legs += 1;
      }
    }
    const totalGal = entries.reduce((s, e) => s + (Number(e.gallons) || 0), 0);
    const totalCost = entries.reduce((s, e) => s + (Number(e.total_cost) || 0), 0);
    return {
      count: entries.length,
      gallons: totalGal,
      cost: totalCost,
      miles: legs > 0 ? miles : null,
      mpg: legs > 0 && gallons > 0 ? miles / gallons : null,
      legs,
    };
  }, [unitFilter, entries]);

  useEffect(() => {
    if (!vehicles.length) return;
    void loadFuel(unitFilter).catch((e) =>
      setError(e instanceof Error ? e.message : "Could not load fuel for that unit")
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitFilter]);

  function applyVehicleCrew(id: string) {
    setVehicleId(id);
    if (!id) {
      setCrewNote("");
      return;
    }
    const v = vehicles.find((x) => String(x.id) === id);
    if (!v) return;

    if (!(isDriver && user?.employee_id)) {
      if (v.driver_employee_id) {
        setEmployeeId(String(v.driver_employee_id));
      } else if (v.assigned_driver) {
        const n = v.assigned_driver.toLowerCase().replace(/\(.*?\)/g, "").trim();
        const hit = employees.find((e) => {
          const en = e.name.toLowerCase();
          return en === n || en.includes(n) || n.includes(en);
        });
        if (hit) setEmployeeId(String(hit.id));
      }
    }

    const driverLabel = v.driver_name || v.assigned_driver || null;
    if (v.is_my_default) {
      setCrewNote(
        driverLabel
          ? `Usual unit ${v.unit_number} — ${driverLabel}`
          : `Usual unit ${v.unit_number}`
      );
    } else if (driverLabel) {
      setCrewNote(
        `Other van today: Unit ${v.unit_number} (usually ${driverLabel}). OK if you rode with them.`
      );
    } else {
      setCrewNote(`Other van today: Unit ${v.unit_number}.`);
    }
  }

  function applyParsed(parsed: ReceiptParseResult) {
    const src: OcrSource = {};

    if (parsed.fuel_date) {
      setFuelDate(parsed.fuel_date);
      src.fuel_date = "scan";
    } else src.fuel_date = "missing";

    if (parsed.fuel_time) {
      setFuelTime(parsed.fuel_time);
      src.fuel_time = "scan";
    } else src.fuel_time = "missing";

    if (parsed.gallons != null) {
      // Keep pump thousandths: 16.290 not 16.29
      setGallons(formatGallonsDisplay(parsed.gallons));
      src.gallons = "scan";
    } else src.gallons = "missing";

    if (parsed.total_cost != null) {
      setTotalCost(Number(parsed.total_cost).toFixed(2));
      src.total_cost = "scan";
    } else src.total_cost = "missing";

    // Never accept letter-only garbage (e.g. OCR of Store # **** → "KKK")
    const storeOk =
      parsed.store_number &&
      /\d/.test(parsed.store_number) &&
      !/^(.)\1{2,}$/i.test(parsed.store_number.trim()) &&
      !/^[A-Za-z*#]+$/i.test(parsed.store_number.trim());
    if (storeOk) {
      setStoreNumber(parsed.store_number!);
      src.store_number = "scan";
    } else src.store_number = "missing";

    // Drivers have personal gas cards — verify receipt last-4 against their usual card
    src.card_last4 = applyCardVerification(parsed.card_last4, employeeId);

    // Remember what OCR thought so we can learn when the driver corrects it
    setLastOcr({
      raw_text: parsed.raw_text || "",
      fuel_date: parsed.fuel_date,
      fuel_time: parsed.fuel_time,
      gallons: parsed.gallons,
      total_cost: parsed.total_cost,
      store_number: storeOk ? parsed.store_number : null,
      card_last4: parsed.card_last4,
    });

    setOcrSource(src);
    setNeedsRetake(parsed.needs_retake);
    setIsPrepay(Boolean(parsed.is_prepay));
    if (!parsed.is_prepay) setPrepayReason("");
    // Never block save for a weak scan — photo on file is enough for records
    if (parsed.missing_core.length >= 2) {
      setShowReceiptDetails(false);
    }

    const parts: string[] = [];
    if (parsed.fuel_date) {
      parts.push(parsed.fuel_time ? `${parsed.fuel_date} ${parsed.fuel_time}` : parsed.fuel_date);
    }
    if (storeOk && parsed.store_number) parts.push(`store ${parsed.store_number}`);
    if (parsed.card_last4) parts.push(`card ••${parsed.card_last4}`);
    else if (expectedCardFor(employeeId)) parts.push(`card ••${expectedCardFor(employeeId)} (expected)`);
    if (parsed.gallons != null) parts.push(`${formatGallonsDisplay(parsed.gallons)} gal`);
    if (parsed.total_cost != null) parts.push(`$${Number(parsed.total_cost).toFixed(2)}`);

    let note = "";
    if (parsed.is_prepay) {
      note = `Prepay / pre-auth receipt: ${parts.join(" · ") || "total only"}. Please note why (we prefer pump-then-pay). Then odometer & save.`;
    } else if (parts.length) {
      note = `Read: ${parts.join(" · ")}. Tap the photo to verify, then enter odometer and save.`;
    } else {
      note =
        "Couldn’t auto-read fields — that’s OK. Tap photo to check it’s clear enough, enter odometer, and save.";
    }
    // Surface card verify/mismatch in the main scan note (not only collapsed details)
    const expected = expectedCardFor(employeeId);
    if (parsed.card_last4 && expected && parsed.card_last4 !== expected) {
      note += ` ⚠️ Card on receipt (••${parsed.card_last4}) does not match this driver’s usual card (••${expected}).`;
    } else if (parsed.card_last4 && expected && parsed.card_last4 === expected) {
      note += ` ✓ Card matches driver’s gas card.`;
    }
    setOcrNote(note);
  }

  async function handleReceipt(f: File | null) {
    setFile(f);
    setOcrNote("");
    setOcrSource({});
    setLastOcr(null);
    setNeedsRetake(false);
    setIsPrepay(false);
    setPrepayReason("");
    setShowPreviewFull(false);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
    if (!f) return;

    setScanning(true);
    try {
      // Run OCR and hints in parallel (don't wait on API before scanning)
      const [hints, rawParsed] = await Promise.all([
        loadOcrHints((path) => api<OcrHints>(path)).catch(() => null),
        ocrReceiptImage(f, null),
      ]);
      const parsed =
        hints != null
          ? { ...applyOcrLearning(rawParsed, rawParsed.raw_text || "", hints), raw_text: rawParsed.raw_text }
          : rawParsed;
      applyParsed(parsed);
    } catch (e) {
      setLastOcr(null);
      setOcrSource({
        fuel_date: "missing",
        fuel_time: "missing",
        gallons: "missing",
        total_cost: "missing",
        store_number: "missing",
        card_last4: "missing",
      });
      setNeedsRetake(true);
      setOcrNote(
        e instanceof Error
          ? `Auto-read failed (${e.message}). Photo is still fine — check it, enter odometer, and save.`
          : "Auto-read failed. Photo is still fine — check it, enter odometer, and save."
      );
    } finally {
      setScanning(false);
    }
  }

  function clearReceipt() {
    setFile(null);
    setOcrNote("");
    setOcrSource({});
    setLastOcr(null);
    setNeedsRetake(false);
    setIsPrepay(false);
    setPrepayReason("");
    setShowPreviewFull(false);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function markManual(field: OcrField) {
    setOcrSource((prev) => ({ ...prev, [field]: "manual" }));
  }

  function fieldHint(field: OcrField) {
    const s = ocrSource[field];
    if (s === "missing") {
      return (
        <span className="badge warning" style={{ marginLeft: "0.35rem", fontSize: "0.72rem" }}>
          optional fix
        </span>
      );
    }
    if (s === "mismatch") {
      return (
        <span className="badge danger" style={{ marginLeft: "0.35rem", fontSize: "0.72rem" }}>
          doesn’t match driver’s card
        </span>
      );
    }
    if (s === "expected") return <span className="muted"> (driver’s usual card)</span>;
    if (s === "scan") return <span className="muted"> (from photo)</span>;
    if (s === "manual") return <span className="muted"> (edited)</span>;
    return null;
  }

  // When driver/employee changes, re-check card vs their usual gas card
  useEffect(() => {
    if (!employeeId || !cardLast4) return;
    if (ocrSource.card_last4 === "manual") return;
    const expected = expectedCardFor(employeeId);
    if (!expected) return;
    if (cardLast4 === expected && ocrSource.card_last4 === "mismatch") {
      setOcrSource((p) => ({ ...p, card_last4: "scan" }));
      setCardCheckNote(`Card ••${cardLast4} matches this driver’s gas card.`);
    } else if (cardLast4 !== expected && ocrSource.card_last4 !== "expected") {
      setOcrSource((p) => ({ ...p, card_last4: "mismatch" }));
      setCardCheckNote(
        `Card mismatch: receipt/form has ••${cardLast4}, driver usually uses ••${expected}.`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when employee or card changes
  }, [employeeId, cardLast4]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!can(user, "logFuel")) return;

    if (!file) {
      setError("Receipt photo is required for our records. Take a picture of the receipt.");
      return;
    }
    if (!odometer.trim()) {
      setError("Enter the odometer reading — that’s the main thing we need from you.");
      return;
    }
    if (isPrepay && prepayReason.trim().length < 3) {
      setError("This looks like a prepaid receipt — briefly say why (we prefer not to prepay).");
      return;
    }
    if (isSuspiciousOdometer(odometer) && odoExplain.trim().length < 3) {
      setError("That odometer doesn’t look real (e.g. 0 or 1234) — briefly explain.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const uploadFile = await compressReceiptForUpload(file);
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("folder", "fuel-receipts");
      const up = await api<{ key: string }>("/uploads/receipt", { method: "POST", body: fd });

      // Tag notes only when these rare cases fire (searchable later)
      const noteParts: string[] = [];
      if (isPrepay) {
        noteParts.push(`PREPAY: ${prepayReason.trim()}`);
      }
      if (isSuspiciousOdometer(odometer)) {
        noteParts.push(`ODO NOTE: ${odoExplain.trim()}`);
      }
      if (notes.trim()) noteParts.push(notes.trim());
      const stationNotes = noteParts.join(" | ");

      const finalSnap = {
        fuel_date: fuelDate || null,
        fuel_time: fuelTime || null,
        gallons: gallons === "" ? null : Number(gallons),
        total_cost: totalCost === "" ? null : Number(totalCost),
        store_number: storeNumber || null,
        card_last4: cardLast4 || null,
      };

      const ocr_feedback = lastOcr
        ? {
            raw_text: lastOcr.raw_text,
            ocr: {
              fuel_date: lastOcr.fuel_date,
              fuel_time: lastOcr.fuel_time,
              gallons: lastOcr.gallons,
              total_cost: lastOcr.total_cost,
              store_number: lastOcr.store_number,
              card_last4: lastOcr.card_last4,
            },
            final: finalSnap,
          }
        : undefined;

      const unitLabel =
        vehicles.find((v) => String(v.id) === vehicleId)?.unit_number || "?";
      const odoNum = Number(odometer);
      const galNum = gallons === "" ? null : Number(gallons);
      const totNum = totalCost === "" ? null : Number(totalCost);

      const res = await api<{ entry: FuelEntry; alerts: Array<{ id?: number; message?: string }> }>(
        "/fuel",
        {
          method: "POST",
          body: JSON.stringify({
            employee_id: Number(employeeId),
            vehicle_id: Number(vehicleId),
            odometer: odoNum,
            gallons: galNum ?? undefined,
            total_cost: totNum ?? undefined,
            fuel_date: fuelDate,
            fuel_time: fuelTime || undefined,
            store_number: storeNumber || undefined,
            card_last4: cardLast4 || undefined,
            station_notes: stationNotes || undefined,
            receipt_key: up.key,
            ocr_feedback,
          }),
        }
      );

      // Count fields the driver fixed vs OCR — those teach the next scan
      let learned = 0;
      if (lastOcr) {
        clearOcrHintsCache();
        const pairs: Array<[unknown, unknown]> = [
          [lastOcr.gallons, galNum],
          [lastOcr.total_cost, totNum],
          [lastOcr.card_last4, cardLast4 || null],
          [lastOcr.store_number, storeNumber || null],
          [lastOcr.fuel_date, fuelDate || null],
          [lastOcr.fuel_time, fuelTime || null],
        ];
        for (const [a, b] of pairs) {
          const sa = a == null || a === "" ? "" : String(a);
          const sb = b == null || b === "" ? "" : String(b);
          if (sb && sa !== sb) learned++;
          else if (sb && !sa) learned++;
        }
      }

      setSuccess({
        unit: unitLabel,
        odometer: odoNum,
        gallons: galNum,
        total: totNum,
        alertCount: (res.alerts || []).length,
        learned,
      });
    } catch (err) {
      // Offline queue holds the failed step (photo or fuel save) until signal returns
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  function goHomeAfterSuccess() {
    navigate("/", { replace: true });
  }

  const scanReady = Boolean(file);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Fuel log</h1>
          <p>
            {canReviewReceipts ? (
              <>
                Log new fuel stops below. Open <strong>Recent fuel entries</strong> to view receipt
                photos, correct values, and verify so the app learns.
              </>
            ) : (
              <>
                <strong>Your job:</strong> pick the unit, photo the receipt, type the odometer. The
                app prioritizes <strong>gallons</strong> and <strong>total $</strong> from the photo
                (plus date, store, card last 4 when readable).
              </>
            )}
          </p>
        </div>
        <div className="toolbar no-print" style={{ flexDirection: "column", alignItems: "flex-end", gap: "0.35rem" }}>
          {totals && (
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              {totals.count} entries · {Number(totals.gallons).toFixed(1)} gal · $
              {Number(totals.total_cost).toFixed(2)}
            </div>
          )}
          {canReviewReceipts && (
            <Link className="btn btn-sm" to="/fuel/receipt-review">
              Review receipt photos
            </Link>
          )}
        </div>
      </div>

      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {success && (
        <div className="fuel-success-overlay" role="alertdialog" aria-labelledby="fuel-success-title">
          <div className="fuel-success-card">
            <div className="fuel-success-check" aria-hidden>
              ✓
            </div>
            <h2 id="fuel-success-title">Fuel submitted</h2>
            <p className="fuel-success-lead">You’re all set. This stop is saved with the receipt photo.</p>
            <ul className="fuel-success-facts">
              <li>
                <span>Unit</span>
                <strong>{success.unit}</strong>
              </li>
              <li>
                <span>Odometer</span>
                <strong>{success.odometer.toLocaleString()} mi</strong>
              </li>
              {success.gallons != null && (
                <li>
                  <span>Gallons</span>
                  <strong>{Number(success.gallons).toFixed(1)}</strong>
                </li>
              )}
              {success.total != null && (
                <li>
                  <span>Total</span>
                  <strong>${Number(success.total).toFixed(2)}</strong>
                </li>
              )}
            </ul>
            {success.alertCount > 0 && (
              <p className="muted" style={{ fontSize: "0.88rem", margin: "0 0 0.75rem" }}>
                Office was flagged on mileage — nothing else for you to do.
              </p>
            )}
            {success.learned > 0 && (
              <p className="fuel-success-learn">
                Learned {success.learned} fix{success.learned === 1 ? "" : "es"} from this receipt —
                next similar scan should fill better.
              </p>
            )}
            <button className="btn fuel-success-btn" type="button" onClick={goHomeAfterSuccess}>
              Done · Back to home
            </button>
            <p className="muted" style={{ margin: "0.65rem 0 0", fontSize: "0.82rem" }}>
              Review the numbers above, then tap Done when you’re ready.
            </p>
          </div>
        </div>
      )}

      {can(user, "logFuel") && !success && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2>New fuel stop</h2>
          <form className="form" onSubmit={onSubmit}>
            {/* STEP 1 — plate or unit (usual vans still in dropdown) */}
            <div>
              <p style={{ margin: "0 0 0.35rem", fontWeight: 700 }}>1. Vehicle</p>
              <VehicleQuickPick
                value={vehicleId}
                vehicles={vehicles}
                onChange={(id) => applyVehicleCrew(id)}
                required
                label="License plate or unit #"
                placeholder="Type plate to auto-fill unit…"
              />
            </div>
            {crewNote && <div className="info-banner">{crewNote}</div>}
            {isDriver && (
              <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.82rem" }}>
                Default is your usual van. Type a plate or pick another unit if you rode with someone
                else.
              </p>
            )}

            {/* Driver hidden for typical tech flow when auto-filled; still available for office */}
            {(!isDriver || !user?.employee_id) && (
              <div className="form row">
                <label>
                  Driver
                  <select
                    value={employeeId}
                    onChange={(e) => setEmployeeId(e.target.value)}
                    required
                  >
                    <option value="">Select…</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {/* STEP 2 — required receipt photo */}
            <div style={{ marginTop: "0.5rem" }} className="receipt-drop">
              <PhotoCapture
                required
                label="2. Receipt photo"
                hint={
                  scanning
                    ? "Reading receipt…"
                    : "Take photo with the camera, or choose from gallery. Whole receipt in frame if you can."
                }
                tip={PHOTO_TIPS.receipt}
                previewUrl={preview}
                disabled={scanning}
                onPick={(f) => void handleReceipt(f)}
                onClear={() => {
                  setFile(null);
                  setPreview(null);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              />
              {preview && (
                <button
                  type="button"
                  className="receipt-preview-btn"
                  onClick={() => setShowPreviewFull(true)}
                  aria-label="Open full receipt preview"
                >
                  <span className="receipt-preview-hint">Tap to enlarge · check it looks OK</span>
                </button>
              )}
            </div>

            {ocrNote && <div className="info-banner">{ocrNote}</div>}
            {needsRetake && file && (
              <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.88rem" }}>
                Auto-fill was weak — you can still save. Optional: retake or fix fields below.
              </p>
            )}

            {showPreviewFull && preview && (
              <div
                className="modal-backdrop receipt-lightbox"
                onClick={() => setShowPreviewFull(false)}
                role="presentation"
              >
                <div
                  className="receipt-lightbox-inner"
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Receipt full preview"
                >
                  <img src={preview} alt="Full receipt" className="receipt-lightbox-img" />
                  <div className="toolbar" style={{ marginTop: "0.75rem", justifyContent: "center" }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setShowPreviewFull(false)}
                    >
                      Looks good
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => {
                        setShowPreviewFull(false);
                        fileRef.current?.click();
                      }}
                    >
                      Retake
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Scanned summary (collapsed for drivers) */}
            {file && scanReady && (
              <div className="card" style={{ margin: "0.75rem 0", padding: "0.75rem 1rem" }}>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ width: "100%", justifyContent: "space-between" }}
                  onClick={() => setShowReceiptDetails((v) => !v)}
                >
                  <span>
                    Receipt details{" "}
                    <span className="muted">(auto-filled — open only if something looks wrong)</span>
                  </span>
                  <span>{showReceiptDetails ? "▲" : "▼"}</span>
                </button>
                {!showReceiptDetails && (
                  <div className="muted" style={{ fontSize: "0.88rem", marginTop: "0.35rem" }}>
                    {[
                      fuelDate && (fuelTime ? `${fuelDate} ${fuelTime}` : fuelDate),
                      storeNumber && `store ${storeNumber}`,
                      cardLast4 && `card ••${cardLast4}`,
                      gallons && `${gallons} gal`,
                      totalCost && `$${Number(totalCost).toFixed(2)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No fields read yet — expand to edit"}
                  </div>
                )}
                {showReceiptDetails && (
                  <div className="form row" style={{ marginTop: "0.75rem" }}>
                    <label>
                      Date{fieldHint("fuel_date")}
                      <input
                        type="date"
                        value={fuelDate}
                        onChange={(e) => {
                          setFuelDate(e.target.value);
                          markManual("fuel_date");
                        }}
                        required
                        className={ocrSource.fuel_date === "missing" ? "needs-manual" : undefined}
                      />
                    </label>
                    <label>
                      Time{fieldHint("fuel_time")}
                      <input
                        type="time"
                        value={fuelTime}
                        onChange={(e) => {
                          setFuelTime(e.target.value);
                          markManual("fuel_time");
                        }}
                        className={ocrSource.fuel_time === "missing" ? "needs-manual" : undefined}
                      />
                    </label>
                    <label>
                      Store #{fieldHint("store_number")}
                      <input
                        value={storeNumber}
                        onChange={(e) => {
                          setStoreNumber(e.target.value);
                          markManual("store_number");
                        }}
                        placeholder="From receipt"
                        className={ocrSource.store_number === "missing" ? "needs-manual" : undefined}
                      />
                    </label>
                    <label>
                      Card last 4{fieldHint("card_last4")}
                      <input
                        value={cardLast4}
                        onChange={(e) => {
                          setCardLast4(e.target.value.replace(/\D/g, "").slice(0, 4));
                          markManual("card_last4");
                          setCardCheckNote("");
                        }}
                        inputMode="numeric"
                        maxLength={4}
                        placeholder={expectedCardFor(employeeId) || "1234"}
                        className={
                          ocrSource.card_last4 === "missing" || ocrSource.card_last4 === "mismatch"
                            ? "needs-manual"
                            : undefined
                        }
                      />
                      {cardCheckNote && (
                        <span
                          className={ocrSource.card_last4 === "mismatch" ? "error" : "muted"}
                          style={{ display: "block", fontSize: "0.82rem", marginTop: "0.25rem" }}
                        >
                          {cardCheckNote}
                        </span>
                      )}
                    </label>
                    <label>
                      Gallons{fieldHint("gallons")}
                      <input
                        type="number"
                        step="0.001"
                        value={gallons}
                        onChange={(e) => {
                          setGallons(e.target.value);
                          markManual("gallons");
                        }}
                        inputMode="decimal"
                        className={ocrSource.gallons === "missing" ? "needs-manual" : undefined}
                      />
                    </label>
                    <label>
                      Total cost ($){fieldHint("total_cost")}
                      <input
                        type="number"
                        step="0.01"
                        value={totalCost}
                        onChange={(e) => {
                          setTotalCost(e.target.value);
                          markManual("total_cost");
                        }}
                        inputMode="decimal"
                        className={ocrSource.total_cost === "missing" ? "needs-manual" : undefined}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* STEP 3 — odometer (main driver work) */}
            <label>
              3. Odometer <span className="muted">(you type this)</span>
              <input
                className="input-hero"
                type="number"
                step="0.1"
                value={odometer}
                onChange={(e) => {
                  setOdometer(e.target.value);
                  if (!isSuspiciousOdometer(e.target.value)) setOdoExplain("");
                }}
                required
                inputMode="decimal"
                placeholder="Current miles"
                disabled={!file}
              />
            </label>
            {!file && (
              <p className="muted" style={{ marginTop: "-0.35rem", fontSize: "0.85rem" }}>
                Photograph the receipt first — then odometer unlocks.
              </p>
            )}

            {/* Only when odometer looks fake — keep UI minimal otherwise */}
            {file && odoLooksFake && (
              <div
                className="info-banner"
                style={{
                  marginTop: "0.5rem",
                  borderLeft: "3px solid var(--warning, #c9a227)",
                  padding: "0.65rem 0.75rem",
                }}
              >
                <strong style={{ fontSize: "0.9rem" }}>Odometer looks incomplete</strong>
                <p className="muted" style={{ margin: "0.25rem 0 0.4rem", fontSize: "0.85rem" }}>
                  Values like 0 or 1234 need a quick note (we use miles for maintenance).
                </p>
                <label style={{ margin: 0 }}>
                  Why this reading?
                  <input
                    value={odoExplain}
                    onChange={(e) => setOdoExplain(e.target.value)}
                    placeholder="e.g. gauge broken / estimate / cluster replaced"
                    maxLength={200}
                    required
                  />
                </label>
              </div>
            )}

            {/* Only for prepaid / pre-auth receipts — discourage as normal practice */}
            {file && isPrepay && (
              <div
                className="info-banner"
                style={{
                  marginTop: "0.5rem",
                  borderLeft: "3px solid var(--danger, #b42318)",
                  padding: "0.65rem 0.75rem",
                }}
              >
                <strong style={{ fontSize: "0.9rem" }}>Prepaid receipt</strong>
                <p className="muted" style={{ margin: "0.25rem 0 0.4rem", fontSize: "0.85rem" }}>
                  Prefer pump first, then pay. Prepay should be rare — short reason required.
                </p>
                <label style={{ margin: 0 }}>
                  Why was this prepaid?
                  <input
                    value={prepayReason}
                    onChange={(e) => setPrepayReason(e.target.value)}
                    placeholder="e.g. pump required prepay / card declined at pump"
                    maxLength={200}
                    required
                  />
                </label>
              </div>
            )}

            <button
              className="btn"
              disabled={
                busy ||
                scanning ||
                !file ||
                !vehicleId ||
                !employeeId ||
                (isPrepay && prepayReason.trim().length < 3) ||
                (odoLooksFake && odoExplain.trim().length < 3)
              }
              type="submit"
              style={{ marginTop: "0.5rem", minHeight: 52, fontSize: "1.05rem" }}
            >
              {busy ? "Saving…" : scanning ? "Still reading receipt…" : "Save fuel stop"}
            </button>
          </form>
        </div>
      )}

      <CollapsibleSection
        title="Recent fuel entries"
        count={entries.length}
        hint={
          canReviewReceipts
            ? "Filter by unit · open a row for receipt · Review & edit to verify OCR"
            : "Pick a unit to see only that van’s fuel · tap a row for details"
        }
        defaultOpen={canReviewReceipts || !!unitFilter}
      >
        <div className="fuel-unit-filter no-print">
          <label>
            Show unit
            <select
              value={unitFilter}
              onChange={(e) => {
                setUnitFilter(e.target.value);
                setInspectId(null);
              }}
              aria-label="Filter fuel entries by unit"
            >
              <option value="">All units</option>
              {vehiclesByUnit.map((v) => (
                <option key={v.id} value={String(v.id)}>
                  Unit {v.unit_number}
                  {v.driver_name || v.assigned_driver
                    ? ` · ${v.driver_name || v.assigned_driver}`
                    : ""}
                </option>
              ))}
            </select>
          </label>
          {unitFilter && (
            <button
              type="button"
              className="btn ghost btn-sm"
              onClick={() => setUnitFilter("")}
            >
              Clear filter
            </button>
          )}
        </div>

        {unitFilter && unitUsage && (
          <div className="fuel-unit-usage no-print" aria-live="polite">
            <strong>
              Unit {filterUnitLabel || "—"} usage
            </strong>
            <span>
              {unitUsage.count} stop{unitUsage.count === 1 ? "" : "s"} ·{" "}
              {unitUsage.gallons.toFixed(1)} gal · ${unitUsage.cost.toFixed(2)}
              {unitUsage.mpg != null
                ? ` · ~${unitUsage.mpg.toFixed(1)} mpg (${unitUsage.legs} interval${
                    unitUsage.legs === 1 ? "" : "s"
                  })`
                : unitUsage.count >= 2
                  ? " · MPG needs valid odometer gaps"
                  : ""}
            </span>
          </div>
        )}

        <LogList
          className="fuel-entry-list"
          empty={
            unitFilter
              ? `No fuel entries for unit ${filterUnitLabel || "selected"}.`
              : "No entries yet."
          }
        >
          {entries.map((e) => {
            const open = inspectId === e.id;
            return (
              <LogItem
                key={e.id}
                defaultOpen={open}
                summary={
                  <>
                    <strong>{e.fuel_date}</strong>
                    {e.fuel_time ? <span className="log-item-meta">{e.fuel_time}</span> : null}
                    {e.unit_number && !unitFilter ? (
                      <span className="log-item-badge">Unit {e.unit_number}</span>
                    ) : null}
                    <span className="log-item-meta">
                      {e.gallons != null ? `${Number(e.gallons).toFixed(1)} gal` : "—"}
                      {e.total_cost != null ? ` · $${Number(e.total_cost).toFixed(2)}` : ""}
                      {unitFilter ? ` · ${Number(e.odometer).toLocaleString()} mi` : ""}
                    </span>
                    {canReviewReceipts && e.receipt_key ? (
                      <span className="log-item-badge" title="Has receipt photo">
                        Photo
                      </span>
                    ) : null}
                  </>
                }
              >
                <div className="fuel-entry-stats">
                  <div className="fuel-entry-stat">
                    <span className="fuel-entry-label">Odometer</span>
                    <span className="fuel-entry-value">{e.odometer.toLocaleString()}</span>
                  </div>
                  <div className="fuel-entry-stat">
                    <span className="fuel-entry-label">Gallons</span>
                    <span className="fuel-entry-value">
                      {e.gallons != null ? Number(e.gallons).toFixed(1) : "—"}
                    </span>
                  </div>
                  <div className="fuel-entry-stat">
                    <span className="fuel-entry-label">Total</span>
                    <span className="fuel-entry-value">
                      {e.total_cost != null ? `$${Number(e.total_cost).toFixed(2)}` : "—"}
                    </span>
                  </div>
                </div>
                {e.employee_name || e.entered_by_name ? (
                  <div className="muted">
                    {e.employee_name || e.entered_by_name}
                    {e.store_number ? ` · store ${e.store_number}` : ""}
                    {e.card_last4 ? ` · card ••${e.card_last4}` : ""}
                  </div>
                ) : null}
                {canReviewReceipts && e.receipt_key ? (
                  <div className="fuel-log-review-block no-print">
                    <a
                      href={`/api/uploads/${encodeURIComponent(e.receipt_key)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="fuel-log-receipt-thumb-link"
                    >
                      <img
                        src={`/api/uploads/${encodeURIComponent(e.receipt_key)}`}
                        alt={`Receipt unit ${e.unit_number}`}
                        className="fuel-log-receipt-thumb"
                      />
                    </a>
                    <div className="fuel-log-review-actions">
                      <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
                        Tap photo for full size. Open review to correct fields and teach OCR.
                      </p>
                      <Link
                        className="btn btn-sm"
                        to={`/fuel/receipt-review?id=${e.id}`}
                        onClick={() => setInspectId(e.id)}
                      >
                        Review &amp; edit · verify
                      </Link>
                    </div>
                  </div>
                ) : canReviewReceipts ? (
                  <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>
                    No receipt photo on this entry.
                  </p>
                ) : null}
              </LogItem>
            );
          })}
        </LogList>
      </CollapsibleSection>
    </div>
  );
}
