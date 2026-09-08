/**
 * Office Day Board — Phase 1 READ-ONLY.
 * Live ST appointments for a Chicago calendar day. No ST writes.
 */

import type { Env, PublicUser } from "./types";
import { isOfficeSide } from "./auth";
import { isChicagoWeekend } from "./pto";
import { stApiGet, stConfigured, stTenantId } from "./servicetitan";
import {
  loadStTechnicians,
  matchUserToStTechnician,
  type StTechnician,
} from "./zeroCharge";

const TZ = "America/Chicago";

export type DayBoardJob = {
  st_appointment_id: string;
  st_job_id: string | null;
  job_number: string | null;
  address: string | null;
  /** Which ST field won for hover debug (e.g. invoice.locationAddress.street) */
  address_source?: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  job_type: string | null;
  window_start: string | null;
  window_end: string | null;
  status: string | null;
  /** Sheet-like “done” (yellow) — ST Done/Completed only */
  is_done: boolean;
  /** Red OFF/Out cell */
  is_off: boolean;
  /** st = in ServiceTitan (blue text); board = not in ST yet (black) — Phase 2 */
  ink: "st" | "board";
  note: string | null;
  /** unused — pairs are row labels (Name/Helper), not chip text */
  helpers: string[];
};

export type DayBoardPto = {
  request_id: number;
  label: string;
  start_date: string;
  end_date: string;
};

export type DayBoardTechRow = {
  user_id: number | null;
  display_name: string;
  st_technician_id: number | null;
  is_self: boolean;
  crew: "service" | "install";
  /** Install supervisor (Chris Miller) — pin at top of Install */
  is_supervisor?: boolean;
  jobs: DayBoardJob[];
  pto: DayBoardPto[];
};

export type DayBoardResponse = {
  date: string;
  timezone: string;
  view: "office" | "self";
  st_write_enabled: false;
  rows: DayBoardTechRow[];
  message?: string;
  error?: string;
};

function chicagoParts(d: Date): { y: number; m: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    day: Number(parts.day),
  };
}

function tzOffsetMs(timeZone: string, date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

function zonedLocalToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mi: number,
  ss: number
): Date {
  let utc = new Date(Date.UTC(y, m - 1, d, hh, mi, ss));
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(TZ, utc);
    utc = new Date(Date.UTC(y, m - 1, d, hh, mi, ss) - off);
  }
  return utc;
}

function toChicagoOffsetIso(utcInstant: Date): string {
  const offMs = tzOffsetMs(TZ, utcInstant);
  const totalMin = Math.round(offMs / 60000);
  const sign = totalMin <= 0 ? "-" : "+";
  const abs = Math.abs(totalMin);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(utcInstant).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:${parts.minute}:${parts.second}${sign}${offH}:${offM}`;
}

/** Parse YYYY-MM-DD → Chicago day window for ST appointments. */
export function dayBoundsForIsoDate(isoDate: string): {
  date: string;
  startOff: string;
  endBeforeOff: string;
} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!(y > 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const start = zonedLocalToUtc(y, mo, d, 0, 0, 0);
  const probe = chicagoParts(new Date(start.getTime() + 30 * 3600 * 1000));
  const end = zonedLocalToUtc(probe.y, probe.m, probe.day, 0, 0, 0);
  const date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return {
    date,
    startOff: toChicagoOffsetIso(start),
    endBeforeOff: toChicagoOffsetIso(end),
  };
}

export function shopTodayIso(): string {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function canViewDayBoard(user: PublicUser): boolean {
  if (isOfficeSide(user.role)) return true;
  if (user.role === "driver") return true;
  return false;
}

export function dayBoardView(user: PublicUser): "office" | "self" {
  return isOfficeSide(user.role) ? "office" : "self";
}

function isDoneStatus(status: string | null | undefined): boolean {
  const s = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  if (!s) return false;
  if (isOffStatus(s)) return false;
  return s === "done" || s === "completed" || s === "complete" || /\bdone\b/.test(s);
}

function crewFromTeam(team: string | null | undefined): "service" | "install" {
  const t = String(team || "").toLowerCase();
  if (t.includes("install")) return "install";
  return "service";
}

function isOffStatus(status: string | null | undefined): boolean {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  if (!s) return false;
  return (
    s === "out" ||
    s === "off" ||
    s.includes("out of office") ||
    s === "unused" ||
    s === "canceled" ||
    s === "cancelled"
  );
}

function customerPhoneFromAppt(a: Record<string, unknown>): string | null {
  const direct =
    (typeof a.customerPhone === "string" && a.customerPhone) ||
    (typeof a.phone === "string" && a.phone) ||
    (typeof a.mobilePhone === "string" && a.mobilePhone) ||
    "";
  if (direct.trim()) return direct.trim();
  const cust =
    a.customer && typeof a.customer === "object"
      ? (a.customer as Record<string, unknown>)
      : null;
  if (cust) {
    for (const k of ["phone", "mobilePhone", "mobile", "primaryPhone"]) {
      const v = cust[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/** True when text looks like a real street (not a person/business name). */
function looksLikeStreet(raw: string): boolean {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || t.length < 4) return false;
  if (/^\d{1,6}[A-Za-z]?\s+\S/.test(t)) return true; // 7710 Montereau / 1581 U.S.
  if (/^(p\.?\s*o\.?\s*box|hwy|fm|ih|us|rr|cr)\b/i.test(t)) return true;
  return false;
}

/**
 * Miller-style / location-name street: leading segment before first ` - ` / `—` / `-`,
 * or strip trailing "(RNC)" tags. Only returns when it looks like a street.
 */
function parseLeadingStreet(raw: unknown): string | null {
  let s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  // Prefer spaced dash / em-dash (Miller "7710 Montereau — Install…")
  const spaced = s.match(/^(.+?)\s+[—–-]\s+/);
  if (spaced) s = spaced[1].trim();
  else {
    // Tight dash: "7710 Montereau-Install duct" → "7710 Montereau"
    const tight = s.match(
      /^(\d{1,6}[A-Za-z]?\s+[A-Za-z][A-Za-z0-9.'/# ]*?)\s*[—–-]\s*[A-Za-z]/
    );
    if (tight) s = tight[1].trim();
  }
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim(); // "6709 La Salle (RNC)"
  if (!looksLikeStreet(s)) return null;
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

function cleanStreet(raw: unknown): string | null {
  const s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** Pull street from nested ST address shapes (CRM location, invoice locationAddress, etc.). */
function streetFromAddressShape(
  loc: unknown
): { street: string; source: string } | null {
  if (!loc) return null;
  if (typeof loc === "string") {
    const direct = cleanStreet(loc);
    if (direct && looksLikeStreet(direct)) {
      return { street: direct, source: "string" };
    }
    const parsed = parseLeadingStreet(loc);
    if (parsed) return { street: parsed, source: "string.leadingStreet" };
    return null;
  }
  if (typeof loc !== "object") return null;
  const o = loc as Record<string, unknown>;

  // Nested .address object (CRM Location)
  if (o.address && typeof o.address === "object") {
    const nested = streetFromAddressShape(o.address);
    if (nested) {
      return { street: nested.street, source: `address.${nested.source}` };
    }
  }

  const street = cleanStreet(
    o.street ||
      o.streetAddress ||
      o.addressLine1 ||
      o.line1 ||
      o.Address ||
      o.address1 ||
      ""
  );
  if (street) {
    const city = cleanStreet(o.city) || "";
    // Prefer street; append city when street is very short (e.g. "Hwy 59")
    if (street.length < 12 && city) {
      return { street: `${street}, ${city}`, source: "street+city" };
    }
    return { street, source: "street" };
  }

  // location.name often embeds street: "6709 La Salle (RNC)" / "7805 Houshang (RNC)"
  const nameParsed = parseLeadingStreet(o.name || o.customerName || "");
  if (nameParsed) return { street: nameParsed, source: "name.leadingStreet" };

  return null;
}

/** True when job already has a usable street (not just a non-street location name). */
function jobHasStreet(job: Record<string, unknown>): boolean {
  if (streetFromAddressShape(job._resolvedLocation)) return true;
  if (streetFromAddressShape(job.location)) return true;
  if (streetFromAddressShape(job.address)) return true;
  if (streetFromAddressShape(job.locationAddress)) return true;
  if (typeof job.locationAddress === "string" && looksLikeStreet(job.locationAddress)) {
    return true;
  }
  if (typeof job.address === "string" && looksLikeStreet(job.address)) return true;
  return false;
}

async function enrichLocations(
  env: Env,
  db: D1Database,
  tenantId: string,
  locationIds: number[]
): Promise<Map<number, Record<string, unknown>>> {
  const map = new Map<number, Record<string, unknown>>();
  const ids = [...new Set(locationIds.filter((n) => n > 0))];
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const q = new URLSearchParams({
      ids: chunk.join(","),
      pageSize: String(Math.max(chunk.length, 10)),
    });
    const res = await stApiGet(
      env,
      db,
      `/crm/v2/tenant/${tenantId}/locations?${q.toString()}`
    );
    if (!res.ok) continue; // often 403 without CRM Locations Read — invoice fallback covers it
    const body = res.json as { data?: Record<string, unknown>[] };
    for (const row of body.data || []) {
      const id = Number(row.id);
      if (id > 0) map.set(id, row);
    }
  }
  return map;
}

/**
 * Accounting invoices expose locationAddress even when CRM Locations scope is missing.
 * Prefer locationAddress (job site) over customerAddress (often a PO box).
 */
async function enrichInvoiceAddresses(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobIds: number[]
): Promise<Map<number, { street: string; source: string; raw: Record<string, unknown> }>> {
  const map = new Map<
    number,
    { street: string; source: string; raw: Record<string, unknown> }
  >();
  const ids = [...new Set(jobIds.filter((n) => n > 0))];
  if (!ids.length) return map;

  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (jobId) => {
        const q = new URLSearchParams({
          jobId: String(jobId),
          pageSize: "5",
        });
        const res = await stApiGet(
          env,
          db,
          `/accounting/v2/tenant/${tenantId}/invoices?${q.toString()}`
        );
        if (!res.ok) return;
        const body = res.json as { data?: Record<string, unknown>[] };
        const rows = body.data || [];
        for (const inv of rows) {
          const locAddr = streetFromAddressShape(inv.locationAddress);
          if (locAddr) {
            map.set(jobId, {
              street: locAddr.street,
              source: `invoice.locationAddress.${locAddr.source}`,
              raw:
                inv.locationAddress && typeof inv.locationAddress === "object"
                  ? (inv.locationAddress as Record<string, unknown>)
                  : { street: locAddr.street },
            });
            return;
          }
          const locName = streetFromAddressShape(inv.location);
          if (locName) {
            map.set(jobId, {
              street: locName.street,
              source: `invoice.location.${locName.source}`,
              raw:
                inv.location && typeof inv.location === "object"
                  ? (inv.location as Record<string, unknown>)
                  : { street: locName.street },
            });
            return;
          }
          const cust = streetFromAddressShape(inv.customerAddress);
          if (cust) {
            map.set(jobId, {
              street: cust.street,
              source: `invoice.customerAddress.${cust.source}`,
              raw:
                inv.customerAddress && typeof inv.customerAddress === "object"
                  ? (inv.customerAddress as Record<string, unknown>)
                  : { street: cust.street },
            });
            return;
          }
        }
      })
    );
  }
  return map;
}

/**
 * Batch-load ST jobs, then CRM locations, then invoice locationAddress.
 * Mutates each job with `_resolvedLocation` + `_addressSource` for parseJobChip.
 * CRM Locations often 403 on this tenant — invoices are the reliable street source.
 */
async function enrichJobs(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobIds: number[]
): Promise<Map<number, Record<string, unknown>>> {
  const map = new Map<number, Record<string, unknown>>();
  const ids = [...new Set(jobIds.filter((n) => n > 0))];
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const q = new URLSearchParams({
      ids: chunk.join(","),
      pageSize: String(Math.max(chunk.length, 10)),
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
    if (!res.ok) continue;
    const body = res.json as { data?: Record<string, unknown>[] };
    for (const row of body.data || []) {
      const id = Number(row.id);
      if (id > 0) map.set(id, row);
    }
  }

  // 1) CRM locations when job only has locationId (soft-fail on 403)
  const needLoc: number[] = [];
  for (const job of map.values()) {
    if (jobHasStreet(job)) continue;
    const lid = Number(job.locationId);
    if (lid > 0) needLoc.push(lid);
  }
  if (needLoc.length) {
    const locMap = await enrichLocations(env, db, tenantId, needLoc);
    for (const job of map.values()) {
      if (jobHasStreet(job)) continue;
      const lid = Number(job.locationId);
      const loc = lid > 0 ? locMap.get(lid) : undefined;
      if (!loc) continue;
      const got = streetFromAddressShape(loc);
      if (got) {
        job._resolvedLocation = loc;
        job._addressSource = `crm.location.${got.source}`;
      }
    }
  }

  // 2) Accounting invoice locationAddress (works without CRM Locations scope)
  const needInv: number[] = [];
  for (const [id, job] of map) {
    if (jobHasStreet(job)) continue;
    needInv.push(id);
  }
  if (needInv.length) {
    const invMap = await enrichInvoiceAddresses(env, db, tenantId, needInv);
    for (const [id, info] of invMap) {
      const job = map.get(id);
      if (!job || jobHasStreet(job)) continue;
      job._resolvedLocation = info.raw;
      job._addressSource = info.source;
    }
  }

  return map;
}
function techIdsFromAppt(row: Record<string, unknown>): number[] {
  const out = new Set<number>();
  if (Array.isArray(row.technicianIds)) {
    for (const v of row.technicianIds) {
      const n = Number(v);
      if (n > 0) out.add(n);
    }
  }
  if (row.technicianId != null) {
    const n = Number(row.technicianId);
    if (n > 0) out.add(n);
  }
  return [...out];
}

type ApptAssignment = {
  appointmentId: number;
  technicianId: number;
  active?: boolean;
};

/**
 * JPM appointments omit technicianIds. Dispatch appointment-assignments holds the map.
 * Needs ST scope: Dispatch → Appointment Assignments (Read). Soft-fail on 403.
 */
async function fetchTechIdsByAppointment(
  env: Env,
  db: D1Database,
  tenantId: string,
  appointmentIds: number[]
): Promise<{ map: Map<number, number[]>; scopeMissing: boolean }> {
  const map = new Map<number, number[]>();
  const ids = [...new Set(appointmentIds.filter((n) => n > 0))];
  if (!ids.length) return { map, scopeMissing: false };

  let scopeMissing = false;
  const chunkSize = 40;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const q = new URLSearchParams({
      appointmentIds: chunk.join(","),
      pageSize: "200",
      active: "True",
    });
    const res = await stApiGet(
      env,
      db,
      `/dispatch/v2/tenant/${tenantId}/appointment-assignments?${q.toString()}`
    );
    if (!res.ok) {
      if (res.status === 403 || res.status === 401) scopeMissing = true;
      continue;
    }
    const body = res.json as { data?: ApptAssignment[] };
    for (const row of body.data || []) {
      const apptId = Number(row.appointmentId);
      const techId = Number(row.technicianId);
      if (!(apptId > 0) || !(techId > 0)) continue;
      if (row.active === false) continue;
      const list = map.get(apptId) || [];
      if (!list.includes(techId)) list.push(techId);
      map.set(apptId, list);
    }
  }
  return { map, scopeMissing };
}

function shortNote(raw: unknown): string | null {
  const s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

type RawAppt = Record<string, unknown>;

/** Keep for modifiedOnOrAfter fallback filter. */
function apptStartsInDayWindow(
  a: RawAppt,
  dayStartMs: number,
  dayEndMs: number
): boolean {
  const raw =
    (typeof a.start === "string" && a.start) ||
    (typeof a.arrivalWindowStart === "string" && a.arrivalWindowStart) ||
    "";
  if (!raw) return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return t >= dayStartMs && t < dayEndMs;
}

/**
 * Prefer starts* day window (Appointments Read). Fallback: modifiedOnOrAfter + filter.
 */
async function fetchAppointmentsForDay(
  env: Env,
  db: D1Database,
  tenantId: string,
  startOff: string,
  endBeforeOff: string
): Promise<{ ok: boolean; appointments: RawAppt[]; status?: number; error?: string }> {
  const dayStartMs = Date.parse(startOff);
  const dayEndMs = Date.parse(endBeforeOff);
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(dayEndMs)) {
    return { ok: false, appointments: [], error: "Invalid day window" };
  }

  async function pull(
    params: Record<string, string>
  ): Promise<{ ok: boolean; appointments: RawAppt[]; status?: number; error?: string }> {
    const appointments: RawAppt[] = [];
    let page = 1;
    while (page <= 40) {
      const q = new URLSearchParams({ ...params, page: String(page), pageSize: "100" });
      const res = await stApiGet(
        env,
        db,
        `/jpm/v2/tenant/${tenantId}/appointments?${q.toString()}`
      );
      if (!res.ok) {
        return {
          ok: false,
          appointments: [],
          status: res.status,
          error: `ServiceTitan appointments failed (${res.status})`,
        };
      }
      const body = res.json as { data?: RawAppt[]; hasMore?: boolean };
      const rows = body.data || [];
      for (const a of rows) appointments.push(a);
      if (!rows.length || body.hasMore === false) break;
      if (body.hasMore !== true && rows.length < 100) break;
      page += 1;
    }
    return { ok: true, appointments };
  }

  // Prefer modifiedOnOrAfter (same as assignmentSms) — starts* often 403s on this tenant.
  const lookFrom = new Date(dayStartMs - 120 * 24 * 3600 * 1000);
  const modifiedOnOrAfter = toChicagoOffsetIso(lookFrom);
  const fb = await pull({ modifiedOnOrAfter });
  if (fb.ok) {
    return {
      ok: true,
      appointments: fb.appointments.filter((a) =>
        apptStartsInDayWindow(a, dayStartMs, dayEndMs)
      ),
    };
  }

  // Fallback: starts* day window if modified path fails for another reason
  let got = await pull({ startsOnOrAfter: startOff, startsBefore: endBeforeOff });
  if (!got.ok) {
    got = await pull({ startsOnOrAfter: startOff, startsOnOrBefore: endBeforeOff });
  }
  if (got.ok) return got;
  return fb;
}

function parseJobChip(
  a: RawAppt,
  job?: Record<string, unknown> | null
): DayBoardJob {
  const apptId = a.id != null ? String(a.id) : "";
  const jobId = a.jobId != null ? String(a.jobId) : null;
  const status = a.status != null ? String(a.status) : null;
  const typeName =
    (typeof a.jobTypeName === "string" && a.jobTypeName) ||
    (a.jobType && typeof a.jobType === "object"
      ? String((a.jobType as Record<string, unknown>).name || "")
      : "") ||
    (job && typeof job.jobType === "string" ? job.jobType : null) ||
    (job && job.jobType && typeof job.jobType === "object"
      ? String((job.jobType as Record<string, unknown>).name || "")
      : "") ||
    (typeof a.type === "string" ? a.type : "") ||
    null;
  const customer =
    (typeof a.customerName === "string" && a.customerName) ||
    (a.customer && typeof a.customer === "object"
      ? String((a.customer as Record<string, unknown>).name || "")
      : "") ||
    (job && typeof job.customerName === "string" ? job.customerName : null) ||
    (job && job.customer && typeof job.customer === "object"
      ? String((job.customer as Record<string, unknown>).name || "")
      : "") ||
    null;
  const note =
    shortNote(a.specialInstructions) ||
    shortNote(a.summary) ||
    shortNote(a.notes) ||
    shortNote(a.appointmentSummary) ||
    null;

  const jobNumber =
    (job && job.jobNumber != null ? String(job.jobNumber) : null) ||
    (job && job.number != null ? String(job.number) : null) ||
    (a.jobNumber != null ? String(a.jobNumber) : null) ||
    (a.number != null ? String(a.number) : null);

  // Resolve street from every common ST shape; track which field won for hover debug.
  type Cand = { street: string; source: string };
  const cands: Cand[] = [];
  const push = (got: { street: string; source: string } | null, prefix: string) => {
    if (got?.street) cands.push({ street: got.street, source: `${prefix}.${got.source}` });
  };
  const pushStreet = (street: string | null, source: string) => {
    if (street) cands.push({ street, source });
  };

  if (job) {
    const resolved = streetFromAddressShape(job._resolvedLocation);
    if (resolved) {
      const src =
        typeof job._addressSource === "string" && job._addressSource.trim()
          ? String(job._addressSource).trim()
          : `job._resolvedLocation.${resolved.source}`;
      cands.push({ street: resolved.street, source: src });
    }
    push(streetFromAddressShape(job.location), "job.location");
    push(streetFromAddressShape(job.address), "job.address");
    push(streetFromAddressShape(job.locationAddress), "job.locationAddress");
    if (typeof job.locationAddress === "string") {
      pushStreet(cleanStreet(job.locationAddress), "job.locationAddress.string");
    }
    if (typeof job.address === "string") {
      const s = cleanStreet(job.address);
      if (s && looksLikeStreet(s)) pushStreet(s, "job.address.string");
    }
    pushStreet(parseLeadingStreet(job.summary), "job.summary.leadingStreet");
    pushStreet(parseLeadingStreet(job.summaryOfWork), "job.summaryOfWork.leadingStreet");
  }

  push(streetFromAddressShape(a.customerAddress), "appt.customerAddress");
  push(streetFromAddressShape(a.address), "appt.address");
  push(streetFromAddressShape(a.location), "appt.location");
  push(streetFromAddressShape(a.locationAddress), "appt.locationAddress");
  if (typeof a.locationAddress === "string") {
    pushStreet(cleanStreet(a.locationAddress), "appt.locationAddress.string");
  }
  if (typeof a.address === "string") {
    const s = cleanStreet(a.address);
    if (s && looksLikeStreet(s)) pushStreet(s, "appt.address.string");
  }
  // Miller-style summary already starts with street when ST location is empty
  pushStreet(parseLeadingStreet(a.summary), "appt.summary.leadingStreet");
  pushStreet(parseLeadingStreet(a.specialInstructions), "appt.specialInstructions.leadingStreet");
  pushStreet(parseLeadingStreet(a.appointmentSummary), "appt.appointmentSummary.leadingStreet");
  pushStreet(parseLeadingStreet(a.notes), "appt.notes.leadingStreet");

  const best = cands.find((c) => looksLikeStreet(c.street)) || cands[0] || null;
  const address = best?.street || null;
  const address_source = best?.source || null;

  const phoneFromJob =
    (job ? customerPhoneFromAppt(job) : null) ||
    (job && job.customer && typeof job.customer === "object"
      ? customerPhoneFromAppt({ customer: job.customer })
      : null);

  return {
    st_appointment_id: apptId,
    st_job_id: jobId,
    job_number: jobNumber,
    address,
    address_source,
    customer_name: customer && String(customer).trim() ? String(customer).trim() : null,
    customer_phone: customerPhoneFromAppt(a) || phoneFromJob,
    job_type: typeName && String(typeName).trim() ? String(typeName).trim() : null,
    window_start:
      (typeof a.arrivalWindowStart === "string" && a.arrivalWindowStart) ||
      (typeof a.start === "string" && a.start) ||
      null,
    window_end:
      (typeof a.arrivalWindowEnd === "string" && a.arrivalWindowEnd) ||
      (typeof a.end === "string" && a.end) ||
      null,
    status,
    is_done: isDoneStatus(status),
    is_off: isOffStatus(status),
    ink: "st",
    note,
    helpers: [],
  };
}

function ptoTypeLabel(
  requestType: string | null | undefined,
  hoursDeducted?: number | null
): string {
  const raw = String(requestType || "pto")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  // Paid bank types with no hours taken → show Unpaid (never fake "PTO")
  const paidBank = raw === "pto" || raw === "personal" || raw === "sick";
  if (
    paidBank &&
    (hoursDeducted == null || !Number.isFinite(Number(hoursDeducted)) || Number(hoursDeducted) <= 0)
  ) {
    return "Unpaid";
  }
  if (raw === "pto") return "PTO";
  if (!raw) return "PTO";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

type PtoLoadResult = {
  ok: boolean;
  map: Map<number, DayBoardPto[]>;
  /** Full FA display names keyed by user_id (never partial / clipped). */
  names: Map<number, string>;
  /** Normalized full name → user_id for ST-only rows without user_id. */
  byNormName: Map<string, number>;
};

function normPersonName(raw: string | null | undefined): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Approved time-off covering this Chicago calendar day.
 * Weekends never count — Sat/Sun returns empty even if the stored range includes them.
 * Matches via user_id; also carries full display_name / employee name for attach.
 * ok=false means the query failed — caller must NOT clear existing PTO marks.
 */
async function loadPtoForDate(
  db: D1Database,
  date: string,
  userIds: number[] | null
): Promise<PtoLoadResult> {
  const map = new Map<number, DayBoardPto[]>();
  const names = new Map<number, string>();
  const byNormName = new Map<string, number>();
  if (isChicagoWeekend(date)) return { ok: true, map, names, byNormName };
  try {
    // Join users + employees so we always have full display names (Jaden DeLaGarza, etc.)
    let sql = `SELECT r.id, r.user_id, r.start_date, r.end_date, r.request_type, r.hours_deducted,
                      u.display_name, u.employee_id, e.name AS employee_name
               FROM time_off_requests r
               JOIN users u ON u.id = r.user_id
               LEFT JOIN employees e ON e.id = u.employee_id
               WHERE r.status = 'approved'
                 AND r.start_date <= ?
                 AND r.end_date >= ?`;
    const binds: unknown[] = [date, date];
    if (userIds && userIds.length) {
      const ids = [...new Set(userIds.map(Number).filter((n) => n > 0))];
      if (ids.length) {
        sql += ` AND r.user_id IN (${ids.map(() => "?").join(",")})`;
        binds.push(...ids);
      }
    }
    const rows = await db
      .prepare(sql)
      .bind(...binds)
      .all<{
        id: number;
        user_id: number;
        start_date: string;
        end_date: string;
        request_type: string | null;
        hours_deducted: number | null;
        display_name: string | null;
        employee_id: number | null;
        employee_name: string | null;
      }>();
    for (const r of rows.results || []) {
      const uid = Number(r.user_id);
      if (!(uid > 0)) continue;
      const list = map.get(uid) || [];
      list.push({
        request_id: Number(r.id),
        label: ptoTypeLabel(r.request_type, r.hours_deducted),
        start_date: String(r.start_date),
        end_date: String(r.end_date),
      });
      map.set(uid, list);
      const full =
        String(r.display_name || "").trim() ||
        String(r.employee_name || "").trim() ||
        `User ${uid}`;
      names.set(uid, full);
      const n1 = normPersonName(r.display_name);
      const n2 = normPersonName(r.employee_name);
      if (n1) byNormName.set(n1, uid);
      if (n2) byNormName.set(n2, uid);
    }
    return { ok: true, map, names, byNormName };
  } catch {
    // Fallback without joins (older schema) — still weekday-filtered
    try {
      let sql = `SELECT id, user_id, start_date, end_date, request_type, hours_deducted
                 FROM time_off_requests
                 WHERE status = 'approved'
                   AND start_date <= ?
                   AND end_date >= ?`;
      const binds: unknown[] = [date, date];
      if (userIds && userIds.length) {
        const ids = [...new Set(userIds.map(Number).filter((n) => n > 0))];
        if (ids.length) {
          sql += ` AND user_id IN (${ids.map(() => "?").join(",")})`;
          binds.push(...ids);
        }
      }
      const rows = await db
        .prepare(sql)
        .bind(...binds)
        .all<{
          id: number;
          user_id: number;
          start_date: string;
          end_date: string;
          request_type: string | null;
          hours_deducted: number | null;
        }>();
      for (const r of rows.results || []) {
        const uid = Number(r.user_id);
        if (!(uid > 0)) continue;
        const list = map.get(uid) || [];
        list.push({
          request_id: Number(r.id),
          label: ptoTypeLabel(r.request_type, r.hours_deducted),
          start_date: String(r.start_date),
          end_date: String(r.end_date),
        });
        map.set(uid, list);
      }
      return { ok: true, map, names, byNormName };
    } catch {
      return { ok: false, map, names, byNormName };
    }
  }
}

/** Attach PTO by user_id, else full normalized display_name; inject missing OFF rows. */
function applyPtoToRows(
  rows: DayBoardTechRow[],
  ptoMap: Map<number, DayBoardPto[]>,
  nameByUserId: Map<number, string>,
  byNormName?: Map<string, number>
): DayBoardTechRow[] {
  const out = rows.map((row) => {
    let uid = row.user_id != null ? Number(row.user_id) : null;
    if (!(uid != null && uid > 0) && byNormName?.size) {
      const hit = byNormName.get(normPersonName(row.display_name));
      if (hit) uid = hit;
    }
    if (uid == null || !(uid > 0)) return { ...row, pto: row.pto || [] };
    const pto = ptoMap.get(uid) || [];
    // Prefer full FA display name when we have it (never “jade”)
    const full = nameByUserId.get(uid);
    if (pto.length && full && !String(row.display_name).includes("/")) {
      return { ...row, user_id: uid, display_name: full, pto };
    }
    return { ...row, user_id: row.user_id ?? uid, pto };
  });
  const present = new Set(
    out
      .map((r) => (r.user_id != null ? Number(r.user_id) : 0))
      .filter((n) => n > 0)
  );
  for (const [uid, pto] of ptoMap) {
    if (!pto.length || present.has(uid)) continue;
    const display = nameByUserId.get(uid) || `User ${uid}`;
    out.push({
      user_id: uid,
      display_name: display,
      st_technician_id: null,
      is_self: false,
      crew: "service",
      jobs: [],
      pto,
    });
    present.add(uid);
  }
  return out;
}

type FaUser = {
  id: number;
  display_name: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  st_technician_id: number | null;
  role: string;
};


type FaInstallPair = {
  /** Full partner display/employee name — shortened at merge with collision set */
  partnerFull: string;
  partnerUserId: number | null;
};

async function loadFaInstallPairs(
  db: D1Database
): Promise<Map<number, FaInstallPair>> {
  const out = new Map<number, FaInstallPair>();
  /** Prefer FA user full display_name, else employee name. */
  const fullName = (...names: Array<string | null | undefined>) => {
    for (const raw of names) {
      const t = String(raw || "")
        .replace(/\s+/g, " ")
        .trim();
      if (t) return t;
    }
    return "";
  };
  try {
    const pairs = await db
      .prepare(
        `SELECT p.name AS partner_name,
                up.display_name AS partner_display_name,
                u.id AS user_id, up.id AS partner_user_id
         FROM employees e
         JOIN employees p ON p.id = e.rides_with_employee_id AND p.active = 1
         JOIN users u ON u.active = 1
           AND lower(trim(u.display_name)) = lower(trim(e.name))
         LEFT JOIN users up ON up.active = 1
           AND lower(trim(up.display_name)) = lower(trim(p.name))
         WHERE e.active = 1 AND e.rides_with_employee_id IS NOT NULL`
      )
      .all<{
        partner_name: string;
        partner_display_name: string | null;
        user_id: number;
        partner_user_id: number | null;
      }>();
    for (const r of pairs.results || []) {
      const full = fullName(r.partner_display_name, r.partner_name);
      if (!full || !(r.user_id > 0)) continue;
      if (out.has(r.user_id)) continue;
      out.set(r.user_id, {
        partnerFull: full,
        partnerUserId:
          r.partner_user_id != null && r.partner_user_id > 0
            ? r.partner_user_id
            : null,
      });
    }
  } catch {
    /* rides_with optional until migration 036 */
  }
  try {
    const trucks = await db
      .prepare(
        `SELECT u.id AS user_id, h.name AS helper_name,
                uh.display_name AS helper_display_name, uh.id AS helper_user_id
         FROM vehicles v
         JOIN employees a ON a.id = v.assigned_employee_id AND a.active = 1
         JOIN employees h ON h.id = v.helper_employee_id AND h.active = 1
         JOIN users u ON u.active = 1
           AND lower(trim(u.display_name)) = lower(trim(a.name))
         LEFT JOIN users uh ON uh.active = 1
           AND lower(trim(uh.display_name)) = lower(trim(h.name))
         WHERE IFNULL(v.status, '') != 'retired'
           AND v.assigned_employee_id IS NOT NULL
           AND v.helper_employee_id IS NOT NULL`
      )
      .all<{
        user_id: number;
        helper_name: string;
        helper_display_name: string | null;
        helper_user_id: number | null;
      }>();
    for (const r of trucks.results || []) {
      if (out.has(r.user_id)) continue;
      const full = fullName(r.helper_display_name, r.helper_name);
      if (!full || !(r.user_id > 0)) continue;
      out.set(r.user_id, {
        partnerFull: full,
        partnerUserId:
          r.helper_user_id != null && r.helper_user_id > 0
            ? r.helper_user_id
            : null,
      });
    }
  } catch {
    /* vehicle helper optional */
  }
  return out;
}

/**
 * Board sticky/pair label: always "First L" (Abel H, Jaden D).
 * Pairs: "Abel H/Geo M". Never bare "Chris".
 */
function shortBoardLabel(full: string): string {
  const t = String(full || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  if (t.includes("/")) {
    return t
      .split("/")
      .map((p) => shortBoardLabel(p.trim()))
      .filter(Boolean)
      .join("/");
  }
  const parts = t.split(/\s+/).filter(Boolean);
  const first = parts[0] || t;
  // Never emit a bare first name that is only "Chris" (Brady/Miller/Marroquin risk)
  if (first.toLowerCase() === "chris" && parts.length === 1) return "";
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1];
  const initial = last.charAt(0).toUpperCase();
  return `${first} ${initial}`;
}

function mergeJobLists(a: DayBoardJob[], b: DayBoardJob[]): DayBoardJob[] {
  const seen = new Set<string>();
  const out: DayBoardJob[] = [];
  for (const j of [...a, ...b]) {
    const k =
      j.st_appointment_id ||
      `${j.st_job_id}|${j.window_start}|${j.address}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...j, helpers: [] });
  }
  out.sort((x, y) =>
    String(x.window_start || "").localeCompare(String(y.window_start || ""))
  );
  return out;
}

/** Oct-sheet style: one Install row `Beto/Geo`, shared jobs; helper row absorbed.
 * If either side has PTO/OFF, split — never imply the helper is also out.
 */
function mergeInstallPairRows(
  rows: DayBoardTechRow[],
  faPairs: Map<number, FaInstallPair>
): DayBoardTechRow[] {
  const byUser = new Map<number, DayBoardTechRow>();
  for (const r of rows) {
    if (r.user_id != null) byUser.set(r.user_id, r);
  }
  const helperOf = new Map<number, number>();
  for (const [primId, p] of faPairs) {
    if (p.partnerUserId != null) helperOf.set(p.partnerUserId, primId);
  }
  // Never fall back to raw full name — bare "Chris" must stay blank/filtered
  const label = (full: string) => shortBoardLabel(full);

  const used = new Set<number>();
  const out: DayBoardTechRow[] = [];

  for (const row of rows) {
    if (row.crew !== "install") {
      out.push(row);
      continue;
    }
    if (row.user_id != null && used.has(row.user_id)) continue;

    const uid = row.user_id;
    const pair = uid != null ? faPairs.get(uid) : undefined;

    if (uid != null && helperOf.has(uid)) {
      const primId = helperOf.get(uid)!;
      const prim = byUser.get(primId);
      const rev = faPairs.get(uid);
      const mutual = rev?.partnerUserId === primId;
      if (prim && prim.crew === "install") {
        const eitherPto =
          (prim.pto && prim.pto.length > 0) || (row.pto && row.pto.length > 0);
        if (eitherPto) {
          // Will be emitted when we visit each row as solo — don't absorb
        } else if (!mutual || uid > primId) {
          continue;
        }
      }
    }

    if (pair && uid != null) {
      const pid = pair.partnerUserId;
      const partner = pid != null ? byUser.get(pid) : undefined;
      const eitherPto =
        (row.pto && row.pto.length > 0) ||
        !!(partner?.pto && partner.pto.length > 0);

      // Either side OFF/PTO → never glue names; PTO person stays alone OFF
      if (eitherPto) {
        out.push({
          ...row,
          display_name: label(row.display_name) || row.display_name,
          jobs: row.jobs.map((j) => ({ ...j, helpers: [] })),
          pto: row.pto || [],
        });
        used.add(uid);
        if (
          partner &&
          pid != null &&
          !used.has(pid) &&
          partner.crew === "install"
        ) {
          out.push({
            ...partner,
            display_name: label(partner.display_name) || partner.display_name,
            jobs: partner.jobs.map((j) => ({ ...j, helpers: [] })),
            pto: partner.pto || [],
          });
          used.add(pid);
        }
        continue;
      }

      if (
        partner &&
        partner.crew === "install" &&
        pid != null &&
        !used.has(pid)
      ) {
        const rev = faPairs.get(pid);
        if (rev?.partnerUserId === uid && pid < uid) {
          // mutual: lower id owns merge
          continue;
        }
        const a = label(row.display_name);
        const b = label(partner.display_name || pair.partnerFull);
        out.push({
          ...row,
          display_name: `${a}/${b}`,
          is_self: row.is_self || partner.is_self,
          jobs: mergeJobLists(row.jobs, partner.jobs),
          pto: [],
        });
        used.add(uid);
        used.add(pid);
        continue;
      }
      if (pair.partnerFull) {
        // Partner not on Install board — Name/Helper label only when both available
        out.push({
          ...row,
          display_name: `${label(row.display_name)}/${label(pair.partnerFull)}`,
          jobs: row.jobs.map((j) => ({ ...j, helpers: [] })),
        });
        used.add(uid);
        continue;
      }
    }

    out.push({
      ...row,
      jobs: row.jobs.map((j) => ({ ...j, helpers: [] })),
    });
    if (uid != null) used.add(uid);
  }
  return out;
}

function isBoardExtraName(display: string, username: string | null): boolean {
  const n = String(display || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const u = String(username || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "");
  // Adam always on Service board (even OFF / PTO)
  if (n === "adam bosquez" || n.startsWith("adam bosquez ")) return true;
  if (u === "adambosquez") return true;
  return false;
}

/** Chris Miller = supervisor only — never on Day Board (any crew / Unassigned). */
/** Chris Marroquin (ops) + bare Chris — never on Day Board. */
function isExcludedBoardChrisName(
  display: string | null | undefined,
  username?: string | null
): boolean {
  const n = String(display || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const u = String(username || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "");
  if (n === "chris" || n === "chris marroquin" || n.startsWith("chris marroquin ")) return true;
  if (n === "chris brady" || n.startsWith("chris brady ")) return true;
  // Shortened First L forms after label pass
  if (n === "chris m" || n === "chris b") return true;
  if (u === "chris" || u === "chrismarroquin" || u === "cmarroquin" || u === "chrisbrady") {
    return true;
  }
  if (n.startsWith("chris/") || n.endsWith("/chris")) return true;
  return false;
}

function isChrisMillerName(
  display: string | null | undefined,
  username?: string | null
): boolean {
  const n = String(display || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const u = String(username || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "");
  if (u === "chrismiller" || u === "cmiller") return true;
  if (n === "chris miller" || n.startsWith("chris miller ")) return true;
  if (n === "chris m") return true; // First L after label pass
  // "Miller, Chris" / "C Miller"
  if (/\bmiller\b/.test(n) && /\bchris\b/.test(n)) return true;
  return false;
}

/** Ops Chris + Miller — never appear on Service or Install. */
function isHiddenDayBoardPerson(
  display: string | null | undefined,
  username?: string | null
): boolean {
  return (
    isChrisMillerName(display, username) ||
    isExcludedBoardChrisName(display, username)
  );
}


async function loadFieldUsers(db: D1Database): Promise<FaUser[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT id, display_name, username, email, phone, st_technician_id, role
         FROM users
         WHERE active = 1 AND IFNULL(is_warehouse, 0) = 0
           AND (
             role = 'driver'
             OR role = 'supervisor'
           )
         ORDER BY display_name COLLATE NOCASE ASC`
      )
      .all<FaUser>();
    const all = rows.results || [];
    // Drivers always; supervisors only when named board locks (Adam / Chris Miller)
    // or they have an ST tech id (can appear on dispatch).
    return all.filter((u) => {
      if (isHiddenDayBoardPerson(u.display_name, u.username)) return false;
      if (u.role === "driver") return true;
      if (u.role === "supervisor") {
        // Adam only among supervisors (not Miller, not other office supers)
        if (isBoardExtraName(u.display_name, u.username)) return true;
      }
      return false;
    });
  } catch {
    try {
      const rows = await db
        .prepare(
          `SELECT id, display_name, username, email, phone, st_technician_id, role
           FROM users WHERE active = 1 AND role = 'driver'
           ORDER BY display_name COLLATE NOCASE ASC`
        )
        .all<FaUser>();
      return (rows.results || []).filter(
        (u) => !isHiddenDayBoardPerson(u.display_name, u.username)
      );
    } catch {
      return [];
    }
  }
}

export async function buildDayBoard(
  env: Env,
  db: D1Database,
  user: PublicUser,
  dateRaw: string | null | undefined
): Promise<DayBoardResponse> {
  const view = dayBoardView(user);
  const dateIn = (dateRaw || "").trim() || shopTodayIso();
  const bounds = dayBoundsForIsoDate(dateIn);
  const empty: DayBoardResponse = {
    date: dateIn,
    timezone: TZ,
    view,
    st_write_enabled: false,
    rows: [],
  };

  if (!canViewDayBoard(user)) {
    return { ...empty, error: "Forbidden" };
  }
  if (!bounds) {
    return { ...empty, error: "Invalid date — use YYYY-MM-DD" };
  }

  if (!(await stConfigured(env, db))) {
    return {
      ...empty,
      date: bounds.date,
      message: "ServiceTitan not connected.",
    };
  }
  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return { ...empty, date: bounds.date, message: "ServiceTitan tenant missing." };
  }

  const [apptRes, techsRes, fieldUsers, faPairs] = await Promise.all([
    fetchAppointmentsForDay(env, db, tenantId, bounds.startOff, bounds.endBeforeOff),
    loadStTechnicians(env, db, tenantId),
    loadFieldUsers(db),
    loadFaInstallPairs(db),
  ]);

  if (!apptRes.ok) {
    return {
      ...empty,
      date: bounds.date,
      error: apptRes.error || "Could not load appointments.",
    };
  }

  const techs: StTechnician[] = (techsRes.ok ? techsRes.techs : []).filter(
    (t) => !isHiddenDayBoardPerson(t.name)
  );
  const techNameById = new Map<number, string>();
  const teamByStId = new Map<number, string | null>();
  const millerStIds = new Set<number>();
  for (const t of techsRes.ok ? techsRes.techs : []) {
    if (isHiddenDayBoardPerson(t.name)) millerStIds.add(t.id);
  }
  for (const t of techs) {
    techNameById.set(t.id, t.name);
    teamByStId.set(t.id, t.team);
  }

  // Resolve FA user → ST tech id
  type Resolved = {
    user: FaUser | null;
    stId: number | null;
    display_name: string;
  };
  const resolved: Resolved[] = [];
  const stToUser = new Map<number, FaUser>();

  for (const u of fieldUsers) {
    const match = matchUserToStTechnician(
      {
        display_name: u.display_name,
        username: u.username,
        email: u.email,
        phone: u.phone,
        st_technician_id: u.st_technician_id,
      },
      techs
    );
    const stored =
      u.st_technician_id != null && Number(u.st_technician_id) > 0
        ? Number(u.st_technician_id)
        : null;
    const stId = stored || (match.status === "matched" ? match.stId : null);
    resolved.push({ user: u, stId, display_name: u.display_name });
    if (stId) stToUser.set(stId, u);
  }

  // JPM often omits technicianIds — fill from Dispatch appointment-assignments
  const apptIdNums = apptRes.appointments
    .map((a) => Number(a.id))
    .filter((n) => n > 0);
  const assignLookup = await fetchTechIdsByAppointment(
    env,
    db,
    tenantId,
    apptIdNums
  );

  // JPM appointments often omit street — enrich from job location (same as jobClock)
  const jobIdNums = apptRes.appointments
    .map((a) => Number(a.jobId))
    .filter((n) => n > 0);
  const jobMap = await enrichJobs(env, db, tenantId, jobIdNums);

  // Jobs by technician id
  const jobsByTech = new Map<number, DayBoardJob[]>();
  const unassigned: DayBoardJob[] = [];

  for (const a of apptRes.appointments) {
    const jid = Number(a.jobId);
    const chip = parseJobChip(a, jid > 0 ? jobMap.get(jid) : undefined);
    if (!chip.st_appointment_id) continue;
    let ids = techIdsFromAppt(a);
    if (!ids.length) {
      const fromDispatch = assignLookup.map.get(Number(a.id));
      if (fromDispatch?.length) ids = fromDispatch;
    }
    if (!ids.length) {
      unassigned.push(chip);
      continue;
    }
    for (const tid of ids) {
      if (millerStIds.has(tid)) continue; // never attribute to Chris Miller
      const list = jobsByTech.get(tid) || [];
      list.push(chip);
      jobsByTech.set(tid, list);
    }
  }

  // Sort jobs by window start
  for (const [, list] of jobsByTech) {
    list.sort((x, y) =>
      String(x.window_start || "").localeCompare(String(y.window_start || ""))
    );
  }

  const selfStId =
    user.st_technician_id != null && Number(user.st_technician_id) > 0
      ? Number(user.st_technician_id)
      : (() => {
          const m = matchUserToStTechnician(
            {
              display_name: user.display_name,
              username: user.username,
              email: user.email,
              phone: user.phone,
              st_technician_id: user.st_technician_id,
            },
            techs
          );
          return m.status === "matched" ? m.stId : null;
        })();

  let rows: DayBoardTechRow[] = [];

  if (view === "self") {
    const meUser = fieldUsers.find((u) => u.id === user.id) || null;
    const stId = selfStId;
    const jobs = stId ? jobsByTech.get(stId) || [] : [];
    rows = [
      {
        user_id: user.id,
        display_name: user.display_name,
        st_technician_id: stId,
        is_self: true,
        crew: crewFromTeam(stId ? teamByStId.get(stId) : null),
        jobs,
        pto: [],
      },
    ];
    void meUser;
  } else {
    // Office: all FA field users + any ST tech who has jobs that day but no FA row
    const seenSt = new Set<number>();
    for (const r of resolved) {
      if (r.stId) seenSt.add(r.stId);
      rows.push({
        user_id: r.user?.id ?? null,
        display_name: r.display_name,
        st_technician_id: r.stId,
        is_self: r.user?.id === user.id,
        crew: crewFromTeam(r.stId ? teamByStId.get(r.stId) : null),
        jobs: r.stId ? jobsByTech.get(r.stId) || [] : [],
        pto: [],
      });
    }
    for (const [stId, jobs] of jobsByTech) {
      if (seenSt.has(stId)) continue;
      if (millerStIds.has(stId)) continue;
      const stName = techNameById.get(stId) || `ST tech ${stId}`;
      if (isHiddenDayBoardPerson(stName)) continue;
      rows.push({
        user_id: null,
        display_name: stName,
        st_technician_id: stId,
        is_self: false,
        crew: crewFromTeam(teamByStId.get(stId)),
        jobs,
        pto: [],
      });
    }
    // Board lock: Adam = service tech (always listed, even OFF / no jobs)
    for (const row of rows) {
      if (row.user_id == null) continue;
      const u = fieldUsers.find((x) => x.id === row.user_id);
      if (!u) continue;
      if (isBoardExtraName(u.display_name, u.username)) {
        row.crew = "service";
        row.is_supervisor = false;
      }
    }
    rows.sort((a, b) => {
      const ac = a.crew === "install" ? 1 : 0;
      const bc = b.crew === "install" ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return a.display_name.localeCompare(b.display_name, undefined, {
        sensitivity: "base",
      });
    });
  }

  // PTO overlay — load ALL approved covering this day (office), weekdays only.
  // Do not filter to board userIds first: people on PTO with no ST jobs must still show OFF.
  const ptoLoad = await loadPtoForDate(
    db,
    bounds.date,
    view === "self" ? [user.id] : null
  );
  const ptoMap = ptoLoad.map;
  const nameByUserId = new Map<number, string>();
  for (const u of fieldUsers) nameByUserId.set(u.id, u.display_name);
  // Prefer full names from the PTO join (display_name / employee name)
  for (const [uid, nm] of ptoLoad.names) {
    if (nm) nameByUserId.set(uid, nm);
  }
  // Names for any remaining PTO users not yet resolved
  if (ptoMap.size) {
    const missing = [...ptoMap.keys()].filter((id) => !nameByUserId.has(id));
    if (missing.length) {
      try {
        const q = await db
          .prepare(
            `SELECT id, display_name FROM users
             WHERE id IN (${missing.map(() => "?").join(",")})`
          )
          .bind(...missing)
          .all<{ id: number; display_name: string }>();
        for (const r of q.results || []) {
          nameByUserId.set(Number(r.id), String(r.display_name || `User ${r.id}`));
        }
      } catch {
        /* ignore */
      }
    }
  }
  const paintPto = (list: DayBoardTechRow[]) =>
    ptoLoad.ok
      ? applyPtoToRows(list, ptoMap, nameByUserId, ptoLoad.byNormName)
      : list;

  rows = paintPto(rows);

  // FA install pairs: one row label Name/Helper (Oct sheet), shared jobs.
  // Pair merge splits when either side has PTO (helper stays available).
  rows = mergeInstallPairRows(rows, faPairs);
  rows = paintPto(rows);

  // Final hard lock: never show Chris Miller / Marroquin / Brady / bare Chris
  rows = rows.filter(
    (r) =>
      !isHiddenDayBoardPerson(r.display_name) &&
      !(r.st_technician_id != null && millerStIds.has(r.st_technician_id))
  );

  // Board labels: First L everywhere (pairs already labeled in merge)
  rows = rows.map((r) => {
    if (r.display_name === "Unassigned") return r;
    if (r.display_name.includes("/")) {
      // Re-normalize each side
      const labeled = shortBoardLabel(r.display_name);
      return labeled ? { ...r, display_name: labeled } : r;
    }
    const labeled = shortBoardLabel(r.display_name);
    return labeled ? { ...r, display_name: labeled } : r;
  });
  rows = rows.filter(
    (r) =>
      r.display_name === "Unassigned" ||
      (!!r.display_name && !isHiddenDayBoardPerson(r.display_name))
  );

  let message: string | undefined;
  if (assignLookup.scopeMissing && view === "office") {
    message =
      "ST Appointment Assignments (Read) scope missing — tech rows may be incomplete. Enable Dispatch → Appointment Assignments in the ST app.";
  }
  if (!rows.some((r) => r.jobs.length) && !unassigned.length) {
    message = message || "No appointments on this day.";
  } else if (unassigned.length && view === "office") {
    // Only show Unassigned when there are actually unassigned jobs
    rows.push({
      user_id: null,
      display_name: "Unassigned",
      st_technician_id: null,
      is_self: false,
      crew: "service",
      jobs: unassigned.sort((a, b) =>
        String(a.window_start || "").localeCompare(String(b.window_start || ""))
      ),
      pto: [],
    });
  }

  // Last step: re-apply approved PTO after every rebuild (appointments, pairs, filters)
  rows = paintPto(rows);

  return {
    date: bounds.date,
    timezone: TZ,
    view,
    st_write_enabled: false,
    rows,
    message,
  };
}
