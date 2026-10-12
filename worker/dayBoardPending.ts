/**
 * Day Board pending service chips (No Cool / after-hours).
 * D1 first → Approve → background ST create/link.
 * HARD: notificationsEnabled false (Confirms OFF + no booking texts).
 * Soft: DAY_BOARD_PENDING_ST unset/dry = no ST write; live = POST jobs.
 */
import type { Env, PublicUser } from "./types";
import { getSetting } from "./audit";
import {
  chicagoWallToIso,
  findOpenJobsAtAddressText,
  searchMillerLocations,
} from "./millerBookJob";
import { stApiGet, stApiJson, stConfigured, stTenantId } from "./servicetitan";
import type { DayBoardJob } from "./dayBoard";

export type PendingStatus =
  | "pending"
  | "approved"
  | "linking"
  | "linked"
  | "failed"
  | "discarded";

export type DayBoardPendingRow = {
  id: number;
  date: string;
  tech_user_id: number | null;
  st_technician_id: number | null;
  display_name: string | null;
  customer_name: string;
  customer_phone: string | null;
  address: string;
  address_verified: number;
  issue: string;
  window_start: string | null;
  window_end: string | null;
  status: PendingStatus;
  st_job_id: string | null;
  st_appointment_id: string | null;
  st_job_number: string | null;
  error: string | null;
  created_by: number | null;
  approved_by: number | null;
  created_at: string;
  updated_at: string;
};

let tableReady = false;

export async function ensureDayBoardPendingTable(db: D1Database): Promise<void> {
  if (tableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS day_board_pending (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         date TEXT NOT NULL,
         tech_user_id INTEGER,
         st_technician_id INTEGER,
         display_name TEXT,
         customer_name TEXT NOT NULL,
         customer_phone TEXT,
         address TEXT NOT NULL,
         address_verified INTEGER NOT NULL DEFAULT 0,
         issue TEXT NOT NULL,
         window_start TEXT,
         window_end TEXT,
         status TEXT NOT NULL DEFAULT 'pending',
         st_job_id TEXT,
         st_appointment_id TEXT,
         st_job_number TEXT,
         error TEXT,
         created_by INTEGER,
         approved_by INTEGER,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();
  try {
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_day_board_pending_date
         ON day_board_pending(date, status)`
      )
      .run();
  } catch {
    /* ignore */
  }
  tableReady = true;
}

export function canWriteDayBoardPending(user: { role: string }): boolean {
  return ["admin", "office", "supervisor"].includes(user.role);
}

export type PendingStMode = "dry" | "live";

export function dayBoardPendingStMode(env?: Env): PendingStMode {
  const raw = String(env?.DAY_BOARD_PENDING_ST || "")
    .trim()
    .toLowerCase();
  if (raw === "live" || raw === "1" || raw === "true" || raw === "on") return "live";
  return "dry";
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asDataArray(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  const d = (json as { data?: unknown }).data;
  return Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
}

/** Parse HH:MM or ISO → Chicago wall ISO for date. */
function windowToIso(date: string, raw: string | null | undefined, fallbackHm: string): string {
  const s = str(raw);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  const hm = /^(\d{1,2}):(\d{2})/.exec(s) || /^(\d{1,2}):(\d{2})/.exec(fallbackHm);
  const hour = hm ? Number(hm[1]) : 8;
  const minute = hm ? Number(hm[2]) : 0;
  return chicagoWallToIso(date, hour, minute);
}

export async function createDayBoardPending(
  db: D1Database,
  input: {
    date: string;
    tech_user_id?: number | null;
    st_technician_id?: number | null;
    display_name?: string | null;
    customer_name: string;
    customer_phone?: string | null;
    address: string;
    issue?: string | null;
    window_start?: string | null;
    window_end?: string | null;
    created_by: number;
  }
): Promise<{ ok: true; row: DayBoardPendingRow } | { ok: false; error: string }> {
  await ensureDayBoardPendingTable(db);
  const date = str(input.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "date required (YYYY-MM-DD)" };
  }
  const customer = str(input.customer_name);
  const address = str(input.address);
  if (customer.length < 2) return { ok: false, error: "Customer name required" };
  if (address.length < 5) return { ok: false, error: "Address required" };
  const issue = str(input.issue) || "No Cool";
  const stTech =
    input.st_technician_id != null && Number(input.st_technician_id) > 0
      ? Number(input.st_technician_id)
      : null;
  if (!stTech) return { ok: false, error: "Technician required" };

  const ins = await db
    .prepare(
      `INSERT INTO day_board_pending (
         date, tech_user_id, st_technician_id, display_name,
         customer_name, customer_phone, address, address_verified, issue,
         window_start, window_end, status, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'pending', ?, datetime('now'), datetime('now'))`
    )
    .bind(
      date,
      input.tech_user_id != null && Number(input.tech_user_id) > 0
        ? Number(input.tech_user_id)
        : null,
      stTech,
      str(input.display_name) || null,
      customer,
      str(input.customer_phone) || null,
      address,
      issue,
      str(input.window_start) || null,
      str(input.window_end) || null,
      input.created_by
    )
    .run();
  const id = Number(ins.meta.last_row_id);
  const row = await getPendingById(db, id);
  if (!row) return { ok: false, error: "Created but could not reload" };
  return { ok: true, row };
}

export async function getPendingById(
  db: D1Database,
  id: number
): Promise<DayBoardPendingRow | null> {
  await ensureDayBoardPendingTable(db);
  return (
    (await db
      .prepare(`SELECT * FROM day_board_pending WHERE id = ?`)
      .bind(id)
      .first<DayBoardPendingRow>()) || null
  );
}

export async function loadPendingJobsForBoard(
  db: D1Database,
  date: string
): Promise<Array<DayBoardJob & { _pending_tech_id?: number; pending_id?: number; board_status?: string }>> {
  await ensureDayBoardPendingTable(db);
  try {
    const q = await db
      .prepare(
        `SELECT * FROM day_board_pending
         WHERE date = ?
           AND status IN ('pending','approved','linking','failed')
         ORDER BY id ASC`
      )
      .bind(date)
      .all<DayBoardPendingRow>();
    const out: Array<
      DayBoardJob & {
        _pending_tech_id?: number;
        pending_id?: number;
        board_status?: string;
      }
    > = [];
    for (const r of q.results || []) {
      // Linked rows disappear from board-only merge — live ST appt will show
      if (r.status === "linked" || r.status === "discarded") continue;
      const stTech = r.st_technician_id != null ? Number(r.st_technician_id) : 0;
      if (!(stTech > 0)) continue;
      const startIso = windowToIso(r.date, r.window_start, "08:00");
      const endIso = windowToIso(r.date, r.window_end, "12:00");
      let note = "Pending approve";
      let statusLabel = "Pending";
      if (r.status === "linking" || r.status === "approved") {
        note = "Linking to ST…";
        statusLabel = "Linking";
      } else if (r.status === "failed") {
        note = `Link failed · Retry${r.error ? ` — ${r.error}` : ""}`.slice(0, 180);
        statusLabel = "Failed";
      }
      const job: DayBoardJob & {
        _pending_tech_id?: number;
        pending_id?: number;
        board_status?: string;
      } = {
        st_appointment_id: `pending-${r.id}`,
        st_job_id: r.st_job_id,
        job_number: r.st_job_number,
        address: r.address,
        address_source: "day_board_pending",
        customer_name: r.customer_name,
        customer_phone: r.customer_phone,
        job_type: r.issue || "No Cool",
        window_start: startIso,
        window_end: endIso,
        arrival_window_start: startIso,
        arrival_window_end: endIso,
        status: statusLabel,
        st_phase: "hold",
        is_done: false,
        is_off: false,
        ink: "board",
        note,
        helpers: [],
        pending_id: r.id,
        board_status: r.status,
        _pending_tech_id: stTech,
      };
      out.push(job);
    }
    return out;
  } catch {
    return [];
  }
}

async function resolveServiceBu(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<{ id: number | null; name: string; error?: string }> {
  const cached = (await getSetting(db, "day_board_pending_bu_id", "")).trim();
  if (cached && Number(cached) > 0) {
    return { id: Number(cached), name: "Service" };
  }
  const prefer = [
    (await getSetting(db, "day_board_pending_bu_name", "")).trim(),
    "HVAC Service",
    "Service",
    "Residential Service",
  ].filter(Boolean);
  let page = 1;
  const all: Array<{ id: number; name: string }> = [];
  while (page <= 20) {
    const res = await stApiGet(
      env,
      db,
      `/settings/v2/tenant/${tenantId}/business-units?page=${page}&pageSize=100&active=true`
    );
    if (!res.ok) break;
    for (const row of asDataArray(res.json)) {
      const id = num(row.id);
      const name = str(row.name);
      if (id && name) all.push({ id, name });
    }
    if (!(res.json as { hasMore?: boolean })?.hasMore) break;
    page += 1;
  }
  for (const want of prefer) {
    const hit = all.find((b) => b.name.toLowerCase() === want.toLowerCase());
    if (hit) return hit;
  }
  for (const want of prefer) {
    const hit = all.find((b) => b.name.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit;
  }
  return {
    id: null,
    name: prefer[0] || "Service",
    error: "Service business unit not found — set day_board_pending_bu_id",
  };
}

async function resolveNoCoolJobType(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<{ id: number | null; name: string; error?: string }> {
  const cached = (await getSetting(db, "day_board_pending_job_type_id", "")).trim();
  if (cached && Number(cached) > 0) {
    return { id: Number(cached), name: "No Cool" };
  }
  const prefer = [
    (await getSetting(db, "day_board_pending_job_type_name", "")).trim(),
    "No Cool",
    "No Cool - After Hours",
    "After Hours",
  ].filter(Boolean);
  let page = 1;
  const all: Array<{ id: number; name: string }> = [];
  while (page <= 30) {
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/job-types?page=${page}&pageSize=100&active=true`
    );
    if (!res.ok) break;
    for (const row of asDataArray(res.json)) {
      const id = num(row.id);
      const name = str(row.name);
      if (id && name) all.push({ id, name });
    }
    if (!(res.json as { hasMore?: boolean })?.hasMore) break;
    page += 1;
  }
  for (const want of prefer) {
    const hit = all.find((j) => j.name.toLowerCase() === want.toLowerCase());
    if (hit) return hit;
  }
  for (const want of prefer) {
    const hit = all.find((j) => j.name.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit;
  }
  return {
    id: null,
    name: "No Cool",
    error: "No Cool job type not found — set day_board_pending_job_type_id",
  };
}

async function resolveCampaign(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<{ id: number | null; name: string | null; error?: string }> {
  for (const key of ["day_board_pending_campaign_id", "miller_book_campaign_id"]) {
    const idSetting = (await getSetting(db, key, "")).trim();
    if (idSetting && Number(idSetting) > 0) {
      return { id: Number(idSetting), name: null };
    }
  }
  const res = await stApiGet(
    env,
    db,
    `/marketing/v2/tenant/${tenantId}/campaigns?page=1&pageSize=100&active=true`
  );
  if (!res.ok) {
    return { id: null, name: null, error: `Campaigns fetch failed (${res.status})` };
  }
  const first = asDataArray(res.json)[0];
  if (!first) return { id: null, name: null, error: "No active campaigns" };
  return { id: num(first.id) || null, name: str(first.name) || null };
}

async function setPendingStatus(
  db: D1Database,
  id: number,
  patch: {
    status: PendingStatus;
    error?: string | null;
    address_verified?: number;
    st_job_id?: string | null;
    st_appointment_id?: string | null;
    st_job_number?: string | null;
    approved_by?: number | null;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE day_board_pending SET
         status = ?,
         error = ?,
         address_verified = COALESCE(?, address_verified),
         st_job_id = COALESCE(?, st_job_id),
         st_appointment_id = COALESCE(?, st_appointment_id),
         st_job_number = COALESCE(?, st_job_number),
         approved_by = COALESCE(?, approved_by),
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(
      patch.status,
      patch.error !== undefined ? patch.error : null,
      patch.address_verified != null ? patch.address_verified : null,
      patch.st_job_id != null ? patch.st_job_id : null,
      patch.st_appointment_id != null ? patch.st_appointment_id : null,
      patch.st_job_number != null ? patch.st_job_number : null,
      patch.approved_by != null ? patch.approved_by : null,
      id
    )
    .run();
}

/**
 * Background linker: verify address → anti-dupe → ST create (Confirms OFF).
 * Never sends customer SMS/email.
 */
export async function linkPendingToServiceTitan(
  env: Env,
  db: D1Database,
  pendingId: number,
  actor: PublicUser
): Promise<{ ok: boolean; message: string; mode: PendingStMode }> {
  await ensureDayBoardPendingTable(db);
  const row = await getPendingById(db, pendingId);
  if (!row) return { ok: false, message: "Pending not found", mode: dayBoardPendingStMode(env) };
  if (row.status === "discarded") {
    return { ok: false, message: "Discarded", mode: dayBoardPendingStMode(env) };
  }
  if (row.status === "linked" && row.st_job_id) {
    return { ok: true, message: "Already linked", mode: dayBoardPendingStMode(env) };
  }

  const mode = dayBoardPendingStMode(env);
  await setPendingStatus(db, pendingId, {
    status: "linking",
    error: null,
    approved_by: actor.id,
  });

  try {
    if (!(await stConfigured(env, db))) {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: "ServiceTitan not connected",
      });
      return { ok: false, message: "ServiceTitan not connected", mode };
    }
    const tenantId = await stTenantId(env, db);
    if (!tenantId) {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: "ST tenant missing",
      });
      return { ok: false, message: "ST tenant missing", mode };
    }

    // 1) Address VERIFY — must resolve to an ST location
    const { hits } = await searchMillerLocations(env, db, row.address);
    const loc = hits[0];
    if (!loc || !(Number(loc.location_id) > 0)) {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: "Address not found in ServiceTitan — verify name + maps-correct street",
        address_verified: 0,
      });
      return {
        ok: false,
        message: "Address not verified in ST",
        mode,
      };
    }
    const locationId = Number(loc.location_id);
    const customerId = Number(loc.customer_id) || 0;
    if (!(customerId > 0)) {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: "Location has no customer in ST",
        address_verified: 0,
      });
      return { ok: false, message: "No customer on location", mode };
    }
    await setPendingStatus(db, pendingId, {
      status: "linking",
      address_verified: 1,
      error: null,
    });

    // 2) Anti-dupe: open jobs at address
    const open = await findOpenJobsAtAddressText(
      env,
      db,
      tenantId,
      row.address,
      row.date
    );
    if (open.length > 0) {
      const first = open[0]!;
      const jobNum = str(first.job_number) || String(first.job_id || "open");
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: `Open ST job already at address (#${jobNum}) - link manually or discard`,
        address_verified: 1,
      });
      return {
        ok: false,
        message: `Anti-dupe: open job #${jobNum}`,
        mode,
      };
    }

    const bu = await resolveServiceBu(env, db, tenantId);
    if (!bu.id) {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: bu.error || "Service BU missing",
        address_verified: 1,
      });
      return { ok: false, message: bu.error || "BU missing", mode };
    }
    const jt = await resolveNoCoolJobType(env, db, tenantId);
    if (!jt.id) {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: jt.error || "No Cool job type missing",
        address_verified: 1,
      });
      return { ok: false, message: jt.error || "Job type missing", mode };
    }
    const campaign = await resolveCampaign(env, db, tenantId);
    if (!campaign.id) {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: campaign.error || "Campaign missing",
        address_verified: 1,
      });
      return { ok: false, message: campaign.error || "Campaign missing", mode };
    }

    const techId = Number(row.st_technician_id);
    if (!(techId > 0)) {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: "No ST technician on pending chip",
        address_verified: 1,
      });
      return { ok: false, message: "No technician", mode };
    }

    const startIso = windowToIso(row.date, row.window_start, "08:00");
    const endIso = windowToIso(row.date, row.window_end, "12:00");
    const summary =
      `${row.issue || "No Cool"} - ${row.customer_name}`.slice(0, 120);

    // HARD LOCK: Confirms OFF + Job Notifications OFF (no customer texts)
    const payload: Record<string, unknown> = {
      customerId,
      locationId,
      businessUnitId: bu.id,
      jobTypeId: jt.id,
      priority: "Normal",
      campaignId: campaign.id,
      summary,
      notificationsEnabled: false,
      appointments: [
        {
          start: startIso,
          end: endIso,
          arrivalWindowStart: startIso,
          arrivalWindowEnd: endIso,
          technicianIds: [techId],
        },
      ],
    };

    if (mode !== "live") {
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error:
          "ST link dry-run only — set DAY_BOARD_PENDING_ST=live after READY + Chris Y",
        address_verified: 1,
      });
      return {
        ok: false,
        message: "Dry mode — no ST write",
        mode,
      };
    }

    const post = await stApiJson(env, db, `/jpm/v2/tenant/${tenantId}/jobs`, {
      method: "POST",
      body: payload,
    });
    if (!post.ok) {
      const err = (post.text || `ST ${post.status}`).slice(0, 400);
      await setPendingStatus(db, pendingId, {
        status: "failed",
        error: err,
        address_verified: 1,
      });
      return { ok: false, message: err, mode };
    }
    const body = (post.json || {}) as Record<string, unknown>;
    const stJobId = num(body.id) ? String(num(body.id)) : null;
    const stJobNumber = str(body.jobNumber) || null;
    const stAppt =
      num(body.firstAppointmentId) || num(body.lastAppointmentId)
        ? String(num(body.firstAppointmentId) || num(body.lastAppointmentId))
        : null;

    await setPendingStatus(db, pendingId, {
      status: "linked",
      error: null,
      address_verified: 1,
      st_job_id: stJobId,
      st_appointment_id: stAppt,
      st_job_number: stJobNumber,
      approved_by: actor.id,
    });
    return {
      ok: true,
      message: `Linked ST job ${stJobNumber || stJobId || ""}`,
      mode,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setPendingStatus(db, pendingId, {
      status: "failed",
      error: msg.slice(0, 400),
    }).catch(() => {});
    return { ok: false, message: msg, mode: dayBoardPendingStMode(env) };
  }
}

export async function discardPending(
  db: D1Database,
  id: number
): Promise<{ ok: boolean; error?: string }> {
  await ensureDayBoardPendingTable(db);
  const row = await getPendingById(db, id);
  if (!row) return { ok: false, error: "Not found" };
  if (row.status === "linked" && row.st_job_id) {
    return { ok: false, error: "Already in ServiceTitan — discard blocked" };
  }
  await setPendingStatus(db, id, { status: "discarded", error: null });
  return { ok: true };
}
