/** Pure rules for Deliveries. No D1, no fetch, no env. */

import { scoreAddressMatch } from "./addressFuzzy";
import { jobRefMatchKey, parseArrivalQty, chicagoTodayYmd } from "./partsReceivePlan";
import { toAsciiUiText } from "./utf8Mojibake";

export const DELIVERY_STATUSES = ["received", "scheduled", "picked_up", "voided"] as const;
export const OPEN_DELIVERY_STATUSES = ["received", "scheduled"] as const;

/** keep in sync with WARRANTY_OPEN_STATUSES, worker/index.ts:6729 */
export const WARRANTY_OPEN = ["dropped_off", "claim_submitted", "return_to_vendor", "delivered"] as const;

export const DELIVERY_SMS_DAILY_CAP = 8;
export const OVERDUE_DAYS = 7;
export const DELIVERY_PHOTO_FOLDER = "part-deliveries";
export const SPOT_HINT = "Small parts go to the office by Kelsie's desk.";

export function settingOn(raw: string | null | undefined): boolean {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function cleanSpotLabel(raw: unknown): { label: string; key: string } | { error: string } {
  const label = toAsciiUiText(String(raw ?? "")).replace(/\s+/g, " ").trim();
  if (label.length < 3 || label.length > 60) return { error: "Name the spot (3-60 letters)." };
  return { label, key: label.toLowerCase() };
}

export function cleanDeliveryPhotoKey(raw: unknown): { key: string | null; error: string | null } {
  const k = String(raw ?? "").trim();
  if (!k) return { key: null, error: null };
  if (!/^part-deliveries\/[A-Za-z0-9._-]+$/.test(k)) return { key: null, error: "Photo did not save." };
  return { key: k, error: null };
}

export type DeliveryLine = { description: string; part_code: string | null; qty: number };

export function parseDeliveryLines(raw: unknown): { lines: DeliveryLine[] } | { error: string } {
  const arr = Array.isArray(raw) ? raw : [];
  const kept: Record<string, unknown>[] = [];
  for (const row of arr) {
    const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    const desc = toAsciiUiText(String(r.description ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    const code = toAsciiUiText(String(r.part_code ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    const qtyBlank = r.qty == null || String(r.qty).trim() === "";
    if (!desc && !code && qtyBlank) continue;
    kept.push(r);
  }
  if (kept.length < 1) return { error: "Add at least one item." };
  if (kept.length > 30) return { error: "30 items max." };
  const lines: DeliveryLine[] = [];
  for (let i = 0; i < kept.length; i++) {
    const r = kept[i];
    const description = toAsciiUiText(String(r.description ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    if (description.length < 2 || description.length > 120) {
      return { error: `Line ${i + 1}: enter a description (2-120 letters).` };
    }
    const qtyBlank = r.qty == null || String(r.qty).trim() === "";
    let qty = 1;
    if (!qtyBlank) {
      const n = parseArrivalQty(r.qty);
      if (n == null) return { error: `Line ${i + 1}: enter a qty above 0` };
      qty = n;
    }
    const code = toAsciiUiText(String(r.part_code ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    lines.push({ description, part_code: code || null, qty });
  }
  return { lines };
}

export type ReceiveCheck = {
  photo_key?: string | null;
  po_number?: string | null;
  job_kind?: string | null;
  job_number?: string | null;
  st_job_id?: string | null;
  customer_name?: string | null;
  spot_id?: number | null;
  new_spot_label?: string | null;
};

export function receiveError(input: ReceiveCheck): string | null {
  const photo = String(input.photo_key || "").trim();
  const po = String(input.po_number || "").trim();
  if (!photo && !po) return "Add a photo of the label/slip or the PO.";
  const kind = String(input.job_kind || "").trim();
  if (kind !== "job" && kind !== "stock") return "Pick a job or No job / stock.";
  if (kind === "job") {
    const job = String(input.job_number || "").trim();
    const st = String(input.st_job_id || "").trim();
    const cust = String(input.customer_name || "").trim();
    if (!job && !st && !cust) return "Pick the job, or choose No job / stock.";
  }
  const spotId = Number(input.spot_id);
  const fresh = String(input.new_spot_label || "").trim();
  if (!(spotId > 0) && !fresh) return "Pick where it is staged.";
  if (po.length > 40) return "PO is too long.";
  return null;
}

export type DeliveryTargetInput = {
  job_kind?: string | null;
  job_number?: string | null;
  customer_name?: string | null;
  job_address?: string | null;
};

export function deliveryTarget(d: DeliveryTargetInput): string {
  if (String(d.job_kind || "") === "stock") return "stock (no job)";
  const num = String(d.job_number || "")
    .replace(/^#+/, "")
    .trim();
  const cust = String(d.customer_name || "")
    .replace(/\s+/g, " ")
    .trim();
  const addr = String(d.job_address || "")
    .replace(/\s+/g, " ")
    .trim();
  if (num && cust) return `job #${num} / ${cust}`;
  if (cust) return cust;
  if (addr) return addr;
  if (num) return `job #${num}`;
  return "job";
}

function clip60(raw: string): string {
  const t = toAsciiUiText(raw).replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 60) : t;
}

export function officeNoticeText(d: DeliveryTargetInput, spotLabel: string): string {
  const spot = clip60(spotLabel);
  if (String(d.job_kind || "") === "stock") {
    const text = `Parts in for stock (no job) - staged at ${spot}.`;
    return text.length > 280 ? text.slice(0, 280) : text;
  }
  const target = clip60(deliveryTarget(d));
  const text = `Parts in for ${target} - staged at ${spot} - ready to schedule.`;
  return text.length > 280 ? text.slice(0, 280) : text;
}

export function nextStatus(
  from: string,
  action: string,
  hasScheduledAt: boolean
): { to: string } | { error: string } {
  const st = String(from || "").toLowerCase();
  if (st === "voided") return { error: "This delivery was voided" };
  if (action === "schedule") {
    if (st === "received" || st === "scheduled") return { to: "scheduled" };
    return { error: "Already picked up" };
  }
  if (action === "unschedule") {
    if (st === "scheduled") return { to: "received" };
    return { error: "Not scheduled" };
  }
  if (action === "pickup") {
    if (st === "received" || st === "scheduled") return { to: "picked_up" };
    return { error: "Already picked up" };
  }
  if (action === "undo_pickup") {
    if (st === "picked_up") return { to: hasScheduledAt ? "scheduled" : "received" };
    return { error: "Not scheduled" };
  }
  if (action === "void") {
    if (st === "received" || st === "scheduled") return { to: "voided" };
    return { error: "Already picked up" };
  }
  if (action === "move_spot") {
    if (st === "received" || st === "scheduled") return { to: st };
    return { error: "Already picked up" };
  }
  if (st === "picked_up") return { error: "Already picked up" };
  return { error: "Not scheduled" };
}

export function parseScheduledFor(raw: unknown): { ymd: string | null } | { error: string } {
  if (raw == null) return { ymd: null };
  const s = String(raw).trim();
  if (!s) return { ymd: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: "Use a date like YYYY-MM-DD." };
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { error: "That date is not real." };
  }
  return { ymd: s };
}

export function ageDaysCt(receivedAtUtc: string | null | undefined, nowMs: number): number {
  const raw = String(receivedAtUtc || "").trim();
  if (!raw) return 0;
  const iso = raw.includes("T") ? (/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`) : `${raw.replace(" ", "T")}Z`;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 0;
  const a = chicagoTodayYmd(start.getTime());
  const b = chicagoTodayYmd(nowMs);
  const am = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  const bm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!am || !bm) return 0;
  const ad = Date.UTC(Number(am[1]), Number(am[2]) - 1, Number(am[3]));
  const bd = Date.UTC(Number(bm[1]), Number(bm[2]) - 1, Number(bm[3]));
  const days = Math.round((bd - ad) / 86400000);
  return days < 0 ? 0 : days;
}

export function isOverdue(status: string, ageDays: number): boolean {
  return (OPEN_DELIVERY_STATUSES as readonly string[]).includes(status) && ageDays > OVERDUE_DAYS;
}

export type WarrantyLink = { id: number; log_number: string; why: "po" | "address" | "customer" };

export type WarrantyClaimMatch = {
  id: number;
  log_number?: string | null;
  status?: string | null;
  service_address?: string | null;
  customer_name?: string | null;
  rma_number?: string | null;
};

function normCustomer(raw: string | null | undefined): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function warrantyLinks(d: DeliveryTargetInput & { po_number?: string | null }, claims: WarrantyClaimMatch[]): WarrantyLink[] {
  if (String(d.job_kind || "") !== "job") return [];
  const open = new Set<string>(WARRANTY_OPEN);
  const sorted = [...claims].sort((a, b) => Number(b.id) - Number(a.id));
  const hits: WarrantyLink[] = [];
  const seen = new Set<number>();
  for (const c of sorted) {
    if (hits.length >= 3) break;
    const id = Number(c.id);
    if (!id || seen.has(id)) continue;
    if (!open.has(String(c.status || "").toLowerCase())) continue;
    let why: WarrantyLink["why"] | null = null;
    const poKey = jobRefMatchKey(d.po_number);
    const rmaKey = jobRefMatchKey(c.rma_number);
    if (poKey && rmaKey && poKey === rmaKey) why = "po";
    if (!why) {
      const jobAddr = String(d.job_address || "").trim();
      const claimAddr = String(c.service_address || "").trim();
      if (jobAddr.length >= 5 && claimAddr.length >= 5) {
        const score = scoreAddressMatch(claimAddr, jobAddr);
        if (score && (score.match === "contain" || score.match === "tokens")) why = "address";
      }
    }
    if (!why) {
      const left = normCustomer(d.customer_name);
      const right = normCustomer(c.customer_name);
      if (left.length >= 3 && right.length >= 3 && left === right) why = "customer";
    }
    if (!why) continue;
    seen.add(id);
    hits.push({ id, log_number: String(c.log_number || ""), why });
  }
  return hits;
}

export function smsCapReached(sentLast24h: number): boolean {
  return Number(sentLast24h) >= DELIVERY_SMS_DAILY_CAP;
}

export function escapeLike(q: string): string {
  return String(q || "").replace(/[%_]/g, "");
}
