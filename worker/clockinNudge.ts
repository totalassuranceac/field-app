/**
 * Weekday clock-in watch. Default off. Dry logs the text and does not call Twilio.
 * Live uses sendSms. Never edits a punch.
 *
 * Office texts go to the three numbers in the Step 1 build note (Chris, Kelsie, Bianca).
 * 8:15 uses Today's jobs. There is no separate shift table.
 */

import type { Env } from "./types";
import { getSetting } from "./audit";
import { logSms, normalizePhone, sendSms, smsConfigured } from "./sms";
import { toAsciiUiText } from "./utf8Mojibake";
import { ptoCoversChicagoDate } from "./pto";
import { notifyUsers } from "./notifications";
import {
  dayBoardCacheKey,
  readDayBoardCache,
  warmTodayDayBoard,
  type DayBoardResponse,
} from "./dayBoard";
import {
  asciiSms,
  chicagoLocalToUtc,
  chicagoWall,
  chicagoYmd,
  foldOpenJobSessions,
  inNudgeWindow,
  parseUtcLoose,
  planClockinTick,
  planLeftOnJobTick,
  resolveClockinMode,
  shouldCallTwilio,
  type DayClosed,
  type LeftOpenSession,
  type LeftPlanAction,
  type NudgeMode,
  type PlanAction,
  type PlanJob,
} from "./clockinNudgePlan";
import { onsiteNudgeMode, runOnsiteNudges } from "./onsiteNudge";

export {
  planClockinTick,
  replayClockinDay,
  resolveClockinMode,
  shouldCallTwilio,
} from "./clockinNudgePlan";
export { CHRIS_PHONE } from "./onsiteNudgePlan";

/** Build-note office phones. Not looked up from the user table. */
const OFFICE_PHONES = ["+13617791182", "+13614467438", "+13614627939"] as const;

const SETTING_KEY = "clockin_nudge_enabled";
const CACHE_REFRESH_MS = 4 * 60 * 1000;
const CACHE_MAX_MS = 45 * 60 * 1000;

let tablesReady = false;

export async function ensureClockinNudgeTables(db: D1Database): Promise<void> {
  if (tablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS fa_clockin_nudges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      appt_id TEXT NOT NULL,
      chicago_day TEXT NOT NULL,
      nudge_type TEXT NOT NULL DEFAULT 'late',
      nudge_at TEXT,
      office_alert_at TEXT,
      resolved_at TEXT,
      employee_name TEXT,
      job_label TEXT,
      window_start TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (employee_id, appt_id, chicago_day, nudge_type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fa_clockin_nudges_day
      ON fa_clockin_nudges (chicago_day, resolved_at, nudge_at)`,
    `CREATE TABLE IF NOT EXISTS fa_clockin_morning (
      chicago_day TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      body TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS fa_clockin_nudge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chicago_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      employee_id INTEGER,
      appt_id TEXT,
      mode TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fa_clockin_nudge_log_day
      ON fa_clockin_nudge_log (chicago_day, id)`,
  ];
  for (const sql of stmts) {
    await db.prepare(sql).run();
  }
  await migrateNudgeTypeColumn(db);
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_fa_clockin_nudges_left
       ON fa_clockin_nudges (nudge_type, employee_id, appt_id, resolved_at)`
    )
    .run();
  tablesReady = true;
}

/** Older local tables used a 3-column unique and had no type. Production has not created this yet. */
async function migrateNudgeTypeColumn(db: D1Database): Promise<void> {
  const row = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fa_clockin_nudges'`)
    .first<{ sql: string }>();
  const sql = String(row?.sql || "");
  if (!sql || sql.includes("nudge_type")) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE fa_clockin_nudges_v2 (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         employee_id INTEGER NOT NULL,
         appt_id TEXT NOT NULL,
         chicago_day TEXT NOT NULL,
         nudge_type TEXT NOT NULL DEFAULT 'late',
         nudge_at TEXT,
         office_alert_at TEXT,
         resolved_at TEXT,
         employee_name TEXT,
         job_label TEXT,
         window_start TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         UNIQUE (employee_id, appt_id, chicago_day, nudge_type)
       )`
    ),
    db.prepare(
      `INSERT INTO fa_clockin_nudges_v2
         (id, employee_id, appt_id, chicago_day, nudge_type, nudge_at, office_alert_at, resolved_at,
          employee_name, job_label, window_start, created_at)
       SELECT id, employee_id, appt_id, chicago_day, 'late', nudge_at, office_alert_at, resolved_at,
              employee_name, job_label, window_start, created_at
       FROM fa_clockin_nudges`
    ),
    db.prepare(`DROP TABLE fa_clockin_nudges`),
    db.prepare(`ALTER TABLE fa_clockin_nudges_v2 RENAME TO fa_clockin_nudges`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_fa_clockin_nudges_day
       ON fa_clockin_nudges (chicago_day, resolved_at, nudge_at)`
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_fa_clockin_nudges_left
       ON fa_clockin_nudges (nudge_type, employee_id, appt_id, resolved_at)`
    ),
  ]);
}

export async function clockinNudgeMode(env: Env, db: D1Database): Promise<NudgeMode> {
  let setting = "off";
  try {
    setting = await getSetting(db, SETTING_KEY, "off");
  } catch {
    setting = "off";
  }
  return resolveClockinMode(env.CLOCKIN_NUDGE_ENABLED, setting);
}

export async function markClockinNudgesResolved(db: D1Database, userId: number): Promise<void> {
  if (!(Number(userId) > 0)) return;
  try {
    const day = chicagoYmd(Date.now());
    await db
      .prepare(
        `UPDATE fa_clockin_nudges
         SET resolved_at = datetime('now')
         WHERE employee_id = ?
           AND chicago_day = ?
           AND resolved_at IS NULL
           AND nudge_type != 'left_on_job'`
      )
      .bind(userId, day)
      .run();
  } catch {
    try {
      await db
        .prepare(
          `UPDATE fa_clockin_nudges
           SET resolved_at = datetime('now')
           WHERE employee_id = ?
             AND chicago_day = ?
             AND resolved_at IS NULL`
        )
        .bind(userId, chicagoYmd(Date.now()))
        .run();
    } catch {
      /* table missing, or no open row — punch already saved */
    }
  }
}

/** Finished on that job stops the left-on-job texts. Does not change the punch. */
export async function markLeftOnJobResolved(
  db: D1Database,
  userId: number,
  apptIds: Array<string | null | undefined>
): Promise<void> {
  if (!(Number(userId) > 0)) return;
  const ids = [...new Set(apptIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return;
  try {
    for (const apptId of ids) {
      await db
        .prepare(
          `UPDATE fa_clockin_nudges
           SET resolved_at = datetime('now')
           WHERE employee_id = ?
             AND appt_id = ?
             AND nudge_type = 'left_on_job'
             AND resolved_at IS NULL`
        )
        .bind(userId, apptId)
        .run();
    }
  } catch {
    /* table missing */
  }
}

type UserLite = {
  id: number;
  display_name: string | null;
  username: string | null;
  phone: string | null;
  active: number | null;
};

export type OpenClockinNudge = {
  employee_id: number;
  name: string;
  job: string;
  appt_id: string;
  minutes_late: number | null;
  nudge_at: string | null;
  office_alerted: boolean;
  nudge_type: "late" | "left_on_job";
};

export async function listOpenClockinNudges(
  env: Env,
  db: D1Database
): Promise<{ mode: NudgeMode; day: string; items: OpenClockinNudge[] }> {
  const mode = await clockinNudgeMode(env, db);
  const day = chicagoYmd(Date.now());
  try {
    const rows = await db
      .prepare(
        `SELECT employee_id, appt_id, employee_name, job_label, window_start, nudge_at, office_alert_at, nudge_type
         FROM fa_clockin_nudges
         WHERE nudge_at IS NOT NULL
           AND resolved_at IS NULL
           AND (chicago_day = ? OR nudge_type = 'left_on_job')
         ORDER BY window_start ASC`
      )
      .bind(day)
      .all<{
        employee_id: number;
        appt_id: string;
        employee_name: string | null;
        job_label: string | null;
        window_start: string | null;
        nudge_at: string | null;
        office_alert_at: string | null;
        nudge_type: string | null;
      }>();
    const now = Date.now();
    const items: OpenClockinNudge[] = (rows.results || []).map((r) => {
      const start = r.window_start ? Date.parse(r.window_start) : NaN;
      const minutes = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 60000)) : null;
      const nudgeType = String(r.nudge_type || "late") === "left_on_job" ? "left_on_job" : "late";
      return {
        employee_id: Number(r.employee_id),
        name: asciiSms(r.employee_name) || "Tech",
        job: asciiSms(r.job_label) || "Job",
        appt_id: String(r.appt_id || ""),
        minutes_late: nudgeType === "left_on_job" ? null : minutes,
        nudge_at: r.nudge_at,
        office_alerted: !!r.office_alert_at,
        nudge_type: nudgeType,
      };
    });
    items.sort((a, b) => (b.minutes_late ?? 0) - (a.minutes_late ?? 0));
    return { mode, day, items };
  } catch {
    return { mode, day, items: [] };
  }
}

type RunAction = {
  kind: string;
  userId?: number;
  apptId?: string;
  status: string;
  body?: string;
};

export type ClockinNudgeRunResult = {
  mode: NudgeMode;
  day?: string;
  skipped?: string;
  actions: RunAction[];
};

function appBase(env: Env): string {
  const b = String(env.APP_BASE_URL || "").trim().replace(/\/$/, "");
  return b || "https://total-assurance-fleet.totalassurance.workers.dev";
}

async function writeLog(
  db: D1Database,
  row: {
    day: string;
    kind: string;
    employeeId: number | null;
    apptId: string | null;
    mode: NudgeMode;
    body: string;
    status: string;
  }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO fa_clockin_nudge_log
          (chicago_day, kind, employee_id, appt_id, mode, body, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.day,
        row.kind,
        row.employeeId,
        row.apptId,
        row.mode,
        row.body.slice(0, 1500),
        row.status
      )
      .run();
  } catch {
    /* log table best-effort */
  }
}

async function deliver(
  env: Env,
  db: D1Database,
  opts: {
    mode: NudgeMode;
    day: string;
    kind: string;
    toPhone: string | null;
    toUserId: number | null;
    employeeId: number | null;
    apptId: string | null;
    body: string;
    context: string;
  }
): Promise<string> {
  const body = toAsciiUiText(asciiSms(opts.body)).slice(0, 1500);
  if (!opts.toPhone) {
    await writeLog(db, {
      day: opts.day,
      kind: opts.kind,
      employeeId: opts.employeeId,
      apptId: opts.apptId,
      mode: opts.mode,
      body,
      status: "skipped_no_phone",
    });
    return "skipped_no_phone";
  }
  if (!shouldCallTwilio(opts.mode)) {
    await logSms(db, {
      from_user_id: null,
      to_user_id: opts.toUserId,
      to_phone: opts.toPhone,
      body,
      status: "dry",
      context: opts.context,
    });
    await writeLog(db, {
      day: opts.day,
      kind: opts.kind,
      employeeId: opts.employeeId,
      apptId: opts.apptId,
      mode: opts.mode,
      body,
      status: "would_send",
    });
    return "would_send";
  }
  if (!smsConfigured(env)) {
    await logSms(db, {
      from_user_id: null,
      to_user_id: opts.toUserId,
      to_phone: opts.toPhone,
      body,
      status: "failed",
      error: "sms_not_configured",
      context: opts.context,
    });
    await writeLog(db, {
      day: opts.day,
      kind: opts.kind,
      employeeId: opts.employeeId,
      apptId: opts.apptId,
      mode: opts.mode,
      body,
      status: "failed",
    });
    return "failed";
  }
  const sent = await sendSms(env, opts.toPhone, body);
  await logSms(db, {
    from_user_id: null,
    to_user_id: opts.toUserId,
    to_phone: opts.toPhone,
    body,
    status: sent.ok ? sent.status || "sent" : "failed",
    provider_sid: sent.ok ? sent.sid : null,
    error: sent.ok ? null : sent.error,
    context: opts.context,
  });
  await writeLog(db, {
    day: opts.day,
    kind: opts.kind,
    employeeId: opts.employeeId,
    apptId: opts.apptId,
    mode: opts.mode,
    body,
    status: sent.ok ? "sent" : "failed",
  });
  return sent.ok ? "sent" : "failed";
}

async function loadUsers(db: D1Database): Promise<Map<number, UserLite>> {
  const map = new Map<number, UserLite>();
  try {
    const rows = await db
      .prepare(
        `SELECT id, display_name, username, phone, active FROM users`
      )
      .all<UserLite>();
    for (const r of rows.results || []) {
      const id = Number(r.id);
      if (id > 0) map.set(id, r);
    }
  } catch {
    /* users optional */
  }
  return map;
}

async function loadPtoIds(db: D1Database, day: string): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const rows = await db
      .prepare(
        `SELECT user_id, start_date, end_date, hours_deducted
         FROM time_off_requests
         WHERE status = 'approved'
           AND start_date <= ?
           AND end_date >= ?`
      )
      .bind(day, day)
      .all<{
        user_id: number;
        start_date: string;
        end_date: string;
        hours_deducted: number | null;
      }>();
    for (const r of rows.results || []) {
      const uid = Number(r.user_id);
      if (!(uid > 0)) continue;
      if (ptoCoversChicagoDate(String(r.start_date), String(r.end_date), day, r.hours_deducted)) {
        ids.add(uid);
      }
    }
  } catch {
    /* PTO table optional */
  }
  return ids;
}

async function loadClockSnapshot(db: D1Database, day: string): Promise<{
  shopUserIds: number[];
  jobUserIds: number[];
  apptKeys: string[];
  jobKeys: string[];
}> {
  const shopUserIds: number[] = [];
  const jobUserIds: number[] = [];
  const apptKeys: string[] = [];
  const jobKeys: string[] = [];
  try {
    const rows = await db
      .prepare(
        `SELECT user_id, st_appointment_id, st_job_id, client_ts, created_at
         FROM job_clock_events
         WHERE step IN ('dispatch', 'arrive')
           AND created_at >= datetime('now', '-2 days')`
      )
      .all<{
        user_id: number;
        st_appointment_id: string | null;
        st_job_id: string | null;
        client_ts: string | null;
        created_at: string | null;
      }>();
    for (const r of rows.results || []) {
      const uid = Number(r.user_id);
      if (!(uid > 0)) continue;
      const ms = parseUtcLoose(r.client_ts) ?? parseUtcLoose(r.created_at);
      if (ms == null || chicagoYmd(ms) !== day) continue;
      jobUserIds.push(uid);
      if (r.st_appointment_id) apptKeys.push(`${uid}|${r.st_appointment_id}`);
      if (r.st_job_id) jobKeys.push(`${uid}|${r.st_job_id}`);
    }
  } catch {
    /* job clock table may be missing */
  }
  try {
    const rows = await db
      .prepare(
        `SELECT user_id, clock_in_at, created_at
         FROM fa_time_sessions
         WHERE created_at >= datetime('now', '-2 days')`
      )
      .all<{ user_id: number; clock_in_at: string | null; created_at: string | null }>();
    for (const r of rows.results || []) {
      const uid = Number(r.user_id);
      if (!(uid > 0)) continue;
      const ms = parseUtcLoose(r.clock_in_at) ?? parseUtcLoose(r.created_at);
      if (ms == null || chicagoYmd(ms) !== day) continue;
      shopUserIds.push(uid);
    }
  } catch {
    /* shop clock table may be missing */
  }
  return { shopUserIds, jobUserIds, apptKeys, jobKeys };
}

function jobsFromBoard(
  payload: DayBoardResponse,
  users: Map<number, UserLite>,
  ptoIds: Set<number>
): PlanJob[] {
  const out: PlanJob[] = [];
  for (const row of payload.rows || []) {
    const uid = row.user_id != null ? Number(row.user_id) : 0;
    if (!(uid > 0)) continue;
    const user = users.get(uid);
    const rawName = user?.display_name || row.display_name || "";
    const name = String(rawName).split("/")[0].trim();
    const onPto = ptoIds.has(uid) || (row.pto || []).length > 0;
    for (const job of row.jobs || []) {
      const apptId = String(job.st_appointment_id || "").trim();
      if (!apptId) continue;
      out.push({
        userId: uid,
        name,
        username: user?.username || null,
        apptId,
        jobId: job.st_job_id,
        customer: job.customer_name,
        address: job.address,
        windowStart: job.window_start,
        stPhase: job.st_phase,
        isDone: !!job.is_done,
        isOff: !!job.is_off,
        onPto,
        active: user ? Number(user.active) !== 0 : true,
      });
    }
  }
  return out;
}

async function loadBoard(
  env: Env,
  db: D1Database,
  day: string
): Promise<{ payload: DayBoardResponse; ageMs: number } | null> {
  const key = dayBoardCacheKey(day, "office", 0);
  let hit = await readDayBoardCache(db, key, CACHE_MAX_MS);
  if (!hit || hit.ageMs > CACHE_REFRESH_MS) {
    try {
      await warmTodayDayBoard(env, db);
    } catch {
      /* ST read is best-effort */
    }
    const fresh = await readDayBoardCache(db, key, CACHE_MAX_MS);
    if (fresh) hit = fresh;
  }
  if (!hit || hit.ageMs > CACHE_MAX_MS) return null;
  return { payload: hit.payload, ageMs: hit.ageMs };
}

function previousChicagoYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map((n) => Number(n));
  if (!(y > 0 && m > 0 && d > 0)) return ymd;
  return chicagoYmd(chicagoLocalToUtc(y, m, d, 12, 0) - 24 * 60 * 60 * 1000);
}

function jobLabelFromBoardJob(customer: string | null | undefined, address: string | null | undefined): string {
  const who = asciiSms(customer);
  const street = asciiSms(address).split(",")[0].trim();
  return (who && street ? `${who} - ${street}` : who || street || "a job").slice(0, 80);
}

async function loadDayClosed(db: D1Database): Promise<DayClosed[]> {
  const latestShop = new Map<number, { inMs: number; outAt: string | null }>();
  try {
    const rows = await db
      .prepare(
        `SELECT user_id, clock_in_at, clock_out_at
         FROM fa_time_sessions
         WHERE created_at >= datetime('now', '-45 days')
            OR clock_in_at >= datetime('now', '-45 days')`
      )
      .all<{ user_id: number; clock_in_at: string | null; clock_out_at: string | null }>();
    for (const row of rows.results || []) {
      const userId = Number(row.user_id);
      const inMs = parseUtcLoose(row.clock_in_at) ?? 0;
      if (!(userId > 0)) continue;
      const prev = latestShop.get(userId);
      if (!prev || inMs >= prev.inMs) {
        latestShop.set(userId, { inMs, outAt: row.clock_out_at });
      }
    }
  } catch {
    /* shop table optional */
  }
  const dayOut = new Map<number, string>();
  try {
    const rows = await db
      .prepare(
        `SELECT user_id, clock_out_at
         FROM fa_day_clock
         WHERE clock_out_at >= datetime('now', '-45 days')`
      )
      .all<{ user_id: number; clock_out_at: string }>();
    for (const row of rows.results || []) {
      const userId = Number(row.user_id);
      const at = String(row.clock_out_at || "");
      if (!(userId > 0) || !at) continue;
      const prev = dayOut.get(userId);
      if (!prev || (parseUtcLoose(at) || 0) >= (parseUtcLoose(prev) || 0)) dayOut.set(userId, at);
    }
  } catch {
    /* day clock table is created on the first clock-out */
  }
  const closed: DayClosed[] = [];
  const ids = new Set<number>([...latestShop.keys(), ...dayOut.keys()]);
  for (const userId of ids) {
    const shop = latestShop.get(userId);
    if (shop && !shop.outAt) continue;
    const shopAt = shop?.outAt || null;
    const dayAt = dayOut.get(userId) || null;
    const clockOutAt =
      shopAt && dayAt
        ? (parseUtcLoose(shopAt) || 0) >= (parseUtcLoose(dayAt) || 0)
          ? shopAt
          : dayAt
        : shopAt || dayAt;
    if (clockOutAt) closed.push({ userId, clockOutAt });
  }
  return closed;
}

function rememberBoardSession(
  payload: DayBoardResponse | null,
  users: Map<number, UserLite>,
  open: Map<string, LeftOpenSession>,
  finished: Set<string>,
  faFinished: Set<string>
): void {
  if (!payload) return;
  for (const row of payload.rows || []) {
    const userId = row.user_id != null ? Number(row.user_id) : 0;
    if (!(userId > 0)) continue;
    const user = users.get(userId);
    const name = String(user?.display_name || row.display_name || "").split("/")[0].trim() || "Tech";
    for (const job of row.jobs || []) {
      const apptId = String(job.st_appointment_id || "").trim();
      const jobId = String(job.st_job_id || "").trim();
      if (!apptId && !jobId) continue;
      const keyId = apptId || jobId;
      const key = `${userId}|${keyId}`;
      const phase = String(job.st_phase || "").toLowerCase();
      const done =
        !!job.is_done ||
        !!job.is_off ||
        phase === "finished" ||
        phase === "canceled" ||
        phase === "cancelled" ||
        phase === "off" ||
        phase === "hold" ||
        phase === "nonjob";
      if (done) {
        finished.add(key);
        if (jobId) finished.add(`${userId}|${jobId}`);
        if (apptId) finished.add(`${userId}|${apptId}`);
      }
      const working = phase === "dispatched" || phase === "arrived" || phase === "working";
      if (!working || done || faFinished.has(key) || faFinished.has(`${userId}|${jobId}`)) continue;
      if (open.has(key)) continue;
      open.set(key, {
        userId,
        name,
        username: user?.username || null,
        apptId: keyId,
        jobId: jobId || null,
        jobLabel: jobLabelFromBoardJob(job.customer_name, job.address),
        active: user ? Number(user.active) !== 0 : true,
      });
    }
  }
}

async function runLeftOnJob(
  env: Env,
  db: D1Database,
  mode: NudgeMode,
  day: string,
  users: Map<number, UserLite>,
  todayBoard: DayBoardResponse | null
): Promise<RunAction[]> {
  const closed = await loadDayClosed(db);
  let faOk = true;
  const faFinished = new Set<string>();
  const open = new Map<string, LeftOpenSession>();
  try {
    const rows = await db
      .prepare(
        `SELECT id, user_id, st_appointment_id, st_job_id, step
         FROM job_clock_events
         WHERE created_at >= datetime('now', '-45 days')
         ORDER BY id ASC`
      )
      .all<{
        id: number;
        user_id: number;
        st_appointment_id: string | null;
        st_job_id: string | null;
        step: string;
      }>();
    const folded = foldOpenJobSessions(
      (rows.results || []).map((row) => ({
        id: Number(row.id),
        userId: Number(row.user_id),
        apptId: row.st_appointment_id,
        jobId: row.st_job_id,
        step: row.step,
      }))
    );
    for (const session of folded) {
      const key = `${session.userId}|${session.apptId}`;
      if (session.finished) {
        faFinished.add(key);
        if (session.jobId) faFinished.add(`${session.userId}|${session.jobId}`);
      }
      if (!session.open) continue;
      const user = users.get(session.userId);
      open.set(key, {
        userId: session.userId,
        name: String(user?.display_name || "").split("/")[0].trim() || "Tech",
        username: user?.username || null,
        apptId: session.apptId,
        jobId: session.jobId || null,
        jobLabel: session.jobId ? `job ${session.jobId}` : "a job",
        active: user ? Number(user.active) !== 0 : true,
      });
    }
  } catch {
    faOk = false;
  }

  let yesterday: DayBoardResponse | null = null;
  try {
    const ymd = previousChicagoYmd(day);
    const hit = await readDayBoardCache(db, dayBoardCacheKey(ymd, "office", 0), 20 * 60 * 60 * 1000);
    yesterday = hit?.payload || null;
  } catch {
    yesterday = null;
  }
  const finished = new Set<string>(faFinished);
  rememberBoardSession(yesterday, users, open, finished, faFinished);
  rememberBoardSession(todayBoard, users, open, finished, faFinished);

  // Prefer a Today / yesterday customer label over a bare job id.
  const labeled = new Map<string, string>();
  for (const payload of [yesterday, todayBoard]) {
    if (!payload) continue;
    for (const row of payload.rows || []) {
      const userId = row.user_id != null ? Number(row.user_id) : 0;
      for (const job of row.jobs || []) {
        const apptId = String(job.st_appointment_id || "").trim();
        const jobId = String(job.st_job_id || "").trim();
        const label = jobLabelFromBoardJob(job.customer_name, job.address);
        if (userId > 0 && apptId) labeled.set(`${userId}|${apptId}`, label);
        if (userId > 0 && jobId) labeled.set(`${userId}|${jobId}`, label);
      }
    }
  }
  for (const [key, session] of open) {
    const better = labeled.get(key) || (session.jobId ? labeled.get(`${session.userId}|${session.jobId}`) : "");
    if (better && better !== "a job") session.jobLabel = better;
  }
  const keeper = new Map<string, string>();
  for (const [key, session] of open) {
    const jobKey = session.jobId ? `${session.userId}|${session.jobId}` : key;
    const prev = keeper.get(jobKey);
    if (!prev) {
      keeper.set(jobKey, key);
      continue;
    }
    const prevSession = open.get(prev);
    const prevIsJob = !!prevSession && prevSession.apptId === prevSession.jobId;
    const thisIsJob = session.apptId === session.jobId;
    if (prevIsJob && !thisIsJob) {
      open.delete(prev);
      keeper.set(jobKey, key);
    } else {
      open.delete(key);
    }
  }

  let existing: Array<{
    employee_id: number;
    appt_id: string;
    nudge_at: string | null;
    office_alert_at: string | null;
    resolved_at: string | null;
  }> = [];
  try {
    const rows = await db
      .prepare(
        `SELECT employee_id, appt_id, nudge_at, office_alert_at, resolved_at
         FROM fa_clockin_nudges
         WHERE nudge_type = 'left_on_job'
           AND (resolved_at IS NULL OR created_at >= datetime('now', '-45 days'))`
      )
      .all<{
        employee_id: number;
        appt_id: string;
        nudge_at: string | null;
        office_alert_at: string | null;
        resolved_at: string | null;
      }>();
    existing = rows.results || [];
  } catch {
    existing = [];
  }

  const plan = planLeftOnJobTick({
    now: new Date(),
    mode,
    closed,
    openSessions: [...open.values()],
    finishedKeys: [...finished],
    existing: existing.map((row) => ({
      userId: Number(row.employee_id),
      apptId: String(row.appt_id),
      nudgeAt: row.nudge_at,
      officeAt: row.office_alert_at,
      resolvedAt: row.resolved_at,
    })),
    appBase: appBase(env),
    allowResolve: faOk && !!todayBoard,
  });

  const actions: RunAction[] = [];
  for (const action of plan.actions) {
    try {
      actions.push(await applyAction(env, db, mode, day, action, users));
    } catch {
      actions.push({ kind: action.kind, status: "error" });
    }
  }
  return actions;
}

export async function runClockinNudges(env: Env, db: D1Database): Promise<ClockinNudgeRunResult> {
  const lateMode = await clockinNudgeMode(env, db);
  const onsiteMode = await onsiteNudgeMode(env, db);
  if (lateMode === "off" && onsiteMode === "off") return { mode: lateMode, actions: [] };

  const now = new Date();
  const wall = chicagoWall(now);
  const daytime = inNudgeWindow(wall);
  const actions: RunAction[] = [];
  let users = new Map<number, UserLite>();
  let board: DayBoardResponse | null = null;
  let boardAgeMs = Number.MAX_SAFE_INTEGER;

  let lateTablesOk = false;
  if (lateMode !== "off") {
    try {
      await ensureClockinNudgeTables(db);
      lateTablesOk = true;
    } catch {
      if (onsiteMode === "off") return { mode: lateMode, day: wall.ymd, skipped: "tables", actions: [] };
    }
  }

  if ((lateMode !== "off" && lateTablesOk) || onsiteMode !== "off") {
    const loaded = await loadBoard(env, db, wall.ymd);
    board = loaded?.payload ?? null;
    boardAgeMs = loaded?.ageMs ?? Number.MAX_SAFE_INTEGER;
  }

  if (lateMode !== "off" && lateTablesOk) {
    if (daytime && board) {
      const [loadedUsers, ptoIds, clock, existingRows, morningRow] = await Promise.all([
        loadUsers(db),
        loadPtoIds(db, wall.ymd),
        loadClockSnapshot(db, wall.ymd),
        db
          .prepare(
            `SELECT employee_id, appt_id, nudge_at, office_alert_at, resolved_at
             FROM fa_clockin_nudges
             WHERE chicago_day = ? AND nudge_type = 'late'`
          )
          .bind(wall.ymd)
          .all<{
            employee_id: number;
            appt_id: string;
            nudge_at: string | null;
            office_alert_at: string | null;
            resolved_at: string | null;
          }>(),
        db
          .prepare(`SELECT chicago_day FROM fa_clockin_morning WHERE chicago_day = ?`)
          .bind(wall.ymd)
          .first<{ chicago_day: string }>(),
      ]);
      users = loadedUsers;
      let onsiteKeys: string[] = [];
      try {
        const led = await db
          .prepare(
            `SELECT lead_user_id, appt_id FROM fa_onsite_nudges
             WHERE chicago_day = ? AND lead_at IS NOT NULL`
          )
          .bind(wall.ymd)
          .all<{ lead_user_id: number; appt_id: string }>();
        onsiteKeys = (led.results || []).map((row) => `${Number(row.lead_user_id)}|${String(row.appt_id)}`);
      } catch {
        onsiteKeys = [];
      }
      const plan = planClockinTick({
        now,
        mode: lateMode,
        jobs: jobsFromBoard(board, users, ptoIds),
        clock,
        existing: (existingRows.results || []).map((r) => ({
          userId: Number(r.employee_id),
          apptId: String(r.appt_id),
          nudgeAt: r.nudge_at,
          officeAt: r.office_alert_at,
          resolvedAt: r.resolved_at,
        })),
        morningSent: !!morningRow,
        appBase: appBase(env),
        onsiteKeys,
      });
      for (const action of plan.actions) {
        try {
          actions.push(await applyAction(env, db, lateMode, wall.ymd, action, users));
        } catch {
          actions.push({ kind: action.kind, status: "error" });
        }
      }
    } else if (daytime) {
      actions.push({ kind: "daytime", status: "no_board" });
    }

    if (users.size === 0) users = await loadUsers(db);
    try {
      actions.push(...(await runLeftOnJob(env, db, lateMode, wall.ymd, users, board)));
    } catch {
      actions.push({ kind: "left_on_job", status: "error" });
    }
  }

  if (onsiteMode !== "off") {
    try {
      if (users.size === 0) users = await loadUsers(db);
      await runOnsiteNudges(env, db, board, boardAgeMs, users, now);
    } catch {
      actions.push({ kind: "onsite", status: "error" });
    }
  }

  return {
    mode: lateMode,
    day: wall.ymd,
    skipped: lateMode !== "off" && lateTablesOk && !daytime ? "outside_window" : undefined,
    actions,
  };
}

async function applyAction(
  env: Env,
  db: D1Database,
  mode: NudgeMode,
  day: string,
  action: PlanAction | LeftPlanAction,
  users: Map<number, UserLite>
): Promise<RunAction> {
  if (action.kind === "left_resolve") {
    await db
      .prepare(
        `UPDATE fa_clockin_nudges
         SET resolved_at = datetime('now')
         WHERE employee_id = ? AND appt_id = ? AND nudge_type = 'left_on_job' AND resolved_at IS NULL`
      )
      .bind(action.userId, action.apptId)
      .run();
    return { kind: "left_resolve", userId: action.userId, apptId: action.apptId, status: "resolved" };
  }

  if (action.kind === "left_tech") {
    const phone = normalizePhone(users.get(action.userId)?.phone);
    const status = await deliver(env, db, {
      mode,
      day,
      kind: "left_on_job",
      toPhone: phone,
      toUserId: action.userId,
      employeeId: action.userId,
      apptId: action.apptId,
      body: action.body,
      context: `clockin_nudge:left:${action.userId}:${action.apptId}`,
    });
    if (status === "sent" || status === "would_send" || status === "skipped_no_phone") {
      await db
        .prepare(
          `INSERT INTO fa_clockin_nudges
            (employee_id, appt_id, chicago_day, nudge_type, employee_name, job_label, window_start, nudge_at)
           VALUES (?, ?, ?, 'left_on_job', ?, ?, ?, datetime('now'))
           ON CONFLICT(employee_id, appt_id, chicago_day, nudge_type) DO UPDATE SET
             nudge_at = excluded.nudge_at,
             office_alert_at = NULL,
             resolved_at = NULL,
             employee_name = excluded.employee_name,
             job_label = excluded.job_label,
             window_start = excluded.window_start
           WHERE fa_clockin_nudges.resolved_at IS NOT NULL`
        )
        .bind(action.userId, action.apptId, day, action.name, action.jobLabel, action.clockOutAt)
        .run();
      if (shouldCallTwilio(mode)) {
        try {
          await notifyUsers(db, [action.userId], "left_on_job", "Still on a job", action.body, {
            type: "left_on_job",
            id: action.apptId,
          });
          await writeLog(db, {
            day,
            kind: "left_on_job_push",
            employeeId: action.userId,
            apptId: action.apptId,
            mode,
            body: action.body,
            status: "sent",
          });
        } catch {
          await writeLog(db, {
            day,
            kind: "left_on_job_push",
            employeeId: action.userId,
            apptId: action.apptId,
            mode,
            body: action.body,
            status: "failed",
          });
        }
      } else {
        await writeLog(db, {
          day,
          kind: "left_on_job_push",
          employeeId: action.userId,
          apptId: action.apptId,
          mode,
          body: action.body,
          status: "would_send",
        });
      }
    }
    return { kind: "left_tech", userId: action.userId, apptId: action.apptId, status, body: action.body };
  }

  if (action.kind === "left_office") {
    let anyOk = false;
    let anyFail = false;
    for (const phone of OFFICE_PHONES) {
      const status = await deliver(env, db, {
        mode,
        day,
        kind: "left_on_job_office",
        toPhone: phone,
        toUserId: null,
        employeeId: action.userId,
        apptId: action.apptId,
        body: action.body,
        context: `clockin_nudge:left_office:${action.apptId}:${action.userId}`,
      });
      if (status === "sent" || status === "would_send") anyOk = true;
      if (status === "failed") anyFail = true;
    }
    if (anyOk) {
      await db
        .prepare(
          `UPDATE fa_clockin_nudges
           SET office_alert_at = datetime('now')
           WHERE employee_id = ? AND appt_id = ? AND nudge_type = 'left_on_job'
             AND resolved_at IS NULL AND office_alert_at IS NULL`
        )
        .bind(action.userId, action.apptId)
        .run();
    }
    return {
      kind: "left_office",
      userId: action.userId,
      apptId: action.apptId,
      status: anyOk ? (mode === "dry" ? "would_send" : "sent") : anyFail ? "failed" : "skipped",
      body: action.body,
    };
  }

  if (action.kind === "resolve") {
    await db
      .prepare(
        `UPDATE fa_clockin_nudges
         SET resolved_at = datetime('now')
         WHERE employee_id = ? AND appt_id = ? AND chicago_day = ? AND nudge_type = 'late' AND resolved_at IS NULL`
      )
      .bind(action.userId, action.apptId, day)
      .run();
    return { kind: "resolve", userId: action.userId, apptId: action.apptId, status: "resolved" };
  }

  if (action.kind === "morning") {
    let anyOk = false;
    let anyFail = false;
    for (const phone of OFFICE_PHONES) {
      const status = await deliver(env, db, {
        mode,
        day,
        kind: "morning",
        toPhone: phone,
        toUserId: null,
        employeeId: null,
        apptId: null,
        body: action.body,
        context: `clockin_nudge:morning:${day}`,
      });
      if (status === "sent" || status === "would_send") anyOk = true;
      if (status === "failed") anyFail = true;
    }
    if (anyOk) {
      await db
        .prepare(
          `INSERT INTO fa_clockin_morning (chicago_day, sent_at, mode, body)
           VALUES (?, datetime('now'), ?, ?)
           ON CONFLICT(chicago_day) DO NOTHING`
        )
        .bind(day, mode, action.body.slice(0, 1500))
        .run();
    }
    return {
      kind: "morning",
      status: anyOk ? (mode === "dry" ? "would_send" : "sent") : anyFail ? "failed" : "skipped",
      body: action.body,
    };
  }

  if (action.kind === "tech") {
    const phone = normalizePhone(users.get(action.userId)?.phone);
    const status = await deliver(env, db, {
      mode,
      day,
      kind: "tech",
      toPhone: phone,
      toUserId: action.userId,
      employeeId: action.userId,
      apptId: action.apptId,
      body: action.body,
      context: `clockin_nudge:tech:${action.userId}:${action.apptId}`,
    });
    if (status === "sent" || status === "would_send" || status === "skipped_no_phone") {
      await db
        .prepare(
          `INSERT INTO fa_clockin_nudges
            (employee_id, appt_id, chicago_day, nudge_type, employee_name, job_label, window_start, nudge_at)
           VALUES (?, ?, ?, 'late', ?, ?, ?, datetime('now'))
           ON CONFLICT(employee_id, appt_id, chicago_day, nudge_type) DO UPDATE SET
             nudge_at = COALESCE(fa_clockin_nudges.nudge_at, excluded.nudge_at),
             employee_name = excluded.employee_name,
             job_label = excluded.job_label,
             window_start = COALESCE(fa_clockin_nudges.window_start, excluded.window_start)`
        )
        .bind(
          action.userId,
          action.apptId,
          day,
          action.name,
          action.jobLabel,
          action.windowStart
        )
        .run();
    }
    return { kind: "tech", userId: action.userId, apptId: action.apptId, status, body: action.body };
  }

  let anyOk = false;
  let anyFail = false;
  for (const phone of OFFICE_PHONES) {
    const status = await deliver(env, db, {
      mode,
      day,
      kind: "office",
      toPhone: phone,
      toUserId: null,
      employeeId: action.userId,
      apptId: action.apptId,
      body: action.body,
      context: `clockin_nudge:office:${action.apptId}`,
    });
    if (status === "sent" || status === "would_send") anyOk = true;
    if (status === "failed") anyFail = true;
  }
  if (anyOk) {
    const ids = action.userIds.length ? action.userIds : [action.userId];
    for (const uid of ids) {
      await db
        .prepare(
          `UPDATE fa_clockin_nudges
           SET office_alert_at = datetime('now')
           WHERE employee_id = ? AND appt_id = ? AND chicago_day = ? AND nudge_type = 'late' AND office_alert_at IS NULL`
        )
        .bind(uid, action.apptId, day)
        .run();
    }
  }
  return {
    kind: "office",
    userId: action.userId,
    apptId: action.apptId,
    status: anyOk ? (mode === "dry" ? "would_send" : "sent") : anyFail ? "failed" : "skipped",
    body: action.body,
  };
}


