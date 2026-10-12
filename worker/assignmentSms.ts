/**
 * After-4pm CT job assignment SMS → Field App tech phone only.
 * Assigned time (not booked window) must be ≥ 16:00 America/Chicago.
 * No customer texts. No ST writes. Dedupe per appointment+tech.
 */

import type { Env } from "./types";
import { getSetting } from "./audit";
import { secretsMatch } from "./secretCompare";
import {
  loadStTechnicians,
  matchUserToStTechnician,
  type StTechnician,
} from "./zeroCharge";
import { stApiGet, stConfigured, stTenantId } from "./servicetitan";
import { logSms, normalizePhone, sendSms, smsConfigured } from "./sms";

const TZ = "America/Chicago";
const DEDUPE_HOURS = 6;
/** Optional shared secret for public ST/Zapier webhook (settings or env). */


export type AssignmentEvent = {
  st_job_id: string;
  st_appointment_id: string | null;
  st_technician_id: number;
  /** ISO / ST timestamp of the assignment action */
  assigned_at: string;
  customer_name?: string | null;
  street?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  source?: string;
};

export type AssignmentSmsResult = {
  sent: boolean;
  skipped: boolean;
  reason: string;
  status: string;
  to_user_id?: number | null;
  body?: string;
};

let tablesReady = false;

export async function ensureAssignmentSmsTables(db: D1Database): Promise<void> {
  if (tablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS st_assignment_sms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      st_job_id TEXT NOT NULL,
      st_appointment_id TEXT,
      st_technician_id TEXT NOT NULL,
      user_id INTEGER,
      assigned_at TEXT,
      notified_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'sent',
      detail TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_st_assignment_sms_appt_tech
      ON st_assignment_sms(st_appointment_id, st_technician_id)`,
    `CREATE INDEX IF NOT EXISTS idx_st_assignment_sms_job_tech
      ON st_assignment_sms(st_job_id, st_technician_id, notified_at DESC)`,
    `CREATE TABLE IF NOT EXISTS st_assignment_snapshot (
      st_appointment_id TEXT PRIMARY KEY,
      st_job_id TEXT,
      tech_ids_json TEXT NOT NULL DEFAULT '[]',
      modified_on TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
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

function chicagoParts(d: Date): {
  y: number;
  m: number;
  day: number;
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
  };
}

/** True when instant is at/after 4:00 PM America/Chicago wall clock. */
export function isAfter4pmChicago(when: Date | string): boolean {
  const d = typeof when === "string" ? new Date(when) : when;
  if (!Number.isFinite(d.getTime())) return false;
  const p = chicagoParts(d);
  return p.hour >= 16;
}

function tzOffsetMs(date: Date): number {
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
    const off = tzOffsetMs(utc);
    utc = new Date(Date.UTC(y, m - 1, d, hh, mi, ss) - off);
  }
  return utc;
}

function toChicagoOffsetIso(utcInstant: Date): string {
  const offMs = tzOffsetMs(utcInstant);
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

/** Today 4:00 PM Chicago as ST-style offset timestamp. */
export function today4pmChicagoOffset(now = new Date()): string {
  const p = chicagoParts(now);
  const d = zonedLocalToUtc(p.y, p.m, p.day, 16, 0, 0);
  return toChicagoOffsetIso(d);
}

function formatWindow(start?: string | null, end?: string | null): string {
  const fmt = (iso: string) => {
    try {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return "";
      return d.toLocaleTimeString("en-US", {
        timeZone: TZ,
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  };
  const a = start ? fmt(start) : "";
  const b = end ? fmt(end) : "";
  if (a && b) return `${a}–${b}`;
  return a || b || "";
}

/** Lean one-segment body. No brand prefix — From number brands it. */
export function buildAssignmentSmsBody(ev: AssignmentEvent): string {
  const place =
    (ev.street && String(ev.street).trim()) ||
    (ev.customer_name && String(ev.customer_name).trim()) ||
    "your next stop";
  const when = formatWindow(ev.window_start, ev.window_end);
  let body = when
    ? `New job on your board: ${place} ${when}. Open Field App.`
    : `New job on your board: ${place}. Open Field App.`;
  // Keep under ~140 when possible; add -Atlas only if still short and helpful
  if (body.length <= 120) {
    body = `${body} -Atlas`;
  }
  return body.slice(0, 280);
}

async function alreadyNotified(
  db: D1Database,
  apptId: string | null,
  jobId: string,
  techId: number
): Promise<boolean> {
  try {
    if (apptId) {
      const row = await db
        .prepare(
          `SELECT id FROM st_assignment_sms
           WHERE st_appointment_id = ? AND st_technician_id = ?
             AND notified_at > datetime('now', ?)
           LIMIT 1`
        )
        .bind(String(apptId), String(techId), `-${DEDUPE_HOURS} hours`)
        .first();
      if (row) return true;
    }
    const row2 = await db
      .prepare(
        `SELECT id FROM st_assignment_sms
         WHERE st_job_id = ? AND st_technician_id = ?
           AND notified_at > datetime('now', ?)
         LIMIT 1`
      )
      .bind(String(jobId), String(techId), `-${DEDUPE_HOURS} hours`)
      .first();
    if (row2) return true;
  } catch {
    /* table optional */
  }
  // Also check sms_log context
  try {
    const ctx = `st_assign:${jobId}:${techId}`;
    const recent = await db
      .prepare(
        `SELECT id FROM sms_log
         WHERE context = ? AND created_at > datetime('now', ?)
         LIMIT 1`
      )
      .bind(ctx.slice(0, 120), `-${DEDUPE_HOURS} hours`)
      .first();
    if (recent) return true;
  } catch {
    /* optional */
  }
  return false;
}

async function recordAttempt(
  db: D1Database,
  ev: AssignmentEvent,
  userId: number | null,
  status: string,
  detail: string | null
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO st_assignment_sms
          (st_job_id, st_appointment_id, st_technician_id, user_id, assigned_at, status, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(st_appointment_id, st_technician_id) DO UPDATE SET
           notified_at = datetime('now'),
           status = excluded.status,
           detail = excluded.detail,
           user_id = COALESCE(excluded.user_id, st_assignment_sms.user_id)`
      )
      .bind(
        String(ev.st_job_id),
        ev.st_appointment_id != null ? String(ev.st_appointment_id) : `job:${ev.st_job_id}`,
        String(ev.st_technician_id),
        userId,
        ev.assigned_at || null,
        status,
        detail
      )
      .run();
  } catch {
    try {
      await db
        .prepare(
          `INSERT INTO st_assignment_sms
            (st_job_id, st_appointment_id, st_technician_id, user_id, assigned_at, status, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          String(ev.st_job_id),
          ev.st_appointment_id != null ? String(ev.st_appointment_id) : null,
          String(ev.st_technician_id),
          userId,
          ev.assigned_at || null,
          status,
          detail
        )
        .run();
    } catch {
      /* ignore */
    }
  }
}

async function resolveUserForStTech(
  db: D1Database,
  env: Env,
  stTechnicianId: number
): Promise<{
  user_id: number;
  display_name: string;
  phone: string | null;
} | null> {
  // Prefer explicit Admin link
  const byId = await db
    .prepare(
      `SELECT id, display_name, phone FROM users
       WHERE active = 1 AND st_technician_id = ?
       ORDER BY id ASC LIMIT 1`
    )
    .bind(stTechnicianId)
    .first<{ id: number; display_name: string; phone: string | null }>();
  if (byId) {
    return { user_id: byId.id, display_name: byId.display_name, phone: byId.phone };
  }

  // Match via ST tech list name/phone → Field App users
  if (!(await stConfigured(env, db))) return null;
  const tenantId = await stTenantId(env, db);
  if (!tenantId) return null;
  let techs: StTechnician[] = [];
  try {
    const loaded = await loadStTechnicians(env, db, tenantId);
    if (loaded.ok) techs = loaded.techs;
  } catch {
    return null;
  }
  const stTech = techs.find((t) => t.id === stTechnicianId);
  if (!stTech) return null;

  const drivers = await db
    .prepare(
      `SELECT id, display_name, username, email, phone, st_technician_id
       FROM users WHERE active = 1 AND role IN ('driver','mechanic','admin','office','supervisor')`
    )
    .all<{
      id: number;
      display_name: string;
      username: string | null;
      email: string | null;
      phone: string | null;
      st_technician_id: number | null;
    }>();

  for (const u of drivers.results || []) {
    const m = matchUserToStTechnician(u, [stTech]);
    if (m.status === "matched" && m.stId === stTechnicianId) {
      return { user_id: u.id, display_name: u.display_name, phone: u.phone };
    }
  }
  return null;
}

/**
 * Core: maybe SMS one tech about one after-hours assignment.
 * Never throws to caller — logs and returns.
 */
export async function maybeSmsAfterHoursAssignment(
  env: Env,
  db: D1Database,
  ev: AssignmentEvent
): Promise<AssignmentSmsResult> {
  await ensureAssignmentSmsTables(db);

  const assignedAt = ev.assigned_at || new Date().toISOString();
  if (!isAfter4pmChicago(assignedAt)) {
    return {
      sent: false,
      skipped: true,
      reason: "assigned_before_4pm_ct",
      status: "skipped_before_4pm",
    };
  }

  if (!(ev.st_technician_id > 0) || !ev.st_job_id) {
    return {
      sent: false,
      skipped: true,
      reason: "missing_ids",
      status: "skipped_bad_payload",
    };
  }

  if (
    await alreadyNotified(
      db,
      ev.st_appointment_id,
      String(ev.st_job_id),
      ev.st_technician_id
    )
  ) {
    return {
      sent: false,
      skipped: true,
      reason: "deduped",
      status: "skipped_dedupe",
    };
  }

  const user = await resolveUserForStTech(db, env, ev.st_technician_id);
  if (!user) {
    await recordAttempt(
      db,
      ev,
      null,
      "skipped_no_user",
      `No Field App user for ST tech ${ev.st_technician_id}`
    );
    await logSms(db, {
      from_user_id: null,
      to_user_id: null,
      to_phone: "",
      body: buildAssignmentSmsBody(ev),
      status: "skipped",
      error: `No Field App user linked to ST technician ${ev.st_technician_id}`,
      context: `st_assign:${ev.st_job_id}:${ev.st_technician_id}`,
    });
    return {
      sent: false,
      skipped: true,
      reason: "no_user",
      status: "skipped_no_user",
    };
  }

  const phone = normalizePhone(user.phone);
  const body = buildAssignmentSmsBody(ev);
  const ctx = `st_assign:${ev.st_job_id}:${ev.st_technician_id}`;

  if (!phone) {
    await recordAttempt(
      db,
      ev,
      user.user_id,
      "skipped_no_phone",
      `${user.display_name} has no phone on file`
    );
    await logSms(db, {
      from_user_id: null,
      to_user_id: user.user_id,
      to_phone: "",
      body,
      status: "skipped",
      error: `No phone on file for ${user.display_name}`,
      context: ctx,
    });
    return {
      sent: false,
      skipped: true,
      reason: "no_phone",
      status: "skipped_no_phone",
      to_user_id: user.user_id,
      body,
    };
  }

  if (!smsConfigured(env)) {
    await recordAttempt(
      db,
      ev,
      user.user_id,
      "queued_no_twilio",
      "Twilio not configured — would-send logged"
    );
    await logSms(db, {
      from_user_id: null,
      to_user_id: user.user_id,
      to_phone: phone,
      body,
      status: "queued",
      error: "Twilio not configured — would-send only",
      context: ctx,
    });
    return {
      sent: false,
      skipped: false,
      reason: "twilio_not_configured",
      status: "queued_no_twilio",
      to_user_id: user.user_id,
      body,
    };
  }

  const result = await sendSms(env, phone, body);
  if (result.ok) {
    await recordAttempt(db, ev, user.user_id, "sent", null);
    await logSms(db, {
      from_user_id: null,
      to_user_id: user.user_id,
      to_phone: phone,
      body,
      status: "sent",
      provider_sid: result.sid,
      context: ctx,
    });
    return {
      sent: true,
      skipped: false,
      reason: "sent",
      status: "sent",
      to_user_id: user.user_id,
      body,
    };
  }

  await recordAttempt(db, ev, user.user_id, "error", result.error);
  await logSms(db, {
    from_user_id: null,
    to_user_id: user.user_id,
    to_phone: phone,
    body,
    status: "failed",
    error: result.error,
    context: ctx,
  });
  return {
    sent: false,
    skipped: false,
    reason: result.error,
    status: "failed",
    to_user_id: user.user_id,
    body,
  };
}

/** Flexible parse of ST webhook / Zapier / manual JSON into AssignmentEvent(s). */
export function parseAssignmentWebhookPayload(raw: unknown): AssignmentEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;

  // Already our shape (single)
  if (o.st_job_id != null && o.st_technician_id != null) {
    return [
      {
        st_job_id: String(o.st_job_id),
        st_appointment_id:
          o.st_appointment_id != null ? String(o.st_appointment_id) : null,
        st_technician_id: Number(o.st_technician_id),
        assigned_at: String(o.assigned_at || o.modifiedOn || new Date().toISOString()),
        customer_name: (o.customer_name as string) || null,
        street: (o.street as string) || null,
        window_start: (o.window_start as string) || null,
        window_end: (o.window_end as string) || null,
        source: "payload",
      },
    ];
  }

  // Nested job / appointment / technician
  const job = (o.job && typeof o.job === "object" ? o.job : o) as Record<string, unknown>;
  const appt = (
    o.appointment && typeof o.appointment === "object"
      ? o.appointment
      : o.jobAppointment && typeof o.jobAppointment === "object"
        ? o.jobAppointment
        : job
  ) as Record<string, unknown>;
  const tech =
    o.technician && typeof o.technician === "object"
      ? (o.technician as Record<string, unknown>)
      : null;

  const jobId = Number(job.jobId ?? job.id ?? o.jobId ?? 0);
  const apptId = Number(
    appt.id ?? appt.appointmentId ?? o.appointmentId ?? o.jobAppointmentId ?? 0
  );
  const assignedAt = String(
    o.assignedOn ||
      o.assigned_at ||
      o.eventTime ||
      o.timestamp ||
      appt.modifiedOn ||
      job.modifiedOn ||
      new Date().toISOString()
  );

  const customer =
    (typeof o.customerName === "string" && o.customerName) ||
    (o.customer && typeof o.customer === "object"
      ? String((o.customer as Record<string, unknown>).name || "")
      : "") ||
    null;
  const street =
    (typeof o.street === "string" && o.street) ||
    (o.location && typeof o.location === "object"
      ? String(
          ((o.location as Record<string, unknown>).address as Record<string, unknown>)
            ?.street ||
            (o.location as Record<string, unknown>).street ||
            ""
        )
      : "") ||
    null;
  const windowStart = String(
    appt.start || appt.arrivalWindowStart || o.start || o.window_start || ""
  ) || null;
  const windowEnd = String(
    appt.end || appt.arrivalWindowEnd || o.end || o.window_end || ""
  ) || null;

  const techIds = new Set<number>();
  if (tech?.id != null) techIds.add(Number(tech.id));
  if (o.technicianId != null) techIds.add(Number(o.technicianId));
  const arr =
    (Array.isArray(o.technicianIds) && o.technicianIds) ||
    (Array.isArray(appt.technicianIds) && appt.technicianIds) ||
    (Array.isArray(job.technicianIds) && job.technicianIds) ||
    [];
  for (const t of arr) techIds.add(Number(t));

  if (!(jobId > 0) && !(apptId > 0)) return [];
  const out: AssignmentEvent[] = [];
  for (const tid of techIds) {
    if (!(tid > 0)) continue;
    out.push({
      st_job_id: String(jobId > 0 ? jobId : `appt:${apptId}`),
      st_appointment_id: apptId > 0 ? String(apptId) : null,
      st_technician_id: tid,
      assigned_at: assignedAt,
      customer_name: customer,
      street: street || null,
      window_start: windowStart,
      window_end: windowEnd,
      source: "webhook",
    });
  }
  return out;
}

/** Header secret only. Unset or shorter than 32 chars = disabled. Both headers, if they differ, are bad. */
export async function assignmentWebhookAuth(
  env: Env,
  headers: { primary?: string | null; alt?: string | null }
): Promise<"ok" | "disabled" | "missing" | "bad"> {
  const secret = String(env.ST_ASSIGNMENT_WEBHOOK_SECRET || "").trim();
  if (secret.length < 32) return "disabled";
  const primary = String(headers.primary || "").trim();
  const alt = String(headers.alt || "").trim();
  if (primary && alt && primary !== alt) return "bad";
  const got = primary || alt;
  if (!got) return "missing";
  if (!(await secretsMatch(got, secret))) return "bad";
  return "ok";
}

type ApptRow = {
  id: number;
  jobId: number;
  modifiedOn: string | null;
  start: string | null;
  end: string | null;
  technicianIds: number[];
  customerName: string | null;
  street: string | null;
};

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

/**
 * Poll ST appointments modified since today 4pm CT; SMS only newly-seen tech assignments.
 * Safe before 4pm: updates snapshot only, never texts.
 */
export async function pollAfterHoursAssignments(
  env: Env,
  db: D1Database
): Promise<{ checked: number; notified: number; skipped: number; error?: string }> {
  await ensureAssignmentSmsTables(db);
  let notified = 0;
  let skipped = 0;

  if (!(await stConfigured(env, db))) {
    return { checked: 0, notified: 0, skipped: 0, error: "ST not configured" };
  }
  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return { checked: 0, notified: 0, skipped: 0, error: "no tenant" };
  }

  const now = new Date();
  const after4 = isAfter4pmChicago(now);
  // Look back from today 3:30pm CT so we catch borderline assigns; gate SMS on assigned time
  const p = chicagoParts(now);
  const lookFrom = zonedLocalToUtc(p.y, p.m, p.day, 15, 30, 0);
  const modifiedOnOrAfter = toChicagoOffsetIso(lookFrom);

  const appointments: ApptRow[] = [];
  let page = 1;
  while (page <= 10) {
    const q = new URLSearchParams({
      modifiedOnOrAfter,
      page: String(page),
      pageSize: "100",
    });
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/appointments?${q.toString()}`
    );
    if (!res.ok) {
      return {
        checked: 0,
        notified: 0,
        skipped: 0,
        error: `appointments ${res.status}`,
      };
    }
    const body = res.json as { data?: Record<string, unknown>[]; hasMore?: boolean };
    for (const row of body.data || []) {
      const id = Number(row.id);
      if (!(id > 0)) continue;
      const loc =
        row.customerAddress && typeof row.customerAddress === "object"
          ? (row.customerAddress as Record<string, unknown>)
          : row.address && typeof row.address === "object"
            ? (row.address as Record<string, unknown>)
            : null;
      appointments.push({
        id,
        jobId: Number(row.jobId) || 0,
        modifiedOn: typeof row.modifiedOn === "string" ? row.modifiedOn : null,
        start: typeof row.start === "string" ? row.start : null,
        end: typeof row.end === "string" ? row.end : null,
        technicianIds: techIdsFromAppt(row),
        customerName:
          typeof row.customerName === "string"
            ? row.customerName
            : null,
        street: loc
          ? String(loc.street || loc.streetAddress || "").trim() || null
          : null,
      });
    }
    if (!body.hasMore || !(body.data || []).length) break;
    page += 1;
  }

  for (const appt of appointments) {
    const apptKey = String(appt.id);
    let prevIds: number[] = [];
    try {
      const snap = await db
        .prepare(
          `SELECT tech_ids_json FROM st_assignment_snapshot WHERE st_appointment_id = ?`
        )
        .bind(apptKey)
        .first<{ tech_ids_json: string }>();
      if (snap?.tech_ids_json) {
        const parsed = JSON.parse(snap.tech_ids_json) as number[];
        if (Array.isArray(parsed)) prevIds = parsed.map(Number).filter((n) => n > 0);
      }
    } catch {
      prevIds = [];
    }

    const prevSet = new Set(prevIds);
    const newTechs = appt.technicianIds.filter((id) => !prevSet.has(id));

    // Update snapshot always
    try {
      await db
        .prepare(
          `INSERT INTO st_assignment_snapshot
            (st_appointment_id, st_job_id, tech_ids_json, modified_on, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(st_appointment_id) DO UPDATE SET
             st_job_id = excluded.st_job_id,
             tech_ids_json = excluded.tech_ids_json,
             modified_on = excluded.modified_on,
             updated_at = datetime('now')`
        )
        .bind(
          apptKey,
          appt.jobId > 0 ? String(appt.jobId) : null,
          JSON.stringify(appt.technicianIds),
          appt.modifiedOn
        )
        .run();
    } catch {
      /* ignore */
    }

    if (!after4 || !newTechs.length) {
      skipped += newTechs.length ? newTechs.length : 0;
      continue;
    }

    const assignedAt = appt.modifiedOn || now.toISOString();
    for (const techId of newTechs) {
      const result = await maybeSmsAfterHoursAssignment(env, db, {
        st_job_id: String(appt.jobId > 0 ? appt.jobId : `appt:${appt.id}`),
        st_appointment_id: apptKey,
        st_technician_id: techId,
        assigned_at: assignedAt,
        customer_name: appt.customerName,
        street: appt.street,
        window_start: appt.start,
        window_end: appt.end,
        source: "poll",
      });
      if (result.sent || result.status === "queued_no_twilio") notified += 1;
      else skipped += 1;
    }
  }

  return { checked: appointments.length, notified, skipped };
}

