/**
 * Office Day Board — Phase 1 READ-ONLY.
 * Live ST appointments for a Chicago calendar day. No ST writes.
 */

import type { Env, PublicUser } from "./types";
import { isOfficeSide } from "./auth";
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

function formatAddress(loc: unknown): string | null {
  if (!loc || typeof loc !== "object") return null;
  const o = loc as Record<string, unknown>;
  const addr =
    o.address && typeof o.address === "object"
      ? (o.address as Record<string, unknown>)
      : o;
  const street = String(addr.street || addr.streetAddress || addr.line1 || "").trim();
  const city = String(addr.city || "").trim();
  const state = String(addr.state || addr.stateProv || "").trim();
  const zip = String(addr.zip || addr.postalCode || "").trim();
  // Prefer street for chip; fall back to city line
  if (street) return street;
  const rest = [city, state, zip].filter(Boolean).join(", ");
  return rest || null;
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

  let got = await pull({ startsOnOrAfter: startOff, startsBefore: endBeforeOff });
  if (!got.ok) {
    got = await pull({ startsOnOrAfter: startOff, startsOnOrBefore: endBeforeOff });
  }
  if (got.ok) return got;

  const lookFrom = new Date(dayStartMs - 120 * 24 * 3600 * 1000);
  const modifiedOnOrAfter = toChicagoOffsetIso(lookFrom);
  const fb = await pull({ modifiedOnOrAfter });
  if (!fb.ok) return fb;
  return {
    ok: true,
    appointments: fb.appointments.filter((a) =>
      apptStartsInDayWindow(a, dayStartMs, dayEndMs)
    ),
  };
}

function parseJobChip(a: RawAppt): DayBoardJob {
  const apptId = a.id != null ? String(a.id) : "";
  const jobId = a.jobId != null ? String(a.jobId) : null;
  const status = a.status != null ? String(a.status) : null;
  const typeName =
    (typeof a.jobTypeName === "string" && a.jobTypeName) ||
    (a.jobType && typeof a.jobType === "object"
      ? String((a.jobType as Record<string, unknown>).name || "")
      : "") ||
    (typeof a.type === "string" ? a.type : "") ||
    null;
  const customer =
    (typeof a.customerName === "string" && a.customerName) ||
    (a.customer && typeof a.customer === "object"
      ? String((a.customer as Record<string, unknown>).name || "")
      : "") ||
    null;
  const note =
    shortNote(a.specialInstructions) ||
    shortNote(a.summary) ||
    shortNote(a.notes) ||
    shortNote(a.appointmentSummary) ||
    null;

  return {
    st_appointment_id: apptId,
    st_job_id: jobId,
    job_number:
      a.jobNumber != null
        ? String(a.jobNumber)
        : a.number != null
          ? String(a.number)
          : null,
    address:
      formatAddress(a.customerAddress) ||
      formatAddress(a.address) ||
      formatAddress(a.location) ||
      (typeof a.summary === "string" ? null : null),
    customer_name: customer && customer.trim() ? customer.trim() : null,
    customer_phone: customerPhoneFromAppt(a),
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
  };
}

async function loadPtoForDate(
  db: D1Database,
  date: string,
  userIds: number[] | null
): Promise<Map<number, DayBoardPto[]>> {
  const map = new Map<number, DayBoardPto[]>();
  try {
    let sql = `SELECT id, user_id, start_date, end_date, request_type
               FROM time_off_requests
               WHERE status = 'approved'
                 AND date(start_date) <= date(?)
                 AND date(end_date) >= date(?)`;
    const binds: unknown[] = [date, date];
    if (userIds && userIds.length) {
      sql += ` AND user_id IN (${userIds.map(() => "?").join(",")})`;
      binds.push(...userIds);
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
      }>();
    for (const r of rows.results || []) {
      const label = (r.request_type || "PTO").replace(/_/g, " ");
      const list = map.get(r.user_id) || [];
      list.push({
        request_id: r.id,
        label: label.charAt(0).toUpperCase() + label.slice(1),
        start_date: r.start_date,
        end_date: r.end_date,
      });
      map.set(r.user_id, list);
    }
  } catch {
    /* time_off optional */
  }
  return map;
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

async function loadFieldUsers(db: D1Database): Promise<FaUser[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT id, display_name, username, email, phone, st_technician_id, role
         FROM users
         WHERE active = 1 AND role = 'driver' AND IFNULL(is_warehouse, 0) = 0
         ORDER BY display_name COLLATE NOCASE ASC`
      )
      .all<FaUser>();
    return rows.results || [];
  } catch {
    try {
      const rows = await db
        .prepare(
          `SELECT id, display_name, username, email, phone, st_technician_id, role
           FROM users WHERE active = 1 AND role = 'driver'
           ORDER BY display_name COLLATE NOCASE ASC`
        )
        .all<FaUser>();
      return rows.results || [];
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

  const [apptRes, techsRes, fieldUsers] = await Promise.all([
    fetchAppointmentsForDay(env, db, tenantId, bounds.startOff, bounds.endBeforeOff),
    loadStTechnicians(env, db, tenantId),
    loadFieldUsers(db),
  ]);

  if (!apptRes.ok) {
    return {
      ...empty,
      date: bounds.date,
      error: apptRes.error || "Could not load appointments.",
    };
  }

  const techs: StTechnician[] = techsRes.ok ? techsRes.techs : [];
  const techNameById = new Map<number, string>();
  const teamByStId = new Map<number, string | null>();
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

  // Jobs by technician id
  const jobsByTech = new Map<number, DayBoardJob[]>();
  const unassigned: DayBoardJob[] = [];

  for (const a of apptRes.appointments) {
    const chip = parseJobChip(a);
    if (!chip.st_appointment_id) continue;
    const ids = techIdsFromAppt(a);
    if (!ids.length) {
      unassigned.push(chip);
      continue;
    }
    for (const tid of ids) {
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
      rows.push({
        user_id: null,
        display_name: techNameById.get(stId) || `ST tech ${stId}`,
        st_technician_id: stId,
        is_self: false,
        crew: crewFromTeam(teamByStId.get(stId)),
        jobs,
        pto: [],
      });
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

  // PTO overlay
  const userIds = rows
    .map((r) => r.user_id)
    .filter((id): id is number => id != null && id > 0);
  const ptoMap = await loadPtoForDate(
    db,
    bounds.date,
    view === "self" ? [user.id] : userIds.length ? userIds : null
  );
  for (const row of rows) {
    if (row.user_id != null) row.pto = ptoMap.get(row.user_id) || [];
  }

  let message: string | undefined;
  if (!rows.some((r) => r.jobs.length) && !unassigned.length) {
    message = "No appointments on this day.";
  } else if (unassigned.length && view === "office") {
    // Append unassigned row for visibility
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

  return {
    date: bounds.date,
    timezone: TZ,
    view,
    st_write_enabled: false,
    rows,
    message,
  };
}
