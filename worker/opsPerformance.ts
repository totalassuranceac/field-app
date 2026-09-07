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

const TZ = "America/Chicago";
const ZC_TYPE_NAMES = ["Follow-up Visit", "Warranty Service"] as const;
const SALES_EXCLUDE = "Customer Quote";

export type OpsPeriod = "this_week" | "last_week" | "this_month" | "last_month";

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
};

export type OpsJobLine = {
  st_job_id: string;
  job_number: string | null;
  customer_name: string | null;
  address: string | null;
  completed_at: string | null;
  total: number | null;
  job_type: string | null;
};

export type OpsPerformanceResponse = {
  period: OpsPeriod;
  period_label: string;
  prior_label: string;
  timezone: string;
  service: OpsPersonRow[];
  install: OpsPersonRow[];
  pulse: {
    jobs: number | null;
    jobs_prior: number | null;
    jobs_delta: number | null;
  };
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

/** Monday-based week in America/Chicago (Mon 00:00 → next Mon 00:00). */
function weekStartMonday(now = new Date()): { y: number; m: number; day: number } {
  const { y, m, day } = chicagoParts(now);
  const noon = zonedLocalToUtc(y, m, day, 12, 0, 0);
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
  const offset = map[weekday] ?? 0;
  let cy = y;
  let cm = m;
  let cd = day;
  for (let i = 0; i < offset; i++) {
    const n = chicagoParts(new Date(zonedLocalToUtc(cy, cm, cd, 12, 0, 0).getTime() - 30 * 3600 * 1000));
    cy = n.y;
    cm = n.m;
    cd = n.day;
  }
  return { y: cy, m: cm, day: cd };
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

function weekLabel(start: { y: number; m: number; day: number }): string {
  const d = zonedLocalToUtc(start.y, start.m, start.day, 12, 0, 0);
  return `Week of ${d.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  })}`;
}

export function resolveOpsPeriods(period: OpsPeriod, now = new Date()): {
  current: WindowOff;
  prior: WindowOff;
} {
  const cur = chicagoParts(now);
  if (period === "this_month" || period === "last_month") {
    let y = cur.y;
    let m = cur.m;
    if (period === "last_month") {
      m -= 1;
      if (m < 1) {
        m = 12;
        y -= 1;
      }
    }
    const current = monthWindow(y, m);
    let py = y;
    let pm = m - 1;
    if (pm < 1) {
      pm = 12;
      py -= 1;
    }
    return { current, prior: monthWindow(py, pm) };
  }

  // weeks
  let start = weekStartMonday(now);
  if (period === "last_week") {
    const noon = zonedLocalToUtc(start.y, start.m, start.day, 12, 0, 0);
    const prev = chicagoParts(new Date(noon.getTime() - 30 * 3600 * 1000));
    // walk back to previous Monday
    start = weekStartMonday(zonedLocalToUtc(prev.y, prev.m, prev.day, 12, 0, 0));
  }
  const current = windowFromLocalDays(start.y, start.m, start.day, 7, weekLabel(start));
  const noon = zonedLocalToUtc(start.y, start.m, start.day, 12, 0, 0);
  const prevDay = chicagoParts(new Date(noon.getTime() - 30 * 3600 * 1000));
  const priorStart = weekStartMonday(zonedLocalToUtc(prevDay.y, prevDay.m, prevDay.day, 12, 0, 0));
  const prior = windowFromLocalDays(
    priorStart.y,
    priorStart.m,
    priorStart.day,
    7,
    weekLabel(priorStart)
  );
  return { current, prior };
}

export function parseOpsPeriod(raw: string | null | undefined): OpsPeriod {
  const p = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (p === "last_week" || p === "lastweek") return "last_week";
  if (p === "this_month" || p === "thismonth") return "this_month";
  if (p === "last_month" || p === "lastmonth") return "last_month";
  return "this_week";
}

export function canViewOpsPerformance(user: PublicUser): boolean {
  return isOfficeSide(user.role);
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
  };
}

async function fetchCompletedJobsPool(
  env: Env,
  db: D1Database,
  tenantId: string,
  win: WindowOff
): Promise<{ ok: boolean; jobs: StJobLite[]; status?: number }> {
  const jobs: StJobLite[] = [];
  let page = 1;
  while (page <= 40) {
    const q = new URLSearchParams({
      jobStatus: "Completed",
      completedOnOrAfter: win.startOff,
      completedOnOrBefore: win.endOnOrBeforeOff,
      page: String(page),
      pageSize: "100",
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
    if (body.hasMore !== true && rows.length < 100) break;
    page += 1;
  }
  return { ok: true, jobs };
}

async function resolveTypeIds(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<{ zc: Set<number>; exclude: Set<number> }> {
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
  return { zc, exclude };
}

function isCustomerQuote(job: StJobLite, excludeIds: Set<number>): boolean {
  if (job.jobTypeId != null && excludeIds.has(job.jobTypeId)) return true;
  const n = (job.jobTypeName || "").trim().toLowerCase();
  return n === "customer quote" || n === "customerquote" || /^quote$/.test(n);
}

function summarizeForTech(
  jobs: StJobLite[],
  techId: number,
  zcIds: Set<number>,
  excludeIds: Set<number>
): { jobs: number; zc: number | null; jobIds: number[] } {
  let count = 0;
  let zc = 0;
  const jobIds: number[] = [];
  const zcReady = zcIds.size > 0;
  for (const j of jobs) {
    if (!j.technicianIds.includes(techId)) continue;
    if (isCustomerQuote(j, excludeIds)) continue;
    count += 1;
    jobIds.push(j.id);
    if (zcReady && j.jobTypeId != null && zcIds.has(j.jobTypeId)) zc += 1;
  }
  return { jobs: count, zc: zcReady ? zc : null, jobIds };
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
  withSales: boolean
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
      });
      continue;
    }
    const cur = summarizeForTech(currentJobs, stId, zcIds, excludeIds);
    const pri = summarizeForTech(priorJobs, stId, zcIds, excludeIds);
    const sCur = withSales ? salesCurrent.get(stId) ?? null : null;
    const sPri = withSales ? salesPrior.get(stId) ?? null : null;
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
    });
  }

  rows.sort((a, b) =>
    a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" })
  );
  return rows;
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
    service: [],
    install: [],
    pulse: { jobs: null, jobs_prior: null, jobs_delta: null },
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
  const fieldUsers = await loadFieldUsers(db);
  const installUsers = millerId
    ? fieldUsers.filter((u) => Number(u.manager_user_id) === millerId)
    : [];
  const installIds = new Set(installUsers.map((u) => u.id));
  const serviceUsers = fieldUsers.filter((u) => !installIds.has(u.id));

  const techsRes = await loadStTechnicians(env, db, tenantId);
  const techs = techsRes.ok ? techsRes.techs : [];

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

  const [service, install] = await Promise.all([
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
      withSales
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
      false // install: jobs only, no sales race
    ),
  ]);

  // Pulse = unique completed jobs in period (ex-quote) vs prior
  const pulseJobs = curPool.jobs.filter((j) => !isCustomerQuote(j, typeIds.exclude)).length;
  const pulsePrior = priPool.jobs.filter((j) => !isCustomerQuote(j, typeIds.exclude)).length;

  let message: string | undefined;
  if (!millerId) {
    message = "Install crew: link Chris Miller as manager on duct techs in People.";
  } else if (!installUsers.length) {
    message = "Install crew: no active field logins report to Chris Miller yet.";
  }

  return {
    period,
    period_label: current.label,
    prior_label: prior.label,
    timezone: TZ,
    service,
    install: install.map((r) => ({
      ...r,
      sales: null,
      sales_prior: null,
      sales_delta: null,
      zero_charge: null,
      zero_charge_prior: null,
      zero_charge_delta: null,
    })),
    pulse: {
      jobs: pulseJobs,
      jobs_prior: pulsePrior,
      jobs_delta: pulseJobs - pulsePrior,
    },
    miller_user_id: millerId,
    message,
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
  const inv = await loadInvoiceTotalsForJobIds(
    env,
    db,
    tenantId,
    mine.map((j) => j.id)
  );
  const lines: OpsJobLine[] = mine.map((j) => ({
    st_job_id: String(j.id),
    job_number: j.jobNumber,
    customer_name: j.customerName,
    address: j.address,
    completed_at: j.completedOn,
    total: inv.ok ? inv.byJobId.get(j.id) ?? null : null,
    job_type: j.jobTypeName,
  }));
  lines.sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
  return {
    period,
    period_label: current.label,
    display_name: target.display_name,
    jobs: lines,
  };
}
