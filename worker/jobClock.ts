/**
 * Job Clock — today's ST appointments + Dispatch / Arrive / Complete punches.
 *
 * Phase 2 CLOCK_ST_WRITE used to PATCH /appointments/{id} with {status}.
 * That is not a valid ST operation (AppointmentUpdateRequest only allows
 * specialInstructions) and ServiceTitan returns 404
 * "Unable to match incoming request to an operation."
 *
 * Sync now:
 *  1) Treat already-advanced appointment / assignment / timesheet as synced.
 *  2) Try job-timesheet timestamp writes (the real ST punch fields).
 *  3) Never PATCH appointment status.
 *  4) If ST still cannot accept the punch, leave a clear office retry/ack path.
 */

import type { Env, PublicUser } from "./types";
import { stApiGet, stApiJson, stConfigured, stTenantId } from "./servicetitan";
import { loadStTechnicians, matchUserToStTechnician, type StTechnician } from "./zeroCharge";
import { evaluatePermitGate } from "./installPermitGate";
import { loadShopSessionBrief } from "./shopClock";

const TZ = "America/Chicago";
const DEDUPE_MINUTES = 2;
const SYNC_LABEL_QUEUED = "Saved on Field App - do not use ServiceTitan Time Clock";
const SYNC_LABEL_LIVE = "Saved - syncing appointment status to ServiceTitan";
const SYNC_BATCH = 40;

export type ClockStep = "dispatch" | "arrive" | "complete";

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

export type ClockState = {
  dispatch_at: string | null;
  arrive_at: string | null;
  complete_at: string | null;
  next_step: ClockStep | null;
  sync_status: string | null;
  sync_error: string | null;
};

type SyncResult = "synced" | "dry" | "failed_transient" | "failed_permanent" | "needs_office";

/** Appointment-level enum (GET). Not writable via PATCH. */
const CLOCK_STEP_TO_APPT_STATUS: Record<ClockStep, string> = {
  dispatch: "Dispatched",
  arrive: "InProgress",
  complete: "Done",
};

/** Per-tech assignment enum. Arrive = Working. */
const CLOCK_STEP_TO_ASSIGNMENT_STATUS: Record<ClockStep, string> = {
  dispatch: "Dispatched",
  arrive: "Working",
  complete: "Done",
};

const CLOCK_STEP_LABEL: Record<ClockStep, string> = {
  dispatch: "Dispatched",
  arrive: "Arrived / Working",
  complete: "Done",
};

export function clockStWriteMode(env: Env): "off" | "dry" | "live" {
  const raw = String(env?.CLOCK_ST_WRITE ?? "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off" || raw === "no") return "off";
  if (raw === "dry" || raw === "dry-run" || raw === "dryrun") return "dry";
  if (raw === "1" || raw === "true" || raw === "live" || raw === "on" || raw === "yes") {
    return "live";
  }
  return "off";
}

export function clockStWriteEnabled(env: Env): boolean {
  return clockStWriteMode(env) === "live";
}

function clockSyncPipelineEnabled(env: Env): boolean {
  const m = clockStWriteMode(env);
  return m === "live" || m === "dry";
}

function clockSyncLabel(env: Env): string {
  return clockStWriteEnabled(env) ? SYNC_LABEL_LIVE : SYNC_LABEL_QUEUED;
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
      /* already exists / older CHECK */
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

function zonedLocalToUtc(y: number, m: number, d: number, hh: number, mi: number, ss: number): Date {
  let utc = new Date(Date.UTC(y, m - 1, d, hh, mi, ss));
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(TZ, utc);
    utc = new Date(Date.UTC(y, m - 1, d, hh, mi, ss) - off);
  }
  return utc;
}

function toChicagoOffsetIso(utcInstant: Date): string {
  const offMs = tzOffsetMs(TZ, utcInstant);
  const totalMin = Math.round(offMs / 6e4);
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

function chicagoDayBounds(now = new Date()): { today: string; startOff: string; endBeforeOff: string } {
  const { y, m, day } = chicagoParts(now);
  const start = zonedLocalToUtc(y, m, day, 0, 0, 0);
  const probe = chicagoParts(new Date(start.getTime() + 30 * 3600 * 1e3));
  const end = zonedLocalToUtc(probe.y, probe.m, probe.day, 0, 0, 0);
  const today = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { today, startOff: toChicagoOffsetIso(start), endBeforeOff: toChicagoOffsetIso(end) };
}

function emptyClock(): ClockState {
  return {
    dispatch_at: null,
    arrive_at: null,
    complete_at: null,
    next_step: "dispatch",
    sync_status: null,
    sync_error: null,
  };
}

function clockStateFromEvents(
  events: Array<{ step: string; client_ts: string | null; sync_status: string | null; sync_error?: string | null }>
): ClockState {
  const clock = emptyClock();
  let latestSync: string | null = null;
  let latestError: string | null = null;
  for (const e of events) {
    const step = String(e.step || "").toLowerCase();
    const ts = e.client_ts || null;
    if (step === "dispatch" && !clock.dispatch_at) clock.dispatch_at = ts;
    if (step === "arrive" && !clock.arrive_at) clock.arrive_at = ts;
    if (step === "complete" && !clock.complete_at) clock.complete_at = ts;
    const ss = String(e.sync_status || "").toLowerCase();
    if (ss === "error") {
      latestSync = "error";
      if (e.sync_error) latestError = String(e.sync_error);
    } else if (ss === "queued" && latestSync !== "error") {
      latestSync = "queued";
    } else if (ss === "synced" && !latestSync) {
      latestSync = "synced";
    }
  }
  clock.sync_status = latestSync;
  clock.sync_error = latestSync === "error" ? latestError : null;
  if (!clock.dispatch_at) clock.next_step = "dispatch";
  else if (!clock.arrive_at) clock.next_step = "arrive";
  else if (!clock.complete_at) clock.next_step = "complete";
  else clock.next_step = null;
  return clock;
}

async function loadClockEventsForUser(db: D1Database, userId: number): Promise<ClockEventRow[]> {
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function strField(obj: unknown, ...keys: string[]): string | null {
  const o = asRecord(obj);
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (v == null) continue;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function nestStr(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const p of path) {
    const o = asRecord(cur);
    if (!o) return null;
    cur = o[p];
  }
  if (typeof cur === "string" && cur.trim()) return cur.trim();
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  return null;
}

function looksLikeStreet(raw: string): boolean {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || t.length < 4) return false;
  if (/^\d{1,6}[A-Za-z]?\s+\S/.test(t)) return true;
  if (/^(p\.?\s*o\.?\s*box|hwy|fm|ih|us|rr|cr)\b/i.test(t)) return true;
  return false;
}

function parseLeadingStreet(raw: unknown): string | null {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const spaced = s.match(/^(.+?)\s+[—–-]\s+/);
  if (spaced) s = spaced[1].trim();
  else {
    const tight = s.match(/^(\d{1,6}[A-Za-z]?\s+[A-Za-z][A-Za-z0-9.'/# ]*?)\s*[—–-]\s*[A-Za-z]/);
    if (tight) s = tight[1].trim();
  }
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!looksLikeStreet(s)) return null;
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

export function formatAddress(loc: unknown): string | null {
  if (!loc) return null;
  if (typeof loc === "string") {
    const s = loc.trim();
    return s || null;
  }
  const rec = asRecord(loc);
  if (!rec) return null;
  const addr = (asRecord(rec.address) || rec) as Record<string, unknown>;
  const street =
    strField(addr, "street", "streetAddress", "line1", "address1") ||
    (typeof addr.name === "string" && /\d/.test(addr.name) ? String(addr.name).trim() : null);
  const unit = strField(addr, "unit", "apt", "suite");
  const city = strField(addr, "city");
  const state = strField(addr, "state", "stateProv");
  const zip = strField(addr, "zip", "postalCode", "zipCode");
  const streetLine = [street, unit].filter(Boolean).join(" ");
  const parts = [streetLine, [city, state].filter(Boolean).join(", "), zip].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function streetFromAddressShape(loc: unknown): string | null {
  if (!loc) return null;
  if (typeof loc === "string") {
    const direct = loc.replace(/\s+/g, " ").trim();
    if (direct && looksLikeStreet(direct)) return direct;
    return parseLeadingStreet(direct);
  }
  const o = asRecord(loc);
  if (!o) return null;
  if (o.address && typeof o.address === "object") {
    const nested = streetFromAddressShape(o.address);
    if (nested) return nested;
  }
  const street = strField(o, "street", "streetAddress", "addressLine1", "line1", "Address", "address1");
  if (street) {
    const city = strField(o, "city") || "";
    if (street.length < 12 && city) return `${street}, ${city}`;
    return street;
  }
  return parseLeadingStreet(o.name || o.customerName || "");
}

/** Full line for techs: street · city, ST zip when CRM has it; else any street ST stored. */
export function resolveJobAddress(opts: {
  crmLoc?: unknown;
  job?: Record<string, unknown>;
  appt?: Record<string, unknown>;
}): string | null {
  const { crmLoc, job, appt } = opts;
  const formatted =
    formatAddress(crmLoc) ||
    (job ? formatAddress(job.location) : null) ||
    (job ? formatAddress(job.locationAddress) : null) ||
    (job ? formatAddress(job.address) : null) ||
    (appt ? formatAddress(appt.location) : null) ||
    (appt ? formatAddress(appt.address) : null) ||
    (appt ? formatAddress(appt.locationAddress) : null) ||
    (appt ? formatAddress(appt.customerAddress) : null);
  if (formatted && (looksLikeStreet(formatted) || formatted.includes("·") || formatted.includes(","))) {
    return formatted;
  }
  const cands: string[] = [];
  const push = (s: string | null) => {
    if (s && s.trim()) cands.push(s.trim());
  };
  push(streetFromAddressShape(crmLoc));
  if (job) {
    push(streetFromAddressShape(job._resolvedLocation));
    push(streetFromAddressShape(job.location));
    push(streetFromAddressShape(job.address));
    push(streetFromAddressShape(job.locationAddress));
    if (typeof job.locationAddress === "string") push(job.locationAddress);
    push(parseLeadingStreet(job.summary));
    push(parseLeadingStreet(job.summaryOfWork));
    push(parseLeadingStreet(job.specialInstructions));
  }
  if (appt) {
    push(streetFromAddressShape(appt.customerAddress));
    push(streetFromAddressShape(appt.address));
    push(streetFromAddressShape(appt.location));
    push(streetFromAddressShape(appt.locationAddress));
    if (typeof appt.locationAddress === "string") push(appt.locationAddress);
    if (typeof appt.address === "string") push(appt.address);
    push(parseLeadingStreet(appt.summary));
    push(parseLeadingStreet(appt.specialInstructions));
    push(parseLeadingStreet(appt.appointmentSummary));
    push(parseLeadingStreet(appt.notes));
    push(strField(appt, "address", "locationAddress"));
  }
  const best = cands.find((c) => looksLikeStreet(c)) || cands[0] || formatted;
  return best || null;
}

async function fetchTodaysAppointments(
  env: Env,
  db: D1Database,
  tenantId: string,
  technicianId: number,
  startOff: string,
  endBeforeOff: string
): Promise<{ ok: boolean; appointments: Record<string, unknown>[]; error?: string; status?: number }> {
  const appointments: Record<string, unknown>[] = [];
  let page = 1;
  while (page <= 20) {
    const q = new URLSearchParams({
      technicianId: String(technicianId),
      startsOnOrAfter: startOff,
      startsBefore: endBeforeOff,
      page: String(page),
      pageSize: "100",
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/appointments?${q.toString()}`);
    if (!res.ok) {
      if (page === 1) {
        const q2 = new URLSearchParams({
          technicianId: String(technicianId),
          startsOnOrAfter: startOff,
          startsOnOrBefore: endBeforeOff,
          page: "1",
          pageSize: "100",
        });
        const res2 = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/appointments?${q2.toString()}`);
        if (!res2.ok) {
          return {
            ok: false,
            status: res.status,
            appointments: [],
            error: `ServiceTitan appointments failed (${res.status})`,
          };
        }
        const body2 = asRecord(res2.json);
        const data = Array.isArray(body2?.data) ? body2!.data : [];
        for (const a of data) {
          const row = asRecord(a);
          if (row) appointments.push(row);
        }
        break;
      }
      break;
    }
    const body = asRecord(res.json);
    const rows = Array.isArray(body?.data) ? body!.data : [];
    for (const a of rows) {
      const row = asRecord(a);
      if (row) appointments.push(row);
    }
    if (!rows.length || body?.hasMore === false) break;
    if (body?.hasMore !== true && rows.length < 100) break;
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
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const q = new URLSearchParams({
      ids: chunk.join(","),
      pageSize: String(Math.max(chunk.length, 10)),
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
    if (!res.ok) continue;
    const body = asRecord(res.json);
    for (const row of (Array.isArray(body?.data) ? body!.data : []) as unknown[]) {
      const rec = asRecord(row);
      const id = Number(rec?.id);
      if (rec && id > 0) map.set(id, rec);
    }
  }
  const missing = ids.filter((id) => !map.has(id));
  for (const id of missing) {
    const one = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs/${id}`);
    const rec = asRecord(one.json);
    if (one.ok && rec && Number(rec.id) > 0) map.set(Number(rec.id), rec);
  }
  return map;
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
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const q = new URLSearchParams({
      ids: chunk.join(","),
      pageSize: String(Math.max(chunk.length, 10)),
    });
    const res = await stApiGet(env, db, `/crm/v2/tenant/${tenantId}/locations?${q.toString()}`);
    if (!res.ok) continue;
    const body = asRecord(res.json);
    for (const row of (Array.isArray(body?.data) ? body!.data : []) as unknown[]) {
      const rec = asRecord(row);
      const id = Number(rec?.id);
      if (rec && id > 0) map.set(id, rec);
    }
  }
  const missing = ids.filter((id) => !map.has(id));
  for (const id of missing) {
    const one = await stApiGet(env, db, `/crm/v2/tenant/${tenantId}/locations/${id}`);
    const rec = asRecord(one.json);
    if (one.ok && rec && Number(rec.id) > 0) map.set(Number(rec.id), rec);
  }
  return map;
}

async function cacheStTechnicianId(
  db: D1Database,
  userId: number,
  current: number | null,
  matched: { status: string; stId?: number }
): Promise<number | null> {
  if (current != null && current > 0) return current;
  if (matched.status !== "matched" || !matched.stId) return null;
  try {
    await db
      .prepare(
        `UPDATE users
           SET st_technician_id = ?, updated_at = datetime('now')
           WHERE id = ? AND (st_technician_id IS NULL OR st_technician_id = 0)`
      )
      .bind(matched.stId, userId)
      .run();
  } catch {
    /* column may be missing */
  }
  return matched.stId;
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
  if (match.status === "matched") {
    const persisted = await cacheStTechnicianId(db, user.id, stored, match);
    return { technicianId: persisted || match.stId };
  }
  return {
    technicianId: null,
    message: "No ServiceTitan technician linked - ask office to set your ST tech ID in People.",
  };
}

function jobTypeNameOf(job: Record<string, unknown> | undefined, appt: Record<string, unknown>): string | null {
  if (job) {
    if (typeof job.jobType === "string") return job.jobType;
    if (job.jobType && typeof job.jobType === "object") {
      const n = (job.jobType as { name?: unknown }).name;
      if (typeof n === "string" && n.trim()) return n.trim();
    }
    if (typeof job.jobTypeName === "string" && job.jobTypeName.trim()) return job.jobTypeName.trim();
  }
  const jt =
    strField(appt, "jobTypeName") ||
    (appt.jobType && typeof appt.jobType === "object"
      ? String((appt.jobType as { name?: unknown }).name || "")
      : "");
  return jt || null;
}

export async function getTodaysJobsForUser(env: Env, db: D1Database, user: PublicUser) {
  await ensureJobClockTables(db);
  const { today, startOff, endBeforeOff } = chicagoDayBounds();
  const mode = clockStWriteMode(env);
  const shopSession = await loadShopSessionBrief(db, user.id, today);
  const base = {
    configured: false,
    st_write_enabled: mode === "live",
    st_write_mode: mode,
    technician_id: null as number | null,
    today,
    jobs: [] as unknown[],
    shop_session: shopSession,
  };
  if (!(await stConfigured(env, db))) {
    return { ...base, message: "ServiceTitan not connected. Office can add credentials in Admin." };
  }
  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return { ...base, configured: true, message: "ServiceTitan tenant missing." };
  }
  const resolved = await resolveTechnicianId(env, db, user, tenantId);
  if (!resolved.technicianId) {
    return { ...base, configured: true, message: resolved.message };
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
      message: apptRes.error || "Could not load today's jobs from ServiceTitan.",
    };
  }
  const jobIds = apptRes.appointments.map((a) => Number(a.jobId)).filter((n) => n > 0);
  const jobMap = await enrichJobs(env, db, tenantId, jobIds);
  const locationIds: number[] = [];
  for (const job of jobMap.values()) {
    const lid = Number(
      job.locationId ?? (asRecord(job.location)?.id ?? 0)
    );
    if (lid > 0) locationIds.push(lid);
  }
  for (const a of apptRes.appointments) {
    const lid = Number(a.locationId ?? (asRecord(a.location)?.id ?? 0));
    if (lid > 0) locationIds.push(lid);
  }
  const locMap = await enrichLocations(env, db, tenantId, locationIds);
  const allEvents = await loadClockEventsForUser(db, user.id);
  const jobs = [];
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
    const locId =
      Number(a.locationId) ||
      Number(job?.locationId) ||
      Number(asRecord(a.location)?.id) ||
      Number(asRecord(job?.location)?.id) ||
      0;
    const crmLoc = locId > 0 ? locMap.get(locId) : undefined;
    const address = resolveJobAddress({ crmLoc, job, appt: a });
    const jobNumber =
      (job ? strField(job, "jobNumber", "number") : null) ||
      strField(a, "jobNumber") ||
      (jobIdNum > 0 ? String(jobIdNum) : null);
    const windowStart = strField(a, "start", "startDate", "arrivalWindowStart", "scheduledStart");
    const windowEnd = strField(a, "end", "endDate", "arrivalWindowEnd", "scheduledEnd");
    const status = strField(a, "status", "appointmentStatus", "appointmentStatusName");
    const related = eventsForAppointment(allEvents, stJobId, apptId);
    const chronological = [...related].reverse();
    const clock = clockStateFromEvents(chronological);
    const typeName = jobTypeNameOf(job, a);
    let permit = null;
    try {
      const cfs = job && Array.isArray(job.customFields) ? job.customFields : [];
      permit = await evaluatePermitGate(env, db, stJobId, {
        jobTypeName: typeName,
        customFields: cfs as Array<{ name?: string; value?: unknown }>,
      });
    } catch {
      permit = null;
    }
    jobs.push({
      st_job_id: stJobId,
      st_appointment_id: apptId,
      job_number: jobNumber,
      customer_name: customerName,
      address,
      window_start: windowStart,
      window_end: windowEnd,
      st_appointment_status: status,
      job_type: typeName,
      permit,
      clock,
    });
  }
  jobs.sort((x, y) => String(x.window_start || "").localeCompare(String(y.window_start || "")));
  return {
    configured: true,
    st_write_enabled: mode === "live",
    st_write_mode: mode,
    technician_id: resolved.technicianId,
    today,
    jobs,
    message: jobs.length ? undefined : "No jobs on your schedule for today.",
    shop_session: shopSession,
  };
}

function isValidStep(step: string): step is ClockStep {
  return step === "dispatch" || step === "arrive" || step === "complete";
}

export async function recordClockStep(
  env: Env,
  db: D1Database,
  user: PublicUser,
  stepRaw: string,
  body: Record<string, unknown>
): Promise<
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      deduped: boolean;
      event: ClockEventRow;
      clock: ClockState;
      label: string;
    }
> {
  await ensureJobClockTables(db);
  if (!isValidStep(stepRaw)) {
    return { ok: false, status: 400, error: "step must be dispatch, arrive, or complete" };
  }
  const step = stepRaw;
  const stJobId = String(body.st_job_id || "").trim();
  if (!stJobId) return { ok: false, status: 400, error: "st_job_id required" };
  const stAppointmentId =
    body.st_appointment_id != null && String(body.st_appointment_id).trim()
      ? String(body.st_appointment_id).trim()
      : null;
  const clientTs =
    (body.client_ts && String(body.client_ts).trim()) || new Date().toISOString();
  const all = await loadClockEventsForUser(db, user.id);
  const related = eventsForAppointment(all, stJobId, stAppointmentId);
  const clockBefore = clockStateFromEvents([...related].reverse());
  if (step === "arrive" && !clockBefore.dispatch_at) {
    return { ok: false, status: 400, error: "Dispatch before Arrive." };
  }
  if (step === "complete" && !clockBefore.arrive_at) {
    return { ok: false, status: 400, error: "Arrive before Complete." };
  }
  if (clockBefore.next_step && clockBefore.next_step !== step) {
    const already =
      (step === "dispatch" && clockBefore.dispatch_at) ||
      (step === "arrive" && clockBefore.arrive_at) ||
      (step === "complete" && clockBefore.complete_at);
    if (!already) {
      return { ok: false, status: 400, error: `Next step is ${clockBefore.next_step}.` };
    }
  }
  const label = clockSyncLabel(env);
  const recent = related.find((e) => {
    if (String(e.step).toLowerCase() !== step) return false;
    const created = Date.parse(
      String(e.created_at).includes("T") ? e.created_at : `${e.created_at}Z`
    );
    const ageMin = (Date.now() - (Number.isFinite(created) ? created : 0)) / 6e4;
    return ageMin >= 0 && ageMin <= DEDUPE_MINUTES;
  });
  if (recent) {
    return { ok: true, deduped: true, event: recent, clock: clockStateFromEvents([...related].reverse()), label };
  }
  const alreadyDone =
    (step === "dispatch" && clockBefore.dispatch_at) ||
    (step === "arrive" && clockBefore.arrive_at) ||
    (step === "complete" && clockBefore.complete_at);
  if (alreadyDone) {
    const existing = related.find((e) => String(e.step).toLowerCase() === step);
    if (existing) {
      return { ok: true, deduped: true, event: existing, clock: clockBefore, label };
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
  if (!event) return { ok: false, status: 500, error: "Insert failed" };
  const refreshed = await loadClockEventsForUser(db, user.id);
  const relatedAsc = eventsForAppointment(refreshed, stJobId, stAppointmentId).slice().reverse();
  return {
    ok: true,
    deduped: false,
    event,
    clock: clockStateFromEvents(relatedAsc),
    label,
  };
}

async function markEventSynced(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(`UPDATE job_clock_events SET sync_status = 'synced', sync_error = NULL WHERE id = ?`)
    .bind(id)
    .run();
}

async function markEventError(
  db: D1Database,
  id: number,
  err: string,
  keepQueued: boolean
): Promise<void> {
  const msg = err.slice(0, 500);
  if (keepQueued) {
    await db
      .prepare(`UPDATE job_clock_events SET sync_status = 'queued', sync_error = ? WHERE id = ?`)
      .bind(msg, id)
      .run();
  } else {
    await db
      .prepare(`UPDATE job_clock_events SET sync_status = 'error', sync_error = ? WHERE id = ?`)
      .bind(msg, id)
      .run();
  }
}

function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export function statusRank(raw: string | null | undefined): number {
  const s = String(raw || "").trim().toLowerCase().replace(/[_\s]/g, "");
  if (!s) return 0;
  if (s.includes("cancel")) return 99;
  if (s === "done" || s === "completed" || s === "complete" || s.includes("finish")) return 3;
  if (s === "inprogress" || s === "working" || s.includes("arriv") || s.includes("onsite")) return 2;
  if (s === "dispatched" || s.includes("dispatch")) return 1;
  if (s === "hold") return 1;
  return 0;
}

function officeUnblockMessage(step: ClockStep, jobId: string, apptId: string): string {
  const want = CLOCK_STEP_LABEL[step];
  return (
    `ST API cannot set appointment status (PATCH {status} is not a valid operation). ` +
    `Office: on job ${jobId} appt ${apptId}, set this tech to ${want} on the Dispatch board ` +
    `or job timesheet, then tap Retry ST sync (or Ack if already done in ST).`
  );
}

async function loadUserTechId(db: D1Database, userId: number): Promise<number | null> {
  try {
    const row = await db
      .prepare(`SELECT st_technician_id FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ st_technician_id: number | null }>();
    const n = Number(row?.st_technician_id);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function assignmentAlreadyAdvanced(
  env: Env,
  db: D1Database,
  tenantId: string,
  apptId: string,
  technicianId: number | null,
  step: ClockStep
): Promise<boolean> {
  const q = new URLSearchParams({
    appointmentIds: apptId,
    pageSize: "50",
    active: "True",
  });
  const res = await stApiGet(
    env,
    db,
    `/dispatch/v2/tenant/${tenantId}/appointment-assignments?${q.toString()}`
  );
  if (!res.ok) return false;
  const body = asRecord(res.json);
  const rows = Array.isArray(body?.data) ? body!.data : [];
  const want = statusRank(CLOCK_STEP_TO_ASSIGNMENT_STATUS[step]);
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    if (technicianId && Number(row.technicianId) !== technicianId) continue;
    if (statusRank(strField(row, "status")) >= want && statusRank(strField(row, "status")) < 99) {
      return true;
    }
  }
  return false;
}

function timesheetStampForStep(row: Record<string, unknown>, step: ClockStep): unknown {
  if (step === "dispatch") return row.dispatchedOn ?? row.dispatched_on ?? row.dispatchedOnUtc;
  if (step === "arrive") return row.arrivedOn ?? row.arrived_on ?? row.arrivedOnUtc;
  return row.doneOn ?? row.done_on ?? row.canceledOn ?? row.doneOnUtc;
}

async function timesheetAlreadyStamped(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobId: string,
  technicianId: number | null,
  step: ClockStep
): Promise<{ stamped: boolean; sheet?: Record<string, unknown> }> {
  const jobNum = Number(jobId);
  if (!(jobNum > 0)) return { stamped: false };
  const res = await stApiGet(env, db, `/payroll/v2/tenant/${tenantId}/jobs/${jobNum}/timesheets`);
  if (!res.ok) return { stamped: false };
  const body = asRecord(res.json);
  const rows = Array.isArray(body?.data)
    ? body!.data
    : Array.isArray(body)
      ? (body as unknown as unknown[])
      : [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    if (technicianId && Number(row.technicianId ?? row.technician_id) !== technicianId) continue;
    const stamp = timesheetStampForStep(row, step);
    if (stamp) return { stamped: true, sheet: row };
    return { stamped: false, sheet: row };
  }
  return { stamped: false };
}

async function tryWriteJobTimesheet(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobId: string,
  technicianId: number | null,
  step: ClockStep,
  clientTs: string,
  existing?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; text: string }> {
  const jobNum = Number(jobId);
  if (!(jobNum > 0) || !technicianId) {
    return { ok: false, status: 0, text: "missing job or technician id" };
  }
  const stampKey =
    step === "dispatch" ? "dispatchedOn" : step === "arrive" ? "arrivedOn" : "doneOn";
  const payload: Record<string, unknown> = {
    technicianId,
    [stampKey]: clientTs,
  };
  if (existing) {
    if (existing.dispatchedOn) payload.dispatchedOn = existing.dispatchedOn;
    if (existing.arrivedOn) payload.arrivedOn = existing.arrivedOn;
    if (existing.doneOn) payload.doneOn = existing.doneOn;
    payload[stampKey] = clientTs;
    const sheetId = Number(existing.id);
    if (sheetId > 0) {
      const patch = await stApiJson(
        env,
        db,
        `/payroll/v2/tenant/${tenantId}/jobs/${jobNum}/timesheets/${sheetId}`,
        { method: "PUT", body: payload }
      );
      if (patch.ok || !isUnmatchedOperation(patch.status, patch.text)) return patch;
    }
  }
  return stApiJson(env, db, `/payroll/v2/tenant/${tenantId}/jobs/${jobNum}/timesheets`, {
    method: "POST",
    body: { ...payload, jobId: jobNum },
  });
}

function isUnmatchedOperation(status: number, text: string): boolean {
  if (status !== 404) return false;
  return /unable to match incoming request to an operation/i.test(text);
}

export async function applyClockEventToSt(
  env: Env,
  db: D1Database,
  tenantId: string,
  event: ClockEventRow,
  mode: "off" | "dry" | "live"
): Promise<SyncResult> {
  const stepRaw = String(event.step || "").toLowerCase();
  if (!isValidStep(stepRaw)) {
    await markEventError(db, event.id, `Unknown step ${event.step}`, false);
    return "failed_permanent";
  }
  const step = stepRaw;
  const apptId = String(event.st_appointment_id || "").trim();
  if (!apptId || !/^\d+$/.test(apptId)) {
    await markEventError(
      db,
      event.id,
      "Missing numeric st_appointment_id - cannot update ST appointment. Office: confirm the job is on today's board, then retry.",
      false
    );
    return "failed_permanent";
  }

  const technicianId = await loadUserTechId(db, event.user_id);
  const wantAppt = CLOCK_STEP_TO_APPT_STATUS[step];
  const path = `/jpm/v2/tenant/${tenantId}/appointments/${apptId}`;
  const got = await stApiGet(env, db, path);
  if (got.ok && got.json && typeof got.json === "object") {
    const cur = strField(got.json, "status", "appointmentStatus");
    if (cur && statusRank(cur) >= statusRank(wantAppt) && statusRank(cur) < 99) {
      await markEventSynced(db, event.id);
      return "synced";
    }
  } else if (got.status === 404 && !isUnmatchedOperation(got.status, got.text)) {
    await markEventError(db, event.id, `ST appointment ${apptId} not found`, false);
    return "failed_permanent";
  } else if (!got.ok && isTransientStatus(got.status)) {
    await markEventError(
      db,
      event.id,
      `ST GET appointment transient ${got.status}: ${got.text.slice(0, 160)}`,
      true
    );
    return "failed_transient";
  }

  if (await assignmentAlreadyAdvanced(env, db, tenantId, apptId, technicianId, step)) {
    await markEventSynced(db, event.id);
    return "synced";
  }

  const sheetState = await timesheetAlreadyStamped(
    env,
    db,
    tenantId,
    event.st_job_id,
    technicianId,
    step
  );
  if (sheetState.stamped) {
    await markEventSynced(db, event.id);
    return "synced";
  }

  if (mode === "dry") {
    console.log(
      "[clock-st] DRY would write timesheet",
      `job=${event.st_job_id} appt=${apptId} step=${step} event=${event.id}`
    );
    await db
      .prepare(
        `UPDATE job_clock_events SET sync_error = ? WHERE id = ? AND sync_status = 'queued'`
      )
      .bind(`dry-run: would set ${CLOCK_STEP_LABEL[step]} on job timesheet`, event.id)
      .run();
    return "dry";
  }

  const write = await tryWriteJobTimesheet(
    env,
    db,
    tenantId,
    event.st_job_id,
    technicianId,
    step,
    event.client_ts,
    sheetState.sheet
  );
  if (write.ok) {
    await markEventSynced(db, event.id);
    return "synced";
  }
  if (isTransientStatus(write.status)) {
    await markEventError(
      db,
      event.id,
      `ST timesheet write transient ${write.status}: ${write.text.slice(0, 160)}`,
      true
    );
    return "failed_transient";
  }

  const afterAssign = await assignmentAlreadyAdvanced(env, db, tenantId, apptId, technicianId, step);
  if (afterAssign) {
    await markEventSynced(db, event.id);
    return "synced";
  }

  const detail = officeUnblockMessage(step, event.st_job_id, apptId);
  console.log("[clock-st]", detail, `event=${event.id} write=${write.status}`);
  await markEventError(db, event.id, `${detail} (${write.status}: ${write.text.slice(0, 120)})`, false);
  return "needs_office";
}

export async function syncQueuedClockEvents(
  env: Env,
  db: D1Database,
  opts?: { limit?: number; includeErrors?: boolean; onlyUserId?: number; onlyEventId?: number }
) {
  const mode = clockStWriteMode(env);
  const out = {
    mode,
    processed: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    dry_logged: 0,
    errors: [] as string[],
  };
  if (!clockSyncPipelineEnabled(env)) return out;
  await ensureJobClockTables(db);
  if (!(await stConfigured(env, db))) {
    out.errors.push("ServiceTitan not configured");
    return out;
  }
  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    out.errors.push("ServiceTitan tenant missing");
    return out;
  }
  const limit = Math.min(Math.max(opts?.limit ?? SYNC_BATCH, 1), 200);
  const clauses = [opts?.includeErrors ? `sync_status IN ('queued', 'error')` : `sync_status = 'queued'`];
  const binds: Array<string | number> = [];
  if (opts?.onlyUserId) {
    clauses.push(`user_id = ?`);
    binds.push(opts.onlyUserId);
  }
  if (opts?.onlyEventId) {
    clauses.push(`id = ?`);
    binds.push(opts.onlyEventId);
  }
  const rows = await db
    .prepare(
      `SELECT id, user_id, st_job_id, st_appointment_id, step, client_ts, created_at,
              sync_status, sync_error
         FROM job_clock_events
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at ASC, id ASC
         LIMIT ?`
    )
    .bind(...binds, limit)
    .all<ClockEventRow>();
  for (const event of rows.results || []) {
    out.processed += 1;
    try {
      if (String(event.sync_status) === "error") {
        await db
          .prepare(
            `UPDATE job_clock_events SET sync_status = 'queued' WHERE id = ? AND sync_status = 'error'`
          )
          .bind(event.id)
          .run();
      }
      const r = await applyClockEventToSt(env, db, tenantId, event, mode);
      if (r === "synced") out.synced += 1;
      else if (r === "dry") out.dry_logged += 1;
      else {
        out.failed += 1;
        const step = String(event.step || "");
        out.errors.push(
          `${step || "punch"} job ${event.st_job_id}: ${r}`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await markEventError(db, event.id, msg, true);
      out.failed += 1;
      out.errors.push(`event ${event.id}: ${msg}`);
    }
  }
  return out;
}

export async function ackClockEventSynced(
  db: D1Database,
  id: number,
  note?: string
): Promise<{ ok: boolean; error?: string }> {
  await ensureJobClockTables(db);
  const row = await db
    .prepare(`SELECT id, sync_status FROM job_clock_events WHERE id = ?`)
    .bind(id)
    .first<{ id: number; sync_status: string }>();
  if (!row) return { ok: false, error: "Event not found" };
  await db
    .prepare(
      `UPDATE job_clock_events
         SET sync_status = 'synced',
             sync_error = ?
       WHERE id = ?`
    )
    .bind(note ? `acked: ${note.slice(0, 200)}` : "acked by office — already done in ST", id)
    .run();
  return { ok: true };
}
