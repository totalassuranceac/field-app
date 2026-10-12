/**
 * Ops Performance — office/admin/supervisor only.
 * Read-only ServiceTitan jobs + invoices. No ST writes.
 */

import type { Env, PublicUser } from "./types";
import { isOfficeSide } from "./auth";
import { stApiGet, stConfigured, stTenantId } from "./servicetitan";
import {
  loadInvoiceTotalsForJobIds,
  loadStTechnicians,
  matchUserToStTechnician,
  normName,
  type StTechnician,
} from "./zeroCharge";
import { resolveHardLockPairs } from "./installCrewPairs";
import {
  averageTicket,
  comebackRate,
  countComebackTypes,
  emptyCoaching,
  recallsForTech,
  type OpsCoaching,
} from "./opsCoaching";

const TZ = "America/Chicago";
const ZC_TYPE_NAMES = ["Follow-up Visit", "Warranty Service"] as const;
const SALES_EXCLUDE = "Customer Quote";

/** Short in-isolate cache so jobs-first then sales-second paints don't re-hit ST twice. */
const OPS_POOL_CACHE_TTL_MS = 90_000;
/** Bump when window math / attribution keys change so stale all-zero caches die. */
const OPS_CACHE_VER = "v7-coaching";
/** Original jobs for recalls, so the sales follow-up request does not fetch them again. */
const RECALL_ORIGINAL_CAP = 50;
const recallOriginalCache = new Map<number, { at: number; job: StJobLite }>();
type OpsPoolCacheEntry = {
  at: number;
  jobs: StJobLite[];
};
const opsPoolCache = new Map<string, OpsPoolCacheEntry>();
type OpsTypesCacheEntry = { at: number; zc: Set<number>; exclude: Set<number> };
let opsTypesCache: OpsTypesCacheEntry | null = null;

export type OpsPeriod = "7" | "30" | "90";

export type OpsPersonRow = {
  user_id: number;
  display_name: string;
  st_technician_id: number | null;
  jobs: number | null;
  jobs_prior: number | null;
  jobs_delta: number | null;
  sales: number | null;
  sales_prior: number | null;
  sales_delta: number | null;
  zero_charge: number | null;
  zero_charge_prior: number | null;
  zero_charge_delta: number | null;
  status: "ok" | "unavailable";
} & OpsCoaching;

export type OpsJobLine = {
  st_job_id: string;
  job_number: string | null;
  customer_name: string | null;
  address: string | null;
  completed_at: string | null;
  total: number | null;
  job_type: string | null;
  is_comeback: boolean;
  recall_for_job_id: string | null;
  recall_for_job_number: string | null;
};

/** Install row: pair (side-by-side) or solo, ranked by combined production */
export type OpsInstallTeam = {
  key: string;
  label: string;
  members: OpsPersonRow[];
  jobs: number | null;
  jobs_prior: number | null;
  jobs_delta: number | null;
  status: "ok" | "unavailable";
};

export type OpsPerformanceResponse = {
  period: OpsPeriod;
  period_label: string;
  prior_label: string;
  timezone: string;
  //** office = full board; self = caller row + HARD LOCK crew partner only */
  view: "office" | "self";
  service: OpsPersonRow[];
  /** @deprecated use install_teams — kept for older clients */
  install: OpsPersonRow[];
  install_teams: OpsInstallTeam[];
  pulse: {
    jobs: number | null;
    jobs_prior: number | null;
    jobs_delta: number | null;
    /** Completed jobs that have at least one ST tech stamp */
    jobs_tagged: number | null;
    jobs_tagged_prior: number | null;
  };
  /** Jobs/day sparkline for selected lookback (Chicago). Office=shop; self=caller. */
  sparkline: {
    dates: string[];
    jobs: number[];
  };
  /** Excitement path: caller's own totals + vs prior (no public leaderboard). */
  self_summary: {
    user_id: number;
    display_name: string;
    jobs: number | null;
    jobs_prior: number | null;
    jobs_delta: number | null;
    sales: number | null;
    sales_prior: number | null;
    sales_delta: number | null;
  } & OpsCoaching | null;
  /** True when more than RECALL_ORIGINAL_CAP originals sat outside the loaded windows. */
  recalls_partial?: boolean;
  /** How Install vs Service was decided */
  crew_split: "st_team" | "rides_with" | "service_only";
  /** Explicit Chicago window for office trust (ISO dates) */
  window_start_date?: string;
  window_end_date?: string;
  miller_user_id: number | null;
  message?: string;
  error?: string;
};

type WindowOff = {
  startOff: string;
  endBeforeOff: string;
  endOnOrBeforeOff: string;
  label: string;
};

type StJobLite = {
  id: number;
  jobTypeId: number | null;
  jobTypeName: string | null;
  jobNumber: string | null;
  customerName: string | null;
  address: string | null;
  completedOn: string | null;
  technicianIds: number[];
  /** ST recallForId: this completed job calls back that earlier job. */
  recallForId: number | null;
  /** Used to enrich technicianIds via Dispatch appointment-assignments */
  appointmentIds: number[];
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
  return { y: Number(parts.year), m: Number(parts.month), day: Number(parts.day) };
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

function windowFromLocalDays(
  y: number,
  m: number,
  d: number,
  dayCount: number,
  label: string
): WindowOff {
  const start = zonedLocalToUtc(y, m, d, 0, 0, 0);
  const endProbe = chicagoParts(new Date(start.getTime() + (dayCount * 24 + 6) * 3600 * 1000));
  // Walk dayCount calendar days forward in Chicago
  let cy = y;
  let cm = m;
  let cd = d;
  for (let i = 0; i < dayCount; i++) {
    const noon = zonedLocalToUtc(cy, cm, cd, 12, 0, 0);
    const next = chicagoParts(new Date(noon.getTime() + 30 * 3600 * 1000));
    cy = next.y;
    cm = next.m;
    cd = next.day;
  }
  void endProbe;
  const endEx = zonedLocalToUtc(cy, cm, cd, 0, 0, 0);
  const endIncl = new Date(endEx.getTime() - 1000);
  return {
    startOff: toChicagoOffsetIso(start),
    endBeforeOff: toChicagoOffsetIso(endEx),
    endOnOrBeforeOff: toChicagoOffsetIso(endIncl),
    label,
  };
}

/** 0=Mon … 6=Sun in America/Chicago. */
function chicagoMondayOffset(now: Date): number {
  const noonParts = chicagoParts(now);
  const noon = zonedLocalToUtc(noonParts.y, noonParts.m, noonParts.day, 12, 0, 0);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(noon);
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return map[weekday] ?? 0;
}

function shiftChicagoYmd(
  y: number,
  m: number,
  day: number,
  deltaDays: number
): { y: number; m: number; day: number } {
  let cy = y;
  let cm = m;
  let cd = day;
  const step = deltaDays >= 0 ? 1 : -1;
  const n = Math.abs(deltaDays);
  for (let i = 0; i < n; i++) {
    const noon = zonedLocalToUtc(cy, cm, cd, 12, 0, 0);
    const next = chicagoParts(
      new Date(noon.getTime() + step * 30 * 3600 * 1000)
    );
    cy = next.y;
    cm = next.m;
    cd = next.day;
  }
  return { y: cy, m: cm, day: cd };
}

/** Monday-based week in America/Chicago (Mon 00:00 → next Mon 00:00). */
function weekStartMonday(now = new Date()): { y: number; m: number; day: number } {
  const { y, m, day } = chicagoParts(now);
  const offset = chicagoMondayOffset(now);
  return shiftChicagoYmd(y, m, day, -offset);
}

function monthWindow(y: number, m: number): WindowOff {
  const start = zonedLocalToUtc(y, m, 1, 0, 0, 0);
  let ny = y;
  let nm = m + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  const endEx = zonedLocalToUtc(ny, nm, 1, 0, 0, 0);
  const endIncl = new Date(endEx.getTime() - 1000);
  const label = start.toLocaleString("en-US", { timeZone: TZ, month: "short", year: "numeric" });
  return {
    startOff: toChicagoOffsetIso(start),
    endBeforeOff: toChicagoOffsetIso(endEx),
    endOnOrBeforeOff: toChicagoOffsetIso(endIncl),
    label,
  };
}

function ymdLabel(p: { y: number; m: number; day: number }): string {
  const d = zonedLocalToUtc(p.y, p.m, p.day, 12, 0, 0);
  return d.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  });
}

function weekLabel(start: { y: number; m: number; day: number }): string {
  const endSun = shiftChicagoYmd(start.y, start.m, start.day, 6);
  return `${ymdLabel(start)} – ${ymdLabel(endSun)} (Chicago Mon–Sun)`;
}

export function lookbackDays(period: OpsPeriod): 7 | 30 | 90 {
  if (period === "7") return 7;
  if (period === "90") return 90;
  return 30;
}

/** Rolling look-back ending today (inclusive) in America/Chicago. Prior = previous N days. */
export function resolveOpsPeriods(period: OpsPeriod, now = new Date()): {
  current: WindowOff;
  prior: WindowOff;
} {
  const days = lookbackDays(period);
  const cur = chicagoParts(now);
  const start = shiftChicagoYmd(cur.y, cur.m, cur.day, -(days - 1));
  const label = `Last ${days} days (${ymdLabel(start)} – ${ymdLabel(cur)})`;
  const current = windowFromLocalDays(start.y, start.m, start.day, days, label);
  const priorStart = shiftChicagoYmd(start.y, start.m, start.day, -days);
  const priorEnd = shiftChicagoYmd(start.y, start.m, start.day, -1);
  const priorLabel = `Prior ${days} days (${ymdLabel(priorStart)} – ${ymdLabel(priorEnd)})`;
  const prior = windowFromLocalDays(
    priorStart.y,
    priorStart.m,
    priorStart.day,
    days,
    priorLabel
  );
  return { current, prior };
}

export function parseOpsPeriod(raw: string | null | undefined): OpsPeriod {
  const p = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (p === "7" || p === "d7" || p === "lookback_7" || p === "this_week" || p === "last_week" || p === "lastweek") {
    return "7";
  }
  if (p === "90" || p === "d90" || p === "lookback_90") return "90";
  // 30 + legacy month + unknown → default 30
  return "30";
}

export function canViewOpsPerformance(user: PublicUser): boolean {
  if (isOfficeSide(user.role)) return true;
  // Field: employee-ID holders (and drivers) can open their own board
  if (user.employee_id != null && Number(user.employee_id) > 0) return true;
  if (user.role === "driver") return true;
  return false;
}

/** Full shop board vs own row + HARD LOCK crew only. Supervisors/admin/office = full. */
export function opsPerformanceView(user: PublicUser): "office" | "self" {
  return isOfficeSide(user.role) ? "office" : "self";
}

function addTechId(out: Set<number>, v: unknown): void {
  const n = Number(v);
  if (n > 0) out.add(n);
}

function techIdsFromJobRow(row: Record<string, unknown>): number[] {
  const out = new Set<number>();
  addTechId(out, row.technicianId);
  addTechId(out, row.assignedTech);
  addTechId(out, row.assignedTechnicianId);
  // Do NOT use createdBy* — often office staff; would fake "tagged" and leave real techs at 0.
  if (Array.isArray(row.technicianIds)) {
    for (const v of row.technicianIds) addTechId(out, v);
  }
  const appts = row.appointments;
  if (Array.isArray(appts)) {
    for (const a of appts) {
      if (!a || typeof a !== "object") continue;
      const o = a as Record<string, unknown>;
      addTechId(out, o.technicianId);
      if (Array.isArray(o.technicianIds)) {
        for (const v of o.technicianIds) addTechId(out, v);
      }
    }
  }
  return [...out];
}

/** Same rule as Day Board: ST team label containing "install". */
function crewFromStTeam(team: string | null | undefined): "service" | "install" {
  const t = String(team || "").toLowerCase();
  if (t.includes("install")) return "install";
  return "service";
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
  const parts = [street, [city, state].filter(Boolean).join(", "), zip].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function recallIdFromRow(row: Record<string, unknown>): number | null {
  const direct = Number(row.recallForId);
  if (direct > 0) return direct;
  const nested = row.recallFor;
  if (nested && typeof nested === "object") {
    const id = Number((nested as Record<string, unknown>).id);
    if (id > 0) return id;
  }
  return null;
}

function parseJob(row: Record<string, unknown>): StJobLite | null {
  const id = Number(row.id);
  if (!(id > 0)) return null;
  const typeObj = row.type && typeof row.type === "object" ? (row.type as Record<string, unknown>) : null;
  const jobTypeId =
    row.jobTypeId != null
      ? Number(row.jobTypeId)
      : typeObj?.id != null
        ? Number(typeObj.id)
        : null;
  const jobTypeName =
    (typeof row.jobTypeName === "string" && row.jobTypeName) ||
    (typeof typeObj?.name === "string" && typeObj.name) ||
    (typeof row.type === "string" && row.type) ||
    null;
  const customer =
    (typeof row.customerName === "string" && row.customerName) ||
    (row.customer && typeof row.customer === "object"
      ? String((row.customer as Record<string, unknown>).name || "")
      : "") ||
    null;
  const apptIds = new Set<number>();
  for (const k of ["firstAppointmentId", "lastAppointmentId", "appointmentId"]) {
    const n = Number(row[k]);
    if (n > 0) apptIds.add(n);
  }
  if (Array.isArray(row.appointmentIds)) {
    for (const v of row.appointmentIds) {
      const n = Number(v);
      if (n > 0) apptIds.add(n);
    }
  }

  return {
    id,
    jobTypeId: jobTypeId != null && Number.isFinite(jobTypeId) ? jobTypeId : null,
    jobTypeName: jobTypeName ? String(jobTypeName) : null,
    jobNumber: row.jobNumber != null ? String(row.jobNumber) : row.number != null ? String(row.number) : null,
    customerName: customer && String(customer).trim() ? String(customer).trim() : null,
    address: formatAddress(row.location) || formatAddress(row.address),
    completedOn:
      (typeof row.completedOn === "string" && row.completedOn) ||
      (typeof row.completedDate === "string" && row.completedDate) ||
      null,
    technicianIds: techIdsFromJobRow(row),
    recallForId: recallIdFromRow(row),
    appointmentIds: [...apptIds],
  };
}

/**
 * JPM completed-jobs list often omits appointmentIds. Pull appointments by
 * modifiedOnOrAfter (same Day Board trick) and attach ids so Dispatch
 * appointment-assignments can stamp techs — same completed pool as shop pulse.
 */
async function attachAppointmentIdsForJobs(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobs: StJobLite[],
  win: WindowOff
): Promise<void> {
  const need = jobs.filter(
    (j) => !j.technicianIds.length && !j.appointmentIds.length
  );
  if (!need.length) return;
  const needSet = new Set(need.map((j) => j.id));
  const byJob = new Map<number, number[]>();

  const startMs = Date.parse(win.startOff);
  const lookFrom = new Date(
    (Number.isFinite(startMs) ? startMs : Date.now()) - 120 * 24 * 3600 * 1000
  );
  const modifiedOnOrAfter = toChicagoOffsetIso(lookFrom);

  let page = 1;
  while (page <= 50) {
    const q = new URLSearchParams({
      modifiedOnOrAfter,
      page: String(page),
      pageSize: "200",
    });
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/appointments?${q.toString()}`
    );
    if (!res.ok) break;
    const body = res.json as {
      data?: Array<{ id?: number; jobId?: number }>;
      hasMore?: boolean;
    };
    const rows = body.data || [];
    for (const a of rows) {
      const jobId = Number(a.jobId);
      const apptId = Number(a.id);
      if (!(jobId > 0) || !(apptId > 0) || !needSet.has(jobId)) continue;
      const list = byJob.get(jobId) || [];
      if (!list.includes(apptId)) list.push(apptId);
      byJob.set(jobId, list);
    }
    if (!rows.length || body.hasMore === false) break;
    if (body.hasMore !== true && rows.length < 200) break;
    page += 1;
  }

  for (const j of jobs) {
    const ids = byJob.get(j.id);
    if (!ids?.length) continue;
    j.appointmentIds = [...new Set([...j.appointmentIds, ...ids])];
  }
}

/**
 * JPM completed-jobs list omits technicianIds. Dispatch appointment-assignments
 * maps appointment → technician (same as Day Board). Mutates jobs in place.
 */
async function enrichJobsWithAssignmentTechs(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobs: StJobLite[]
): Promise<void> {
  const need = jobs.filter((j) => !j.technicianIds.length && j.appointmentIds.length);
  if (!need.length) return;

  const apptIds = [
    ...new Set(need.flatMap((j) => j.appointmentIds).filter((n) => n > 0)),
  ];
  if (!apptIds.length) return;

  /** appointmentId → technicianIds */
  const byAppt = new Map<number, number[]>();
  /** jobId → technicianIds (assignments also stamp jobId) */
  const byJob = new Map<number, Set<number>>();

  const chunkSize = 40;
  for (let i = 0; i < apptIds.length; i += chunkSize) {
    const chunk = apptIds.slice(i, i + chunkSize);
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
    if (!res.ok) continue;
    const body = res.json as {
      data?: Array<{
        appointmentId?: number;
        technicianId?: number;
        jobId?: number;
        active?: boolean;
      }>;
    };
    for (const row of body.data || []) {
      if (row.active === false) continue;
      const apptId = Number(row.appointmentId);
      const techId = Number(row.technicianId);
      const jobId = Number(row.jobId);
      if (!(techId > 0)) continue;
      if (apptId > 0) {
        const list = byAppt.get(apptId) || [];
        if (!list.includes(techId)) list.push(techId);
        byAppt.set(apptId, list);
      }
      if (jobId > 0) {
        const set = byJob.get(jobId) || new Set<number>();
        set.add(techId);
        byJob.set(jobId, set);
      }
    }
  }

  for (const job of jobs) {
    if (job.technicianIds.length) continue;
    const fromJob = byJob.get(job.id);
    if (fromJob?.size) {
      job.technicianIds = [...fromJob];
      continue;
    }
    const ids = new Set<number>();
    for (const apptId of job.appointmentIds) {
      for (const tid of byAppt.get(apptId) || []) ids.add(tid);
    }
    if (ids.size) job.technicianIds = [...ids];
  }
}

async function fetchCompletedJobsPool(
  env: Env,
  db: D1Database,
  tenantId: string,
  win: WindowOff
): Promise<{ ok: boolean; jobs: StJobLite[]; status?: number }> {
  const cacheKey = `${OPS_CACHE_VER}|${tenantId}|${win.startOff}|${win.endOnOrBeforeOff}`;
  const hit = opsPoolCache.get(cacheKey);
  if (hit && Date.now() - hit.at < OPS_POOL_CACHE_TTL_MS) {
    return { ok: true, jobs: hit.jobs };
  }

  const jobs: StJobLite[] = [];
  let page = 1;
  while (page <= 40) {
    const q = new URLSearchParams({
      jobStatus: "Completed",
      completedOnOrAfter: win.startOff,
      completedOnOrBefore: win.endOnOrBeforeOff,
      page: String(page),
      pageSize: "200",
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
    if (!res.ok) {
      return { ok: false, jobs, status: res.status };
    }
    const body = res.json as { data?: Record<string, unknown>[]; hasMore?: boolean };
    const rows = body.data || [];
    for (const row of rows) {
      const j = parseJob(row);
      if (j) jobs.push(j);
    }
    if (!rows.length || body.hasMore === false) break;
    if (body.hasMore !== true && rows.length < 200) break;
    page += 1;
  }
  // Same completed window as shop pulse — resolve appt ids, then Dispatch tech stamps
  await attachAppointmentIdsForJobs(env, db, tenantId, jobs, win);
  await enrichJobsWithAssignmentTechs(env, db, tenantId, jobs);
  opsPoolCache.set(cacheKey, { at: Date.now(), jobs });
  return { ok: true, jobs };
}

async function resolveTypeIds(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<{ zc: Set<number>; exclude: Set<number> }> {
  if (
    opsTypesCache &&
    Date.now() - opsTypesCache.at < OPS_POOL_CACHE_TTL_MS
  ) {
    return { zc: opsTypesCache.zc, exclude: opsTypesCache.exclude };
  }
  const zc = new Set<number>();
  const exclude = new Set<number>();
  let page = 1;
  while (page <= 30) {
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/job-types?page=${page}&pageSize=100`
    );
    if (!res.ok) break;
    const body = res.json as { data?: Array<{ id?: number; name?: string }>; hasMore?: boolean };
    for (const row of body.data || []) {
      const name = (row.name || "").trim();
      const id = Number(row.id);
      if (!(id > 0)) continue;
      if ((ZC_TYPE_NAMES as readonly string[]).includes(name)) zc.add(id);
      if (name === SALES_EXCLUDE) exclude.add(id);
    }
    if (!body.hasMore) break;
    page += 1;
  }
  opsTypesCache = { at: Date.now(), zc, exclude };
  return { zc, exclude };
}

function isCustomerQuote(job: StJobLite, excludeIds: Set<number>): boolean {
  if (job.jobTypeId != null && excludeIds.has(job.jobTypeId)) return true;
  const n = (job.jobTypeName || "").trim().toLowerCase();
  return n === "customer quote" || n === "customerquote" || /^quote$/.test(n);
}

function isComebackJob(job: StJobLite, zcIds: Set<number>): boolean {
  return zcIds.size > 0 && job.jobTypeId != null && zcIds.has(job.jobTypeId);
}

function summarizeForTech(
  jobs: StJobLite[],
  techId: number,
  zcIds: Set<number>,
  excludeIds: Set<number>
): { jobs: number; zc: number | null; jobIds: number[]; comebackNames: string[] } {
  let count = 0;
  let zc = 0;
  const jobIds: number[] = [];
  const comebackNames: string[] = [];
  const zcReady = zcIds.size > 0;
  for (const j of jobs) {
    if (!j.technicianIds.includes(techId)) continue;
    if (isCustomerQuote(j, excludeIds)) continue;
    count += 1;
    jobIds.push(j.id);
    if (zcReady && isComebackJob(j, zcIds)) {
      zc += 1;
      comebackNames.push(j.jobTypeName || "");
    }
  }
  return { jobs: count, zc: zcReady ? zc : null, jobIds, comebackNames };
}

async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (!items.length) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/** Original jobs for recalls in this window. Uses jobs already loaded, then a capped GET for the rest. */
async function loadRecallOriginals(
  env: Env,
  db: D1Database,
  tenantId: string,
  currentJobs: StJobLite[],
  alsoKnown: StJobLite[]
): Promise<{ originals: Map<number, StJobLite>; partial: boolean }> {
  const originals = new Map<number, StJobLite>();
  for (const j of [...currentJobs, ...alsoKnown]) originals.set(j.id, j);
  const missing: number[] = [];
  const seen = new Set<number>();
  const now = Date.now();
  for (const j of currentJobs) {
    const id = j.recallForId;
    if (id == null || !(id > 0) || originals.has(id) || seen.has(id)) continue;
    seen.add(id);
    const cached = recallOriginalCache.get(id);
    if (cached && now - cached.at < OPS_POOL_CACHE_TTL_MS) {
      originals.set(id, cached.job);
      continue;
    }
    missing.push(id);
  }
  const batch = missing.slice(0, RECALL_ORIGINAL_CAP);
  const fetched: StJobLite[] = [];
  await mapPool(batch, 4, async (id) => {
    try {
      const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs/${id}`);
      if (!res.ok || !res.json || typeof res.json !== "object") return;
      const body = res.json as Record<string, unknown>;
      const row =
        body.data && typeof body.data === "object" && !Array.isArray(body.data)
          ? (body.data as Record<string, unknown>)
          : body;
      const parsed = parseJob(row);
      if (!parsed) return;
      fetched.push(parsed);
    } catch {
      /* one missed original does not blank the board */
    }
  });
  await enrichJobsWithAssignmentTechs(env, db, tenantId, fetched);
  const stampedAt = Date.now();
  for (const job of fetched) {
    originals.set(job.id, job);
    recallOriginalCache.set(job.id, { at: stampedAt, job });
  }
  return { originals, partial: missing.length > RECALL_ORIGINAL_CAP };
}

type FaUser = {
  id: number;
  display_name: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  st_technician_id: number | null;
  role: string;
  is_warehouse: number;
  manager_user_id: number | null;
};

async function loadFieldUsers(db: D1Database): Promise<FaUser[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT id, display_name, username, email, phone, st_technician_id, role,
                IFNULL(is_warehouse, 0) as is_warehouse, manager_user_id
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
          `SELECT id, display_name, username, email, phone, st_technician_id, role,
                  0 as is_warehouse, NULL as manager_user_id
           FROM users
           WHERE active = 1 AND role = 'driver'
           ORDER BY display_name COLLATE NOCASE ASC`
        )
        .all<FaUser>();
      return rows.results || [];
    } catch {
      return [];
    }
  }
}

async function findMillerUserId(db: D1Database): Promise<number | null> {
  const rows = await db
    .prepare(
      `SELECT id, display_name, username FROM users WHERE active = 1`
    )
    .all<{ id: number; display_name: string; username: string | null }>();
  for (const r of rows.results || []) {
    const n = normName(r.display_name || "");
    const u = normName((r.username || "").replace(/^@/, ""));
    if (n === "chris miller" || n.startsWith("chris miller ")) return r.id;
    if (u === "chrismiller" || u === "cmiller") return r.id;
  }
  return null;
}

function delta(a: number | null, b: number | null): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) * 100) / 100;
}

async function buildRowsForUsers(
  env: Env,
  db: D1Database,
  tenantId: string,
  users: FaUser[],
  techs: StTechnician[],
  currentJobs: StJobLite[],
  priorJobs: StJobLite[],
  zcIds: Set<number>,
  excludeIds: Set<number>,
  withSales: boolean,
  originals: Map<number, StJobLite>
): Promise<OpsPersonRow[]> {
  const rows: OpsPersonRow[] = [];
  const salesCurrent = new Map<number, number>();
  const salesPrior = new Map<number, number>();

  // Resolve ST ids first
  const resolved: Array<{ u: FaUser; stId: number | null }> = [];
  for (const u of users) {
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
    const stId =
      stored || (match.status === "matched" ? match.stId : null);
    resolved.push({ u, stId });
  }

  if (withSales) {
    const allCurrentIds = new Set<number>();
    const allPriorIds = new Set<number>();
    const byTechCurrent = new Map<number, number[]>();
    const byTechPrior = new Map<number, number[]>();
    for (const { stId } of resolved) {
      if (!stId) continue;
      const cur = summarizeForTech(currentJobs, stId, zcIds, excludeIds);
      const pri = summarizeForTech(priorJobs, stId, zcIds, excludeIds);
      byTechCurrent.set(stId, cur.jobIds);
      byTechPrior.set(stId, pri.jobIds);
      for (const id of cur.jobIds) allCurrentIds.add(id);
      for (const id of pri.jobIds) allPriorIds.add(id);
    }
    const [invCur, invPri] = await Promise.all([
      loadInvoiceTotalsForJobIds(env, db, tenantId, [...allCurrentIds]),
      loadInvoiceTotalsForJobIds(env, db, tenantId, [...allPriorIds]),
    ]);
    if (invCur.ok) {
      for (const [stId, ids] of byTechCurrent) {
        let sum = 0;
        for (const id of ids) sum += invCur.byJobId.get(id) || 0;
        salesCurrent.set(stId, Math.round(sum * 100) / 100);
      }
    }
    if (invPri.ok) {
      for (const [stId, ids] of byTechPrior) {
        let sum = 0;
        for (const id of ids) sum += invPri.byJobId.get(id) || 0;
        salesPrior.set(stId, Math.round(sum * 100) / 100);
      }
    }
  }

  for (const { u, stId } of resolved) {
    if (!stId) {
      rows.push({
        user_id: u.id,
        display_name: u.display_name,
        st_technician_id: null,
        jobs: null,
        jobs_prior: null,
        jobs_delta: null,
        sales: null,
        sales_prior: null,
        sales_delta: null,
        zero_charge: null,
        zero_charge_prior: null,
        zero_charge_delta: null,
        status: "unavailable",
        ...emptyCoaching(),
      });
      continue;
    }
    const cur = summarizeForTech(currentJobs, stId, zcIds, excludeIds);
    const pri = summarizeForTech(priorJobs, stId, zcIds, excludeIds);
    const sCur = withSales ? salesCurrent.get(stId) ?? null : null;
    const sPri = withSales ? salesPrior.get(stId) ?? null : null;
    const recallPack = recallsForTech(currentJobs, originals, stId);
    rows.push({
      user_id: u.id,
      display_name: u.display_name,
      st_technician_id: stId,
      jobs: cur.jobs,
      jobs_prior: pri.jobs,
      jobs_delta: cur.jobs - pri.jobs,
      sales: sCur,
      sales_prior: sPri,
      sales_delta: delta(sCur, sPri),
      zero_charge: cur.zc,
      zero_charge_prior: pri.zc,
      zero_charge_delta:
        cur.zc != null && pri.zc != null ? cur.zc - pri.zc : null,
      status: "ok",
      comeback_jobs: cur.zc,
      comeback_rate: comebackRate(cur.zc, cur.jobs),
      comeback_types: countComebackTypes(cur.comebackNames),
      avg_ticket: averageTicket(sCur, cur.jobs),
      recalls: recallPack.recalls,
      recalls_more: recallPack.recalls_more,
    });
  }

  return rows;
}

/** Top mover first: Jobs desc, then Sales desc; unlinked (—) sink to bottom. */
function sortByProduction(a: OpsPersonRow, b: OpsPersonRow): number {
  const score = (r: OpsPersonRow) => {
    if (r.status === "unavailable" || r.jobs == null) return -1;
    return r.jobs;
  };
  const dj = score(b) - score(a);
  if (dj !== 0) return dj;
  const as = a.sales != null && Number.isFinite(a.sales) ? a.sales : -1;
  const bs = b.sales != null && Number.isFinite(b.sales) ? b.sales : -1;
  if (bs !== as) return bs - as;
  return a.display_name.localeCompare(b.display_name, undefined, {
    sensitivity: "base",
  });
}

function sumNullable(vals: Array<number | null | undefined>): number | null {
  let any = false;
  let sum = 0;
  for (const v of vals) {
    if (v == null || !Number.isFinite(v)) continue;
    any = true;
    sum += v;
  }
  return any ? sum : null;
}

function isChrisMillerUser(u: {
  display_name: string;
  username: string | null;
}): boolean {
  const n = normName(u.display_name || "");
  const un = normName((u.username || "").replace(/^@/, ""));
  if (n === "chris miller" || n.startsWith("chris miller ")) return true;
  if (un === "chrismiller" || un === "cmiller") return true;
  if (/\bmiller\b/.test(n) && /\bchris\b/.test(n)) return true;
  return false;
}

/** HARD LOCK short label: First + last initial (Abel H). Never bare first — two Johns collide. */
function shortOpsLabel(full: string): string {
  const t = String(full || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  if (t.includes("/")) {
    return t
      .split("/")
      .map((p) => shortOpsLabel(p.trim()))
      .filter(Boolean)
      .join("/");
  }
  const parts = t.split(/\s+/).filter(Boolean);
  const first = parts[0] || t;
  if (first.toLowerCase() === "chris" && parts.length === 1) return "";
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1];
  return `${first} ${last.charAt(0).toUpperCase()}`;
}

/** FA install pairs (rides_with) among a user id set — mutual or one-way. */
async function loadInstallPartnerMap(
  db: D1Database,
  userIds: Set<number>
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!userIds.size) return out;
  try {
    const rows = await db
      .prepare(
        `SELECT u.id AS user_id, up.id AS partner_user_id
         FROM employees e
         JOIN employees p ON p.id = e.rides_with_employee_id AND p.active = 1
         JOIN users u ON u.active = 1
           AND lower(trim(u.display_name)) = lower(trim(e.name))
         JOIN users up ON up.active = 1
           AND lower(trim(up.display_name)) = lower(trim(p.name))
         WHERE e.active = 1 AND e.rides_with_employee_id IS NOT NULL`
      )
      .all<{ user_id: number; partner_user_id: number }>();
    for (const r of rows.results || []) {
      const a = Number(r.user_id);
      const b = Number(r.partner_user_id);
      if (!(a > 0) || !(b > 0)) continue;
      if (!userIds.has(a) || !userIds.has(b)) continue;
      if (!out.has(a)) out.set(a, b);
    }
  } catch {
    /* rides_with optional */
  }
  return out;
}

function pushPairTeam(
  teams: OpsInstallTeam[],
  lead: OpsPersonRow,
  helper: OpsPersonRow
): void {
  const members = [lead, helper];
  const jobs = sumNullable(members.map((m) => m.jobs));
  const jobsPrior = sumNullable(members.map((m) => m.jobs_prior));
  const label = `${shortOpsLabel(lead.display_name)}/${shortOpsLabel(helper.display_name)}`;
  teams.push({
    key: `pair-${Math.min(lead.user_id, helper.user_id)}-${Math.max(lead.user_id, helper.user_id)}`,
    label,
    members,
    jobs,
    jobs_prior: jobsPrior,
    jobs_delta: jobs != null && jobsPrior != null ? jobs - jobsPrior : null,
    status: members.every((m) => m.status === "unavailable")
      ? "unavailable"
      : "ok",
  });
}

/**
 * Install crews: Chris HARD LOCK lead-first pairs first, then any remaining
 * rides_with pairs, then solos. Ranked by combined jobs (better on top).
 * Dashes (null jobs / unavailable) only when ST tech is unlinked.
 */
function buildInstallTeams(
  people: OpsPersonRow[],
  partnerOf: Map<number, number>,
  hardPairs: Array<{ leadId: number; helperId: number }> = []
): OpsInstallTeam[] {
  const byId = new Map(people.map((p) => [p.user_id, p]));
  const used = new Set<number>();
  const teams: OpsInstallTeam[] = [];

  for (const hp of hardPairs) {
    const lead = byId.get(hp.leadId);
    const helper = byId.get(hp.helperId);
    if (!lead || !helper) continue;
    if (used.has(lead.user_id) || used.has(helper.user_id)) continue;
    pushPairTeam(teams, lead, helper);
    used.add(lead.user_id);
    used.add(helper.user_id);
  }

  for (const p of people) {
    if (used.has(p.user_id)) continue;
    const partnerId = partnerOf.get(p.user_id);
    const partner = partnerId != null ? byId.get(partnerId) : undefined;
    if (partner && !used.has(partner.user_id)) {
      const back = partnerOf.get(partner.user_id);
      // Lead-first when one-way; for mutual, lower id owns only if not hard-locked above
      if (back === p.user_id && partner.user_id < p.user_id) {
        continue;
      }
      pushPairTeam(teams, p, partner);
      used.add(p.user_id);
      used.add(partner.user_id);
      continue;
    }
    teams.push({
      key: `solo-${p.user_id}`,
      label: shortOpsLabel(p.display_name) || p.display_name,
      members: [p],
      jobs: p.jobs,
      jobs_prior: p.jobs_prior,
      jobs_delta: p.jobs_delta,
      status: p.status,
    });
    used.add(p.user_id);
  }

  teams.sort((a, b) => {
    const score = (t: OpsInstallTeam) => {
      if (t.status === "unavailable" || t.jobs == null) return -1;
      return t.jobs;
    };
    const dj = score(b) - score(a);
    if (dj !== 0) return dj;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
  return teams;
}


function chicagoYmdKey(p: { y: number; m: number; day: number }): string {
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function chicagoYmdFromCompletedOn(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return chicagoYmdKey(chicagoParts(d));
}

/**
 * Jobs/day buckets for the current lookback window (Chicago calendar days).
 * techIdFilter null = shop pulse; otherwise only jobs stamped to that ST tech.
 */
function buildJobsSparkline(
  jobs: StJobLite[],
  windowStart: { y: number; m: number; day: number },
  dayCount: number,
  excludeIds: Set<number>,
  techIdFilter: number | null
): { dates: string[]; jobs: number[] } {
  const dates: string[] = [];
  const counts = new Map<string, number>();
  let cy = windowStart.y;
  let cm = windowStart.m;
  let cd = windowStart.day;
  for (let i = 0; i < dayCount; i++) {
    const key = chicagoYmdKey({ y: cy, m: cm, day: cd });
    dates.push(key);
    counts.set(key, 0);
    const next = shiftChicagoYmd(cy, cm, cd, 1);
    cy = next.y;
    cm = next.m;
    cd = next.day;
  }
  for (const j of jobs) {
    if (isCustomerQuote(j, excludeIds)) continue;
    if (techIdFilter != null && !j.technicianIds.includes(techIdFilter)) continue;
    const key = chicagoYmdFromCompletedOn(j.completedOn);
    if (!key || !counts.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { dates, jobs: dates.map((d) => counts.get(d) || 0) };
}

function pickSelfSummary(
  userId: number,
  service: OpsPersonRow[],
  install: OpsPersonRow[],
  install_teams: OpsInstallTeam[]
): OpsPerformanceResponse["self_summary"] {
  const fromService = service.find((r) => r.user_id === userId);
  if (fromService) {
    return {
      user_id: fromService.user_id,
      display_name: fromService.display_name,
      jobs: fromService.jobs,
      jobs_prior: fromService.jobs_prior,
      jobs_delta: fromService.jobs_delta,
      sales: fromService.sales,
      sales_prior: fromService.sales_prior,
      sales_delta: fromService.sales_delta,
      comeback_jobs: fromService.comeback_jobs,
      comeback_rate: fromService.comeback_rate,
      comeback_types: fromService.comeback_types,
      avg_ticket: fromService.avg_ticket,
      recalls: fromService.recalls,
      recalls_more: fromService.recalls_more,
    };
  }
  const fromInstall = install.find((r) => r.user_id === userId);
  if (fromInstall) {
    return {
      user_id: fromInstall.user_id,
      display_name: fromInstall.display_name,
      jobs: fromInstall.jobs,
      jobs_prior: fromInstall.jobs_prior,
      jobs_delta: fromInstall.jobs_delta,
      sales: fromInstall.sales,
      sales_prior: fromInstall.sales_prior,
      sales_delta: fromInstall.sales_delta,
      comeback_jobs: fromInstall.comeback_jobs,
      comeback_rate: fromInstall.comeback_rate,
      comeback_types: fromInstall.comeback_types,
      avg_ticket: fromInstall.avg_ticket,
      recalls: fromInstall.recalls,
      recalls_more: fromInstall.recalls_more,
    };
  }
  for (const team of install_teams) {
    const m = team.members.find((x) => x.user_id === userId);
    if (m) {
      return {
        user_id: m.user_id,
        display_name: m.display_name,
        jobs: m.jobs,
        jobs_prior: m.jobs_prior,
        jobs_delta: m.jobs_delta,
        sales: m.sales,
        sales_prior: m.sales_prior,
        sales_delta: m.sales_delta,
        comeback_jobs: m.comeback_jobs,
        comeback_rate: m.comeback_rate,
        comeback_types: m.comeback_types,
        avg_ticket: m.avg_ticket,
        recalls: m.recalls,
        recalls_more: m.recalls_more,
      };
    }
  }
  return null;
}

function scopeOpsToSelf(
  payload: OpsPerformanceResponse,
  userId: number
): OpsPerformanceResponse {
  const service = payload.service.filter((r) => r.user_id === userId);
  const install = payload.install.filter((r) => r.user_id === userId);
  const install_teams = payload.install_teams
    .filter((t) => t.members.some((m) => m.user_id === userId))
    .map((t) => {
      const members = t.members.filter((m) => m.user_id === userId);
      const me = members[0];
      return {
        ...t,
        members,
        jobs: me?.jobs ?? 0,
        jobs_prior: me?.jobs_prior ?? 0,
        jobs_delta: me?.jobs_delta ?? 0,
      };
    });
  return {
    ...payload,
    view: "self",
    service,
    install,
    install_teams,
  };
}

export async function buildOpsPerformance(
  env: Env,
  db: D1Database,
  user: PublicUser,
  periodRaw: string | null | undefined,
  opts: { sales?: boolean } = {}
): Promise<OpsPerformanceResponse> {
  const period = parseOpsPeriod(periodRaw);
  const { current, prior } = resolveOpsPeriods(period);
  const withSales = opts.sales !== false;

  const empty: OpsPerformanceResponse = {
    period,
    period_label: current.label,
    prior_label: prior.label,
    timezone: TZ,
    view: opsPerformanceView(user),
    service: [],
    install: [],
    install_teams: [],
    pulse: {
      jobs: null,
      jobs_prior: null,
      jobs_delta: null,
      jobs_tagged: null,
      jobs_tagged_prior: null,
    },
    sparkline: { dates: [], jobs: [] },
    self_summary: null,
    crew_split: "service_only",
    window_start_date: current.startOff.slice(0, 10),
    window_end_date: current.endBeforeOff.slice(0, 10),
    miller_user_id: null,
  };

  if (!canViewOpsPerformance(user)) {
    return { ...empty, error: "Forbidden" };
  }

  if (!(await stConfigured(env, db))) {
    return {
      ...empty,
      message: "ServiceTitan not connected.",
    };
  }
  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return { ...empty, message: "ServiceTitan tenant missing." };
  }

  const millerId = await findMillerUserId(db);
  // Never list Chris Miller as a tech/installer row (supervisor only)
  const fieldUsers = (await loadFieldUsers(db)).filter((u) => !isChrisMillerUser(u));

  const techsRes = await loadStTechnicians(env, db, tenantId);
  const techs = (techsRes.ok ? techsRes.techs : []).filter(
    (t) => !isChrisMillerUser({ display_name: t.name || "", username: null })
  );

  // Install vs Service — Chris HARD LOCK pairs + ST team "install" + rides_with.
  // Never invent an empty Install section as gospel.
  const allFieldIds = new Set(fieldUsers.map((u) => u.id));
  const ridePartners = await loadInstallPartnerMap(db, allFieldIds);
  const hardResolved = resolveHardLockPairs(
    fieldUsers.map((u) => ({ id: u.id, display_name: u.display_name }))
  );
  const hardPairs = hardResolved.map((p) => ({
    leadId: p.lead.id,
    helperId: p.helper.id,
  }));
  const anyStTeam = techs.some((t) => Boolean(String(t.team || "").trim()));
  const installIds = new Set<number>();
  let crew_split: OpsPerformanceResponse["crew_split"] = "service_only";

  // HARD LOCK pairs always count as install crews
  for (const hp of hardPairs) {
    installIds.add(hp.leadId);
    installIds.add(hp.helperId);
    crew_split = "rides_with";
  }

  if (anyStTeam) {
    if (crew_split === "service_only") crew_split = "st_team";
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
      if (match.status !== "matched" || match.stId == null) continue;
      const tech = techs.find((t) => t.id === match.stId);
      if (crewFromStTeam(tech?.team) === "install") installIds.add(u.id);
    }
  }
  // rides_with pairs always count as install crews when present
  for (const [a, b] of ridePartners) {
    installIds.add(a);
    installIds.add(b);
    if (crew_split === "service_only") crew_split = "rides_with";
  }



  const installUsers =
    crew_split === "service_only"
      ? []
      : fieldUsers.filter((u) => installIds.has(u.id));
  const serviceUsers =
    crew_split === "service_only"
      ? fieldUsers
      : fieldUsers.filter((u) => !installIds.has(u.id));

  const [typeIds, curPool, priPool] = await Promise.all([
    resolveTypeIds(env, db, tenantId),
    fetchCompletedJobsPool(env, db, tenantId, current),
    fetchCompletedJobsPool(env, db, tenantId, prior),
  ]);

  if (!curPool.ok || !priPool.ok) {
    return {
      ...empty,
      miller_user_id: millerId,
      error: "Could not load completed jobs from ServiceTitan. Try again.",
    };
  }

  const recallLookup = await loadRecallOriginals(
    env,
    db,
    tenantId,
    curPool.jobs,
    priPool.jobs
  );

  const [serviceRaw, installRaw] = await Promise.all([
    buildRowsForUsers(
      env,
      db,
      tenantId,
      serviceUsers,
      techs,
      curPool.jobs,
      priPool.jobs,
      typeIds.zc,
      typeIds.exclude,
      withSales,
      recallLookup.originals
    ),
    buildRowsForUsers(
      env,
      db,
      tenantId,
      installUsers,
      techs,
      curPool.jobs,
      priPool.jobs,
      typeIds.zc,
      typeIds.exclude,
      false, // install: jobs only, no sales race
      recallLookup.originals
    ),
  ]);

  // Service: production first; sink all-zero / unlinked rows to the bottom
  const service = [...serviceRaw].sort((a, b) => {
    const aZero =
      a.status === "unavailable" ||
      ((a.jobs == null || a.jobs === 0) && (a.sales == null || a.sales === 0));
    const bZero =
      b.status === "unavailable" ||
      ((b.jobs == null || b.jobs === 0) && (b.sales == null || b.sales === 0));
    if (aZero !== bZero) return aZero ? 1 : -1;
    return sortByProduction(a, b);
  });
  const installPeople = installRaw.map((r) => ({
    ...r,
    sales: null,
    sales_prior: null,
    sales_delta: null,
    zero_charge: null,
    zero_charge_prior: null,
    zero_charge_delta: null,
  }));
  // HARD LOCK lead→helper wins over DB rides_with for pair cards
  const partnerOf = new Map<number, number>(ridePartners);
  for (const hp of hardPairs) {
    partnerOf.set(hp.leadId, hp.helperId);
    partnerOf.set(hp.helperId, hp.leadId);
  }
  const install_teams = buildInstallTeams(installPeople, partnerOf, hardPairs);

  // Pulse = all completed (ex-quote). Tagged = those with a tech stamp.
  const pulseJobs = curPool.jobs.filter((j) => !isCustomerQuote(j, typeIds.exclude)).length;
  const pulsePrior = priPool.jobs.filter((j) => !isCustomerQuote(j, typeIds.exclude)).length;
  const tagged = curPool.jobs.filter(
    (j) => !isCustomerQuote(j, typeIds.exclude) && j.technicianIds.length > 0
  ).length;
  const taggedPrior = priPool.jobs.filter(
    (j) => !isCustomerQuote(j, typeIds.exclude) && j.technicianIds.length > 0
  ).length;

  // Quiet week for linked techs is OK. Only warn when pulse has work but nothing tagged.
  let message: string | undefined;
  if (pulseJobs > 0 && tagged === 0) {
    message =
      "Completed jobs loaded, but ST didn’t stamp technicians on them — per-tech rows stay — until Dispatch appointment-assignments stamp a tech. A “—” row means ST didn’t name a tech, not that the app failed.";
  } else if (crew_split === "service_only") {
    message =
      "ST technician.team is empty and no FA install pairs — everyone is listed under Service (not a fake empty Install board).";
  }

  const full: OpsPerformanceResponse = {
    period,
    period_label: current.label,
    prior_label: prior.label,
    timezone: TZ,
    view: "office" as const,
    service,
    install: [...installPeople].sort(sortByProduction),
    install_teams,
    pulse: {
      jobs: pulseJobs,
      jobs_prior: pulsePrior,
      jobs_delta: pulseJobs - pulsePrior,
      jobs_tagged: tagged,
      jobs_tagged_prior: taggedPrior,
    },
    crew_split,
    window_start_date: current.startOff.slice(0, 10),
    window_end_date: current.endBeforeOff.slice(0, 10),
    miller_user_id: millerId,
    message,
    sparkline: { dates: [], jobs: [] },
    self_summary: null,
    recalls_partial: recallLookup.partial,
  };

  // Sparkline window = current lookback start (Chicago)
  const days = lookbackDays(period);
  const curParts = chicagoParts(new Date());
  const sparkStart = shiftChicagoYmd(curParts.y, curParts.m, curParts.day, -(days - 1));

  if (opsPerformanceView(user) === "self") {
    const scoped = scopeOpsToSelf(full, user.id);
    // Resolve caller's ST id for personal jobs/day sparkline
    const me =
      scoped.service.find((r) => r.user_id === user.id) ||
      scoped.install.find((r) => r.user_id === user.id) ||
      scoped.install_teams.flatMap((t) => t.members).find((m) => m.user_id === user.id);
    const stId = me?.st_technician_id ?? null;
    const sparkline = buildJobsSparkline(
      curPool.jobs,
      sparkStart,
      days,
      typeIds.exclude,
      stId != null && stId > 0 ? stId : -1 // -1 => empty if unlinked
    );
    // If unlinked (stId null), force empty sparkline
    const spark =
      stId != null && stId > 0
        ? sparkline
        : { dates: sparkline.dates, jobs: sparkline.dates.map(() => 0) };
    return {
      ...scoped,
      sparkline: spark,
      self_summary: pickSelfSummary(
        user.id,
        scoped.service,
        scoped.install,
        scoped.install_teams
      ),
    };
  }

  return {
    ...full,
    view: "office",
    sparkline: buildJobsSparkline(
      curPool.jobs,
      sparkStart,
      days,
      typeIds.exclude,
      null
    ),
    self_summary: null,
  };
}

export async function buildOpsPersonJobs(
  env: Env,
  db: D1Database,
  user: PublicUser,
  targetUserId: number,
  periodRaw: string | null | undefined
): Promise<{
  period: OpsPeriod;
  period_label: string;
  display_name: string;
  jobs: OpsJobLine[];
  error?: string;
  message?: string;
}> {
  const period = parseOpsPeriod(periodRaw);
  const { current } = resolveOpsPeriods(period);
  const empty = {
    period,
    period_label: current.label,
    display_name: "",
    jobs: [] as OpsJobLine[],
  };
  if (!canViewOpsPerformance(user)) {
    return { ...empty, error: "Forbidden" };
  }
  if (!(await stConfigured(env, db))) {
    return { ...empty, message: "ServiceTitan not connected." };
  }
  const tenantId = await stTenantId(env, db);
  if (!tenantId) return { ...empty, message: "ServiceTitan tenant missing." };

  const target = await db
    .prepare(
      `SELECT id, display_name, username, email, phone, st_technician_id, role
       FROM users WHERE id = ?`
    )
    .bind(targetUserId)
    .first<{
      id: number;
      display_name: string;
      username: string | null;
      email: string | null;
      phone: string | null;
      st_technician_id: number | null;
      role: string;
    }>();
  if (!target) return { ...empty, error: "Person not found" };

  // Self view: own jobs, or HARD LOCK crew partner only — never anyone else's.
  if (opsPerformanceView(user) === "self" && targetUserId !== user.id) {
    const field = await loadFieldUsers(db);
    const hard = resolveHardLockPairs(
      field.map((u) => ({ id: u.id, display_name: u.display_name }))
    );
    const crewOk = hard.some(
      (p) =>
        (p.lead.id === user.id && p.helper.id === targetUserId) ||
        (p.helper.id === user.id && p.lead.id === targetUserId)
    );
    if (!crewOk) {
      return { ...empty, error: "Forbidden" };
    }
  }

  const techsRes = await loadStTechnicians(env, db, tenantId);
  const techs = techsRes.ok ? techsRes.techs : [];
  const match = matchUserToStTechnician(target, techs);
  const stId =
    target.st_technician_id != null && Number(target.st_technician_id) > 0
      ? Number(target.st_technician_id)
      : match.status === "matched"
        ? match.stId
        : null;
  if (!stId) {
    return {
      ...empty,
      display_name: target.display_name,
      message: "No ServiceTitan technician linked.",
    };
  }

  const typeIds = await resolveTypeIds(env, db, tenantId);
  const pool = await fetchCompletedJobsPool(env, db, tenantId, current);
  if (!pool.ok) {
    return {
      ...empty,
      display_name: target.display_name,
      error: "Could not load jobs.",
    };
  }
  const mine = pool.jobs.filter(
    (j) => j.technicianIds.includes(stId) && !isCustomerQuote(j, typeIds.exclude)
  );
  const recallLookup = await loadRecallOriginals(env, db, tenantId, mine, pool.jobs);
  const inv = await loadInvoiceTotalsForJobIds(
    env,
    db,
    tenantId,
    mine.map((j) => j.id)
  );
  const lines: OpsJobLine[] = mine.map((j) => {
    const orig = j.recallForId != null ? recallLookup.originals.get(j.recallForId) : undefined;
    return {
      st_job_id: String(j.id),
      job_number: j.jobNumber,
      customer_name: j.customerName,
      address: j.address,
      completed_at: j.completedOn,
      total: inv.ok ? inv.byJobId.get(j.id) ?? null : null,
      job_type: j.jobTypeName,
      is_comeback: isComebackJob(j, typeIds.zc),
      recall_for_job_id: j.recallForId != null ? String(j.recallForId) : null,
      recall_for_job_number: orig?.jobNumber ?? null,
    };
  });
  lines.sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
  return {
    period,
    period_label: current.label,
    display_name: target.display_name,
    jobs: lines,
  };
}
