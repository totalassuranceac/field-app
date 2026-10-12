/**
 * Install-crew board-mismatch watch. Default off. Dry logs and does not text.
 * Service crews are never checked. No live-map GPS and no Verizon login.
 */
import type { Env, PublicUser } from "./types";
import { getSetting, setSetting, writeAudit } from "./audit";
import { logSms, normalizePhone, sendSms } from "./sms";
import { notifyUsers } from "./notifications";
import { applyHardLockFaPairs, loadFaInstallPairs, type DayBoardJob, type DayBoardResponse } from "./dayBoard";
import { driverNameParts, getOneStepPositionsForOnsite, isPoolDriverLabel } from "./gps";
import {
  chicagoYmd,
  foldOpenJobSessions,
  inNudgeWindow,
  resolveClockinMode,
  type NudgeMode,
} from "./clockinNudgePlan";
import { chicagoWall } from "./clockinNudgePlan";
import {
  CHRIS_PHONE,
  JOB_RADIUS_M,
  planOnsiteTick,
  type OnsiteAction,
  type OnsiteCrewInput,
  type OnsiteExisting,
  type OnsiteJob,
  type OnsitePlanInput,
  type OnsitePosition,
} from "./onsiteNudgePlan";

export { CHRIS_PHONE } from "./onsiteNudgePlan";

const MODE_KEY = "onsite_nudge_mode";
const RADIUS_KEY = "onsite_nudge_radius_m";
const GEO_KEY = "onsite_geocoder";
const CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

let tablesReady = false;
let prunedDay = "";
const geocodeFailAt = new Map<string, number>();

type UserLite = {
  id: number;
  display_name?: string | null;
  username?: string | null;
  phone?: string | null;
  active?: number | null;
  employee_id?: number | null;
  employee_name?: string | null;
};

type VehicleRow = {
  id: number;
  unit_number: string | null;
  status: string | null;
  assigned_driver: string | null;
  assigned_employee_id: number | null;
  helper_employee_id: number | null;
  gps_tracker: string | null;
};

export async function onsiteNudgeMode(env: Env, db: D1Database): Promise<NudgeMode> {
  let setting = "off";
  try {
    setting = await getSetting(db, MODE_KEY, "off");
  } catch {
    setting = "off";
  }
  return resolveClockinMode(env.ONSITE_NUDGE_ENABLED, setting);
}

export async function ensureOnsiteTables(db: D1Database): Promise<void> {
  if (tablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS fa_onsite_nudges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_user_id INTEGER NOT NULL,
      appt_id TEXT NOT NULL,
      chicago_day TEXT NOT NULL,
      case_kind TEXT,
      crew TEXT NOT NULL DEFAULT 'install',
      crew_user_ids TEXT,
      job_number TEXT,
      street TEXT,
      vehicle_id INTEGER,
      unit_number TEXT,
      map_source TEXT,
      day_clock_source TEXT,
      first_seen_at TEXT,
      seen_ticks INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      last_distance_m REAL,
      lead_at TEXT,
      lead_tick_count INTEGER NOT NULL DEFAULT 0,
      chris_at TEXT,
      closed_at TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (lead_user_id, appt_id, chicago_day)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fa_onsite_nudges_day ON fa_onsite_nudges (chicago_day, resolved_at)`,
    `CREATE INDEX IF NOT EXISTS idx_fa_onsite_nudges_lead ON fa_onsite_nudges (lead_user_id, chicago_day)`,
    `CREATE TABLE IF NOT EXISTS fa_onsite_nudge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chicago_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      case_kind TEXT,
      lead_user_id INTEGER,
      appt_id TEXT,
      job_number TEXT,
      vehicle_id INTEGER,
      provider TEXT,
      point_at TEXT,
      distance_m REAL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      to_phone_last4 TEXT,
      body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fa_onsite_nudge_log_day ON fa_onsite_nudge_log (chicago_day, id)`,
    `CREATE INDEX IF NOT EXISTS idx_fa_onsite_nudge_log_lead ON fa_onsite_nudge_log (lead_user_id, chicago_day)`,
    `CREATE TABLE IF NOT EXISTS fa_onsite_geocodes (
      address_key TEXT PRIMARY KEY,
      address_text TEXT NOT NULL,
      lat REAL,
      lng REAL,
      source TEXT NOT NULL,
      match_count INTEGER NOT NULL,
      matched_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS fa_onsite_gps_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_at TEXT NOT NULL,
      vehicle_id INTEGER NOT NULL,
      provider TEXT,
      point_at TEXT,
      lat REAL,
      lng REAL,
      speed_mph REAL,
      status TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fa_onsite_gps_samples_v ON fa_onsite_gps_samples (vehicle_id, tick_at)`,
  ];
  for (const sql of stmts) await db.prepare(sql).run();
  tablesReady = true;
}

function normPerson(raw: string | null | undefined): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/^[-x\s]+/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function onestepTracker(raw: string | null | undefined): boolean {
  return /one\s*step|onestep|1step/i.test(String(raw || ""));
}

function last4(phone: string | null | undefined): string | null {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function numOrNull(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function writeLog(
  db: D1Database,
  row: {
    day: string;
    kind: string;
    caseKind?: string | null;
    leadUserId?: number | null;
    apptId?: string | null;
    jobNumber?: string | null;
    vehicleId?: number | null;
    provider?: string | null;
    pointAt?: string | null;
    distanceM?: number | null;
    mode: NudgeMode;
    status: string;
    phone?: string | null;
    body?: string | null;
  }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO fa_onsite_nudge_log
          (chicago_day, kind, case_kind, lead_user_id, appt_id, job_number, vehicle_id, provider, point_at, distance_m, mode, status, to_phone_last4, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.day,
        row.kind,
        row.caseKind || null,
        row.leadUserId ?? null,
        row.apptId || null,
        row.jobNumber || null,
        row.vehicleId ?? null,
        row.provider || null,
        row.pointAt || null,
        row.distanceM ?? null,
        row.mode,
        row.status,
        last4(row.phone),
        String(row.body || "").slice(0, 1500)
      )
      .run();
  } catch {
    /* log is best-effort */
  }
}

async function deliverOnsite(
  env: Env,
  db: D1Database,
  opts: {
    mode: NudgeMode;
    day: string;
    kind: "lead" | "chris";
    phone: string | null;
    userId: number | null;
    leadUserId: number;
    apptId: string;
    caseKind: string;
    jobNumber: string | null;
    body: string;
    context: string;
  }
): Promise<string> {
  const phone = opts.kind === "chris" ? CHRIS_PHONE : opts.phone;
  if (opts.kind === "chris" && phone !== CHRIS_PHONE) {
    await writeLog(db, {
      day: opts.day,
      kind: "chris",
      caseKind: opts.caseKind,
      leadUserId: opts.leadUserId,
      apptId: opts.apptId,
      jobNumber: opts.jobNumber,
      mode: opts.mode,
      status: "skipped_bad_phone",
      body: opts.body,
    });
    return "skipped_bad_phone";
  }
  if (!phone) {
    await writeLog(db, {
      day: opts.day,
      kind: opts.kind,
      caseKind: opts.caseKind,
      leadUserId: opts.leadUserId,
      apptId: opts.apptId,
      jobNumber: opts.jobNumber,
      mode: opts.mode,
      status: "skipped_no_phone",
      body: opts.body,
    });
    return "skipped_no_phone";
  }
  if (opts.mode !== "live") {
    await logSms(db, {
      from_user_id: null,
      to_user_id: opts.kind === "chris" ? null : opts.userId,
      to_phone: phone,
      body: opts.body,
      status: "dry",
      context: opts.context,
    });
    await writeLog(db, {
      day: opts.day,
      kind: opts.kind,
      caseKind: opts.caseKind,
      leadUserId: opts.leadUserId,
      apptId: opts.apptId,
      jobNumber: opts.jobNumber,
      mode: opts.mode,
      status: "would_send",
      phone,
      body: opts.body,
    });
    return "would_send";
  }
  try {
    const dup = await db
      .prepare(
        `SELECT id FROM sms_log
         WHERE context = ? AND status IN ('sent', 'queued', 'delivered')
           AND created_at >= datetime('now', '-6 hours')
         LIMIT 1`
      )
      .bind(opts.context)
      .first<{ id: number }>();
    if (dup) {
      await writeLog(db, {
        day: opts.day,
        kind: opts.kind,
        caseKind: opts.caseKind,
        leadUserId: opts.leadUserId,
        apptId: opts.apptId,
        jobNumber: opts.jobNumber,
        mode: opts.mode,
        status: "skipped_dup_6h",
        phone,
        body: opts.body,
      });
      return "skipped_dup_6h";
    }
  } catch {
    /* sms_log may be missing in a local stub */
  }
  const sent = await sendSms(env, phone, opts.body);
  await logSms(db, {
    from_user_id: null,
    to_user_id: opts.kind === "chris" ? null : opts.userId,
    to_phone: phone,
    body: opts.body,
    status: sent.ok ? sent.status || "sent" : "failed",
    provider_sid: sent.ok ? sent.sid : null,
    error: sent.ok ? null : sent.error,
    context: opts.context,
  });
  await writeLog(db, {
    day: opts.day,
    kind: opts.kind,
    caseKind: opts.caseKind,
    leadUserId: opts.leadUserId,
    apptId: opts.apptId,
    jobNumber: opts.jobNumber,
    mode: opts.mode,
    status: sent.ok ? "sent" : "failed",
    phone,
    body: opts.body,
  });
  return sent.ok ? "sent" : "failed";
}

function toJob(job: DayBoardJob): OnsiteJob {
  return {
    apptId: String(job.st_appointment_id || ""),
    jobId: job.st_job_id,
    jobNumber: job.job_number,
    street: job.address,
    customer: job.customer_name,
    windowStart: job.window_start,
    windowEnd: job.window_end,
    stPhase: job.st_phase,
    isDone: !!job.is_done,
    isOff: !!job.is_off,
    ink: job.ink,
    jobLat: null,
    jobLng: null,
  };
}

async function loadDirectory(db: D1Database, seed: Map<number, UserLite>): Promise<Map<number, UserLite>> {
  const out = new Map(seed);
  try {
    const rows = await db
      .prepare(
        `SELECT u.id, u.display_name, u.username, u.phone, u.active, u.employee_id, e.name AS employee_name
         FROM users u
         LEFT JOIN employees e ON e.id = u.employee_id`
      )
      .all<UserLite>();
    for (const row of rows.results || []) {
      if (Number(row.id) > 0) out.set(Number(row.id), { ...out.get(Number(row.id)), ...row, id: Number(row.id) });
    }
  } catch {
    /* users query is optional for a stub */
  }
  return out;
}

function matchVans(member: UserLite, vehicles: VehicleRow[]): Array<{ van: VehicleRow; source: string }> {
  const names = [normPerson(member.display_name), normPerson(member.employee_name)].filter(Boolean);
  const emp = Number(member.employee_id) > 0 ? Number(member.employee_id) : 0;
  const hits: Array<{ van: VehicleRow; source: string }> = [];
  for (const van of vehicles) {
    if (isPoolDriverLabel(van.assigned_driver) && !(emp > 0)) continue;
    let source = "";
    if (emp && Number(van.assigned_employee_id) === emp) source = "fk_assigned";
    else if (emp && Number(van.helper_employee_id) === emp) source = "fk_helper";
    else if (!isPoolDriverLabel(van.assigned_driver)) {
      const parts = driverNameParts(van.assigned_driver);
      if (names.some((name) => parts.includes(name))) source = "name";
    }
    if (!source) continue;
    if (!hits.some((hit) => hit.van.id === van.id)) hits.push({ van, source });
  }
  return hits;
}

async function geocodeOne(
  db: D1Database,
  address: string
): Promise<{ lat: number; lng: number } | null> {
  const key = address.toLowerCase().replace(/\s+/g, " ").trim();
  try {
    const cached = await db
      .prepare(`SELECT lat, lng, match_count FROM fa_onsite_geocodes WHERE address_key = ?`)
      .bind(key)
      .first<{ lat: number | null; lng: number | null; match_count: number }>();
    if (cached) {
      if (Number(cached.match_count) === 1 && cached.lat != null && cached.lng != null) {
        return { lat: Number(cached.lat), lng: Number(cached.lng) };
      }
      return null;
    }
  } catch {
    /* cache miss */
  }
  const failed = geocodeFailAt.get(key) || 0;
  if (failed && Date.now() - failed < 60 * 60 * 1000) return null;
  const url = `${CENSUS}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let matchCount = 0;
    let lat: number | null = null;
    let lng: number | null = null;
    let matched = "";
    if (text.trim().startsWith("{")) {
      const parsed = JSON.parse(text) as {
        result?: { addressMatches?: Array<{ matchedAddress?: string; coordinates?: { x?: number; y?: number } }> };
      };
      const matches = parsed.result?.addressMatches || [];
      matchCount = matches.length;
      if (matchCount === 1) {
        lng = numOrNull(matches[0]?.coordinates?.x);
        lat = numOrNull(matches[0]?.coordinates?.y);
        matched = String(matches[0]?.matchedAddress || "");
      }
    } else {
      geocodeFailAt.set(key, Date.now());
      return null;
    }
    try {
      await db
        .prepare(
          `INSERT INTO fa_onsite_geocodes (address_key, address_text, lat, lng, source, match_count, matched_address)
           VALUES (?, ?, ?, ?, 'census', ?, ?)
           ON CONFLICT(address_key) DO NOTHING`
        )
        .bind(key, address, lat, lng, matchCount, matched || null)
        .run();
    } catch {
      /* cache write optional */
    }
    if (matchCount === 1 && lat != null && lng != null) return { lat, lng };
    return null;
  } catch {
    geocodeFailAt.set(key, Date.now());
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function runOnsiteNudges(
  env: Env,
  db: D1Database,
  board: DayBoardResponse | null,
  boardAgeMs: number,
  users: ReadonlyMap<number, UserLite>,
  now = new Date()
): Promise<{ mode: NudgeMode; actions: OnsiteAction[] }> {
  const mode = await onsiteNudgeMode(env, db);
  if (mode === "off") return { mode, actions: [] };
  if (!inNudgeWindow(chicagoWall(now))) return { mode, actions: [] };
  try {
    await ensureOnsiteTables(db);
  } catch {
    return { mode, actions: [] };
  }

  let radius = JOB_RADIUS_M;
  let geocoder = "off";
  try {
    const rawRadius = Number(await getSetting(db, RADIUS_KEY, "150"));
    if (rawRadius >= 75 && rawRadius <= 400) radius = rawRadius;
    geocoder = String(await getSetting(db, GEO_KEY, "off") || "off").trim().toLowerCase();
  } catch {
    geocoder = "off";
  }
  if (geocoder !== "census") geocoder = "off";

  const installRows = (board?.rows || []).filter((row) => row.crew === "install" && (row.jobs || []).length > 0 && Number(row.user_id) > 0);
  if (!installRows.length) return { mode, actions: [] };

  const day = chicagoYmd(now.getTime());
  const directory = await loadDirectory(db, new Map(users));
  let pairs = new Map<number, { partnerFull: string; partnerUserId: number | null }>();
  try {
    pairs = await loadFaInstallPairs(db);
    applyHardLockFaPairs(
      pairs,
      [...directory.values()].map((user) => ({ id: user.id, display_name: String(user.display_name || "") }))
    );
  } catch {
    pairs = new Map();
  }

  let vehicles: VehicleRow[] = [];
  try {
    const rows = await db
      .prepare(
        `SELECT id, unit_number, status, assigned_driver, assigned_employee_id, helper_employee_id, gps_tracker
         FROM vehicles WHERE status != 'retired'`
      )
      .all<VehicleRow>();
    vehicles = rows.results || [];
  } catch {
    vehicles = [];
  }

  const memberIds = new Map<number, number[]>();
  for (const row of installRows) {
    const lead = Number(row.user_id);
    const partner = pairs.get(lead)?.partnerUserId;
    const ids = [lead];
    if (partner && partner > 0 && partner !== lead) ids.push(partner);
    memberIds.set(lead, ids);
  }
  const appearances = new Map<number, number>();
  for (const ids of memberIds.values()) {
    for (const id of ids) appearances.set(id, (appearances.get(id) || 0) + 1);
  }

  const crews: OnsiteCrewInput[] = [];
  for (const row of installRows) {
    const lead = Number(row.user_id);
    const ids = memberIds.get(lead) || [lead];
    const shared = ids.find((id) => (appearances.get(id) || 0) > 1);
    let vanAmbiguous: string | null = null;
    let chosen: OnsiteCrewInput["van"] = null;
    if (shared) {
      const who = directory.get(shared)?.display_name || "crew";
      vanAmbiguous = `person_on_two_crews:${who}`;
    } else {
      const leadHits = matchVans(directory.get(lead) || { id: lead }, vehicles);
      const partner = ids[1];
      const partnerHits = partner ? matchVans(directory.get(partner) || { id: partner }, vehicles) : [];
      if (leadHits.length > 1) vanAmbiguous = `two_vans:${directory.get(lead)?.display_name || "lead"}`;
      else if (leadHits.length === 1) {
        const hit = leadHits[0];
        chosen = {
          vehicleId: Number(hit.van.id),
          unit: String(hit.van.unit_number || ""),
          mapSource: hit.source,
          gpsTracker: hit.van.gps_tracker,
          status: hit.van.status,
        };
      } else if (partnerHits.length > 1) vanAmbiguous = `two_vans:${directory.get(partner)?.display_name || "partner"}`;
      else if (partnerHits.length === 1) {
        const hit = partnerHits[0];
        chosen = {
          vehicleId: Number(hit.van.id),
          unit: String(hit.van.unit_number || ""),
          mapSource: "partner",
          gpsTracker: hit.van.gps_tracker,
          status: hit.van.status,
        };
      }
    }
    const leadUser = directory.get(lead);
    crews.push({
      crew: "install",
      leadUserId: lead,
      leadName: String(row.display_name || leadUser?.display_name || "Lead"),
      leadUsername: leadUser?.username || null,
      memberUserIds: ids,
      leadActive: leadUser ? Number(leadUser.active) !== 0 : true,
      leadOnPto: (row.pto || []).length > 0,
      jobs: (row.jobs || []).map(toJob),
      van: chosen,
      vanAmbiguous,
    });
  }

  const dayClocked: Record<number, string> = {};
  try {
    const sessions = await db
      .prepare(
        `SELECT user_id, clock_in_at FROM fa_time_sessions WHERE clock_out_at IS NULL`
      )
      .all<{ user_id: number; clock_in_at: string | null }>();
    for (const row of sessions.results || []) {
      if (chicagoYmd(Date.parse(String(row.clock_in_at || "").includes("T") ? String(row.clock_in_at) : String(row.clock_in_at || "").replace(" ", "T") + "Z") || 0) === day) {
        dayClocked[Number(row.user_id)] = "fa_shop_session";
      }
    }
  } catch {
    /* shop clock optional */
  }
  const faArriveKeys: string[] = [];
  const faDispatchKeys: string[] = [];
  try {
    const punches = await db
      .prepare(
        `SELECT id, user_id, st_appointment_id, st_job_id, step
         FROM job_clock_events
         WHERE created_at >= datetime('now', '-2 days') OR id > 0
         ORDER BY id`
      )
      .all<{ id: number; user_id: number; st_appointment_id: string | null; st_job_id: string | null; step: string }>();
    const todayPunches = punches.results || [];
    for (const punch of todayPunches) {
      const step = String(punch.step || "").toLowerCase();
      if (step === "dispatch" || step === "arrive") dayClocked[Number(punch.user_id)] = dayClocked[Number(punch.user_id)] || "fa_job_punch";
    }
    for (const open of foldOpenJobSessions(todayPunches.map((punch) => ({
      id: punch.id,
      userId: Number(punch.user_id),
      apptId: punch.st_appointment_id,
      jobId: punch.st_job_id,
      step: punch.step,
    })))) {
      if (!open.open) continue;
      const key = `${open.userId}|${open.apptId}`;
      const last = [...todayPunches].reverse().find((punch) => Number(punch.user_id) === open.userId && String(punch.st_appointment_id || punch.st_job_id || "") === (open.apptId || open.jobId));
      if (String(last?.step || "").toLowerCase() === "arrive") faArriveKeys.push(key);
      else faDispatchKeys.push(key);
    }
  } catch {
    /* job punches optional */
  }

  if (geocoder === "census") {
    let looked = 0;
    for (const crew of crews) {
      for (const job of crew.jobs) {
        if (String(job.stPhase || "").toLowerCase() !== "dispatched") continue;
        const full = (board?.rows || [])
          .flatMap((row) => row.jobs || [])
          .find((row) => String(row.st_appointment_id) === job.apptId)?.address_full;
        if (!full) continue;
        if (looked >= 15) break;
        looked += 1;
        const point = await geocodeOne(db, full);
        if (point) {
          job.jobLat = point.lat;
          job.jobLng = point.lng;
        }
      }
    }
  }

  const positions: Record<number, OnsitePosition> = {};
  const needsGps = crews.some((crew) => {
    if (crew.vanAmbiguous || !crew.van || !onestepTracker(crew.van.gpsTracker)) return false;
    if (String(crew.van.status || "").toLowerCase().replace(/\s+/g, "_") === "out_of_service") return false;
    return crew.jobs.some((job) => String(job.stPhase || "").toLowerCase() === "dispatched" && job.jobLat != null && job.jobLng != null);
  });
  if (needsGps) {
    const ids = [...new Set(crews.map((crew) => Number(crew.van?.vehicleId)).filter((id) => id > 0))];
    try {
      const gps = await getOneStepPositionsForOnsite(env, ids);
      if (gps.error && !gps.positions.length) {
        /* planner will skip no_fresh_point; the pass itself logs gps_error below when a crew needed a point */
      }
      for (const pin of gps.positions) {
        if (pin.vehicle_id == null) continue;
        positions[Number(pin.vehicle_id)] = {
          lat: pin.lat,
          lng: pin.lng,
          speedMph: pin.speed_mph,
          pointAt: pin.last_update,
          provider: pin.provider,
          status: pin.status,
        };
      }
      if (mode === "dry") {
        for (const [id, pin] of Object.entries(positions)) {
          await db
            .prepare(
              `INSERT INTO fa_onsite_gps_samples (tick_at, vehicle_id, provider, point_at, lat, lng, speed_mph, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(now.toISOString(), Number(id), pin.provider || null, pin.pointAt || null, pin.lat, pin.lng, pin.speedMph ?? null, pin.status || null)
            .run();
        }
        if (prunedDay !== day) {
          prunedDay = day;
          await db.prepare(`DELETE FROM fa_onsite_gps_samples WHERE tick_at < datetime('now', '-14 days')`).run();
        }
      }
    } catch {
      /* GPS failure becomes no_fresh_point */
    }
  }

  const existing: OnsiteExisting[] = [];
  try {
    const rows = await db
      .prepare(
        `SELECT lead_user_id, appt_id, case_kind, first_seen_at, seen_ticks, last_seen_at, lead_at, lead_tick_count, chris_at, closed_at, resolved_at, resolved_by
         FROM fa_onsite_nudges WHERE chicago_day = ?`
      )
      .bind(day)
      .all<{
        lead_user_id: number;
        appt_id: string;
        case_kind: string | null;
        first_seen_at: string | null;
        seen_ticks: number | null;
        last_seen_at: string | null;
        lead_at: string | null;
        lead_tick_count: number | null;
        chris_at: string | null;
        closed_at: string | null;
        resolved_at: string | null;
        resolved_by: string | null;
      }>();
    for (const row of rows.results || []) {
      existing.push({
        leadUserId: Number(row.lead_user_id),
        apptId: String(row.appt_id),
        caseKind: row.case_kind,
        firstSeenAt: row.first_seen_at,
        seenTicks: row.seen_ticks,
        lastSeenAt: row.last_seen_at,
        leadAt: row.lead_at,
        leadTickCount: row.lead_tick_count,
        chrisAt: row.chris_at,
        closedAt: row.closed_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
      });
    }
  } catch {
    /* empty book */
  }

  const lateNudgedKeys: string[] = [];
  const lateOfficeAppts: string[] = [];
  try {
    const late = await db
      .prepare(
        `SELECT employee_id, appt_id, nudge_at, office_alert_at
         FROM fa_clockin_nudges
         WHERE chicago_day = ? AND nudge_type = 'late'`
      )
      .bind(day)
      .all<{ employee_id: number; appt_id: string; nudge_at: string | null; office_alert_at: string | null }>();
    const cutoff = now.getTime() - 10 * 60 * 1000;
    for (const row of late.results || []) {
      if (row.office_alert_at) lateOfficeAppts.push(String(row.appt_id));
      const nudged = Date.parse(String(row.nudge_at || "").includes("T") ? String(row.nudge_at) : String(row.nudge_at || "").replace(" ", "T") + "Z");
      if (Number.isFinite(nudged) && nudged >= cutoff) lateNudgedKeys.push(`${row.employee_id}|${row.appt_id}`);
    }
  } catch {
    /* late watch tables may not exist */
  }

  const leadSmsToday: Record<number, number> = {};
  let chrisToday = 0;
  try {
    const counts = await db
      .prepare(
        `SELECT kind, lead_user_id FROM fa_onsite_nudge_log
         WHERE chicago_day = ? AND status IN ('sent', 'would_send') AND kind IN ('lead', 'chris')`
      )
      .bind(day)
      .all<{ kind: string; lead_user_id: number | null }>();
    for (const row of counts.results || []) {
      if (row.kind === "chris") chrisToday += 1;
      if (row.kind === "lead" && Number(row.lead_user_id) > 0) {
        const id = Number(row.lead_user_id);
        leadSmsToday[id] = (leadSmsToday[id] || 0) + 1;
      }
    }
  } catch {
    /* no log yet */
  }

  const input: OnsitePlanInput = {
    now,
    mode,
    boardAgeMs,
    crews,
    dayClocked,
    faArriveKeys,
    faDispatchKeys,
    positions,
    existing,
    lateNudgedKeys,
    lateOfficeAppts,
    leadSmsToday,
    chrisToday,
    radiusM: radius,
    appBase:
      String(env.APP_BASE_URL || "").trim().replace(/\/$/, "") ||
      "https://total-assurance-fleet.totalassurance.workers.dev",
  };
  let planned: OnsiteAction[] = [];
  try {
    planned = planOnsiteTick(input).actions;
  } catch {
    return { mode, actions: [] };
  }

  for (const action of planned) {
    try {
      await applyAction(env, db, mode, day, action, directory);
    } catch {
      /* one action must not stop the pass */
    }
  }
  return { mode, actions: planned };
}

async function applyAction(
  env: Env,
  db: D1Database,
  mode: NudgeMode,
  day: string,
  action: OnsiteAction,
  users: Map<number, UserLite>
): Promise<void> {
  const nowIso = new Date().toISOString();
  if (action.kind === "skip") {
    const status = `skipped_${action.reason}`;
    const prior = await db
      .prepare(
        `SELECT id FROM fa_onsite_nudge_log
         WHERE chicago_day = ? AND kind = 'skip' AND status = ?
           AND ifnull(lead_user_id, 0) = ? AND ifnull(appt_id, '') = ?
         LIMIT 1`
      )
      .bind(day, status, Number(action.leadUserId || 0), String(action.apptId || ""))
      .first<{ id: number }>();
    if (prior) return;
    await writeLog(db, {
      day,
      kind: "skip",
      leadUserId: action.leadUserId,
      apptId: action.apptId,
      jobNumber: action.jobNumber,
      mode,
      status,
    });
    return;
  }

  if (action.kind === "seen") {
    await db
      .prepare(
        `INSERT INTO fa_onsite_nudges
          (lead_user_id, appt_id, chicago_day, case_kind, crew, job_number, street, first_seen_at, seen_ticks, last_seen_at, last_distance_m)
         VALUES (?, ?, ?, ?, 'install', ?, ?, ?, 1, ?, ?)
         ON CONFLICT(lead_user_id, appt_id, chicago_day) DO UPDATE SET
           seen_ticks = fa_onsite_nudges.seen_ticks + 1,
           first_seen_at = COALESCE(fa_onsite_nudges.first_seen_at, excluded.first_seen_at),
           last_seen_at = excluded.last_seen_at,
           last_distance_m = excluded.last_distance_m,
           case_kind = COALESCE(fa_onsite_nudges.case_kind, excluded.case_kind),
           job_number = COALESCE(fa_onsite_nudges.job_number, excluded.job_number),
           street = COALESCE(fa_onsite_nudges.street, excluded.street)`
      )
      .bind(action.leadUserId, action.apptId, day, action.caseKind, action.jobNumber || null, action.street || null, nowIso, nowIso, action.distanceM ?? null)
      .run();
    return;
  }

  if (action.kind === "tick") {
    await db
      .prepare(
        `UPDATE fa_onsite_nudges
         SET lead_tick_count = lead_tick_count + 1, last_seen_at = ?
         WHERE lead_user_id = ? AND appt_id = ? AND chicago_day = ?`
      )
      .bind(nowIso, action.leadUserId, action.apptId, day)
      .run();
    return;
  }

  if (action.kind === "reset") {
    await db
      .prepare(
        `UPDATE fa_onsite_nudges
         SET seen_ticks = 0, first_seen_at = NULL, resolved_by = 'left_site', last_seen_at = ?
         WHERE lead_user_id = ? AND appt_id = ? AND chicago_day = ? AND lead_at IS NULL AND closed_at IS NULL`
      )
      .bind(nowIso, action.leadUserId, action.apptId, day)
      .run();
    return;
  }

  if (action.kind === "close" || action.kind === "resolve") {
    await db
      .prepare(
        `INSERT INTO fa_onsite_nudges
          (lead_user_id, appt_id, chicago_day, crew, job_number, closed_at, resolved_at, resolved_by)
         VALUES (?, ?, ?, 'install', ?, ?, ?, ?)
         ON CONFLICT(lead_user_id, appt_id, chicago_day) DO UPDATE SET
           closed_at = COALESCE(fa_onsite_nudges.closed_at, excluded.closed_at),
           resolved_at = COALESCE(fa_onsite_nudges.resolved_at, excluded.resolved_at),
           resolved_by = excluded.resolved_by,
           job_number = COALESCE(fa_onsite_nudges.job_number, excluded.job_number)`
      )
      .bind(
        action.leadUserId,
        action.apptId,
        day,
        action.kind === "close" ? action.jobNumber || null : null,
        action.kind === "close" ? nowIso : null,
        nowIso,
        action.resolvedBy
      )
      .run();
    await writeLog(db, {
      day,
      kind: "resolve",
      leadUserId: action.leadUserId,
      apptId: action.apptId,
      jobNumber: action.kind === "close" ? action.jobNumber : null,
      mode,
      status: "resolved",
      body: action.resolvedBy,
    });
    return;
  }

  if (action.kind === "lead") {
    const guard = await db
      .prepare(
        `UPDATE fa_onsite_nudges
         SET lead_at = ?, case_kind = COALESCE(case_kind, ?)
         WHERE lead_user_id = ? AND appt_id = ? AND chicago_day = ? AND lead_at IS NULL AND closed_at IS NULL`
      )
      .bind(nowIso, action.caseKind, action.leadUserId, action.apptId, day)
      .run();
    if (Number(guard.meta?.changes || 0) !== 1) {
      await db
        .prepare(
          `INSERT INTO fa_onsite_nudges (lead_user_id, appt_id, chicago_day, case_kind, crew, job_number, street, lead_at)
           VALUES (?, ?, ?, ?, 'install', ?, ?, ?)
           ON CONFLICT(lead_user_id, appt_id, chicago_day) DO UPDATE SET
             lead_at = COALESCE(fa_onsite_nudges.lead_at, excluded.lead_at),
             case_kind = COALESCE(fa_onsite_nudges.case_kind, excluded.case_kind)`
        )
        .bind(action.leadUserId, action.apptId, day, action.caseKind, action.jobNumber || null, action.street || null, nowIso)
        .run();
      const again = await db
        .prepare(
          `SELECT lead_at FROM fa_onsite_nudges WHERE lead_user_id = ? AND appt_id = ? AND chicago_day = ? AND lead_at = ? AND closed_at IS NULL`
        )
        .bind(action.leadUserId, action.apptId, day, nowIso)
        .first<{ lead_at: string }>();
      if (!again) return;
    }
    const phone = normalizePhone(users.get(action.leadUserId)?.phone);
    const status = await deliverOnsite(env, db, {
      mode,
      day,
      kind: "lead",
      phone,
      userId: action.leadUserId,
      leadUserId: action.leadUserId,
      apptId: action.apptId,
      caseKind: action.caseKind,
      jobNumber: action.jobNumber || null,
      body: action.body,
      context: `onsite_nudge:lead:${action.leadUserId}:${action.apptId}`,
    });
    if (mode === "live" && status === "sent") {
      await notifyUsers(db, [action.leadUserId], "onsite_clock", "Fix your crew's job status", action.body, {
        type: "onsite_clock",
        id: action.apptId,
      });
    } else if (mode !== "live") {
      await writeLog(db, {
        day,
        kind: "lead_push",
        caseKind: action.caseKind,
        leadUserId: action.leadUserId,
        apptId: action.apptId,
        jobNumber: action.jobNumber,
        mode,
        status: "would_send",
        body: action.body,
      });
    }
    return;
  }

  if (action.kind === "chris") {
    const guard = await db
      .prepare(
        `UPDATE fa_onsite_nudges SET chris_at = ?
         WHERE lead_user_id = ? AND appt_id = ? AND chicago_day = ? AND chris_at IS NULL AND closed_at IS NULL`
      )
      .bind(nowIso, action.leadUserId, action.apptId, day)
      .run();
    if (Number(guard.meta?.changes || 0) !== 1) return;
    await deliverOnsite(env, db, {
      mode,
      day,
      kind: "chris",
      phone: CHRIS_PHONE,
      userId: null,
      leadUserId: action.leadUserId,
      apptId: action.apptId,
      caseKind: action.caseKind,
      jobNumber: action.jobNumber || null,
      body: action.body,
      context: `onsite_nudge:chris:${action.apptId}`,
    });
  }
}

export async function setOnsiteNudgeMode(db: D1Database, user: PublicUser | null, mode: string): Promise<{ ok: true; mode: string } | { error: string }> {
  if (mode !== "off" && mode !== "dry" && mode !== "live") return { error: "Mode must be off, dry, or live" };
  await setSetting(db, MODE_KEY, mode);
  await writeAudit(db, user, "update", "setting", null, "onsite_nudge_mode=" + mode);
  return { ok: true, mode };
}

export async function setOnsiteGeocoder(db: D1Database, user: PublicUser | null, geocoder: string): Promise<{ ok: true; geocoder: string } | { error: string }> {
  if (geocoder !== "off" && geocoder !== "census") return { error: "Geocoder must be off or census" };
  await setSetting(db, GEO_KEY, geocoder);
  await writeAudit(db, user, "update", "setting", null, "onsite_geocoder=" + geocoder);
  return { ok: true, geocoder };
}

export async function onsiteNudgeReport(env: Env, db: D1Database, daysRaw: number) {
  const days = Math.min(90, Math.max(1, Number(daysRaw) || 14));
  const mode = await onsiteNudgeMode(env, db);
  let radius = 150;
  let geocoder = "off";
  try {
    radius = Number(await getSetting(db, RADIUS_KEY, "150")) || 150;
    geocoder = (await getSetting(db, GEO_KEY, "off")) || "off";
  } catch {
    /* defaults */
  }
  const day = chicagoYmd(Date.now());
  const roster: Array<Record<string, unknown>> = [];
  try {
    const { dayBoardCacheKey, readDayBoardCache } = await import("./dayBoard");
    const hit = await readDayBoardCache(db, dayBoardCacheKey(day, "office", 0), 48 * 60 * 60 * 1000);
    for (const row of hit?.payload.rows || []) {
      roster.push({
        lead: row.display_name,
        user_id: row.user_id,
        crew: row.crew || "service",
        included: row.crew === "install",
        jobs: (row.jobs || []).length,
      });
    }
    roster.sort((a, b) => String(a.lead || "").localeCompare(String(b.lead || "")));
  } catch {
    /* board cache optional */
  }
  const empty = { mode, radius_m: radius, geocoder, roster, arrivals: [] as unknown[], today: [] as unknown[], by_lead: [] as unknown[], gps_cadence: [] as unknown[], skips: [] as unknown[] };
  try {
    await ensureOnsiteTables(db);
    const since = `-${days} days`;
    const arrivals = await db
      .prepare(
        `SELECT lead_user_id, appt_id, job_number, case_kind, lead_at, chris_at, closed_at, resolved_by
         FROM fa_onsite_nudges WHERE chicago_day = ? ORDER BY lead_user_id, appt_id`
      )
      .bind(day)
      .all();
    const today = await db
      .prepare(`SELECT * FROM fa_onsite_nudge_log WHERE chicago_day = ? ORDER BY id`)
      .bind(day)
      .all();
    const byLeadRows = await db
      .prepare(
        `SELECT lead_user_id,
                SUM(CASE WHEN case_kind = 'day_no_job' AND kind = 'lead' THEN 1 ELSE 0 END) AS case_a,
                SUM(CASE WHEN case_kind = 'dispatched_on_site' AND kind = 'lead' THEN 1 ELSE 0 END) AS case_b,
                SUM(CASE WHEN kind = 'chris' THEN 1 ELSE 0 END) AS chris_escalations,
                MAX(created_at) AS last_at
         FROM fa_onsite_nudge_log
         WHERE created_at >= datetime('now', ?) AND lead_user_id IS NOT NULL
         GROUP BY lead_user_id`
      )
      .bind(since)
      .all<{ lead_user_id: number; case_a: number; case_b: number; chris_escalations: number; last_at: string | null }>();
    const by_lead = (byLeadRows.results || [])
      .map((row) => ({
        name: String(roster.find((item) => item.user_id === row.lead_user_id)?.lead || row.lead_user_id),
        case_a: Number(row.case_a) || 0,
        case_b: Number(row.case_b) || 0,
        chris_escalations: Number(row.chris_escalations) || 0,
        last_at: row.last_at,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const samples = await db
      .prepare(
        `SELECT vehicle_id, point_at FROM fa_onsite_gps_samples
         WHERE tick_at >= datetime('now', '-14 days') AND point_at IS NOT NULL
         ORDER BY vehicle_id, point_at`
      )
      .all<{ vehicle_id: number; point_at: string }>();
    const gaps = new Map<number, number[]>();
    let prev: { vehicle_id: number; at: number } | null = null;
    for (const row of samples.results || []) {
      const at = Date.parse(String(row.point_at).includes("T") ? row.point_at : row.point_at.replace(" ", "T") + "Z");
      if (!Number.isFinite(at)) continue;
      if (prev && prev.vehicle_id === row.vehicle_id && row.point_at !== "") {
        const list = gaps.get(row.vehicle_id) || [];
        if (at > prev.at) list.push((at - prev.at) / 60000);
        gaps.set(row.vehicle_id, list);
      }
      prev = { vehicle_id: row.vehicle_id, at };
    }
    const gps_cadence = [...gaps.entries()].map(([vehicle_id, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length / 2)] || 0;
      return { vehicle_id, n: sorted.length + 1, median_gap_min: mid, max_gap_min: sorted[sorted.length - 1] || 0 };
    });
    const skipRows = await db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM fa_onsite_nudge_log
         WHERE kind = 'skip' AND created_at >= datetime('now', ?)
         GROUP BY status ORDER BY status`
      )
      .bind(since)
      .all();
    return {
      mode,
      radius_m: radius,
      geocoder,
      roster,
      arrivals: arrivals.results || [],
      today: today.results || [],
      by_lead,
      gps_cadence,
      skips: skipRows.results || [],
    };
  } catch {
    return empty;
  }
}
