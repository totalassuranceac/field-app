/**
 * Clock→ST Phase 1: Field App one-clock (Dispatch → Arrive → Complete).
 * Records taps in D1 as queued. NEVER writes appointment status to ServiceTitan.
 */

import type { Env, PublicUser } from "./types";
import { stApiGet, stConfigured, stTenantId } from "./servicetitan";
import {
  loadStTechnicians,
  matchUserToStTechnician,
  type StTechnician,
} from "./zeroCharge";

export type ClockStep = "dispatch" | "arrive" | "complete";

export type JobClockState = {
  dispatch_at: string | null;
  arrive_at: string | null;
  complete_at: string | null;
  next_step: ClockStep | null;
  sync_status: "queued" | "synced" | "error" | null;
};

export type TodayJob = {
  st_job_id: string;
  st_appointment_id: string | null;
  job_number: string | null;
  customer_name: string | null;
  address: string | null;
  window_start: string | null;
  window_end: string | null;
  st_appointment_status: string | null;
  clock: JobClockState;
};

export type TodayJobsResponse = {
  configured: boolean;
  st_write_enabled: false;
  technician_id: number | null;
  today: string;
  jobs: TodayJob[];
  message?: string;
};

export type ClockEventRow = {
  id: number;
  user_id: number;
  st_job_id: string;
  st_appointment_id: string | null;
  step: string;
  client_ts: string;
  created_at: string;
  sync_status: string;
  sync_error: string | null;
};

const TZ = "America/Chicago";
const DEDUPE_MINUTES = 2;
const PHASE1_SYNC_LABEL = "Saved on phone — ServiceTitan sync coming";

/**
 * PHASE 1 hard guard: never enable ST appointment status writes.
 * Phase 2 may honor env.CLOCK_ST_WRITE === "1" — leave that path unimplemented here.
 */
export function clockStWriteEnabled(_env?: Env): boolean {
  // PHASE 1: never PATCH/POST ServiceTitan appointment / technician status
  return false;
}

export function clockSyncLabel(): string {
  return PHASE1_SYNC_LABEL;
}

let tablesReady = false;
export async function ensureJobClockTables(db: D1Database): Promise<void> {
  if (tablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS job_clock_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      st_job_id TEXT NOT NULL,
      st_appointment_id TEXT,
      step TEXT NOT NULL CHECK (step IN ('dispatch', 'arrive', 'complete')),
      client_ts TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sync_status TEXT NOT NULL DEFAULT 'queued'
        CHECK (sync_status IN ('queued', 'synced', 'error')),
      sync_error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_job_clock_user_appt
      ON job_clock_events(user_id, st_appointment_id, step, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_job_clock_user_job
      ON job_clock_events(user_id, st_job_id, step, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_job_clock_sync
      ON job_clock_events(sync_status, created_at)`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists */
    }
  }
  tablesReady = true;
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

/** Chicago calendar day bounds as ST-style offset timestamps. */
export function chicagoDayBounds(now = new Date()): {
  today: string;
  startOff: string;
  endBeforeOff: string;
} {
  const { y, m, day } = chicagoParts(now);
  const start = zonedLocalToUtc(y, m, day, 0, 0, 0);
  // Next Chicago midnight: walk ~30h ahead and re-read local Y-M-D (DST-safe)
  const probe = chicagoParts(new Date(start.getTime() + 30 * 3600 * 1000));
  const end = zonedLocalToUtc(probe.y, probe.m, probe.day, 0, 0, 0);
  const today = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    today,
    startOff: toChicagoOffsetIso(start),
    endBeforeOff: toChicagoOffsetIso(end),
  };
}

function emptyClock(): JobClockState {
  return {
    dispatch_at: null,
    arrive_at: null,
    complete_at: null,
    next_step: "dispatch",
    sync_status: null,
  };
}

export function clockStateFromEvents(
  events: Array<{ step: string; client_ts: string; sync_status: string }>
): JobClockState {
  const clock = emptyClock();
  let latestSync: JobClockState["sync_status"] = null;
  for (const e of events) {
    const step = String(e.step || "").toLowerCase();
    const ts = e.client_ts || null;
    if (step === "dispatch" && !clock.dispatch_at) clock.dispatch_at = ts;
    if (step === "arrive" && !clock.arrive_at) clock.arrive_at = ts;
    if (step === "complete" && !clock.complete_at) clock.complete_at = ts;
    const ss = String(e.sync_status || "").toLowerCase();
    if (ss === "error") latestSync = "error";
    else if (ss === "queued" && latestSync !== "error") latestSync = "queued";
    else if (ss === "synced" && !latestSync) latestSync = "synced";
  }
  clock.sync_status = latestSync;
  if (!clock.dispatch_at) clock.next_step = "dispatch";
  else if (!clock.arrive_at) clock.next_step = "arrive";
  else if (!clock.complete_at) clock.next_step = "complete";
  else clock.next_step = null;
  return clock;
}

async function loadClockEventsForUser(
  db: D1Database,
  userId: number
): Promise<ClockEventRow[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT id, user_id, st_job_id, st_appointment_id, step, client_ts, created_at,
                sync_status, sync_error
         FROM job_clock_events
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 500`
      )
      .bind(userId)
      .all<ClockEventRow>();
    return rows.results || [];
  } catch {
    return [];
  }
}

function eventsForAppointment(
  all: ClockEventRow[],
  stJobId: string,
  stAppointmentId: string | null
): ClockEventRow[] {
  return all.filter((e) => {
    if (stAppointmentId) {
      return String(e.st_appointment_id || "") === String(stAppointmentId);
    }
    return String(e.st_job_id) === String(stJobId) && !e.st_appointment_id;
  });
}

function strField(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function nestStr(obj: Record<string, unknown>, path: string[]): string | null {
  let cur: unknown = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (typeof cur === "string" && cur.trim()) return cur.trim();
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  return null;
}

function formatAddress(loc: Record<string, unknown> | null | undefined): string | null {
  if (!loc) return null;
  const addr =
    (loc.address && typeof loc.address === "object"
      ? (loc.address as Record<string, unknown>)
      : loc) || {};
  const street = strField(addr as Record<string, unknown>, "street", "streetAddress", "line1");
  const city = strField(addr as Record<string, unknown>, "city");
  const state = strField(addr as Record<string, unknown>, "state", "stateProv");
  const zip = strField(addr as Record<string, unknown>, "zip", "postalCode", "zipCode");
  const parts = [street, [city, state].filter(Boolean).join(", "), zip].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

type RawAppt = Record<string, unknown>;

async function fetchTodaysAppointments(
  env: Env,
  db: D1Database,
  tenantId: string,
  technicianId: number,
  startOff: string,
  endBeforeOff: string
): Promise<{ ok: boolean; status?: number; appointments: RawAppt[]; error?: string }> {
  const appointments: RawAppt[] = [];
  let page = 1;
  while (page <= 20) {
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
        // Fallback param name used elsewhere in zeroCharge
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
          return {
            ok: false,
            status: res.status,
            appointments: [],
            error: `ServiceTitan appointments failed (${res.status})`,
          };
        }
        const body2 = res2.json as { data?: RawAppt[]; hasMore?: boolean };
        for (const a of body2.data || []) appointments.push(a);
        break;
      }
      break;
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

async function enrichJobs(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobIds: number[]
): Promise<Map<number, Record<string, unknown>>> {
  const map = new Map<number, Record<string, unknown>>();
  const ids = [...new Set(jobIds.filter((n) => n > 0))];
  if (!ids.length) return map;
  // Batch in chunks of 50
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
  return map;
}

async function resolveTechnicianId(
  env: Env,
  db: D1Database,
  user: PublicUser,
  tenantId: string
): Promise<{ technicianId: number | null; message?: string }> {
  const stored =
    user.st_technician_id != null && Number(user.st_technician_id) > 0
      ? Number(user.st_technician_id)
      : null;
  if (stored) return { technicianId: stored };

  let techs: StTechnician[] = [];
  try {
    const loaded = await loadStTechnicians(env, db, tenantId);
    if (loaded.ok) techs = loaded.techs;
  } catch {
    /* ignore */
  }
  const match = matchUserToStTechnician(
    {
      display_name: user.display_name,
      username: user.username,
      email: user.email,
      phone: user.phone,
      st_technician_id: user.st_technician_id,
    },
    techs
  );
  if (match.status === "matched") return { technicianId: match.stId };
  return {
    technicianId: null,
    message:
      "No ServiceTitan technician linked — ask office to set your ST tech ID in People.",
  };
}

export async function getTodaysJobsForUser(
  env: Env,
  db: D1Database,
  user: PublicUser
): Promise<TodayJobsResponse> {
  await ensureJobClockTables(db);
  const { today, startOff, endBeforeOff } = chicagoDayBounds();
  const base: TodayJobsResponse = {
    configured: false,
    st_write_enabled: false,
    technician_id: null,
    today,
    jobs: [],
  };

  if (!(await stConfigured(env, db))) {
    return {
      ...base,
      message: "ServiceTitan not connected. Office can add credentials in Admin.",
    };
  }

  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return {
      ...base,
      configured: true,
      message: "ServiceTitan tenant missing.",
    };
  }

  const resolved = await resolveTechnicianId(env, db, user, tenantId);
  if (!resolved.technicianId) {
    return {
      ...base,
      configured: true,
      message: resolved.message,
    };
  }

  const apptRes = await fetchTodaysAppointments(
    env,
    db,
    tenantId,
    resolved.technicianId,
    startOff,
    endBeforeOff
  );
  if (!apptRes.ok) {
    return {
      ...base,
      configured: true,
      technician_id: resolved.technicianId,
      message: apptRes.error || "Could not load today’s jobs from ServiceTitan.",
    };
  }

  const jobIds = apptRes.appointments
    .map((a) => Number(a.jobId))
    .filter((n) => n > 0);
  const jobMap = await enrichJobs(env, db, tenantId, jobIds);
  const allEvents = await loadClockEventsForUser(db, user.id);

  const jobs: TodayJob[] = [];
  for (const a of apptRes.appointments) {
    const apptId = a.id != null ? String(a.id) : null;
    const jobIdNum = Number(a.jobId);
    if (!(jobIdNum > 0) && !apptId) continue;
    const stJobId = jobIdNum > 0 ? String(jobIdNum) : `appt:${apptId}`;
    const job = jobIdNum > 0 ? jobMap.get(jobIdNum) : undefined;

    const customerName =
      strField(a, "customerName", "customer_name") ||
      nestStr(a, ["customer", "name"]) ||
      (job ? strField(job, "customerName") : null) ||
      (job ? nestStr(job, ["customer", "name"]) : null);

    const address =
      formatAddress(a.location as Record<string, unknown>) ||
      formatAddress(a.address as Record<string, unknown>) ||
      strField(a, "address", "locationAddress", "summary") ||
      (job ? formatAddress(job.location as Record<string, unknown>) : null) ||
      (job ? strField(job, "locationAddress", "address") : null);

    const jobNumber =
      (job ? strField(job, "jobNumber", "number") : null) ||
      strField(a, "jobNumber") ||
      (jobIdNum > 0 ? String(jobIdNum) : null);

    const windowStart =
      strField(a, "start", "startDate", "arrivalWindowStart", "scheduledStart") || null;
    const windowEnd =
      strField(a, "end", "endDate", "arrivalWindowEnd", "scheduledEnd") || null;
    const status = strField(a, "status", "appointmentStatus", "appointmentStatusName");

    const related = eventsForAppointment(allEvents, stJobId, apptId);
    // chronological for clockStateFromEvents (it takes first per step — feed oldest first)
    const chronological = [...related].reverse();
    const clock = clockStateFromEvents(
      chronological.map((e) => ({
        step: e.step,
        client_ts: e.client_ts,
        sync_status: e.sync_status,
      }))
    );

    jobs.push({
      st_job_id: stJobId,
      st_appointment_id: apptId,
      job_number: jobNumber,
      customer_name: customerName,
      address,
      window_start: windowStart,
      window_end: windowEnd,
      st_appointment_status: status,
      clock,
    });
  }

  // Sort by window start
  jobs.sort((a, b) => String(a.window_start || "").localeCompare(String(b.window_start || "")));

  return {
    configured: true,
    st_write_enabled: false,
    technician_id: resolved.technicianId,
    today,
    jobs,
    message: jobs.length ? undefined : "No jobs on your schedule for today.",
  };
}

function isValidStep(step: string): step is ClockStep {
  return step === "dispatch" || step === "arrive" || step === "complete";
}

export async function recordClockStep(
  db: D1Database,
  user: PublicUser,
  stepRaw: string,
  body: {
    st_job_id?: string;
    st_appointment_id?: string | null;
    client_ts?: string | null;
  }
): Promise<
  | { ok: true; deduped: boolean; event: ClockEventRow; clock: JobClockState; label: string }
  | { ok: false; status: number; error: string }
> {
  await ensureJobClockTables(db);

  // PHASE 1: assert write guard stays off (no ST mutation path exists here)
  if (clockStWriteEnabled()) {
    return {
      ok: false,
      status: 503,
      error: "ServiceTitan clock sync is not enabled (Phase 1).",
    };
  }

  if (!isValidStep(stepRaw)) {
    return { ok: false, status: 400, error: "step must be dispatch, arrive, or complete" };
  }
  const step: ClockStep = stepRaw;
  const stJobId = String(body.st_job_id || "").trim();
  if (!stJobId) return { ok: false, status: 400, error: "st_job_id required" };
  const stAppointmentId = body.st_appointment_id != null && String(body.st_appointment_id).trim()
    ? String(body.st_appointment_id).trim()
    : null;
  const clientTs =
    (body.client_ts && String(body.client_ts).trim()) || new Date().toISOString();

  const all = await loadClockEventsForUser(db, user.id);
  const related = eventsForAppointment(all, stJobId, stAppointmentId);
  const clockBefore = clockStateFromEvents(
    [...related]
      .reverse()
      .map((e) => ({ step: e.step, client_ts: e.client_ts, sync_status: e.sync_status }))
  );

  // Order enforcement
  if (step === "arrive" && !clockBefore.dispatch_at) {
    return { ok: false, status: 400, error: "Dispatch before Arrive." };
  }
  if (step === "complete" && !clockBefore.arrive_at) {
    return { ok: false, status: 400, error: "Arrive before Complete." };
  }
  if (clockBefore.next_step && clockBefore.next_step !== step) {
    // Allow re-tap of already-done step only via dedupe window; otherwise block skipping
    const already =
      (step === "dispatch" && clockBefore.dispatch_at) ||
      (step === "arrive" && clockBefore.arrive_at) ||
      (step === "complete" && clockBefore.complete_at);
    if (!already) {
      return {
        ok: false,
        status: 400,
        error: `Next step is ${clockBefore.next_step}.`,
      };
    }
  }

  // Idempotent-ish: same step within DEDUPE_MINUTES
  const recent = related.find((e) => {
    if (String(e.step).toLowerCase() !== step) return false;
    const created = Date.parse(String(e.created_at).includes("T") ? e.created_at : `${e.created_at}Z`);
    const ageMin = (Date.now() - (Number.isFinite(created) ? created : 0)) / 60000;
    return ageMin >= 0 && ageMin <= DEDUPE_MINUTES;
  });
  if (recent) {
    const clock = clockStateFromEvents(
      [...related]
        .reverse()
        .map((e) => ({ step: e.step, client_ts: e.client_ts, sync_status: e.sync_status }))
    );
    return {
      ok: true,
      deduped: true,
      event: recent,
      clock,
      label: PHASE1_SYNC_LABEL,
    };
  }

  // Already completed this step earlier (outside dedupe) — return current state, no insert
  const alreadyDone =
    (step === "dispatch" && clockBefore.dispatch_at) ||
    (step === "arrive" && clockBefore.arrive_at) ||
    (step === "complete" && clockBefore.complete_at);
  if (alreadyDone) {
    const existing = related.find((e) => String(e.step).toLowerCase() === step);
    if (existing) {
      return {
        ok: true,
        deduped: true,
        event: existing,
        clock: clockBefore,
        label: PHASE1_SYNC_LABEL,
      };
    }
  }

  const ins = await db
    .prepare(
      `INSERT INTO job_clock_events
        (user_id, st_job_id, st_appointment_id, step, client_ts, sync_status)
       VALUES (?, ?, ?, ?, ?, 'queued')`
    )
    .bind(user.id, stJobId, stAppointmentId, step, clientTs)
    .run();

  const id = Number(ins.meta.last_row_id);
  const event = await db
    .prepare(
      `SELECT id, user_id, st_job_id, st_appointment_id, step, client_ts, created_at,
              sync_status, sync_error
       FROM job_clock_events WHERE id = ?`
    )
    .bind(id)
    .first<ClockEventRow>();

  if (!event) {
    return { ok: false, status: 500, error: "Insert failed" };
  }

  // Rebuild from DB (ASC) so first timestamp per step wins
  const refreshed = await loadClockEventsForUser(db, user.id);
  const relatedAsc = eventsForAppointment(refreshed, stJobId, stAppointmentId)
    .slice()
    .reverse();
  const clock = clockStateFromEvents(
    relatedAsc.map((e) => ({
      step: e.step,
      client_ts: e.client_ts,
      sync_status: e.sync_status,
    }))
  );

  return {
    ok: true,
    deduped: false,
    event,
    clock,
    label: PHASE1_SYNC_LABEL,
  };
}

/** Phase 2 stub — no-op. Never call ST from here in Phase 1. */
export async function syncQueuedClockEvents(_env: Env, _db: D1Database): Promise<number> {
  if (!clockStWriteEnabled()) return 0;
  return 0;
}
