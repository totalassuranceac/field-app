/** Pure rules for warehouse receiving vs open part requests. No I/O. */

export const SHOP_STOCK_LABEL = "Shop stock";

export const DELIVER_TO = ["shop", "truck", "job_site"] as const;
export type DeliverTo = (typeof DELIVER_TO)[number];

export function normalizeJobRef(raw: string | null | undefined, shopStock: boolean): string {
  if (shopStock) return SHOP_STOCK_LABEL;
  return String(raw || "").trim();
}

export function jobRefError(jobRef: string): string | null {
  if (!String(jobRef || "").trim()) return "Enter a job number, or choose Shop stock.";
  return null;
}

export function deliverToError(value: string): string | null {
  if (value === "shop" || value === "truck" || value === "job_site") return null;
  return "Choose where to deliver: Shop, Truck, or Job site.";
}

export function neededByError(ymd: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || "").trim())) return "Needed-by date is required.";
  return null;
}

export function addDaysYmd(ymd: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

export function chicagoTodayYmd(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

/** True when the ETA date is more than 14 days before today. A missing ETA is not stale. */
export function etaIsStale(etaYmd: string | null | undefined, todayYmd: string, days = 14): boolean {
  const eta = String(etaYmd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eta)) return false;
  const cutoff = addDaysYmd(todayYmd, -days);
  if (!cutoff) return false;
  return eta < cutoff;
}

/**
 * Return stays blocked on an unmatched arrival until it is linked to a request
 * or the requester/office has confirmed it is not needed.
 */
export function arrivalReturnBlock(row: {
  requestId?: number | null;
  notNeededAt?: string | null;
}): string | null {
  if (row.requestId != null && Number(row.requestId) > 0) return null;
  if (String(row.notNeededAt || "").trim()) return null;
  return "Link this to an open request, or wait until the requester or office confirms it is not needed.";
}

export function unmatchedArrivalBody(part: string, vendor: string): string {
  const p = String(part || "").replace(/\s+/g, " ").trim() || "part";
  const v = String(vendor || "").replace(/\s+/g, " ").trim();
  const label = v ? `${p} / ${v}` : p;
  return `Part arrived with no open request: ${label}. Keep or return?`;
}

export function deliverToLabel(value: string | null | undefined): string {
  if (value === "shop") return "Shop";
  if (value === "truck") return "Truck";
  if (value === "job_site") return "Job site";
  return "";
}

/** Vendor, PO, and ETA are required when a request is marked ordered or arriving. */
export function orderFieldsError(input: {
  status: string;
  orderedFrom?: string | null;
  poNumber?: string | null;
  etaOn?: string | null;
}): string | null {
  if (input.status !== "ordered" && input.status !== "arriving") return null;
  const vendor = String(input.orderedFrom || "").trim();
  if (vendor !== "autozone" && vendor !== "firstcall" && vendor !== "other") {
    return "Vendor is required. Choose AutoZone, First Call, or Other.";
  }
  if (!String(input.poNumber || "").trim()) return "PO number is required.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.etaOn || "").trim())) {
    return "ETA date is required.";
  }
  return null;
}

/**
 * Received texts use Field App Twilio only.
 * A messaging service is allowed. The 6925 shop From line is not.
 */
export function partsReceiveSmsAllowed(
  messagingServiceSid: string | null | undefined,
  fromNumber: string | null | undefined
): boolean {
  if (String(messagingServiceSid || "").trim()) return true;
  const digits = String(fromNumber || "").replace(/\D/g, "");
  if (!digits) return false;
  if (digits.endsWith("4466925")) return false;
  return true;
}

export function jobRefMatchKey(raw: string | null | undefined): string {
  return String(raw || "")
    .replace(/^#+/, "")
    .trim()
    .toLowerCase();
}

export function isShopStockJobRef(raw: string | null | undefined): boolean {
  return jobRefMatchKey(raw) === SHOP_STOCK_LABEL.toLowerCase();
}

/** Positive arrival qty. Blank or zero is not a count. */
export function parseArrivalQty(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 1000) / 1000;
}

/** Optional box or packing-slip photo stored under parts-arrivals/. */
export function cleanArrivalPhotoKey(raw: unknown): { key: string | null; error: string | null } {
  const k = String(raw ?? "").trim();
  if (!k) return { key: null, error: null };
  if (!/^parts-arrivals\/[A-Za-z0-9._-]+$/.test(k)) return { key: null, error: "Photo did not save." };
  return { key: k, error: null };
}

export function sectionPlaceLabel(
  name: string | null | undefined,
  zone: string | null | undefined,
  type: string | null | undefined
): string {
  const n = String(name || "").trim();
  const z = String(zone || "").toLowerCase();
  let area = "";
  if (z === "overhead") area = "Overhead";
  else if (z === "attic" || type === "attic") area = "Attic";
  else if (z === "main") area = "Main floor";
  else if (z === "other") area = "Other";
  if (!n) return area || "Section";
  if (!area || n.toLowerCase() === area.toLowerCase()) return n;
  return `${n} - ${area}`;
}

/** Truck place label. A name that is already "Unit 200" is not written twice. */
export function truckPlaceLabel(
  unitNumber: string | null | undefined,
  name: string | null | undefined
): string {
  const unit = String(unitNumber || "").trim();
  if (unit) return /^unit\s+/i.test(unit) ? unit : `Unit ${unit}`;
  const raw = String(name || "").trim();
  return raw || "Truck";
}

/** Exact job number or ServiceTitan job id. Shop stock matches no technician. */
export function jobRefMatches(
  jobRef: string | null | undefined,
  jobNumber: string | null | undefined,
  stJobId: string | null | undefined
): boolean {
  const key = jobRefMatchKey(jobRef);
  if (!key || isShopStockJobRef(jobRef)) return false;
  const num = jobRefMatchKey(jobNumber);
  const st = jobRefMatchKey(stJobId);
  return (num !== "" && num === key) || (st !== "" && st === key);
}
