/**
 * Field App Day Board — Phase 1 read-only ServiceTitan dispatch sheet.
 * No Book / crew create (Phase 2). No Unassigned row.
 */

import type { Env } from "./types";
import { stApiGet, stTenantId } from "./servicetitan";
import { loadStTechnicians, normName, type StTechnician } from "./zeroCharge";

const TZ = "America/Chicago";

export type DayBoardInk = "st" | "board";
export type DayBoardCrew = "service" | "install";

export type DayBoardJob = {
  id: string;
  job_id: number | null;
  appointment_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  address: string | null;
  job_type: string | null;
  note: string | null;
  start: string | null;
  end: string | null;
  window_start: string | null;
  window_end: string | null;
  status: string | null;
  is_done: boolean;
  is_off: boolean;
  ink: DayBoardInk;
};

export type DayBoardTechRow = {
  st_id: number;
  display_name: string;
  first_name: string;
  crew: DayBoardCrew;
  pto: boolean;
  jobs: DayBoardJob[];
};

export type DayBoardPayload = {
  date: string;
  timezone: string;
  rows: DayBoardTechRow[];
  error?: string;
};

type StAppt = Record<string, unknown>;

export function crewFromTeam(team: string | null | undefined): DayBoardCrew {
  const t = String(team || "").toLowerCase();
  return t.includes("install") ? "install" : "service";
}

export function isOffStatus(status: string | null | undefined): boolean {
  const s = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (!s) return false;
  if (s === "out of office" || s.includes("out of office")) return true;
  if (s === "unused" || s === "canceled" || s === "cancelled") return true;
  if (s === "out" || s === "off") return true;
  return /\b(out|off)\b/.test(s);
}

function isDoneStatus(status: string | null | undefined): boolean {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  return s === "done" || s === "completed" || s === "complete";
}

function firstNonEmpty(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

export function customerPhoneFromAppt(appt: StAppt): string | null {
  const customer =
    appt.customer && typeof appt.customer === "object"
      ? (appt.customer as Record<string, unknown>)
      : {};
  const contacts = Array.isArray(customer.contacts) ? customer.contacts : [];
  const firstContact =
    contacts[0] && typeof contacts[0] === "object"
      ? (contacts[0] as Record<string, unknown>)
      : {};
  return firstNonEmpty(
    appt.customerPhone,
    appt.customerPhoneNumber,
    appt.phone,
    appt.phoneNumber,
    appt.mobilePhone,
    appt.mobilePhoneNumber,
    customer.phone,
    customer.phoneNumber,
    customer.mobilePhone,
    customer.mobilePhoneNumber,
    firstContact.phone,
    firstContact.phoneNumber,
    firstContact.mobilePhone
  );
}

function addressFromValue(loc: unknown): string | null {
  if (loc == null) return null;
  if (typeof loc === "string") return loc.trim() || null;
  if (typeof loc !== "object") return null;
  const o = loc as Record<string, unknown>;
  const street = firstNonEmpty(
    o.street,
    o.address,
    o.streetAddress,
    o.line1,
    o.addressLine1
  );
  const unit = firstNonEmpty(o.unit, o.apartment, o.suite, o.unitNumber);
  const city = firstNonEmpty(o.city);
  const parts = [street, unit, city].filter(Boolean) as string[];
  return parts.length ? parts.join(" ") : null;
}

function addressFromAppt(appt: StAppt): string | null {
  const customer =
    appt.customer && typeof appt.customer === "object"
      ? (appt.customer as Record<string, unknown>)
      : {};
  return (
    addressFromValue(appt.location) ||
    addressFromValue(appt.address) ||
    addressFromValue(appt.customerAddress) ||
    addressFromValue(customer.address) ||
    addressFromValue(customer.location) ||
    firstNonEmpty(appt.unparsedAddress, customer.unparsedAddress)
  );
}

function customerNameFromAppt(appt: StAppt): string | null {
  const customer =
    appt.customer && typeof appt.customer === "object"
      ? (appt.customer as Record<string, unknown>)
      : {};
  return firstNonEmpty(
    appt.customerName,
    customer.name,
    [customer.firstName, customer.lastName].filter(Boolean).join(" ")
  );
}

function jobTypeFromAppt(appt: StAppt): string | null {
  const jt = appt.jobType;
  if (jt && typeof jt === "object") {
    const name = firstNonEmpty((jt as Record<string, unknown>).name);
    if (name) return name;
  }
  return firstNonEmpty(
    appt.jobTypeName,
    typeof jt === "string" ? jt : null,
    appt.type,
    appt.summary
  );
}

function noteFromAppt(appt: StAppt): string | null {
  return firstNonEmpty(
    appt.specialInstructions,
    appt.notes,
    appt.note,
    appt.summary
  );
}

function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

export function parseJobChip(appt: StAppt): DayBoardJob | null {
  const appointmentId = Number(appt.id);
  const jobId = Number(appt.jobId);
  if (!(appointmentId > 0) && !(jobId > 0)) return null;

  const status = firstNonEmpty(appt.status, appt.appointmentStatus);
  const jobStatus = firstNonEmpty(appt.jobStatus);
  const is_off = isOffStatus(status) || isOffStatus(jobStatus);
  const is_done = !is_off && (isDoneStatus(status) || isDoneStatus(jobStatus));

  return {
    id: appointmentId > 0 ? `st-${appointmentId}` : `st-job-${jobId}`,
    job_id: jobId > 0 ? jobId : null,
    appointment_id: appointmentId > 0 ? appointmentId : null,
    customer_name: customerNameFromAppt(appt),
    customer_phone: customerPhoneFromAppt(appt),
    address: addressFromAppt(appt),
    job_type: jobTypeFromAppt(appt),
    note: noteFromAppt(appt),
    start: isoOrNull(appt.start ?? appt.startDate ?? appt.startsOn),
    end: isoOrNull(appt.end ?? appt.endDate ?? appt.endsOn),
    window_start: isoOrNull(appt.arrivalWindowStart ?? appt.windowStart),
    window_end: isoOrNull(appt.arrivalWindowEnd ?? appt.windowEnd),
    status: status || jobStatus,
    is_done,
    is_off,
    ink: "st",
  };
}

function firstNameOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts[0] || name.trim() || "Tech";
}

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

export function chicagoTodayIso(anchor = new Date()): string {
  const { y, m, day } = chicagoParts(anchor);
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dayBoundsChicago(dateIso: string): {
  start: Date;
  end: Date;
  startOff: string;
  endBeforeOff: string;
  endOnOrBeforeOff: string;
} {
  const [y, m, d] = dateIso.split("-").map(Number);
  const start = zonedLocalToUtc(y, m, d, 0, 0, 0);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = zonedLocalToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    0
  );
  const endIncl = new Date(end.getTime() - 1000);
  return {
    start,
    end,
    startOff: toChicagoOffsetIso(start),
    endBeforeOff: toChicagoOffsetIso(end),
    endOnOrBeforeOff: toChicagoOffsetIso(endIncl),
  };
}

function parseApptInstant(raw: unknown): Date | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/Z|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return zonedLocalToUtc(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] || 0)
    );
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function apptStartsInDayWindow(appt: StAppt, start: Date, end: Date): boolean {
  const inst = parseApptInstant(appt.start ?? appt.startDate ?? appt.startsOn);
  if (!inst) return false;
  const t = inst.getTime();
  return t >= start.getTime() && t < end.getTime();
}

function techIdsFromAppt(appt: StAppt): number[] {
  const out = new Set<number>();
  const add = (v: unknown) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out.add(n);
  };
  add(appt.technicianId);
  if (Array.isArray(appt.technicianIds)) {
    for (const v of appt.technicianIds) add(v);
  }
  const assigned = appt.assignedTechnicians;
  if (Array.isArray(assigned)) {
    for (const v of assigned) {
      if (v && typeof v === "object") add((v as { id?: unknown }).id);
      else add(v);
    }
  }
  return [...out];
}

async function pageAppointments(
  env: Env,
  db: D1Database,
  tenantId: string,
  extra: Record<string, string>
): Promise<{ ok: boolean; status: number; rows: StAppt[] }> {
  const rows: StAppt[] = [];
  let page = 1;
  let lastStatus = 200;
  while (page <= 40) {
    const q = new URLSearchParams({
      ...extra,
      page: String(page),
      pageSize: "200",
    });
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/appointments?${q.toString()}`
    );
    lastStatus = res.status;
    if (!res.ok) return { ok: false, status: res.status, rows };
    const body = res.json as { data?: StAppt[]; hasMore?: boolean };
    const chunk = body.data || [];
    for (const row of chunk) {
      if (row && typeof row === "object") rows.push(row);
    }
    if (chunk.length === 0) break;
    if (body.hasMore === false) break;
    if (body.hasMore !== true && chunk.length < 200) break;
    page += 1;
  }
  return { ok: true, status: lastStatus, rows };
}

export async function fetchAppointmentsForDay(
  env: Env,
  db: D1Database,
  tenantId: string,
  dateIso: string
): Promise<{ ok: boolean; status: number; rows: StAppt[]; via: string }> {
  const bounds = dayBoundsChicago(dateIso);

  const first = await pageAppointments(env, db, tenantId, {
    startsOnOrAfter: bounds.startOff,
    startsBefore: bounds.endBeforeOff,
  });
  if (first.ok) return { ...first, via: "startsOnOrAfter+startsBefore" };

  const second = await pageAppointments(env, db, tenantId, {
    startsOnOrAfter: bounds.startOff,
    startsOnOrBefore: bounds.endOnOrBeforeOff,
  });
  if (second.ok) return { ...second, via: "startsOnOrAfter+startsOnOrBefore" };

  const modifiedFrom = new Date(bounds.start.getTime() - 120 * 86400000);
  const third = await pageAppointments(env, db, tenantId, {
    modifiedOnOrAfter: toChicagoOffsetIso(modifiedFrom),
  });
  if (third.ok) {
    return {
      ok: true,
      status: third.status,
      rows: third.rows.filter((a) => apptStartsInDayWindow(a, bounds.start, bounds.end)),
      via: "modifiedOnOrAfter+dayWindow",
    };
  }
  return { ok: false, status: third.status, rows: [], via: "none" };
}

function jobSortKey(job: DayBoardJob): number {
  const inst = parseApptInstant(job.window_start || job.start);
  return inst ? inst.getTime() : 0;
}

async function ptoStIdsForDate(
  db: D1Database,
  dateIso: string,
  techs: StTechnician[]
): Promise<Set<number>> {
  const out = new Set<number>();
  let rows: Array<{ display_name: string | null; st_technician_id: number | null }> = [];
  try {
    const q = await db
      .prepare(
        `SELECT u.display_name, u.st_technician_id
         FROM time_off_requests r
         JOIN users u ON u.id = r.user_id
         WHERE r.status = 'approved'
           AND r.start_date <= ?
           AND r.end_date >= ?`
      )
      .bind(dateIso, dateIso)
      .all<{ display_name: string | null; st_technician_id: number | null }>();
    rows = q.results || [];
  } catch {
    return out;
  }

  const byNorm = new Map<string, StTechnician[]>();
  const byFirst = new Map<string, StTechnician[]>();
  for (const t of techs) {
    const n = normName(t.name);
    if (n) {
      const list = byNorm.get(n) || [];
      list.push(t);
      byNorm.set(n, list);
    }
    const f = normName(firstNameOf(t.name));
    if (f) {
      const list = byFirst.get(f) || [];
      list.push(t);
      byFirst.set(f, list);
    }
  }

  for (const row of rows) {
    const stored =
      row.st_technician_id != null && Number(row.st_technician_id) > 0
        ? Number(row.st_technician_id)
        : null;
    if (stored != null && techs.some((t) => t.id === stored)) {
      out.add(stored);
      continue;
    }
    const n = normName(row.display_name || "");
    if (!n) continue;
    const full = byNorm.get(n);
    if (full && full.length === 1) {
      out.add(full[0].id);
      continue;
    }
    if (n === "robert gonzalez" || n === "robert") {
      const rob = byNorm.get("roberto gonzalez");
      if (rob && rob.length === 1) {
        out.add(rob[0].id);
        continue;
      }
    }
    const first = n.split(" ")[0];
    const hits = byFirst.get(first);
    if (hits && hits.length === 1) out.add(hits[0].id);
  }
  return out;
}

export async function buildDayBoard(
  env: Env,
  db: D1Database,
  dateIso: string
): Promise<DayBoardPayload> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? dateIso : chicagoTodayIso();
  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return {
      date,
      timezone: TZ,
      rows: [],
      error: "ServiceTitan is not configured",
    };
  }

  const techLoad = await loadStTechnicians(env, db, tenantId);
  if (!techLoad.ok) {
    return {
      date,
      timezone: TZ,
      rows: [],
      error: techLoad.forbidden
        ? "ServiceTitan access denied"
        : "Could not load technicians",
    };
  }

  const techs = techLoad.techs.filter((t) => t.active !== false && t.name.trim());
  const teamByStId = new Map<number, string | null>();
  for (const t of techs) teamByStId.set(t.id, t.team ?? null);

  const appts = await fetchAppointmentsForDay(env, db, tenantId, date);
  const jobsByTech = new Map<number, DayBoardJob[]>();
  for (const appt of appts.rows) {
    const ids = techIdsFromAppt(appt);
    if (!ids.length) continue; // do not invent Unassigned
    const chip = parseJobChip(appt);
    if (!chip) continue;
    for (const id of ids) {
      const list = jobsByTech.get(id) || [];
      list.push(chip);
      jobsByTech.set(id, list);
    }
  }
  for (const list of jobsByTech.values()) {
    list.sort((a, b) => jobSortKey(a) - jobSortKey(b));
  }

  const ptoIds = await ptoStIdsForDate(db, date, techs);

  const rows: DayBoardTechRow[] = [];
  for (const t of techs) {
    rows.push({
      st_id: t.id,
      display_name: t.name,
      first_name: firstNameOf(t.name),
      crew: crewFromTeam(teamByStId.get(t.id) ?? t.team),
      pto: ptoIds.has(t.id),
      jobs: jobsByTech.get(t.id) || [],
    });
  }

  rows.sort((a, b) => {
    if (a.crew !== b.crew) return a.crew === "service" ? -1 : 1;
    return a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" });
  });

  const payload: DayBoardPayload = { date, timezone: TZ, rows };
  if (!appts.ok) {
    payload.error = "Could not load ServiceTitan appointments for this day";
  }
  return payload;
}
