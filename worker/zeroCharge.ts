/**
 * Monthly Zero-charge counter from ServiceTitan.
 * Counts completed jobs whose Job Type is exactly "Follow-up Visit" or "Warranty Service".
 * Read-only. Does not persist customer/address/invoice data.
 */

import type { Env, PublicUser, Role } from "./types";
import { getSetting, setSetting } from "./audit";
import { isOfficeSide } from "./auth";
import { stApiGet, stConfigured, stTenantId } from "./servicetitan";

const ZERO_CHARGE_TYPE_NAMES = ["Follow-up Visit", "Warranty Service"] as const;
const TZ = "America/Chicago";
const CACHE_KEY_TYPES = "st_zero_charge_job_type_ids";
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Extra people who get the manager roster even if role is field. */
const MANAGER_NAME_HINTS = [
  "chris marroquin",
  "kelsie",
  "bianca",
  "eric",
  "adam",
  "chris miller",
];

export type ZeroChargeRow = {
  user_id: number;
  display_name: string;
  st_technician_id: number | null;
  this_month: number | null;
  last_month: number | null;
  delta: number | null;
  /** unavailable = no ST technician id linked */
  status: "ok" | "unavailable";
};

export type ZeroChargeResponse = {
  view: "self" | "roster";
  month_label: string;
  last_month_label: string;
  timezone: string;
  job_types_used: string[];
  job_types_missing: string[];
  self: ZeroChargeRow | null;
  roster: ZeroChargeRow[];
  error?: string;
};

type JobTypeCache = {
  at: number;
  ids: Record<string, number>;
  missing: string[];
};

type CountsCache = {
  at: number;
  /** key: `${techId}:${monthKey}` → count */
  byTechMonth: Record<string, number>;
};

let memoryCounts: CountsCache | null = null;

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isZeroChargeManager(user: PublicUser): boolean {
  if (isOfficeSide(user.role)) return true;
  const n = normName(user.display_name || "");
  if (!n) return false;
  return MANAGER_NAME_HINTS.some((hint) => {
    if (n === hint) return true;
    // first-name-only hints (Kelsie, Bianca, Eric, Adam)
    if (!hint.includes(" ") && n.split(" ")[0] === hint) return true;
    // full name contained
    if (hint.includes(" ") && (n === hint || n.startsWith(hint + " ") || n.endsWith(" " + hint))) {
      return true;
    }
    return false;
  });
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

/** Offset of TZ at a given UTC instant (ms). */
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

/** Local wall time in TZ → UTC Date. */
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

function monthLabel(year: number, month1: number): string {
  const d = zonedLocalToUtc(year, month1, 15, 12, 0, 0);
  return d.toLocaleString("en-US", { timeZone: TZ, month: "short", year: "numeric" });
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
      if (cached.at && Date.now() - cached.at < 24 * 60 * 60 * 1000 && cached.ids) {
        return cached;
      }
    } catch {
      /* refresh */
    }
  }

  const ids: Record<string, number> = {};
  const missing: string[] = [];
  let page = 1;
  const wanted = new Set<string>(ZERO_CHARGE_TYPE_NAMES);

  while (wanted.size > 0 && page <= 20) {
    const path = `/jpm/v2/tenant/${tenantId}/job-types?page=${page}&pageSize=100&includeTotal=true`;
    const res = await stApiGet(env, db, path);
    if (!res.ok) {
      console.log("[zero-charge] job-types fetch failed", res.status, res.text.slice(0, 180));
      break;
    }
    const body = res.json as { data?: Array<{ id?: number; name?: string }>; hasMore?: boolean };
    const rows = body?.data || [];
    for (const row of rows) {
      const name = (row.name || "").trim();
      if (wanted.has(name) && row.id != null) {
        ids[name] = Number(row.id);
        wanted.delete(name);
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

  const cache: JobTypeCache = { at: Date.now(), ids, missing };
  try {
    await setSetting(db, CACHE_KEY_TYPES, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  return cache;
}

/**
 * Count completed jobs of given types assigned to technician in [start, end).
 * Uses ST technicianId filter (job counted if tech is on any appointment).
 */
async function countJobsForTech(
  env: Env,
  db: D1Database,
  tenantId: string,
  typeIds: number[],
  technicianId: number,
  startIso: string,
  endIso: string
): Promise<number> {
  if (!typeIds.length) return 0;
  let total = 0;
  for (const jobTypeId of typeIds) {
    const q = new URLSearchParams({
      jobStatus: "Completed",
      jobTypeId: String(jobTypeId),
      technicianId: String(technicianId),
      completedOnOrAfter: startIso,
      completedBefore: endIso,
      page: "1",
      pageSize: "1",
      includeTotal: "true",
    });
    const path = `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`;
    const res = await stApiGet(env, db, path);
    if (!res.ok) {
      console.log(
        `[zero-charge] jobs fetch failed tech=${technicianId} type=${jobTypeId}`,
        res.status,
        res.text.slice(0, 160)
      );
      continue;
    }
    const body = res.json as { totalCount?: number; data?: unknown[] };
    if (typeof body?.totalCount === "number") {
      total += body.totalCount;
    } else if (Array.isArray(body?.data)) {
      // Fallback: paginate if totalCount absent
      let page = 1;
      let pageTotal = 0;
      let hasMore = true;
      while (hasMore && page <= 50) {
        const q2 = new URLSearchParams({
          jobStatus: "Completed",
          jobTypeId: String(jobTypeId),
          technicianId: String(technicianId),
          completedOnOrAfter: startIso,
          completedBefore: endIso,
          page: String(page),
          pageSize: "100",
        });
        const r2 = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q2}`);
        if (!r2.ok) break;
        const b2 = r2.json as { data?: unknown[]; hasMore?: boolean };
        const n = (b2.data || []).length;
        pageTotal += n;
        hasMore = !!b2.hasMore && n > 0;
        page += 1;
      }
      total += pageTotal;
    }
  }
  return total;
}

async function countsForTechMonths(
  env: Env,
  db: D1Database,
  tenantId: string,
  typeIds: number[],
  technicianId: number,
  thisStart: string,
  thisEnd: string,
  lastStart: string,
  lastEnd: string,
  thisKey: string,
  lastKey: string
): Promise<{ thisMonth: number; lastMonth: number }> {
  const now = Date.now();
  if (!memoryCounts || now - memoryCounts.at > CACHE_TTL_MS) {
    memoryCounts = { at: now, byTechMonth: {} };
  }
  const cache = memoryCounts;
  const kThis = `${technicianId}:${thisKey}`;
  const kLast = `${technicianId}:${lastKey}`;

  let thisMonth = cache.byTechMonth[kThis];
  let lastMonth = cache.byTechMonth[kLast];

  if (thisMonth == null) {
    thisMonth = await countJobsForTech(env, db, tenantId, typeIds, technicianId, thisStart, thisEnd);
    cache.byTechMonth[kThis] = thisMonth;
  }
  if (lastMonth == null) {
    lastMonth = await countJobsForTech(env, db, tenantId, typeIds, technicianId, lastStart, lastEnd);
    cache.byTechMonth[kLast] = lastMonth;
  }
  return { thisMonth, lastMonth };
}

function rowFromCounts(
  userId: number,
  displayName: string,
  stId: number | null,
  thisMonth: number | null,
  lastMonth: number | null
): ZeroChargeRow {
  if (stId == null || !(stId > 0)) {
    return {
      user_id: userId,
      display_name: displayName,
      st_technician_id: null,
      this_month: null,
      last_month: null,
      delta: null,
      status: "unavailable",
    };
  }
  const tm = thisMonth ?? 0;
  const lm = lastMonth ?? 0;
  return {
    user_id: userId,
    display_name: displayName,
    st_technician_id: stId,
    this_month: tm,
    last_month: lm,
    delta: tm - lm,
    status: "ok",
  };
}

export async function buildZeroChargePayload(
  env: Env,
  db: D1Database,
  user: PublicUser
): Promise<ZeroChargeResponse> {
  const now = new Date();
  const cur = chicagoParts(now);
  let ly = cur.y;
  let lm = cur.m - 1;
  if (lm < 1) {
    lm = 12;
    ly -= 1;
  }
  const thisBounds = monthBoundsChicago(cur.y, cur.m);
  const lastBounds = monthBoundsChicago(ly, lm);
  const thisKey = `${cur.y}-${String(cur.m).padStart(2, "0")}`;
  const lastKey = `${ly}-${String(lm).padStart(2, "0")}`;
  const month_label = monthLabel(cur.y, cur.m);
  const last_month_label = monthLabel(ly, lm);

  const empty: ZeroChargeResponse = {
    view: isZeroChargeManager(user) ? "roster" : "self",
    month_label,
    last_month_label,
    timezone: TZ,
    job_types_used: [],
    job_types_missing: [...ZERO_CHARGE_TYPE_NAMES],
    self: null,
    roster: [],
  };

  if (!(await stConfigured(env, db))) {
    return { ...empty, error: "ServiceTitan not configured" };
  }
  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return { ...empty, error: "ServiceTitan tenant missing" };
  }

  const types = await resolveJobTypeIds(env, db, tenantId);
  const typeIds = Object.values(types.ids);
  empty.job_types_used = Object.keys(types.ids);
  empty.job_types_missing = types.missing;

  const manager = isZeroChargeManager(user);

  // Load caller's ST id
  const meRow = await db
    .prepare(
      `SELECT id, display_name, st_technician_id, role FROM users WHERE id = ?`
    )
    .bind(user.id)
    .first<{
      id: number;
      display_name: string;
      st_technician_id: number | null;
      role: string;
    }>();

  const myStId =
    meRow?.st_technician_id != null && Number(meRow.st_technician_id) > 0
      ? Number(meRow.st_technician_id)
      : null;

  if (!manager) {
    // Tech: only self. Never accept client-supplied technician id.
    if (myStId == null) {
      return {
        ...empty,
        view: "self",
        self: rowFromCounts(user.id, user.display_name, null, null, null),
      };
    }
    const counts = await countsForTechMonths(
      env,
      db,
      tenantId,
      typeIds,
      myStId,
      thisBounds.startIso,
      thisBounds.endIso,
      lastBounds.startIso,
      lastBounds.endIso,
      thisKey,
      lastKey
    );
    return {
      ...empty,
      view: "self",
      self: rowFromCounts(user.id, user.display_name, myStId, counts.thisMonth, counts.lastMonth),
      roster: [],
    };
  }

  // Manager roster: active field techs (drivers) + anyone with an ST id
  const techs = await db
    .prepare(
      `SELECT id, display_name, st_technician_id, role
       FROM users
       WHERE active = 1
         AND (
           role = 'driver'
           OR (st_technician_id IS NOT NULL AND st_technician_id > 0)
         )
       ORDER BY display_name COLLATE NOCASE`
    )
    .all<{
      id: number;
      display_name: string;
      st_technician_id: number | null;
      role: Role;
    }>();

  const roster: ZeroChargeRow[] = [];
  for (const t of techs.results || []) {
    const stId =
      t.st_technician_id != null && Number(t.st_technician_id) > 0
        ? Number(t.st_technician_id)
        : null;
    if (stId == null) {
      roster.push(rowFromCounts(t.id, t.display_name, null, null, null));
      continue;
    }
    const counts = await countsForTechMonths(
      env,
      db,
      tenantId,
      typeIds,
      stId,
      thisBounds.startIso,
      thisBounds.endIso,
      lastBounds.startIso,
      lastBounds.endIso,
      thisKey,
      lastKey
    );
    roster.push(
      rowFromCounts(t.id, t.display_name, stId, counts.thisMonth, counts.lastMonth)
    );
  }

  let self: ZeroChargeRow | null = null;
  if (myStId != null) {
    self = roster.find((r) => r.user_id === user.id) || null;
    if (!self) {
      const counts = await countsForTechMonths(
        env,
        db,
        tenantId,
        typeIds,
        myStId,
        thisBounds.startIso,
        thisBounds.endIso,
        lastBounds.startIso,
        lastBounds.endIso,
        thisKey,
        lastKey
      );
      self = rowFromCounts(user.id, user.display_name, myStId, counts.thisMonth, counts.lastMonth);
    }
  } else {
    self = rowFromCounts(user.id, user.display_name, null, null, null);
  }

  return {
    ...empty,
    view: "roster",
    self,
    roster,
  };
}
