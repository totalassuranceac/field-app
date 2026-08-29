/**
 * Monthly Zero-charge counter from ServiceTitan.
 * Counts completed jobs whose Job Type is exactly "Follow-up Visit" or "Warranty Service".
 * Audience is locked to six Field App techs (see ZERO_CHARGE_TECH_NAMES); managers see
 * that roster only. Resolves ST technician ids by email / name / known aliases.
 * Read-only against ServiceTitan. Does not persist customer/address/invoice data.
 */

import type { Env, PublicUser } from "./types";
import { getSetting, setSetting } from "./audit";
import { isOfficeSide } from "./auth";
import { stApiGet, stConfigured, stTenantId } from "./servicetitan";

const ZERO_CHARGE_TYPE_NAMES = ["Follow-up Visit", "Warranty Service"] as const;
/** Excluded from sales totals — never count as sold revenue. */
const SALES_EXCLUDE_TYPE_NAMES = ["Customer Quote"] as const;
const TZ = "America/Chicago";
const CACHE_KEY_TYPES = "st_zero_charge_job_type_ids";
const CACHE_KEY_TECHS = "st_zero_charge_technicians";
const CACHE_TTL_MS = 5 * 60 * 1000;
const TECH_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Extra people who get the manager roster even if role is field.
 * Adam Bosquez is covered by supervisor role (not a first-name hint).
 */
const MANAGER_NAME_HINTS = [
  "chris marroquin",
  "kelsie",
  "bianca",
  "eric",
  "chris miller",
];

/**
 * Locked Zero-charge audience — Field App display names only.
 * Do not add names unless Chris says.
 */
export const ZERO_CHARGE_TECH_NAMES = [
  "Robert Gonzalez",
  "Wayne McCaskill",
  "Abel Herrera",
  "Omar Camacho",
  "Adam Bosquez",
  "Kyle Duffield",
] as const;

/**
 * Alias only: Field App Robert Gonzalez / @robertgonzalez → ST Roberto Gonzalez.
 * Never Eric Gonzalez.
 */
const ROBERT_ALIASES = new Set(["robert gonzalez", "robertgonzalez", "roberto gonzalez"]);

export type ZeroChargeRow = {
  user_id: number;
  display_name: string;
  st_technician_id: number | null;
  /** Zero-charge (Follow-up Visit + Warranty Service) counts — null if types unresolved */
  this_month: number | null;
  last_month: number | null;
  delta: number | null;
  /** Short reason when zc types did not resolve (jobs still valid) */
  zc_reason?: string | null;
  /** All completed jobs this/last month excluding Customer Quote */
  jobs_this_month: number | null;
  jobs_last_month: number | null;
  jobs_delta: number | null;
  /** Sales $ from ST invoices (not Opportunity / Jobs Total). */
  this_month_sales: number | null;
  last_month_sales: number | null;
  sales_delta: number | null;
  /** Supervisor roster rank (1 = highest this-month sales). */
  rank?: number | null;
  /** unavailable = no ST technician id linked */
  status: "ok" | "unavailable";
  /** Why unavailable (shown to tech + managers — not silent) */
  unavailable_reason?: string | null;
};

export type ZeroChargeResponse = {
  /** none = caller not in audience and not a manager — UI hides the card */
  view: "self" | "roster" | "none";
  month_label: string;
  last_month_label: string;
  timezone: string;
  job_types_used: string[];
  job_types_missing: string[];
  self: ZeroChargeRow | null;
  roster: ZeroChargeRow[];
  /** Sorted by this_month_sales desc when sales available */
  roster_sorted_by?: "sales" | "name";
  /** Core board returned first; client should fetch ?sales=1 next */
  sales_pending?: boolean;
  error?: string;
  /** Explicit permission failures (do not invent data) */
  technicians_forbidden?: boolean;
  invoices_forbidden?: boolean;
  jobs_forbidden?: boolean;
  /** How jobs/sales were attributed this response */
  attribution_source?: "jobs" | "invoices" | "none";
  /** Admin-only: raw ST jobs count for Abel this month when board looks empty */
  debug_abel_jobs_this_month?: number | null;
  debug_abel_st_technician_id?: number | null;
  /** Admin-only: ST job-type names that look like follow-up / warranty */
  debug_job_type_hints?: string[];
  /** Chris/admin only: live ST diagnose for Abel / month jobs */
  debug_diagnose?: ZeroChargeDiagnose | null;
};

/** Chris/admin-only diagnose payload (Home card). */
export type ZeroChargeDiagnose = {
  jobs_api_status: number | null;
  /** Completed jobs this Chicago month with NO technician filter (capped). */
  month_completed_count: number | null;
  month_completed_capped: boolean;
  month_completed_error?: string | null;
  /** First 3 jobs: tech-like field names + values */
  first_jobs_tech_fields: Array<{
    jobId: number | null;
    fields: Array<{ path: string; value: unknown }>;
  }>;
  abel_id_appears_in_month_jobs: boolean | null;
  abel_tech: { id: number; userId: number | null; name: string } | null;
  attribution_source: "jobs" | "invoices" | "none";
  note?: string | null;
};

const BOARD_CACHE_TTL_MS = 3 * 60 * 1000;
const BOARD_CACHE_KEY = "st_zero_charge_board_cache_v1";

type BoardCache = {
  at: number;
  thisKey: string;
  lastKey: string;
  rows: ZeroChargeRow[];
  sales_filled: boolean;
};

let memoryBoard: BoardCache | null = null;

type JobTypeCache = {
  at: number;
  ids: Record<string, number>;
  missing: string[];
  hints?: string[];
};

type CountsCache = {
  at: number;
  /** key: `${techId}:${monthKey}` → count */
  byTechMonth: Record<string, number>;
};

export type StTechnician = {
  id: number;
  /** Often same as id; keep when ST exposes a distinct login user id */
  userId: number | null;
  name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
};

/** Single user-facing failure line for Home. No ST/RFC/scope essays. */
const LOAD_FAIL = "Could not load this month. Try again.";

type TechListCache = {
  at: number;
  techs: StTechnician[];
};

export type MatchResult =
  | { status: "matched"; stId: number; via: "stored" | "phone" | "name" | "alias" }
  | { status: "no_match" }
  | { status: "ambiguous"; count: number };

let memoryCounts: CountsCache | null = null;
let memoryTechs: TechListCache | null = null;

export function normName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,'"_/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normEmail(s: string | null | undefined): string | null {
  const e = (s || "").trim().toLowerCase();
  return e && e.includes("@") ? e : null;
}

export function normPhone(s: string | null | undefined): string | null {
  const digits = String(s || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  // Use last 10 digits (US)
  return digits.slice(-10);
}

export function isZeroChargeManager(user: PublicUser): boolean {
  if (isOfficeSide(user.role)) return true;
  const n = normName(user.display_name || "");
  if (!n) return false;
  return MANAGER_NAME_HINTS.some((hint) => {
    if (n === hint) return true;
    if (!hint.includes(" ") && n.split(" ")[0] === hint) return true;
    if (hint.includes(" ") && (n === hint || n.startsWith(hint + " ") || n.endsWith(" " + hint))) {
      return true;
    }
    return false;
  });
}

/** True when this login is one of the six locked Zero-charge techs. */
export function isZeroChargeTech(displayName: string | null | undefined): boolean {
  const n = normName(displayName || "");
  if (!n) return false;
  return ZERO_CHARGE_TECH_NAMES.some((name) => normName(name) === n);
}

/**
 * Who may use Zero-charge.
 * Managers → six-person roster. Locked techs → self only. Everyone else → none.
 */
export function zeroChargeAccess(user: PublicUser): "manager" | "tech" | "none" {
  if (isZeroChargeManager(user)) return "manager";
  if (isZeroChargeTech(user.display_name)) return "tech";
  return "none";
}

function isRobertAlias(displayName: string, username?: string | null): boolean {
  const n = normName(displayName || "");
  const u = normName((username || "").replace(/^@/, ""));
  return ROBERT_ALIASES.has(n) || ROBERT_ALIASES.has(u);
}

/**
 * Match Field App login → ST technician.
 * Order: Admin override → phone last-10 → normalized full name → Robert alias only.
 * Ambiguous (2+) → unmatched. Never invent IDs.
 */
export function matchUserToStTechnician(
  user: {
    display_name: string;
    username?: string | null;
    email?: string | null;
    phone?: string | null;
    st_technician_id?: number | null;
  },
  techs: StTechnician[]
): MatchResult {
  const stored =
    user.st_technician_id != null && Number(user.st_technician_id) > 0
      ? Number(user.st_technician_id)
      : null;
  if (stored != null) {
    return { status: "matched", stId: stored, via: "stored" };
  }

  const active = techs.filter((t) => t.active !== false && t.id > 0);
  if (!active.length) return { status: "no_match" };

  const uPhone = normPhone(user.phone);
  if (uPhone) {
    const hits = active.filter((t) => normPhone(t.phone) === uPhone);
    if (hits.length === 1) return { status: "matched", stId: hits[0].id, via: "phone" };
    if (hits.length > 1) return { status: "ambiguous", count: hits.length };
  }

  const uName = normName(user.display_name || "");
  if (uName) {
    const nameHits = active.filter((t) => normName(t.name) === uName);
    if (nameHits.length === 1) return { status: "matched", stId: nameHits[0].id, via: "name" };
    if (nameHits.length > 1) return { status: "ambiguous", count: nameHits.length };
  }

  // Alias only: Robert Gonzalez / @robertgonzalez → Roberto Gonzalez (not Eric)
  if (isRobertAlias(user.display_name, user.username)) {
    const hits = active.filter((t) => normName(t.name) === "roberto gonzalez");
    if (hits.length === 1) return { status: "matched", stId: hits[0].id, via: "alias" };
    if (hits.length > 1) return { status: "ambiguous", count: hits.length };
  }

  return { status: "no_match" };
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

function monthBoundsChicago(year: number, month1: number): { startIso: string; endIso: string } {
  const start = zonedLocalToUtc(year, month1, 1, 0, 0, 0);
  let ny = year;
  let nm = month1 + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  const end = zonedLocalToUtc(ny, nm, 1, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Format a UTC instant as America/Chicago wall time with numeric offset (e.g. 2026-08-01T00:00:00-05:00). */
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

function monthBoundsChicagoOffset(
  year: number,
  month1: number
): { startOff: string; endBeforeOff: string; endOnOrBeforeOff: string } {
  const { startIso, endIso } = monthBoundsChicago(year, month1);
  const start = new Date(startIso);
  const endEx = new Date(endIso);
  const endIncl = new Date(endEx.getTime() - 1000);
  return {
    startOff: toChicagoOffsetIso(start),
    endBeforeOff: toChicagoOffsetIso(endEx),
    endOnOrBeforeOff: toChicagoOffsetIso(endIncl),
  };
}

function monthLabel(year: number, month1: number): string {
  const d = zonedLocalToUtc(year, month1, 15, 12, 0, 0);
  return d.toLocaleString("en-US", { timeZone: TZ, month: "short", year: "numeric" });
}

function normJobTypeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map a raw ST job-type name to our canonical Follow-up / Warranty / Customer Quote labels. */
function classifyJobTypeName(raw: string): string | null {
  const n = normJobTypeName(raw);
  if (!n) return null;
  if (n === "customer quote" || n === "customerquote") return "Customer Quote";
  // Follow-up Visit variants: "Follow-up Visit", "Follow up", "Follow-Up", etc.
  if (
    n === "follow up visit" ||
    n === "followup visit" ||
    n === "follow up" ||
    n === "followup" ||
    (n.includes("follow") && n.includes("up") && !n.includes("warranty"))
  ) {
    // Prefer exact-ish visit names; allow bare "follow up"
    if (n.includes("visit") || n === "follow up" || n === "followup") {
      return "Follow-up Visit";
    }
  }
  if (
    n === "warranty service" ||
    (n.includes("warranty") && n.includes("service") && !n.includes("coil") && !n.includes("compressor"))
  ) {
    return "Warranty Service";
  }
  return null;
}

function isFollowUpOrWarrantyHint(raw: string): boolean {
  const n = normJobTypeName(raw);
  return n.includes("follow") || (n.includes("warranty") && n.includes("service"));
}

async function resolveJobTypeIds(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<JobTypeCache> {
  const raw = await getSetting(db, CACHE_KEY_TYPES, "");
  if (raw) {
    try {
      const cached = JSON.parse(raw) as JobTypeCache;
      const idCount = cached.ids ? Object.keys(cached.ids).length : 0;
      const hasZcType = ZERO_CHARGE_TYPE_NAMES.some((n) => cached.ids?.[n] != null);
      // Never reuse empty cache. If Follow-up/Warranty still missing, refresh.
      if (
        cached.at &&
        Date.now() - cached.at < 24 * 60 * 60 * 1000 &&
        idCount > 0 &&
        hasZcType
      ) {
        return cached;
      }
    } catch {
      /* refresh */
    }
  }

  const ids: Record<string, number> = {};
  const missing: string[] = [];
  const hints: string[] = [];
  let page = 1;

  while (page <= 30) {
    const path = `/jpm/v2/tenant/${tenantId}/job-types?page=${page}&pageSize=200&includeTotal=true`;
    const res = await stApiGet(env, db, path);
    if (!res.ok) {
      console.log("[zero-charge] job-types fetch failed", res.status, res.text.slice(0, 180));
      break;
    }
    const body = res.json as { data?: Array<{ id?: number; name?: string }>; hasMore?: boolean };
    const rows = body?.data || [];
    for (const row of rows) {
      const rawName = (row.name || "").trim();
      if (!rawName || row.id == null) continue;
      if (isFollowUpOrWarrantyHint(rawName)) {
        hints.push(`${rawName} (#${row.id})`);
      }
      const canon = classifyJobTypeName(rawName);
      if (canon && ids[canon] == null) {
        ids[canon] = Number(row.id);
      }
    }
    if (!body?.hasMore || rows.length === 0) break;
    page += 1;
  }

  for (const name of ZERO_CHARGE_TYPE_NAMES) {
    if (ids[name] == null) {
      missing.push(name);
      console.log(`[zero-charge] job type missing, skip: ${name}`);
    }
  }
  if (hints.length) {
    console.log("[zero-charge] job-type hints (follow/warranty):", hints.slice(0, 30).join(" | "));
  }

  const cache: JobTypeCache = { at: Date.now(), ids, missing };
  // Persist even partial (e.g. Customer Quote only) — zc types may still be missing
  if (Object.keys(ids).length > 0) {
    try {
      await setSetting(db, CACHE_KEY_TYPES, JSON.stringify(cache));
    } catch {
      /* ignore */
    }
  }
  return { ...cache, hints };
}

export type LoadTechniciansResult =
  | { ok: true; techs: StTechnician[] }
  | { ok: false; forbidden: boolean; status: number; techs: StTechnician[] };

/** Load active ST technicians (settings API). Cached ~1h. Never invents IDs. */
export async function loadStTechnicians(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<LoadTechniciansResult> {
  const now = Date.now();
  if (memoryTechs && now - memoryTechs.at < TECH_CACHE_TTL_MS) {
    return { ok: true, techs: memoryTechs.techs };
  }
  const raw = await getSetting(db, CACHE_KEY_TECHS, "");
  if (raw) {
    try {
      const cached = JSON.parse(raw) as TechListCache;
      if (cached.at && now - cached.at < TECH_CACHE_TTL_MS && Array.isArray(cached.techs)) {
        // Normalize older cache rows that lacked userId
        cached.techs = cached.techs.map((t) => ({
          ...t,
          userId: t.userId != null && Number(t.userId) > 0 ? Number(t.userId) : null,
        }));
        memoryTechs = cached;
        return { ok: true, techs: cached.techs };
      }
    } catch {
      /* refresh */
    }
  }

  const techs: StTechnician[] = [];
  let page = 1;
  while (page <= 10) {
    const q = new URLSearchParams({
      page: String(page),
      pageSize: "500",
      includeTotal: "true",
      active: "True",
    });
    // Also try active=true if API is case-sensitive boolean — ST accepts true
    q.set("active", "true");
    const path = `/settings/v2/tenant/${tenantId}/technicians?${q.toString()}`;
    const res = await stApiGet(env, db, path);
    if (!res.ok) {
      console.log("[zero-charge] technicians fetch failed", res.status, res.text.slice(0, 200));
      const forbidden = res.status === 401 || res.status === 403;
      return { ok: false, forbidden, status: res.status, techs: [] };
    }
    const body = res.json as {
      data?: Array<{
        id?: number;
        userId?: number | null;
        name?: string;
        email?: string | null;
        phoneNumber?: string | null;
        phone?: string | null;
        active?: boolean;
      }>;
      hasMore?: boolean;
    };
    const rows = body?.data || [];
    for (const row of rows) {
      if (row.id == null) continue;
      techs.push({
        id: Number(row.id),
        userId: row.userId != null && Number(row.userId) > 0 ? Number(row.userId) : null,
        name: String(row.name || "").trim(),
        email: row.email ? String(row.email).trim() : null,
        phone: row.phoneNumber
          ? String(row.phoneNumber).trim()
          : row.phone
            ? String(row.phone).trim()
            : null,
        active: row.active !== false,
      });
    }
    if (!body?.hasMore || rows.length === 0) break;
    page += 1;
  }

  const cache: TechListCache = { at: now, techs };
  memoryTechs = cache;
  try {
    await setSetting(db, CACHE_KEY_TECHS, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  return { ok: true, techs };
}

export type InvoiceTotalsResult =
  | { ok: true; byJobId: Map<number, number> }
  | { ok: false; forbidden: boolean; status: number; byJobId: Map<number, number> };

/**
 * Sum invoice totals for specific jobIds only (small batches).
 * Never pulls the whole tenant invoice list. 403 → Invoices View missing.
 */
export async function loadInvoiceTotalsForJobIds(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobIds: number[]
): Promise<InvoiceTotalsResult> {
  const byJobId = new Map<number, number>();
  const unique = [...new Set(jobIds.filter((id) => id > 0))];
  if (!unique.length) return { ok: true, byJobId };

  const chunkSize = 8;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map(async (jobId) => {
        const q = new URLSearchParams({
          jobId: String(jobId),
          page: "1",
          pageSize: "50",
          includeTotal: "true",
        });
        const res = await stApiGet(
          env,
          db,
          `/accounting/v2/tenant/${tenantId}/invoices?${q.toString()}`
        );
        if (!res.ok) {
          return { jobId, ok: false as const, status: res.status, total: 0 };
        }
        const body = res.json as { data?: Array<{ total?: number | null }> };
        let sum = 0;
        for (const row of body?.data || []) {
          const t = Number(row.total);
          if (Number.isFinite(t)) sum += t;
        }
        return { jobId, ok: true as const, status: 200, total: Math.round(sum * 100) / 100 };
      })
    );
    for (const r of results) {
      if (!r.ok) {
        const forbidden = r.status === 401 || r.status === 403;
        console.log("[zero-charge] invoices by jobId failed", r.status, r.jobId);
        return { ok: false, forbidden, status: r.status, byJobId };
      }
      if (r.total) byJobId.set(r.jobId, r.total);
    }
  }
  return { ok: true, byJobId };
}

/** Job IDs for sales: completed jobs for tech this window, excluding Customer Quote. */
async function listCompletedJobIdsForTech(
  env: Env,
  db: D1Database,
  tenantId: string,
  technicianId: number,
  startOff: string,
  endOnOrBeforeOff: string,
  endBeforeOff: string,
  excludeTypeIds: Set<number>,
  monthPool?: StJobLite[] | null
): Promise<number[]> {
  const fetched = await fetchCompletedJobsForTech(
    env,
    db,
    tenantId,
    technicianId,
    startOff,
    endOnOrBeforeOff,
    endBeforeOff,
    monthPool
  );
  return fetched.jobs
    .filter((j) => !(j.jobTypeId != null && excludeTypeIds.has(j.jobTypeId)))
    .map((j) => j.id);
}

/** Resolve Customer Quote job type id (excluded from sales). */
async function resolveExcludedSalesTypeIds(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<Set<number>> {
  const out = new Set<number>();
  let page = 1;
  const wanted = new Set<string>(SALES_EXCLUDE_TYPE_NAMES);
  while (wanted.size > 0 && page <= 20) {
    const path = `/jpm/v2/tenant/${tenantId}/job-types?page=${page}&pageSize=100`;
    const res = await stApiGet(env, db, path);
    if (!res.ok) break;
    const body = res.json as { data?: Array<{ id?: number; name?: string }>; hasMore?: boolean };
    for (const row of body?.data || []) {
      const name = (row.name || "").trim();
      if (wanted.has(name) && row.id != null) {
        out.add(Number(row.id));
        wanted.delete(name);
      }
    }
    if (!body?.hasMore) break;
    page += 1;
  }
  for (const name of wanted) {
    console.log(`[zero-charge] sales exclude type missing: ${name}`);
  }
  return out;
}

/** Sales for one tech: list their completed job IDs, then sum invoices for those IDs only. */
async function salesForTechnicianMonth(
  env: Env,
  db: D1Database,
  tenantId: string,
  technicianId: number,
  startOff: string,
  endOnOrBeforeOff: string,
  endBeforeOff: string,
  excludeTypeIds: Set<number>,
  monthPool?: StJobLite[] | null
): Promise<{ total: number | null; forbidden: boolean; status?: number }> {
  const jobIds = await listCompletedJobIdsForTech(
    env,
    db,
    tenantId,
    technicianId,
    startOff,
    endOnOrBeforeOff,
    endBeforeOff,
    excludeTypeIds,
    monthPool
  );
  const inv = await loadInvoiceTotalsForJobIds(env, db, tenantId, jobIds);
  if (!inv.ok) {
    return { total: null, forbidden: inv.forbidden, status: inv.status };
  }
  let sum = 0;
  for (const jobId of jobIds) {
    sum += inv.byJobId.get(jobId) || 0;
  }
  return { total: Math.round(sum * 100) / 100, forbidden: false };
}

/**
 * Cache a unique auto-match onto the user row.
 * Never overwrites a non-null st_technician_id (Admin override / prior cache).
 */
async function cacheStTechnicianId(
  db: D1Database,
  userId: number,
  current: number | null,
  matched: MatchResult
): Promise<number | null> {
  if (current != null && current > 0) return current;
  if (matched.status !== "matched") return null;
  try {
    await db
      .prepare(
        `UPDATE users
         SET st_technician_id = ?, updated_at = datetime('now')
         WHERE id = ? AND (st_technician_id IS NULL OR st_technician_id = 0)`
      )
      .bind(matched.stId, userId)
      .run();
  } catch (e) {
    console.log(
      "[zero-charge] cache st_technician_id failed",
      userId,
      e instanceof Error ? e.message : e
    );
  }
  return matched.stId;
}

type StJobLite = {
  id: number;
  jobTypeId: number | null;
  technicianIds: number[];
};

function addTechId(out: Set<number>, v: unknown): void {
  const n = Number(v);
  if (n > 0) out.add(n);
}

/** Collect every technician-like id ST puts on a job row. */
function techIdsFromJobRow(row: Record<string, unknown>, fallbackTechId?: number): number[] {
  const out = new Set<number>();
  if (fallbackTechId) out.add(fallbackTechId);
  addTechId(out, row.technicianId);
  addTechId(out, row.assignedTech);
  addTechId(out, row.assignedTechnicianId);
  addTechId(out, row.userId);
  if (Array.isArray(row.technicianIds)) {
    for (const v of row.technicianIds) addTechId(out, v);
  }
  const appts = row.appointments;
  if (Array.isArray(appts)) {
    for (const a of appts) {
      if (!a || typeof a !== "object") continue;
      const o = a as Record<string, unknown>;
      addTechId(out, o.technicianId);
      addTechId(out, o.userId);
      if (Array.isArray(o.technicianIds)) {
        for (const v of o.technicianIds) addTechId(out, v);
      }
    }
  }
  const first = row.firstAppointment;
  if (first && typeof first === "object") {
    const o = first as Record<string, unknown>;
    addTechId(out, o.technicianId);
    addTechId(out, o.userId);
    if (Array.isArray(o.technicianIds)) {
      for (const v of o.technicianIds) addTechId(out, v);
    }
  }
  return [...out];
}

function parseJobLite(row: Record<string, unknown>, assumedTechId?: number): StJobLite | null {
  const id = Number(row.id);
  if (!(id > 0)) return null;
  return {
    id,
    jobTypeId: row.jobTypeId != null ? Number(row.jobTypeId) : null,
    technicianIds: techIdsFromJobRow(row, assumedTechId),
  };
}

/** Pick tech-like paths from a job for admin diagnose. */
function pickTechishFields(
  obj: unknown,
  path = "",
  out: Array<{ path: string; value: unknown }> = [],
  depth = 0
): Array<{ path: string; value: unknown }> {
  if (obj == null || depth > 4) return out;
  if (typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    obj.slice(0, 5).forEach((v, i) => pickTechishFields(v, `${path}[${i}]`, out, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (/tech|appoint|assign|userId|soldBy/i.test(k)) {
      out.push({ path: p, value: v });
    }
    if (v && typeof v === "object") {
      pickTechishFields(v, p, out, depth + 1);
    }
  }
  return out;
}

/** Page completed jobs with technicianId filter (no jobTypeId). Chicago offset dates. */
async function pageJobsWithTechnicianFilter(
  env: Env,
  db: D1Database,
  tenantId: string,
  technicianId: number,
  startOff: string,
  endOnOrBeforeOff: string
): Promise<{ jobs: StJobLite[]; ok: boolean; status?: number }> {
  const jobs: StJobLite[] = [];
  let page = 1;
  while (page <= 50) {
    const q = new URLSearchParams({
      jobStatus: "Completed",
      technicianId: String(technicianId),
      completedOnOrAfter: startOff,
      completedOnOrBefore: endOnOrBeforeOff,
      page: String(page),
      pageSize: "100",
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
    if (!res.ok) {
      console.log(
        `[zero-charge] jobs+tech filter failed tech=${technicianId}`,
        res.status,
        res.text.slice(0, 200)
      );
      return { jobs, ok: false, status: res.status };
    }
    const body = res.json as { data?: Record<string, unknown>[]; hasMore?: boolean };
    const rows = body.data || [];
    for (const row of rows) {
      const j = parseJobLite(row, technicianId);
      if (j) jobs.push(j);
    }
    if (rows.length === 0) break;
    if (body.hasMore === false) break;
    if (body.hasMore !== true && rows.length < 100) break;
    page += 1;
  }
  return { jobs, ok: true };
}

/**
 * Fallback when technicianId filter returns 0: appointments for this tech → jobIds → jobs.
 */
async function fetchJobsViaAppointments(
  env: Env,
  db: D1Database,
  tenantId: string,
  technicianId: number,
  startOff: string,
  endBeforeOff: string
): Promise<{ jobs: StJobLite[]; ok: boolean; status?: number }> {
  const jobIdSet = new Set<number>();
  let page = 1;
  while (page <= 50) {
    const q = new URLSearchParams({
      technicianId: String(technicianId),
      startsOnOrAfter: startOff,
      startsBefore: endBeforeOff,
      page: String(page),
      pageSize: "100",
    });
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/appointments?${q.toString()}`
    );
    if (!res.ok) {
      if (page === 1) {
        const q2 = new URLSearchParams({
          technicianId: String(technicianId),
          startsOnOrAfter: startOff,
          startsOnOrBefore: endBeforeOff,
          page: "1",
          pageSize: "100",
        });
        const res2 = await stApiGet(
          env,
          db,
          `/jpm/v2/tenant/${tenantId}/appointments?${q2.toString()}`
        );
        if (!res2.ok) {
          console.log(
            `[zero-charge] appointments fallback failed tech=${technicianId}`,
            res.status,
            res.text.slice(0, 160)
          );
          return { jobs: [], ok: false, status: res.status };
        }
        const body2 = res2.json as {
          data?: Array<{ jobId?: number; technicianIds?: number[] }>;
          hasMore?: boolean;
        };
        for (const a of body2.data || []) {
          const jid = Number(a.jobId);
          if (jid > 0) jobIdSet.add(jid);
        }
        if (!body2.hasMore || !(body2.data || []).length) break;
        page = 2;
        continue;
      }
      break;
    }
    const body = res.json as {
      data?: Array<{ jobId?: number; technicianIds?: number[] }>;
      hasMore?: boolean;
    };
    const rows = body.data || [];
    for (const a of rows) {
      const jid = Number(a.jobId);
      if (jid > 0) jobIdSet.add(jid);
    }
    if (rows.length === 0) break;
    if (body.hasMore === false) break;
    if (body.hasMore !== true && rows.length < 100) break;
    page += 1;
  }

  const jobIds = [...jobIdSet];
  if (!jobIds.length) return { jobs: [], ok: true };

  const jobs: StJobLite[] = [];
  const chunkSize = 50;
  for (let i = 0; i < jobIds.length; i += chunkSize) {
    const chunk = jobIds.slice(i, i + chunkSize);
    const q = new URLSearchParams({
      ids: chunk.join(","),
      page: "1",
      pageSize: String(chunkSize),
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
    if (!res.ok) continue;
    const body = res.json as { data?: Record<string, unknown>[] };
    for (const row of body.data || []) {
      const status = String(row.jobStatus || row.status || "");
      if (status && status.toLowerCase() !== "completed") continue;
      const j = parseJobLite(row, technicianId);
      if (j) jobs.push(j);
    }
  }
  return { jobs, ok: true };
}

type MonthJobsPull = {
  ok: boolean;
  status: number | null;
  jobs: StJobLite[];
  rawRows: Record<string, unknown>[];
  capped: boolean;
  errorText?: string;
};

/** Completed jobs for Chicago month with NO technician filter (up to maxRows). */
async function fetchMonthCompletedJobsNoTechFilter(
  env: Env,
  db: D1Database,
  tenantId: string,
  startOff: string,
  endOnOrBeforeOff: string,
  maxRows = 200
): Promise<MonthJobsPull> {
  const jobs: StJobLite[] = [];
  const rawRows: Record<string, unknown>[] = [];
  let page = 1;
  let status: number | null = null;
  while (jobs.length < maxRows && page <= 20) {
    const pageSize = Math.min(100, maxRows - jobs.length);
    const q = new URLSearchParams({
      jobStatus: "Completed",
      completedOnOrAfter: startOff,
      completedOnOrBefore: endOnOrBeforeOff,
      page: String(page),
      pageSize: String(pageSize),
      includeTotal: "true",
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
    status = res.status;
    if (!res.ok) {
      return {
        ok: false,
        status,
        jobs,
        rawRows,
        capped: false,
        errorText: res.text.slice(0, 240),
      };
    }
    const body = res.json as { data?: Record<string, unknown>[]; hasMore?: boolean };
    const rows = body.data || [];
    for (const row of rows) {
      rawRows.push(row);
      const j = parseJobLite(row);
      if (j) jobs.push(j);
      if (jobs.length >= maxRows) break;
    }
    if (rows.length === 0) break;
    if (body.hasMore === false) break;
    if (body.hasMore !== true && rows.length < pageSize) break;
    page += 1;
  }
  return {
    ok: true,
    status: status ?? 200,
    jobs,
    rawRows,
    capped: jobs.length >= maxRows,
  };
}

async function probeJobsApiAvailable(
  env: Env,
  db: D1Database,
  tenantId: string,
  startOff: string,
  endOnOrBeforeOff: string
): Promise<{ available: boolean; status: number }> {
  const q = new URLSearchParams({
    jobStatus: "Completed",
    completedOnOrAfter: startOff,
    completedOnOrBefore: endOnOrBeforeOff,
    page: "1",
    pageSize: "1",
  });
  const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
  return { available: res.ok, status: res.status };
}

/**
 * Completed jobs for one tech. Prefer technicianId filter; if empty, appointments;
 * if still empty and monthPool provided, match client-side on tech-like fields.
 */
async function fetchCompletedJobsForTech(
  env: Env,
  db: D1Database,
  tenantId: string,
  technicianId: number,
  startOff: string,
  endOnOrBeforeOff: string,
  endBeforeOff: string,
  monthPool?: StJobLite[] | null
): Promise<{
  jobs: StJobLite[];
  ok: boolean;
  via: "technicianId" | "appointments" | "month_client" | "none";
  status?: number;
}> {
  const primary = await pageJobsWithTechnicianFilter(
    env,
    db,
    tenantId,
    technicianId,
    startOff,
    endOnOrBeforeOff
  );
  if (primary.ok && primary.jobs.length > 0) {
    return { jobs: primary.jobs, ok: true, via: "technicianId", status: 200 };
  }
  const fallback = await fetchJobsViaAppointments(
    env,
    db,
    tenantId,
    technicianId,
    startOff,
    endBeforeOff
  );
  if (fallback.ok && fallback.jobs.length > 0) {
    return { jobs: fallback.jobs, ok: true, via: "appointments", status: 200 };
  }
  if (monthPool && monthPool.length) {
    const matched = monthPool.filter((j) => j.technicianIds.includes(technicianId));
    return {
      jobs: matched,
      ok: true,
      via: "month_client",
      status: 200,
    };
  }
  if (primary.ok || fallback.ok) {
    return {
      jobs: [],
      ok: true,
      via: primary.ok ? "technicianId" : "appointments",
      status: 200,
    };
  }
  return {
    jobs: [],
    ok: false,
    via: "none",
    status: primary.status ?? fallback.status,
  };
}

type InvoiceTechAgg = {
  /** Unique job ids (excludes Customer Quote) */
  jobIds: Set<number>;
  /** Full invoice total attributed (no split) when tech is on any item */
  sales: number;
};

/**
 * Attribute invoices to technicians via items[].technicianId OR items[].createdById.
 * (Many completed visits only stamp the tech as createdById, not technicianId.)
 * Used when JPM Jobs scope is missing (403). Excludes Customer Quote via job.type.
 * Full invoice total goes to each of the six who appear on any line — no split.
 * Follow-up/Warranty types are NOT excluded here — those filters are zc-only.
 */
async function attributeInvoicesByTechnician(
  env: Env,
  db: D1Database,
  tenantId: string,
  startOff: string,
  endOnOrBeforeOff: string,
  techIds: Set<number>
): Promise<{
  ok: boolean;
  forbidden: boolean;
  status?: number;
  byTech: Map<number, InvoiceTechAgg>;
}> {
  const byTech = new Map<number, InvoiceTechAgg>();
  for (const id of techIds) {
    byTech.set(id, { jobIds: new Set(), sales: 0 });
  }
  let page = 1;
  while (page <= 40) {
    const q = new URLSearchParams({
      invoicedOnOrAfter: startOff,
      invoicedOnOrBefore: endOnOrBeforeOff,
      page: String(page),
      pageSize: "100",
    });
    const res = await stApiGet(
      env,
      db,
      `/accounting/v2/tenant/${tenantId}/invoices?${q.toString()}`
    );
    if (!res.ok) {
      const forbidden = res.status === 401 || res.status === 403;
      console.log("[zero-charge] invoice attribution failed", res.status, res.text.slice(0, 160));
      return { ok: false, forbidden, status: res.status, byTech };
    }
    const body = res.json as {
      data?: Array<{
        id?: number;
        total?: number | string | null;
        job?: { id?: number; type?: string | null } | null;
        items?: Array<{ technicianId?: number | null; createdById?: number | null }>;
      }>;
      hasMore?: boolean;
    };
    const rows = body.data || [];
    for (const row of rows) {
      const jobType = String(row.job?.type || "");
      if (/customer\s*quote/i.test(jobType) || /^quote$/i.test(jobType.trim())) {
        continue;
      }
      const onInvoice = new Set<number>();
      for (const it of row.items || []) {
        const tid = Number(it.technicianId);
        const created = Number(it.createdById);
        if (tid > 0 && techIds.has(tid)) onInvoice.add(tid);
        if (created > 0 && techIds.has(created)) onInvoice.add(created);
      }
      if (!onInvoice.size) continue;
      const total = Number(row.total) || 0;
      const jobId = row.job?.id != null ? Number(row.job.id) : 0;
      const invoiceId = row.id != null ? Number(row.id) : 0;
      for (const tid of onInvoice) {
        const agg = byTech.get(tid)!;
        // Prefer unique job.id; fall back to invoice id so we still count the visit
        if (jobId > 0) agg.jobIds.add(jobId);
        else if (invoiceId > 0) agg.jobIds.add(-invoiceId);
        agg.sales += total;
      }
    }
    if (rows.length === 0) break;
    if (body.hasMore === false) break;
    if (body.hasMore !== true && rows.length < 100) break;
    page += 1;
  }
  for (const agg of byTech.values()) {
    agg.sales = Math.round(agg.sales * 100) / 100;
  }
  return { ok: true, forbidden: false, byTech };
}

function summarizeJobs(
  jobs: StJobLite[],
  zcTypeIds: Set<number>,
  excludeTypeIds: Set<number>
): { jobsCount: number; zcCount: number | null } {
  let jobsCount = 0;
  let zcCount = 0;
  const zcReady = zcTypeIds.size > 0;
  for (const j of jobs) {
    if (j.jobTypeId != null && excludeTypeIds.has(j.jobTypeId)) continue;
    jobsCount += 1;
    if (zcReady && j.jobTypeId != null && zcTypeIds.has(j.jobTypeId)) {
      zcCount += 1;
    }
  }
  return { jobsCount, zcCount: zcReady ? zcCount : null };
}

async function countsForTechMonths(
  env: Env,
  db: D1Database,
  tenantId: string,
  zcTypeIds: Set<number>,
  excludeTypeIds: Set<number>,
  technicianId: number,
  thisOff: { startOff: string; endOnOrBeforeOff: string; endBeforeOff: string },
  lastOff: { startOff: string; endOnOrBeforeOff: string; endBeforeOff: string },
  thisPool?: StJobLite[] | null,
  lastPool?: StJobLite[] | null
): Promise<{
  zeroThis: number | null;
  zeroLast: number | null;
  jobsThis: number;
  jobsLast: number;
  ok: boolean;
  zc_reason: string | null;
  thisJobIds: number[];
  lastJobIds: number[];
}> {
  const [thisFetch, lastFetch] = await Promise.all([
    fetchCompletedJobsForTech(
      env,
      db,
      tenantId,
      technicianId,
      thisOff.startOff,
      thisOff.endOnOrBeforeOff,
      thisOff.endBeforeOff,
      thisPool
    ),
    fetchCompletedJobsForTech(
      env,
      db,
      tenantId,
      technicianId,
      lastOff.startOff,
      lastOff.endOnOrBeforeOff,
      lastOff.endBeforeOff,
      lastPool
    ),
  ]);
  const thisSum = summarizeJobs(thisFetch.jobs, zcTypeIds, excludeTypeIds);
  const lastSum = summarizeJobs(lastFetch.jobs, zcTypeIds, excludeTypeIds);
  return {
    zeroThis: thisSum.zcCount,
    zeroLast: lastSum.zcCount,
    jobsThis: thisSum.jobsCount,
    jobsLast: lastSum.jobsCount,
    ok: thisFetch.ok && lastFetch.ok,
    zc_reason: null,
    thisJobIds: thisFetch.jobs
      .filter((j) => !(j.jobTypeId != null && excludeTypeIds.has(j.jobTypeId)))
      .map((j) => j.id),
    lastJobIds: lastFetch.jobs
      .filter((j) => !(j.jobTypeId != null && excludeTypeIds.has(j.jobTypeId)))
      .map((j) => j.id),
  };
}

/** True when every matched tech shows 0 jobs — treat as failed pull, not a real board. */
function isAllZeroJobsBoard(rows: ZeroChargeRow[]): boolean {
  const matched = rows.filter((r) => r.status === "ok" && r.st_technician_id);
  if (matched.length < 3) return false;
  return matched.every((r) => (r.jobs_this_month ?? 0) === 0);
}

function rowFromMetrics(
  userId: number,
  displayName: string,
  stId: number | null,
  metrics: {
    zeroThis: number | null;
    zeroLast: number | null;
    jobsThis: number | null;
    jobsLast: number | null;
    salesThis: number | null;
    salesLast: number | null;
    rank?: number | null;
    zc_reason?: string | null;
  },
  opts?: { unavailable_reason?: string | null; includeReason?: boolean }
): ZeroChargeRow {
  if (stId == null || !(stId > 0)) {
    const row: ZeroChargeRow = {
      user_id: userId,
      display_name: displayName,
      st_technician_id: null,
      this_month: null,
      last_month: null,
      delta: null,
      zc_reason: null,
      jobs_this_month: null,
      jobs_last_month: null,
      jobs_delta: null,
      this_month_sales: null,
      last_month_sales: null,
      sales_delta: null,
      status: "unavailable",
    };
    if (opts?.includeReason && opts.unavailable_reason) {
      row.unavailable_reason = opts.unavailable_reason;
    }
    return row;
  }
  const zt = metrics.zeroThis;
  const zl = metrics.zeroLast;
  const jt = metrics.jobsThis ?? 0;
  const jl = metrics.jobsLast ?? 0;
  const st = metrics.salesThis;
  const sl = metrics.salesLast;
  return {
    user_id: userId,
    display_name: displayName,
    st_technician_id: stId,
    this_month: zt,
    last_month: zl,
    delta: zt != null && zl != null ? zt - zl : null,
    zc_reason: metrics.zc_reason ?? null,
    jobs_this_month: jt,
    jobs_last_month: jl,
    jobs_delta: jt - jl,
    this_month_sales: st,
    last_month_sales: sl,
    sales_delta: st != null && sl != null ? Math.round((st - sl) * 100) / 100 : null,
    rank: metrics.rank ?? null,
    status: "ok",
  };
}

function reasonFromMatch(m: MatchResult): string {
  if (m.status === "ambiguous") return "two matches";
  if (m.status === "no_match") return "no match";
  return "";
}

type UserMatchRow = {
  id: number;
  display_name: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  st_technician_id: number | null;
  role: string;
};

async function resolveUserStId(
  db: D1Database,
  u: UserMatchRow,
  techs: StTechnician[],
  includeReason: boolean
): Promise<{ stId: number | null; reason: string | null; match: MatchResult }> {
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
  const current =
    u.st_technician_id != null && Number(u.st_technician_id) > 0
      ? Number(u.st_technician_id)
      : null;
  const stId = await cacheStTechnicianId(db, u.id, current, match);
  const reason =
    stId == null && includeReason ? reasonFromMatch(match) || "no match" : null;
  return { stId, reason, match };
}
function rankRoster(roster: ZeroChargeRow[]): void {
  const salesAvailable = roster.some((r) => r.this_month_sales != null);
  roster.sort((a, b) => {
    const as = a.this_month_sales;
    const bs = b.this_month_sales;
    if (salesAvailable) {
      if (as == null && bs == null) {
        return (b.jobs_this_month ?? 0) - (a.jobs_this_month ?? 0);
      }
      if (as == null) return 1;
      if (bs == null) return -1;
      if (bs !== as) return bs - as;
      return (b.jobs_this_month ?? 0) - (a.jobs_this_month ?? 0);
    }
    return (b.jobs_this_month ?? 0) - (a.jobs_this_month ?? 0);
  });
  let rank = 1;
  for (const r of roster) {
    if (r.status === "ok") {
      r.rank = rank;
      rank += 1;
    } else {
      r.rank = null;
    }
  }
}

function payloadFromRows(
  empty: ZeroChargeResponse,
  access: "manager" | "tech",
  rows: ZeroChargeRow[],
  meUserId: number | null,
  opts: { sales_pending?: boolean }
): ZeroChargeResponse {
  const ranked = rows.map((r) => ({ ...r }));
  rankRoster(ranked);
  if (access === "tech") {
    const self = meUserId != null ? ranked.find((r) => r.user_id === meUserId) || null : null;
    return {
      ...empty,
      view: "self",
      self,
      roster: [],
      sales_pending: opts.sales_pending,
      roster_sorted_by: "name",
    };
  }
  return {
    ...empty,
    view: "roster",
    self: null,
    roster: ranked,
    sales_pending: opts.sales_pending,
    roster_sorted_by: ranked.some((r) => r.this_month_sales != null) ? "sales" : "name",
  };
}

async function readBoardCache(
  db: D1Database,
  thisKey: string,
  lastKey: string
): Promise<BoardCache | null> {
  const now = Date.now();
  if (
    memoryBoard &&
    memoryBoard.thisKey === thisKey &&
    memoryBoard.lastKey === lastKey &&
    now - memoryBoard.at < BOARD_CACHE_TTL_MS
  ) {
    return memoryBoard;
  }
  try {
    const raw = await getSetting(db, BOARD_CACHE_KEY, "");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BoardCache;
    if (
      parsed &&
      parsed.thisKey === thisKey &&
      parsed.lastKey === lastKey &&
      parsed.at &&
      now - parsed.at < BOARD_CACHE_TTL_MS &&
      Array.isArray(parsed.rows)
    ) {
      memoryBoard = parsed;
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function writeBoardCache(db: D1Database, cache: BoardCache): Promise<void> {
  // Never persist an all-zero jobs board — that locks Home on fake zeros
  if (isAllZeroJobsBoard(cache.rows)) {
    memoryBoard = null;
    try {
      await setSetting(db, BOARD_CACHE_KEY, "");
    } catch {
      /* ignore */
    }
    return;
  }
  memoryBoard = cache;
  try {
    await setSetting(db, BOARD_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

async function clearBoardCache(db: D1Database): Promise<void> {
  memoryBoard = null;
  memoryCounts = null;
  try {
    await setSetting(db, BOARD_CACHE_KEY, "");
  } catch {
    /* ignore */
  }
}

/**
 * @param opts.sales when true, fill invoice sales (second request). Default false = jobs + zero-charge only.
 */
export async function buildZeroChargePayload(
  env: Env,
  db: D1Database,
  user: PublicUser,
  opts: { sales?: boolean } = {}
): Promise<ZeroChargeResponse> {
  const wantSales = !!opts.sales;
  const now = new Date();
  const cur = chicagoParts(now);
  let ly = cur.y;
  let lm = cur.m - 1;
  if (lm < 1) {
    lm = 12;
    ly -= 1;
  }
  const thisOff = monthBoundsChicagoOffset(cur.y, cur.m);
  const lastOff = monthBoundsChicagoOffset(ly, lm);
  const thisKey = `${cur.y}-${String(cur.m).padStart(2, "0")}`;
  const lastKey = `${ly}-${String(lm).padStart(2, "0")}`;
  const month_label = monthLabel(cur.y, cur.m);
  const last_month_label = monthLabel(ly, lm);

  const access = zeroChargeAccess(user);
  const empty: ZeroChargeResponse = {
    view: access === "manager" ? "roster" : access === "tech" ? "self" : "none",
    month_label,
    last_month_label,
    timezone: TZ,
    job_types_used: [],
    job_types_missing: [...ZERO_CHARGE_TYPE_NAMES],
    self: null,
    roster: [],
  };

  if (access === "none") {
    return { ...empty, view: "none" };
  }

  if (!(await stConfigured(env, db))) {
    return { ...empty, error: LOAD_FAIL };
  }
  const tenantIdRaw = await stTenantId(env, db);
  if (!tenantIdRaw) {
    return { ...empty, error: LOAD_FAIL };
  }
  const tenantId: string = tenantIdRaw;

  const cached = await readBoardCache(db, thisKey, lastKey);
  // Discard poisoned all-zero caches
  if (cached && isAllZeroJobsBoard(cached.rows)) {
    await clearBoardCache(db);
  } else if (cached) {
    if (!wantSales) {
      return payloadFromRows(empty, access, cached.rows, user.id, {
        sales_pending: !cached.sales_filled,
      });
    }
    if (wantSales && cached.sales_filled) {
      return payloadFromRows(empty, access, cached.rows, user.id, { sales_pending: false });
    }
  }

  const types = await resolveJobTypeIds(env, db, tenantId);
  const zcTypeIds = new Set(
    ZERO_CHARGE_TYPE_NAMES.map((n) => types.ids[n]).filter(
      (id): id is number => id != null && id > 0
    )
  );
  empty.job_types_used = Object.keys(types.ids).filter((k) =>
    (ZERO_CHARGE_TYPE_NAMES as readonly string[]).includes(k)
  );
  empty.job_types_missing = types.missing;

  const techs = await db
    .prepare(
      `SELECT id, display_name, username, email, phone, st_technician_id, role
       FROM users
       WHERE active = 1
       ORDER BY display_name COLLATE NOCASE`
    )
    .all<UserMatchRow>();
  const lockedTechs = (techs.results || []).filter((t) => isZeroChargeTech(t.display_name));

  const needsMatch = lockedTechs.some(
    (t) => !(t.st_technician_id != null && Number(t.st_technician_id) > 0)
  );
  let stTechs: StTechnician[] = [];
  let techForbidden = false;
  {
    const techLoad = await loadStTechnicians(env, db, tenantId);
    stTechs = techLoad.techs;
    if (!techLoad.ok && techLoad.forbidden) {
      techForbidden = true;
      empty.technicians_forbidden = true;
      empty.error = LOAD_FAIL;
    } else if (needsMatch && !techLoad.ok) {
      empty.error = LOAD_FAIL;
    }
  }

  const excludeTypes = new Set<number>();
  if (types.ids["Customer Quote"]) {
    excludeTypes.add(types.ids["Customer Quote"]);
  } else {
    for (const id of await resolveExcludedSalesTypeIds(env, db, tenantId)) {
      excludeTypes.add(id);
    }
  }

  // Resolve ST ids for the six (invoice attribution + jobs path)
  const resolved: Array<{ u: UserMatchRow; stId: number | null; reason: string | null }> =
    await Promise.all(
      lockedTechs.map(async (u) => {
        const { stId, reason } = await resolveUserStId(db, u, stTechs, true);
        return { u, stId, reason };
      })
    );
  const techIdSet = new Set(
    resolved.map((r) => r.stId).filter((id): id is number => id != null && id > 0)
  );

  const jobsProbe = await probeJobsApiAvailable(
    env,
    db,
    tenantId,
    thisOff.startOff,
    thisOff.endOnOrBeforeOff
  );
  let attribution_source: "jobs" | "invoices" | "none" = "none";

  /** Strip any debug fields — Home never shows diagnose. */
  function finish(out: ZeroChargeResponse): ZeroChargeResponse {
    out.debug_diagnose = null;
    out.debug_abel_jobs_this_month = null;
    out.debug_abel_st_technician_id = null;
    out.debug_job_type_hints = undefined;
    out.attribution_source = attribution_source;
    // Never surface ST/scope essays on the card
    if (out.error) out.error = LOAD_FAIL;
    return out;
  }

  // zc column shows "—" when types unresolved — no reason text on Home
  const zcReasonJobsMissing: string | null = null;

  // ——— Invoice path when Jobs API is forbidden ———
  if (!jobsProbe.available) {
    empty.jobs_forbidden = true;
    attribution_source = "invoices";
    const [thisInv, lastInv] = await Promise.all([
      attributeInvoicesByTechnician(
        env,
        db,
        tenantId,
        thisOff.startOff,
        thisOff.endOnOrBeforeOff,
        techIdSet
      ),
      attributeInvoicesByTechnician(
        env,
        db,
        tenantId,
        lastOff.startOff,
        lastOff.endOnOrBeforeOff,
        techIdSet
      ),
    ]);
    if (!thisInv.ok && thisInv.forbidden) {
      empty.invoices_forbidden = true;
      empty.error = LOAD_FAIL;
      const badRows = resolved.map(({ u, stId, reason }) =>
        rowFromMetrics(
          u.id,
          u.display_name,
          stId,
          {
            zeroThis: null,
            zeroLast: null,
            jobsThis: null,
            jobsLast: null,
            salesThis: null,
            salesLast: null,
            zc_reason: zcReasonJobsMissing,
          },
          {
            includeReason: true,
            unavailable_reason: stId ? "unavailable" : techForbidden ? "unavailable" : reason || "unmatched",
          }
        )
      );
      return finish(payloadFromRows(empty, access, badRows, user.id, { sales_pending: false }));
    }
    if (!thisInv.ok) {
      empty.error = LOAD_FAIL;
      await clearBoardCache(db);
      return finish(payloadFromRows(empty, access, [], user.id, { sales_pending: false }));
    }

    const rows: ZeroChargeRow[] = resolved.map(({ u, stId, reason }) => {
      if (stId == null) {
        return rowFromMetrics(
          u.id,
          u.display_name,
          null,
          {
            zeroThis: null,
            zeroLast: null,
            jobsThis: null,
            jobsLast: null,
            salesThis: null,
            salesLast: null,
            zc_reason: zcReasonJobsMissing,
          },
          {
            includeReason: true,
            unavailable_reason: "unavailable",
          }
        );
      }
      const tAgg = thisInv.byTech.get(stId);
      const lAgg = lastInv.ok ? lastInv.byTech.get(stId) : undefined;
      const jobsThis = tAgg?.jobIds.size ?? 0;
      const jobsLast = lAgg?.jobIds.size ?? 0;
      const salesThis = tAgg?.sales ?? 0;
      const salesLast = lastInv.ok ? (lAgg?.sales ?? 0) : null;
      return rowFromMetrics(u.id, u.display_name, stId, {
        zeroThis: zcTypeIds.size ? 0 : null,
        zeroLast: zcTypeIds.size ? 0 : null,
        jobsThis,
        jobsLast,
        salesThis,
        salesLast,
        zc_reason: zcReasonJobsMissing,
      });
    });

    if (isAllZeroJobsBoard(rows)) {
      await clearBoardCache(db);
      empty.error = LOAD_FAIL;
      return finish(
        payloadFromRows(
          empty,
          access,
          rows.map((r) =>
            r.status === "ok"
              ? {
                  ...r,
                  status: "unavailable" as const,
                  this_month: null,
                  last_month: null,
                  delta: null,
                  jobs_this_month: null,
                  jobs_last_month: null,
                  jobs_delta: null,
                  this_month_sales: null,
                  last_month_sales: null,
                  sales_delta: null,
                  unavailable_reason: "unavailable",
                }
              : r
          ),
          user.id,
          { sales_pending: false }
        )
      );
    }

    empty.attribution_source = "invoices";
    await writeBoardCache(db, {
      at: Date.now(),
      thisKey,
      lastKey,
      rows,
      sales_filled: true,
    });
    return finish(
      payloadFromRows(empty, access, rows, user.id, { sales_pending: false })
    );
  }

  // ——— Jobs API available ———
  attribution_source = "jobs";
  empty.attribution_source = "jobs";

  // Month-wide pools for client-side tech match when technicianId filter returns 0
  const [thisMonthPull, lastMonthPull] = await Promise.all([
    fetchMonthCompletedJobsNoTechFilter(
      env,
      db,
      tenantId,
      thisOff.startOff,
      thisOff.endOnOrBeforeOff,
      200
    ),
    fetchMonthCompletedJobsNoTechFilter(
      env,
      db,
      tenantId,
      lastOff.startOff,
      lastOff.endOnOrBeforeOff,
      200
    ),
  ]);
  if (thisMonthPull.ok && thisMonthPull.jobs.length === 0) {
    empty.error = LOAD_FAIL;
    await clearBoardCache(db);
    return finish(payloadFromRows(empty, access, [], user.id, { sales_pending: false }));
  }
  const thisPool = thisMonthPull.ok ? thisMonthPull.jobs : null;
  const lastPool = lastMonthPull.ok ? lastMonthPull.jobs : null;

  async function buildCoreRow(entry: {
    u: UserMatchRow;
    stId: number | null;
    reason: string | null;
  }): Promise<ZeroChargeRow> {
    const { u, stId, reason } = entry;
    if (stId == null) {
      return rowFromMetrics(
        u.id,
        u.display_name,
        null,
        {
          zeroThis: null,
          zeroLast: null,
          jobsThis: null,
          jobsLast: null,
          salesThis: null,
          salesLast: null,
          zc_reason: zcReasonJobsMissing,
        },
        {
          includeReason: true,
          unavailable_reason: "unavailable",
        }
      );
    }
    if (stTechs.length) {
      const st = stTechs.find((t) => t.id === stId);
      const expected =
        normName(u.display_name) === "robert gonzalez"
          ? "roberto gonzalez"
          : normName(u.display_name);
      if (st && normName(st.name) !== expected && !isRobertAlias(u.display_name, u.username)) {
        console.log(
          "[zero-charge] ST id name mismatch",
          u.display_name,
          stId,
          st.name,
          "expected",
          expected
        );
      }
    }
    const counts = await countsForTechMonths(
      env,
      db,
      tenantId,
      zcTypeIds,
      excludeTypes,
      stId,
      thisOff,
      lastOff,
      thisPool,
      lastPool
    );
    return rowFromMetrics(u.id, u.display_name, stId, {
      zeroThis: counts.zeroThis,
      zeroLast: counts.zeroLast,
      jobsThis: counts.jobsThis,
      jobsLast: counts.jobsLast,
      salesThis: null,
      salesLast: null,
      zc_reason: counts.zc_reason || zcReasonJobsMissing,
    });
  }

  let rows: ZeroChargeRow[];
  const freshCached = await readBoardCache(db, thisKey, lastKey);
  if (freshCached && wantSales && !isAllZeroJobsBoard(freshCached.rows) ) {
    rows = freshCached.rows.map((r) => ({ ...r }));
  } else {
    rows = await Promise.all(resolved.map((e) => buildCoreRow(e)));

    if (isAllZeroJobsBoard(rows)) {
      await clearBoardCache(db);
      // Last resort: invoice attribution even when Jobs probe looked available but returned empty per tech
      const thisInv = await attributeInvoicesByTechnician(
        env,
        db,
        tenantId,
        thisOff.startOff,
        thisOff.endOnOrBeforeOff,
        techIdSet
      );
      if (thisInv.ok) {
        const lastInv = await attributeInvoicesByTechnician(
          env,
          db,
          tenantId,
          lastOff.startOff,
          lastOff.endOnOrBeforeOff,
          techIdSet
        );
        attribution_source = "invoices";
        empty.attribution_source = "invoices";
        rows = resolved.map(({ u, stId, reason }) => {
          if (stId == null) {
            return rowFromMetrics(
              u.id,
              u.display_name,
              null,
              {
                zeroThis: null,
                zeroLast: null,
                jobsThis: null,
                jobsLast: null,
                salesThis: null,
                salesLast: null,
                zc_reason: zcReasonJobsMissing,
              },
              {
                includeReason: true,
                unavailable_reason: reason || "unmatched",
              }
            );
          }
          const tAgg = thisInv.byTech.get(stId);
          const lAgg = lastInv.ok ? lastInv.byTech.get(stId) : undefined;
          return rowFromMetrics(u.id, u.display_name, stId, {
            zeroThis: zcTypeIds.size ? 0 : null,
            zeroLast: zcTypeIds.size ? 0 : null,
            jobsThis: tAgg?.jobIds.size ?? 0,
            jobsLast: lAgg?.jobIds.size ?? 0,
            salesThis: tAgg?.sales ?? 0,
            salesLast: lastInv.ok ? (lAgg?.sales ?? 0) : null,
            zc_reason: zcReasonJobsMissing,
          });
        });
        if (!isAllZeroJobsBoard(rows)) {
          await writeBoardCache(db, {
            at: Date.now(),
            thisKey,
            lastKey,
            rows,
            sales_filled: true,
          });
          return finish(
            payloadFromRows(empty, access, rows, user.id, { sales_pending: false })
          );
        }
      }

      empty.error = LOAD_FAIL;
      return finish(
        payloadFromRows(
          empty,
          access,
          rows.map((r) =>
            r.status === "ok"
              ? {
                  ...r,
                  status: "unavailable" as const,
                  this_month: null,
                  last_month: null,
                  delta: null,
                  jobs_this_month: null,
                  jobs_last_month: null,
                  jobs_delta: null,
                  this_month_sales: null,
                  last_month_sales: null,
                  sales_delta: null,
                  unavailable_reason: "unavailable",
                }
              : r
          ),
          user.id,
          { sales_pending: false }
        )
      );
    }

    await writeBoardCache(db, {
      at: Date.now(),
      thisKey,
      lastKey,
      rows,
      sales_filled: false,
    });
  }

  if (!wantSales) {
    if (access === "tech") {
      const me = lockedTechs.find((t) => t.id === user.id);
      if (!me) return { ...empty, view: "none" };
    }
    return finish(
      payloadFromRows(empty, access, rows, user.id, { sales_pending: true })
    );
  }

  let invoicesForbidden = false;
  const withSales = await Promise.all(
    rows.map(async (row) => {
      if (row.status !== "ok" || !row.st_technician_id) return row;
      if (row.this_month_sales != null) return row; // already filled (invoice path)
      const thisS = await salesForTechnicianMonth(
        env,
        db,
        tenantId,
        row.st_technician_id,
        thisOff.startOff,
        thisOff.endOnOrBeforeOff,
        thisOff.endBeforeOff,
        excludeTypes,
        thisPool
      );
      if (thisS.forbidden) {
        invoicesForbidden = true;
        return row;
      }
      const lastS = await salesForTechnicianMonth(
        env,
        db,
        tenantId,
        row.st_technician_id,
        lastOff.startOff,
        lastOff.endOnOrBeforeOff,
        lastOff.endBeforeOff,
        excludeTypes,
        lastPool
      );
      if (lastS.forbidden) {
        invoicesForbidden = true;
        return row;
      }
      const salesThis = thisS.total;
      const salesLast = lastS.total;
      return {
        ...row,
        this_month_sales: salesThis,
        last_month_sales: salesLast,
        sales_delta:
          salesThis != null && salesLast != null
            ? Math.round((salesThis - salesLast) * 100) / 100
            : null,
      };
    })
  );

  if (invoicesForbidden) {
    empty.invoices_forbidden = true;
    // Sales stay null / "…" — do not fail the whole card with a scope essay
  }

  await writeBoardCache(db, {
    at: Date.now(),
    thisKey,
    lastKey,
    rows: withSales,
    sales_filled: !invoicesForbidden,
  });

  return finish(
    payloadFromRows(empty, access, withSales, user.id, { sales_pending: false })
  );
}
