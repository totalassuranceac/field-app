/**
 * Fleet Shop routes and D1 access. No SMS. Bell on a truck report goes to the reporter only.
 */
import { getSetting, setSetting, writeAudit } from "./audit";
import { chicagoYmd, formatChicagoTime, parseUtcLoose } from "./clockinNudgePlan";
import {
  ALLOWED_ENTRY_TYPES,
  ageTone,
  autoCloseAt,
  currentStage,
  entryTypeAllowed,
  hoursForDay,
  oilSeedAccepted,
  pmStatus,
  pmToCreate,
  queueSort,
  reliableOdometer,
  stageAge,
  stageTimeline,
  stepStats,
  validateAgeDays,
  type OdoReading,
  type PmType,
  type QueueItem,
  type StageInput,
} from "./fleetShopPlan";
import { catalogEntry } from "./issueCatalog";
import { notifyUsers } from "./notifications";
import { clockShopIn, clockShopOut } from "./shopClock";
import { ROLE_PERMS, roleAtLeast } from "./auth";
import type { PublicUser } from "./types";

const NOT_READY = "Run migration 111_fleet_shop.sql (after Chris says Y).";
let readyCache = false;

export async function fleetShopReady(db: D1Database): Promise<boolean> {
  if (readyCache) return true;
  try {
    const row = await db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'fleet_wo_stage_events'`)
      .first<{ ok: number }>();
    if (row?.ok) readyCache = true;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}

type Ctx = {
  env: { DB: D1Database };
  get: (key: "user") => PublicUser;
  req: {
    param: (name: string) => string;
    query: (name: string) => string | undefined;
    json: <T>() => Promise<T>;
    header: (name: string) => string | undefined;
  };
  json: (body: unknown, status?: number) => Response;
};

function deny(c: Ctx, roles: string[]): Response | null {
  const user = c.get("user");
  if (!user) return c.json({ error: "Sign in" }, 401);
  if (!roleAtLeast(user.role, roles as never)) return c.json({ error: "Not allowed" }, 403);
  return null;
}

async function chuckId(db: D1Database): Promise<number | null> {
  const named = await db
    .prepare(`SELECT id FROM users WHERE active = 1 AND lower(IFNULL(username,'')) = 'chuckdickerson' LIMIT 1`)
    .first<{ id: number }>();
  if (named?.id) return named.id;
  const mech = await db
    .prepare(`SELECT id FROM users WHERE active = 1 AND role = 'mechanic' ORDER BY id LIMIT 1`)
    .first<{ id: number }>();
  return mech?.id ?? null;
}

async function speedyId(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(`SELECT id FROM users WHERE active = 1 AND lower(IFNULL(username,'')) = 'speedy.marroquin' LIMIT 1`)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function fleetPeople(db: D1Database): Promise<{ chuck_user_id: number | null; speedy_user_id: number | null }> {
  return { chuck_user_id: await chuckId(db), speedy_user_id: await speedyId(db) };
}

async function closeStaleTimer(db: D1Database, userId: number): Promise<void> {
  const open = await db
    .prepare(`SELECT id, started_at, ended_at FROM fleet_wrench_segments WHERE user_id = ? AND ended_at IS NULL`)
    .bind(userId)
    .first<{ id: number; started_at: string; ended_at: string | null }>();
  if (!open) return;
  const closed = autoCloseAt(open, Date.now());
  if (!closed) return;
  await db
    .prepare(`UPDATE fleet_wrench_segments SET ended_at = ?, end_reason = 'auto_close' WHERE id = ? AND ended_at IS NULL`)
    .bind(closed.ended_at, open.id)
    .run();
}

async function loadReadings(db: D1Database, vehicleId: number): Promise<OdoReading[]> {
  const fuel = await db
    .prepare(
      `SELECT id, odometer, substr(COALESCE(fuel_date, created_at), 1, 10) AS date,
              ocr_needs_review, ocr_reviewed_at
       FROM fuel_entries WHERE vehicle_id = ?`
    )
    .bind(vehicleId)
    .all<OdoReading & { date: string }>();
  const insp = await db
    .prepare(
      `SELECT id, odometer, substr(COALESCE(created_at, ''), 1, 10) AS date
       FROM inspections WHERE vehicle_id = ? AND odometer > 0`
    )
    .bind(vehicleId)
    .all<{ id: number; odometer: number; date: string }>();
  const shop = await db
    .prepare(
      `SELECT id, odometer, substr(read_on, 1, 10) AS date, source
       FROM fleet_odometer_readings WHERE vehicle_id = ?`
    )
    .bind(vehicleId)
    .all<{ id: number; odometer: number; date: string; source: string }>();
  return [
    ...(fuel.results || []).map((r) => ({ ...r, source: "fuel" })),
    ...(insp.results || []).map((r) => ({ ...r, source: "inspection" as const })),
    ...(shop.results || []),
  ];
}

async function odoFor(db: D1Database, vehicleId: number, today: string) {
  const maxPerDay = Number(await getSetting(db, "fleet_shop_odo_max_miles_per_day", "400")) || 400;
  const slack = Number(await getSetting(db, "fleet_shop_odo_slack_miles", "300")) || 300;
  return reliableOdometer(await loadReadings(db, vehicleId), { maxPerDay, slack, todayCt: today });
}

const PM_FALLBACK: PmType[] = [
  { code: "oil", label: "Oil change", interval_miles: 5000, interval_days: null, soon_miles: 500, soon_days: 14, date_source: "interval", active: 1 },
  { code: "tires", label: "Tire rotation / check", interval_miles: 7500, interval_days: 182, soon_miles: 500, soon_days: 14, date_source: "interval", active: 1 },
  { code: "brakes", label: "Brake inspection", interval_miles: 15000, interval_days: 365, soon_miles: 1000, soon_days: 30, date_source: "interval", active: 1 },
  { code: "inspection", label: "State inspection", interval_miles: null, interval_days: null, soon_miles: 0, soon_days: 60, date_source: "inspection_expires", active: 1 },
  { code: "registration", label: "Registration", interval_miles: null, interval_days: null, soon_miles: 0, soon_days: 30, date_source: "registration_expires", active: 1 },
];

async function pmTypes(db: D1Database): Promise<PmType[]> {
  try {
    const rows = await db.prepare(`SELECT * FROM fleet_pm_types ORDER BY sort_order, code`).all<PmType>();
    if (rows.results?.length) return rows.results;
  } catch {
    /* table missing */
  }
  return PM_FALLBACK;
}

async function addStage(
  db: D1Database,
  issueId: number,
  stage: string,
  actor: number | null,
  source: string,
  note?: string | null
) {
  await db
    .prepare(
      `INSERT INTO fleet_wo_stage_events (issue_id, stage, at, actor_user_id, source, note)
       VALUES (?, ?, datetime('now'), ?, ?, ?)`
    )
    .bind(issueId, stage, actor, source, note || null)
    .run();
}

export async function syncPmWorkOrders(db: D1Database, opts: { force?: boolean } = {}): Promise<{ created: number }> {
  const autogen = await getSetting(db, "fleet_shop_pm_autogen", "1");
  if (autogen !== "1") return { created: 0 };
  if (!opts.force) {
    const last = await getSetting(db, "fleet_shop_pm_synced_at", "");
    const ms = last ? Date.parse(last.includes("T") ? last : last.replace(" ", "T") + "Z") : 0;
    if (ms && Date.now() - ms < 10 * 60 * 1000) return { created: 0 };
  }
  const today = chicagoYmd(Date.now());
  const types = (await pmTypes(db)).filter((t) => Number(t.active) !== 0);
  const vehicles = await db
    .prepare(
      `SELECT id, unit_number, status, current_odometer, registration_expires, inspection_expires
       FROM vehicles WHERE IFNULL(status, 'active') != 'retired'`
    )
    .all<{
      id: number;
      unit_number: string;
      status: string | null;
      current_odometer: number | null;
      registration_expires: string | null;
      inspection_expires: string | null;
    }>();
  const chuck = await chuckId(db);
  let created = 0;
  for (const vehicle of vehicles.results || []) {
    const odo = await odoFor(db, vehicle.id, today);
    for (const type of types) {
      const state = await db
        .prepare(`SELECT * FROM fleet_pm_vehicle WHERE vehicle_id = ? AND pm_code = ?`)
        .bind(vehicle.id, type.code)
        .first<{
          interval_miles: number | null;
          interval_days: number | null;
          last_done_date: string | null;
          last_done_odometer: number | null;
          active: number;
        }>();
      let useState = state;
      if (type.code === "oil" && !state) {
        const svc = await db
          .prepare(
            `SELECT odometer, substr(COALESCE(service_date, created_at), 1, 10) AS date
             FROM service_records WHERE vehicle_id = ? AND service_type = 'oil_change'
             ORDER BY date DESC, id DESC LIMIT 1`
          )
          .bind(vehicle.id)
          .first<{ odometer: number | null; date: string }>();
        const chain = (await loadReadings(db, vehicle.id))
          .filter((r) => Number(r.odometer) > 0)
          .map((r) => ({ date: String(r.date).slice(0, 10), odometer: Number(r.odometer) }));
        if (svc?.date && oilSeedAccepted({ date: svc.date, odometer: Number(svc.odometer) }, chain)) {
          await db
            .prepare(
              `INSERT OR IGNORE INTO fleet_pm_vehicle (vehicle_id, pm_code, last_done_date, last_done_odometer, active)
               VALUES (?, 'oil', ?, ?, 1)`
            )
            .bind(vehicle.id, svc.date, svc.odometer)
            .run();
          useState = {
            interval_miles: null,
            interval_days: null,
            last_done_date: svc.date,
            last_done_odometer: svc.odometer,
            active: 1,
          };
        }
      }
      const status = pmStatus(type, vehicle, useState, { odometer: odo.odometer, miles_per_day: odo.miles_per_day }, today);
      if (!pmToCreate([status]).length) continue;
      const key = `${vehicle.id}:${type.code}`;
      const open = await db
        .prepare(`SELECT issue_id FROM fleet_wo_meta WHERE pm_open_key = ?`)
        .bind(key)
        .first<{ issue_id: number }>();
      const severity = status.status === "overdue" ? "high" : "low";
      if (open?.issue_id) {
        await db
          .prepare(`UPDATE fleet_wo_meta SET due_reason = ?, due_odometer = ?, due_date = ?, updated_at = datetime('now') WHERE issue_id = ?`)
          .bind(status.reason, status.due_odometer, status.due_date, open.issue_id)
          .run();
        if (severity === "high") {
          await db
            .prepare(
              `UPDATE vehicle_issues SET severity = 'high', updated_at = datetime('now')
               WHERE id = ? AND severity IN ('low', 'medium')`
            )
            .bind(open.issue_id)
            .run();
        }
        continue;
      }
      if (!chuck) continue;
      try {
        const ins = await db
          .prepare(
            `INSERT INTO vehicle_issues
              (vehicle_id, reported_by_user_id, severity, title, description, origin, status)
             VALUES (?, ?, ?, ?, ?, 'pm', 'open')`
          )
          .bind(vehicle.id, chuck, severity, `PM: ${type.label}`, status.reason)
          .run();
        const issueId = Number(ins.meta.last_row_id);
        await db
          .prepare(
            `INSERT INTO fleet_wo_meta
              (issue_id, vehicle_id, kind, pm_code, pm_open_key, due_odometer, due_date, due_reason, source)
             VALUES (?, ?, 'pm', ?, ?, ?, ?, ?, 'pm_auto')`
          )
          .bind(issueId, vehicle.id, type.code, key, status.due_odometer, status.due_date, status.reason)
          .run();
        await addStage(db, issueId, "reported", chuck, "pm_auto", status.reason);
        created += 1;
      } catch {
        /* unique pm_open_key: already open */
      }
    }
  }
  await setSetting(db, "fleet_shop_pm_synced_at", new Date().toISOString());
  return { created };
}

async function openTimer(db: D1Database, userId: number) {
  return db
    .prepare(`SELECT * FROM fleet_wrench_segments WHERE user_id = ? AND ended_at IS NULL`)
    .bind(userId)
    .first<{ id: number; issue_id: number | null; entry_type: string; category: string | null; started_at: string }>();
}

function ctClock(raw: string | null | undefined): string {
  const ms = parseUtcLoose(raw || "");
  if (ms == null) return "";
  return `${formatChicagoTime(ms)} CT`;
}

export function mountFleetShop(api: {
  get: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  post: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  put: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  patch: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  delete: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
}): void {
  const ready = async (c: Ctx) => {
    if (await fleetShopReady(c.env.DB)) return null;
    return c.json({ error: NOT_READY }, 503);
  };

  api.get("/fleet-shop/config", async (c) => {
    const user = c.get("user");
    const db = c.env.DB;
    const on = await fleetShopReady(db);
    const people = on ? await fleetPeople(db) : { chuck_user_id: null, speedy_user_id: null };
    const age = on ? await getSetting(db, "fleet_shop_age_days", "") : "";
    const parsed = validateAgeDays(age || null);
    return c.json({
      ready: on,
      can: {
        view: roleAtLeast(user.role, ROLE_PERMS.viewFleetShop),
        work: roleAtLeast(user.role, ROLE_PERMS.workFleetShop),
        pm: roleAtLeast(user.role, ROLE_PERMS.managePm),
        board: roleAtLeast(user.role, ROLE_PERMS.viewFleetBoard),
        report: roleAtLeast(user.role, ROLE_PERMS.reportTruckProblem),
        settings: roleAtLeast(user.role, ROLE_PERMS.manageFleetShopSettings),
      },
      chuck_user_id: people.chuck_user_id,
      speedy_user_id: people.speedy_user_id,
      age_days: parsed.ok ? parsed.value : (validateAgeDays(null) as { ok: true; value: Record<string, [number, number]> }).value,
      stats_window_days: Number(on ? await getSetting(db, "fleet_shop_stats_window_days", "90") : 90) || 90,
      entry_types: ALLOWED_ENTRY_TYPES,
    });
  });

  api.get("/fleet-shop/queue", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.viewFleetShop);
    if (blocked) return blocked;
    const db = c.env.DB;
    const user = c.get("user");
    await closeStaleTimer(db, user.id);
    await syncPmWorkOrders(db);
    const today = chicagoYmd(Date.now());
    const rows = await db
      .prepare(
        `SELECT i.*, v.unit_number, v.year, v.make, v.model, v.current_odometer,
                u.display_name AS reporter_name, m.kind, m.pm_code, m.truck_down, m.due_reason, m.source AS meta_source
         FROM vehicle_issues i
         JOIN vehicles v ON v.id = i.vehicle_id
         JOIN users u ON u.id = i.reported_by_user_id
         LEFT JOIN fleet_wo_meta m ON m.issue_id = i.id
         WHERE i.status IN ('open', 'scheduled', 'in_progress')
         ORDER BY i.created_at ASC`
      )
      .all<Record<string, unknown>>();
    const ageRaw = validateAgeDays(await getSetting(db, "fleet_shop_age_days", ""));
    const thresholds = ageRaw.ok ? ageRaw.value : { reported: [2, 5] as [number, number], scheduled: [3, 7] as [number, number], waiting_parts: [3, 7] as [number, number], in_progress: [2, 5] as [number, number], open_total: [7, 14] as [number, number] };
    const now = Date.now();
    const items = [];
    for (const row of rows.results || []) {
      const id = Number(row.id);
      const tl = stageTimeline({
        issue: {
          id,
          status: String(row.status),
          created_at: String(row.created_at),
          scheduled_date: row.scheduled_date ? String(row.scheduled_date) : null,
          completed_at: row.completed_at ? String(row.completed_at) : null,
        },
      });
      const timer = await openTimer(db, user.id);
      const runningHere = timer?.issue_id === id;
      const cur = currentStage(tl, String(row.status), runningHere ? "running" : String(row.status) === "in_progress" ? "paused" : "none");
      const age = stageAge(tl, cur.stage, now);
      const createdMs = parseUtcLoose(String(row.created_at)) || now;
      const pm = String(row.kind || "") === "pm" ? (String(row.due_reason || "").toLowerCase().includes("overdue") ? "overdue" : "due_soon") : null;
      const sortItem: QueueItem = {
        is_emergency: Number(row.is_emergency) === 1,
        severity: String(row.severity || "medium"),
        truck_down: Number(row.truck_down) === 1,
        pm_status: pm as QueueItem["pm_status"],
        in_progress: String(row.status) === "in_progress",
        created_at: String(row.created_at),
      };
      items.push({
        ...row,
        sort: sortItem,
        current_stage: cur.stage,
        stage_sub: cur.sub,
        stage_days: age.days,
        age_basis: age.age_basis,
        open_days: age.open_days,
        age_tone: ageTone(cur.stage, age.days, age.open_days, thresholds as Record<string, [number, number]>),
        chip_new: now - createdMs < 24 * 3600000,
        reported_ct: ctClock(String(row.created_at)),
        reliable_odometer: (await odoFor(db, Number(row.vehicle_id), today)).odometer,
      });
    }
    items.sort((a, b) => queueSort(a.sort, b.sort));
    const timer = await openTimer(db, user.id);
    return c.json({ queue: items, open_timer: timer, today });
  });

  api.post("/fleet-shop/pm/sync", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const result = await syncPmWorkOrders(c.env.DB, { force: true });
    await writeAudit(c.env.DB, c.get("user"), "update", "fleet_pm", "sync", `PM sync created ${result.created}`);
    return c.json(result);
  });

  api.get("/fleet-shop/vehicles", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.viewFleetShop);
    if (blocked) return blocked;
    const today = chicagoYmd(Date.now());
    const vehicles = await c.env.DB
      .prepare(
        `SELECT id, unit_number, year, make, model, status, current_odometer, registration_expires, inspection_expires
         FROM vehicles WHERE IFNULL(status,'active') != 'retired' ORDER BY unit_number`
      )
      .all<Record<string, unknown>>();
    const types = await pmTypes(c.env.DB);
    const out = [];
    for (const vehicle of vehicles.results || []) {
      const odo = await odoFor(c.env.DB, Number(vehicle.id), today);
      let worst = "ok";
      for (const type of types) {
        const state = await c.env.DB
          .prepare(`SELECT * FROM fleet_pm_vehicle WHERE vehicle_id = ? AND pm_code = ?`)
          .bind(vehicle.id, type.code)
          .first();
        const st = pmStatus(type, vehicle as never, state as never, { odometer: odo.odometer, miles_per_day: odo.miles_per_day }, today);
        if (st.status === "overdue") worst = "overdue";
        else if (st.status === "due_soon" && worst !== "overdue") worst = "due_soon";
        else if (st.status === "unknown" && worst === "ok") worst = "unknown";
      }
      const open = await c.env.DB
        .prepare(`SELECT COUNT(*) AS n FROM vehicle_issues WHERE vehicle_id = ? AND status IN ('open','scheduled','in_progress')`)
        .bind(vehicle.id)
        .first<{ n: number }>();
      const mismatch =
        odo.odometer != null && vehicle.current_odometer != null && Math.abs(Number(vehicle.current_odometer) - odo.odometer) > 1000;
      out.push({ ...vehicle, odometer: odo, pm_worst: worst, open_wo_count: open?.n || 0, fleet_units_mismatch: mismatch });
    }
    return c.json({ vehicles: out, today });
  });

  api.get("/fleet-shop/vehicles/:id", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.viewFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const today = chicagoYmd(Date.now());
    const vehicle = await c.env.DB.prepare(`SELECT * FROM vehicles WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    if (!vehicle) return c.json({ error: "Not found" }, 404);
    const odo = await odoFor(c.env.DB, id, today);
    const types = await pmTypes(c.env.DB);
    const pm = [];
    for (const type of types) {
      const state = await c.env.DB.prepare(`SELECT * FROM fleet_pm_vehicle WHERE vehicle_id = ? AND pm_code = ?`).bind(id, type.code).first();
      const st = pmStatus(type, vehicle as never, state as never, { odometer: odo.odometer, miles_per_day: odo.miles_per_day }, today);
      pm.push({ type, state, status: st });
    }
    const history = await c.env.DB
      .prepare(
        `SELECT i.id, i.title, i.status, i.completed_at, i.work_performed, i.parts_used, i.labor_hours, u.display_name AS done_by
         FROM vehicle_issues i
         LEFT JOIN users u ON u.id = i.completed_by_user_id
         WHERE i.vehicle_id = ? AND i.status IN ('completed','cancelled')
         ORDER BY COALESCE(i.completed_at, i.created_at) DESC LIMIT 40`
      )
      .bind(id)
      .all();
    const service = await c.env.DB.prepare(`SELECT * FROM service_records WHERE vehicle_id = ? ORDER BY id DESC LIMIT 20`).bind(id).all();
    const downtime = await c.env.DB.prepare(`SELECT * FROM downtime_events WHERE vehicle_id = ? ORDER BY id DESC LIMIT 20`).bind(id).all();
    const open = await c.env.DB
      .prepare(`SELECT * FROM vehicle_issues WHERE vehicle_id = ? AND status IN ('open','scheduled','in_progress') ORDER BY id DESC`)
      .bind(id)
      .all();
    return c.json({
      vehicle,
      odometer: odo,
      pm,
      open_work_orders: open.results || [],
      history: history.results || [],
      service_records: service.results || [],
      downtime: downtime.results || [],
      fleet_units_says: vehicle.current_odometer ?? null,
    });
  });

  api.post("/fleet-shop/vehicles/:id/odometer", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ odometer?: number; photo_key?: string; note?: string }>();
    const odo = Number(body.odometer);
    if (!Number.isFinite(odo) || odo <= 0) return c.json({ error: "Odometer must be greater than 0" }, 400);
    const today = chicagoYmd(Date.now());
    const user = c.get("user");
    const ins = await c.env.DB
      .prepare(
        `INSERT INTO fleet_odometer_readings (vehicle_id, odometer, read_on, source, user_id, photo_key, note)
         VALUES (?, ?, ?, 'shop_confirm', ?, ?, ?)`
      )
      .bind(id, odo, today, user.id, body.photo_key || null, body.note || null)
      .run();
    await writeAudit(c.env.DB, user, "create", "fleet_odometer", ins.meta.last_row_id, `Dash reading ${odo} on vehicle ${id}`);
    return c.json({ id: ins.meta.last_row_id, odometer: odo, read_on: today }, 201);
  });

  api.put("/fleet-shop/vehicles/:id/pm/:code", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.managePm);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const code = c.req.param("code");
    const body = await c.req.json<Record<string, unknown>>();
    const user = c.get("user");
    await c.env.DB
      .prepare(
        `INSERT INTO fleet_pm_vehicle (vehicle_id, pm_code, interval_miles, interval_days, last_done_date, last_done_odometer, active, notes, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(vehicle_id, pm_code) DO UPDATE SET
           interval_miles = COALESCE(excluded.interval_miles, fleet_pm_vehicle.interval_miles),
           interval_days = COALESCE(excluded.interval_days, fleet_pm_vehicle.interval_days),
           last_done_date = COALESCE(excluded.last_done_date, fleet_pm_vehicle.last_done_date),
           last_done_odometer = COALESCE(excluded.last_done_odometer, fleet_pm_vehicle.last_done_odometer),
           active = COALESCE(excluded.active, fleet_pm_vehicle.active),
           notes = COALESCE(excluded.notes, fleet_pm_vehicle.notes),
           updated_at = datetime('now'),
           updated_by_user_id = excluded.updated_by_user_id`
      )
      .bind(
        id,
        code,
        body.interval_miles ?? null,
        body.interval_days ?? null,
        body.last_done_date ?? null,
        body.last_done_odometer ?? null,
        body.active == null ? 1 : body.active ? 1 : 0,
        body.notes ?? null,
        user.id
      )
      .run();
    await writeAudit(c.env.DB, user, "update", "fleet_pm", `${id}:${code}`, `PM ${code} updated`);
    return c.json({ ok: true });
  });

  api.get("/fleet-shop/pm-types", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.viewFleetShop);
    if (blocked) return blocked;
    return c.json({ types: await pmTypes(c.env.DB) });
  });

  api.put("/fleet-shop/pm-types", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.managePm);
    if (blocked) return blocked;
    const body = await c.req.json<{ code?: string; label?: string; interval_miles?: number | null; interval_days?: number | null; soon_miles?: number; soon_days?: number; active?: number }>();
    if (!body.code || !PM_FALLBACK.some((t) => t.code === body.code)) return c.json({ error: "Unknown PM code" }, 400);
    await c.env.DB
      .prepare(
        `UPDATE fleet_pm_types SET label = COALESCE(?, label), interval_miles = ?, interval_days = ?,
         soon_miles = COALESCE(?, soon_miles), soon_days = COALESCE(?, soon_days), active = COALESCE(?, active),
         updated_at = datetime('now'), updated_by_user_id = ? WHERE code = ?`
      )
      .bind(
        body.label ?? null,
        body.interval_miles ?? null,
        body.interval_days ?? null,
        body.soon_miles ?? null,
        body.soon_days ?? null,
        body.active ?? null,
        c.get("user").id,
        body.code
      )
      .run();
    await writeAudit(c.env.DB, c.get("user"), "update", "fleet_pm", body.code, `PM type ${body.code} updated`);
    return c.json({ ok: true, types: await pmTypes(c.env.DB) });
  });

  api.post("/fleet-shop/report", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.reportTruckProblem);
    if (blocked) return blocked;
    const user = c.get("user");
    const body = await c.req.json<{
      vehicle_id?: number;
      issue_category?: string;
      note?: string;
      photo_key?: string;
      truck_down?: boolean;
      client_uuid?: string;
    }>();
    const vehicleId = Number(body.vehicle_id);
    const cat = catalogEntry(body.issue_category);
    if (!vehicleId || !cat) return c.json({ error: "Pick a truck and what is wrong" }, 400);
    const vehicle = await c.env.DB
      .prepare(`SELECT id, unit_number, status FROM vehicles WHERE id = ?`)
      .bind(vehicleId)
      .first<{ id: number; unit_number: string; status: string | null }>();
    if (!vehicle || vehicle.status === "retired") return c.json({ error: "Pick an active truck" }, 400);
    const uuid = String(body.client_uuid || "").trim();
    if (uuid) {
      const prior = await c.env.DB
        .prepare(`SELECT entity_id FROM audit_logs WHERE entity_type = 'fleet_wo' AND summary = ? LIMIT 1`)
        .bind(`client_uuid=${uuid}`)
        .first<{ entity_id: string }>();
      if (prior?.entity_id) {
        const issue = await c.env.DB.prepare(`SELECT * FROM vehicle_issues WHERE id = ?`).bind(prior.entity_id).first();
        return c.json({ issue, duplicate: true, id: Number(prior.entity_id) });
      }
    }
    const truckDown = body.truck_down ? 1 : 0;
    const severity = truckDown ? "critical" : cat.severity;
    const emergency = truckDown || cat.emergency ? 1 : 0;
    const title = cat.label;
    const ins = await c.env.DB
      .prepare(
        `INSERT INTO vehicle_issues
          (vehicle_id, reported_by_user_id, severity, title, description, photo_key, issue_category, is_emergency, origin, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'driver', 'open')`
      )
      .bind(vehicleId, user.id, severity, title, (body.note || "").slice(0, 200) || null, body.photo_key || null, cat.value, emergency)
      .run();
    const id = Number(ins.meta.last_row_id);
    await c.env.DB
      .prepare(
        `INSERT INTO fleet_wo_meta (issue_id, vehicle_id, kind, truck_down, source)
         VALUES (?, ?, 'repair', ?, 'tech_report')`
      )
      .bind(id, vehicleId, truckDown)
      .run();
    await addStage(c.env.DB, id, "reported", user.id, "tech_report", body.note || null);
    if (truckDown) {
      await c.env.DB
        .prepare(
          `INSERT INTO downtime_events (vehicle_id, issue_id, reason, started_at, started_by_user_id, notes)
           VALUES (?, ?, ?, datetime('now'), ?, ?)`
        )
        .bind(vehicleId, id, title, user.id, body.note || null)
        .run();
      await c.env.DB.prepare(`UPDATE vehicles SET status = 'out_of_service', updated_at = datetime('now') WHERE id = ?`).bind(vehicleId).run();
    }
    await writeAudit(c.env.DB, user, "create", "fleet_wo", id, uuid ? `client_uuid=${uuid}` : `Truck problem ${vehicle.unit_number}`);
    await notifyUsers(c.env.DB, [user.id], "truck_problem_sent", `Sent to the shop - WO #${id}`, `Unit ${vehicle.unit_number}: ${title}`, {
      type: "vehicle_issue",
      id,
    });
    return c.json(
      {
        id,
        issue_id: id,
        message: truckDown ? "Marked down. Call the shop if you are stuck on the road." : "Sent to the shop.",
      },
      201
    );
  });

  api.post("/fleet-shop/wo", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const user = c.get("user");
    const body = await c.req.json<{ vehicle_id?: number; title?: string; description?: string; severity?: string; truck_down?: boolean }>();
    const title = String(body.title || "").trim();
    if (!body.vehicle_id || !title) return c.json({ error: "Truck and title are required" }, 400);
    const severity = ["low", "medium", "high", "critical"].includes(String(body.severity)) ? String(body.severity) : "medium";
    const ins = await c.env.DB
      .prepare(
        `INSERT INTO vehicle_issues (vehicle_id, reported_by_user_id, severity, title, description, origin, status, is_emergency)
         VALUES (?, ?, ?, ?, ?, 'shop', 'open', ?)`
      )
      .bind(body.vehicle_id, user.id, severity, title, body.description || null, severity === "critical" ? 1 : 0)
      .run();
    const id = Number(ins.meta.last_row_id);
    await c.env.DB
      .prepare(`INSERT INTO fleet_wo_meta (issue_id, vehicle_id, kind, truck_down, source) VALUES (?, ?, 'repair', ?, 'fleet_shop')`)
      .bind(id, body.vehicle_id, body.truck_down ? 1 : 0)
      .run();
    await addStage(c.env.DB, id, "reported", user.id, "fleet_shop");
    await writeAudit(c.env.DB, user, "create", "fleet_wo", id, `WO #${id} ${title}`);
    return c.json({ id }, 201);
  });

  api.get("/fleet-shop/wo/:id", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.viewFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const issue = await c.env.DB
      .prepare(
        `SELECT i.*, v.unit_number, v.year, v.make, v.model, v.current_odometer, u.display_name AS reporter_name
         FROM vehicle_issues i JOIN vehicles v ON v.id = i.vehicle_id
         JOIN users u ON u.id = i.reported_by_user_id WHERE i.id = ?`
      )
      .bind(id)
      .first<Record<string, unknown>>();
    if (!issue) return c.json({ error: "Not found" }, 404);
    const meta = await c.env.DB.prepare(`SELECT * FROM fleet_wo_meta WHERE issue_id = ?`).bind(id).first();
    const events = await c.env.DB.prepare(`SELECT * FROM fleet_wo_stage_events WHERE issue_id = ? ORDER BY id`).bind(id).all();
    const segments = await c.env.DB.prepare(`SELECT * FROM fleet_wrench_segments WHERE issue_id = ? ORDER BY started_at`).bind(id).all();
    const parts = await c.env.DB.prepare(`SELECT * FROM fleet_wo_parts WHERE issue_id = ? AND removed_at IS NULL ORDER BY id`).bind(id).all();
    const notes = await c.env.DB.prepare(`SELECT n.*, u.display_name FROM fleet_wo_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.issue_id = ? ORDER BY n.id`).bind(id).all();
    const photos = await c.env.DB.prepare(`SELECT * FROM fleet_wo_photos WHERE issue_id = ? AND removed_at IS NULL ORDER BY id`).bind(id).all();
    const orders = await c.env.DB.prepare(`SELECT * FROM parts_order_requests WHERE issue_id = ?`).bind(id).all();
    const audits = await c.env.DB
      .prepare(
        `SELECT created_at, user_id, json_extract(after_json, '$.status') AS after_status
         FROM audit_logs WHERE entity_type = 'vehicle_issue' AND entity_id = ? AND action = 'update'`
      )
      .bind(String(id))
      .all<{ created_at: string; user_id: number | null; after_status: string | null }>();
    const timeline = stageTimeline({
      issue: {
        id,
        status: String(issue.status),
        created_at: String(issue.created_at),
        scheduled_date: issue.scheduled_date ? String(issue.scheduled_date) : null,
        completed_at: issue.completed_at ? String(issue.completed_at) : null,
      },
      stage_events: (events.results || []) as StageInput["stage_events"],
      audits: audits.results || [],
      orders: ((orders.results || []) as { status: string; ordered_at?: string; received_at?: string }[]),
      segments: ((segments.results || []) as { started_at: string }[]),
    });
    const timer = await openTimer(c.env.DB, c.get("user").id);
    const cur = currentStage(timeline, String(issue.status), timer?.issue_id === id ? "running" : String(issue.status) === "in_progress" ? "paused" : "none");
    const age = stageAge(timeline, cur.stage, Date.now());
    const today = chicagoYmd(Date.now());
    const odo = await odoFor(c.env.DB, Number(issue.vehicle_id), today);
    return c.json({ issue, meta, timeline, current: cur, age, segments: segments.results || [], parts: parts.results || [], notes: notes.results || [], photos: photos.results || [], orders: orders.results || [], odometer: odo });
  });

  api.patch("/fleet-shop/wo/:id", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const body = await c.req.json<Record<string, unknown>>();
    const issue = await c.env.DB.prepare(`SELECT * FROM vehicle_issues WHERE id = ?`).bind(id).first<{ id: number; vehicle_id: number; title: string }>();
    if (!issue) return c.json({ error: "Not found" }, 404);
    const meta = await c.env.DB.prepare(`SELECT truck_down FROM fleet_wo_meta WHERE issue_id = ?`).bind(id).first<{ truck_down: number }>();
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const key of ["severity", "title", "description", "completion_notes", "work_performed"] as const) {
      if (body[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(body[key]);
      }
    }
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      await c.env.DB.prepare(`UPDATE vehicle_issues SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
    }
    if (body.truck_down != null) {
      const next = body.truck_down ? 1 : 0;
      const prev = Number(meta?.truck_down || 0);
      await c.env.DB.prepare(`UPDATE fleet_wo_meta SET truck_down = ?, updated_at = datetime('now') WHERE issue_id = ?`).bind(next, id).run();
      if (prev === 0 && next === 1) {
        await c.env.DB
          .prepare(`INSERT INTO downtime_events (vehicle_id, issue_id, reason, started_at, started_by_user_id) VALUES (?, ?, ?, datetime('now'), ?)`)
          .bind(issue.vehicle_id, id, issue.title, c.get("user").id)
          .run();
        await c.env.DB.prepare(`UPDATE vehicles SET status = 'out_of_service', updated_at = datetime('now') WHERE id = ?`).bind(issue.vehicle_id).run();
      }
      if (prev === 1 && next === 0) {
        await c.env.DB
          .prepare(`UPDATE downtime_events SET ended_at = datetime('now'), ended_by_user_id = ? WHERE vehicle_id = ? AND issue_id = ? AND ended_at IS NULL`)
          .bind(c.get("user").id, issue.vehicle_id, id)
          .run();
        const still = await c.env.DB.prepare(`SELECT id FROM downtime_events WHERE vehicle_id = ? AND ended_at IS NULL LIMIT 1`).bind(issue.vehicle_id).first();
        if (!still) await c.env.DB.prepare(`UPDATE vehicles SET status = 'active', updated_at = datetime('now') WHERE id = ?`).bind(issue.vehicle_id).run();
      }
    }
    await writeAudit(c.env.DB, c.get("user"), "update", "fleet_wo", id, `Updated WO #${id}`);
    return c.json({ ok: true });
  });

  api.post("/fleet-shop/wo/:id/schedule", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ date?: string | null }>();
    const user = c.get("user");
    if (body.date) {
      await c.env.DB.prepare(`UPDATE vehicle_issues SET status = 'scheduled', scheduled_date = ?, updated_at = datetime('now') WHERE id = ?`).bind(body.date, id).run();
      await addStage(c.env.DB, id, "scheduled", user.id, "fleet_shop", body.date);
    } else {
      await c.env.DB.prepare(`UPDATE vehicle_issues SET status = 'open', scheduled_date = NULL, updated_at = datetime('now') WHERE id = ?`).bind(id).run();
      await addStage(c.env.DB, id, "unscheduled", user.id, "fleet_shop");
    }
    await writeAudit(c.env.DB, user, "update", "fleet_wo", id, body.date ? `Scheduled ${body.date}` : "Unscheduled");
    return c.json({ ok: true });
  });

  async function endOpen(db: D1Database, userId: number, reason: string) {
    const open = await openTimer(db, userId);
    if (!open) return;
    await db
      .prepare(`UPDATE fleet_wrench_segments SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`)
      .bind(new Date().toISOString(), reason, open.id)
      .run();
  }

  api.post("/fleet-shop/wo/:id/start", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const user = c.get("user");
    const body = await c.req.json<{ odometer_in?: number; client_uuid?: string }>();
    const uuid = String(body.client_uuid || "").trim() || null;
    if (uuid) {
      const prior = await c.env.DB.prepare(`SELECT id FROM fleet_wrench_segments WHERE client_uuid = ?`).bind(uuid).first<{ id: number }>();
      if (prior) return c.json({ ok: true, duplicate: true, segment_id: prior.id });
    }
    await closeStaleTimer(c.env.DB, user.id);
    await endOpen(c.env.DB, user.id, "switch");
    const started = new Date().toISOString();
    const ins = await c.env.DB
      .prepare(
        `INSERT INTO fleet_wrench_segments (user_id, entry_type, issue_id, started_at, client_uuid)
         VALUES (?, 'work_order', ?, ?, ?)`
      )
      .bind(user.id, id, started, uuid)
      .run();
    const issue = await c.env.DB.prepare(`SELECT status, vehicle_id FROM vehicle_issues WHERE id = ?`).bind(id).first<{ status: string; vehicle_id: number }>();
    const priorStart = await c.env.DB.prepare(`SELECT id FROM fleet_wo_stage_events WHERE issue_id = ? AND stage = 'started' LIMIT 1`).bind(id).first();
    await c.env.DB.prepare(`UPDATE vehicle_issues SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`).bind(id).run();
    await addStage(c.env.DB, id, priorStart ? "resumed" : "started", user.id, "fleet_shop");
    if (body.odometer_in && body.odometer_in > 0) {
      await c.env.DB.prepare(`UPDATE fleet_wo_meta SET odometer_in = ?, updated_at = datetime('now') WHERE issue_id = ?`).bind(body.odometer_in, id).run();
      await c.env.DB
        .prepare(`INSERT INTO fleet_odometer_readings (vehicle_id, odometer, read_on, source, issue_id, user_id) VALUES (?, ?, ?, 'wo_in', ?, ?)`)
        .bind(issue?.vehicle_id, body.odometer_in, chicagoYmd(Date.now()), id, user.id)
        .run();
    }
    await writeAudit(c.env.DB, user, "update", "fleet_segment", ins.meta.last_row_id, `Start WO #${id}`);
    return c.json({ ok: true, segment_id: ins.meta.last_row_id });
  });

  api.post("/fleet-shop/wo/:id/pause", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const user = c.get("user");
    await endOpen(c.env.DB, user.id, "pause");
    await addStage(c.env.DB, id, "paused", user.id, "fleet_shop");
    await writeAudit(c.env.DB, user, "update", "fleet_wo", id, `Paused WO #${id}`);
    return c.json({ ok: true });
  });

  api.post("/fleet-shop/wo/:id/done", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const user = c.get("user");
    const body = await c.req.json<{ work_performed?: string; odometer_out?: number; new_expires?: string }>();
    const issue = await c.env.DB.prepare(`SELECT * FROM vehicle_issues WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    if (!issue) return c.json({ error: "Not found" }, 404);
    const correction = String(body.work_performed || issue.work_performed || "").trim();
    if (!correction) return c.json({ error: "Enter what you did (Correction) before Done" }, 400);
    await endOpen(c.env.DB, user.id, "done");
    const segs = await c.env.DB.prepare(`SELECT started_at, ended_at FROM fleet_wrench_segments WHERE issue_id = ?`).bind(id).all<{ started_at: string; ended_at: string | null }>();
    let minutes = 0;
    for (const seg of segs.results || []) {
      const a = parseUtcLoose(seg.started_at) || 0;
      const b = seg.ended_at ? parseUtcLoose(seg.ended_at) || Date.now() : Date.now();
      if (b > a) minutes += (b - a) / 60000;
    }
    const labor = Math.round((minutes / 60) * 100) / 100;
    const partRows = await c.env.DB.prepare(`SELECT qty, description, part_number FROM fleet_wo_parts WHERE issue_id = ? AND removed_at IS NULL`).bind(id).all<{ qty: number; description: string; part_number: string | null }>();
    const partsUsed = (partRows.results || [])
      .map((p) => `${p.qty} x ${p.description}${p.part_number ? ` (${p.part_number})` : ""}`)
      .join("; ");
    await c.env.DB
      .prepare(
        `UPDATE vehicle_issues SET status = 'completed', completed_at = datetime('now'), completed_by_user_id = ?,
         work_performed = ?, labor_hours = ?, parts_used = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(user.id, correction, labor, partsUsed || null, id)
      .run();
    const meta = await c.env.DB.prepare(`SELECT * FROM fleet_wo_meta WHERE issue_id = ?`).bind(id).first<{ kind: string; pm_code: string | null; vehicle_id: number; pm_open_key: string | null }>();
    const today = chicagoYmd(Date.now());
    if (body.odometer_out && body.odometer_out > 0) {
      await c.env.DB.prepare(`UPDATE fleet_wo_meta SET odometer_out = ?, pm_open_key = NULL, updated_at = datetime('now') WHERE issue_id = ?`).bind(body.odometer_out, id).run();
      await c.env.DB
        .prepare(`INSERT INTO fleet_odometer_readings (vehicle_id, odometer, read_on, source, issue_id, user_id) VALUES (?, ?, ?, 'wo_out', ?, ?)`)
        .bind(issue.vehicle_id, body.odometer_out, today, id, user.id)
        .run();
    } else {
      await c.env.DB.prepare(`UPDATE fleet_wo_meta SET pm_open_key = NULL, updated_at = datetime('now') WHERE issue_id = ?`).bind(id).run();
    }
    await c.env.DB
      .prepare(`UPDATE downtime_events SET ended_at = datetime('now'), ended_by_user_id = ? WHERE vehicle_id = ? AND issue_id = ? AND ended_at IS NULL`)
      .bind(user.id, issue.vehicle_id, id)
      .run();
    const still = await c.env.DB.prepare(`SELECT id FROM downtime_events WHERE vehicle_id = ? AND ended_at IS NULL LIMIT 1`).bind(issue.vehicle_id).first();
    if (!still) await c.env.DB.prepare(`UPDATE vehicles SET status = 'active', updated_at = datetime('now') WHERE id = ?`).bind(issue.vehicle_id).run();
    if (meta?.kind === "pm" && meta.pm_code) {
      const odoOut = body.odometer_out && body.odometer_out > 0 ? body.odometer_out : (await odoFor(c.env.DB, Number(issue.vehicle_id), today)).odometer;
      await c.env.DB
        .prepare(
          `INSERT INTO fleet_pm_vehicle (vehicle_id, pm_code, last_done_date, last_done_odometer, last_issue_id, active, updated_by_user_id)
           VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(vehicle_id, pm_code) DO UPDATE SET last_done_date = excluded.last_done_date,
             last_done_odometer = COALESCE(excluded.last_done_odometer, fleet_pm_vehicle.last_done_odometer),
             last_issue_id = excluded.last_issue_id, updated_at = datetime('now'), updated_by_user_id = excluded.updated_by_user_id`
        )
        .bind(issue.vehicle_id, meta.pm_code, today, odoOut, id, user.id)
        .run();
      if (meta.pm_code === "oil") {
        const type = (await pmTypes(c.env.DB)).find((t) => t.code === "oil");
        const interval = type?.interval_miles || 5000;
        await c.env.DB
          .prepare(
            `INSERT INTO service_records (vehicle_id, service_type, service_date, odometer, interval_miles, next_due_odometer, performed_by_user_id, notes)
             VALUES (?, 'oil_change', ?, ?, ?, ?, ?, ?)`
          )
          .bind(issue.vehicle_id, today, odoOut || 0, interval, (odoOut || 0) + interval, user.id, correction)
          .run();
      }
      if ((meta.pm_code === "registration" || meta.pm_code === "inspection") && body.new_expires) {
        const col = meta.pm_code === "registration" ? "registration_expires" : "inspection_expires";
        await c.env.DB.prepare(`UPDATE vehicles SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`).bind(body.new_expires, issue.vehicle_id).run();
      }
    }
    await addStage(c.env.DB, id, "done", user.id, "fleet_shop");
    await writeAudit(c.env.DB, user, "update", "fleet_wo", id, `Done WO #${id}`);
    return c.json({ ok: true, labor_hours: labor, parts_used: partsUsed });
  });

  api.post("/fleet-shop/wo/:id/cancel", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ reason?: string }>();
    const reason = String(body.reason || "").trim();
    if (!reason) return c.json({ error: "A reason is required" }, 400);
    const issue = await c.env.DB.prepare(`SELECT vehicle_id FROM vehicle_issues WHERE id = ?`).bind(id).first<{ vehicle_id: number }>();
    if (!issue) return c.json({ error: "Not found" }, 404);
    await endOpen(c.env.DB, c.get("user").id, "done");
    await c.env.DB.prepare(`UPDATE vehicle_issues SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).bind(id).run();
    await c.env.DB.prepare(`UPDATE fleet_wo_meta SET pm_open_key = NULL, updated_at = datetime('now') WHERE issue_id = ?`).bind(id).run();
    await c.env.DB
      .prepare(`UPDATE downtime_events SET ended_at = datetime('now'), ended_by_user_id = ? WHERE vehicle_id = ? AND issue_id = ? AND ended_at IS NULL`)
      .bind(c.get("user").id, issue.vehicle_id, id)
      .run();
    await addStage(c.env.DB, id, "cancelled", c.get("user").id, "fleet_shop", reason);
    await writeAudit(c.env.DB, c.get("user"), "update", "fleet_wo", id, `Cancelled WO #${id}: ${reason}`);
    return c.json({ ok: true });
  });

  api.post("/fleet-shop/wo/:id/reopen", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const meta = await c.env.DB.prepare(`SELECT * FROM fleet_wo_meta WHERE issue_id = ?`).bind(id).first<{ vehicle_id: number; kind: string; pm_code: string | null }>();
    await c.env.DB.prepare(`UPDATE vehicle_issues SET status = 'open', completed_at = NULL, updated_at = datetime('now') WHERE id = ?`).bind(id).run();
    if (meta?.kind === "pm" && meta.pm_code) {
      const key = `${meta.vehicle_id}:${meta.pm_code}`;
      const other = await c.env.DB.prepare(`SELECT issue_id FROM fleet_wo_meta WHERE pm_open_key = ?`).bind(key).first();
      if (!other) await c.env.DB.prepare(`UPDATE fleet_wo_meta SET pm_open_key = ?, updated_at = datetime('now') WHERE issue_id = ?`).bind(key, id).run();
    }
    await addStage(c.env.DB, id, "reopened", c.get("user").id, "fleet_shop");
    await writeAudit(c.env.DB, c.get("user"), "update", "fleet_wo", id, `Reopened WO #${id}`);
    return c.json({ ok: true });
  });

  api.post("/fleet-shop/wo/:id/notes", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ body?: string }>();
    const text = String(body.body || "").trim();
    if (!text) return c.json({ error: "Note is empty" }, 400);
    const ins = await c.env.DB.prepare(`INSERT INTO fleet_wo_notes (issue_id, user_id, body) VALUES (?, ?, ?)`).bind(id, c.get("user").id, text).run();
    await writeAudit(c.env.DB, c.get("user"), "create", "fleet_wo", id, `Note on WO #${id}`);
    return c.json({ id: ins.meta.last_row_id }, 201);
  });

  api.post("/fleet-shop/wo/:id/parts", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ description?: string; part_number?: string; qty?: number; unit_cost?: number; source?: string; parts_order_request_id?: number }>();
    const description = String(body.description || "").trim();
    if (!description) return c.json({ error: "Describe the part" }, 400);
    const source = body.source === "bought" || body.source === "ordered" ? body.source : "stock";
    if (body.parts_order_request_id) {
      const order = await c.env.DB.prepare(`SELECT issue_id, vehicle_id FROM parts_order_requests WHERE id = ?`).bind(body.parts_order_request_id).first<{ issue_id: number | null; vehicle_id: number | null }>();
      const issue = await c.env.DB.prepare(`SELECT vehicle_id FROM vehicle_issues WHERE id = ?`).bind(id).first<{ vehicle_id: number }>();
      if (!order || (order.issue_id !== id && order.vehicle_id !== issue?.vehicle_id)) return c.json({ error: "That order is not for this truck" }, 400);
    }
    const ins = await c.env.DB
      .prepare(
        `INSERT INTO fleet_wo_parts (issue_id, description, part_number, qty, unit_cost, source, parts_order_request_id, added_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, description, body.part_number || null, body.qty || 1, body.unit_cost ?? null, source, body.parts_order_request_id || null, c.get("user").id)
      .run();
    await writeAudit(c.env.DB, c.get("user"), "create", "fleet_wo", id, `Part on WO #${id}: ${description}`);
    return c.json({ id: ins.meta.last_row_id }, 201);
  });

  api.delete("/fleet-shop/wo/:id/parts/:lineId", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    await c.env.DB
      .prepare(`UPDATE fleet_wo_parts SET removed_at = datetime('now'), removed_by_user_id = ? WHERE id = ? AND issue_id = ?`)
      .bind(c.get("user").id, Number(c.req.param("lineId")), Number(c.req.param("id")))
      .run();
    return c.json({ ok: true });
  });

  api.post("/fleet-shop/wo/:id/photos", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const body = await c.req.json<{ photo_key?: string; stage?: string; caption?: string }>();
    const key = String(body.photo_key || "");
    if (!key.startsWith("issue-photos/")) return c.json({ error: "Upload the photo first" }, 400);
    const stage = body.stage === "before" || body.stage === "after" ? body.stage : "during";
    const ins = await c.env.DB
      .prepare(`INSERT INTO fleet_wo_photos (issue_id, photo_key, stage, caption, uploaded_by_user_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(Number(c.req.param("id")), key, stage, body.caption || null, c.get("user").id)
      .run();
    return c.json({ id: ins.meta.last_row_id }, 201);
  });

  api.delete("/fleet-shop/wo/:id/photos/:photoId", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    await c.env.DB
      .prepare(`UPDATE fleet_wo_photos SET removed_at = datetime('now') WHERE id = ? AND issue_id = ?`)
      .bind(Number(c.req.param("photoId")), Number(c.req.param("id")))
      .run();
    return c.json({ ok: true });
  });

  api.post("/fleet-shop/shop-time/start", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    const body = await c.req.json<{ category?: string; note?: string; entry_type?: string }>();
    if (body.entry_type && !entryTypeAllowed(body.entry_type)) return c.json({ error: "That time type is not used" }, 400);
    const category = String(body.category || "");
    if (!["parts_run", "shop_cleanup", "tool_upkeep", "other"].includes(category)) return c.json({ error: "Pick a shop-time category" }, 400);
    const user = c.get("user");
    await closeStaleTimer(c.env.DB, user.id);
    await endOpen(c.env.DB, user.id, "switch");
    const ins = await c.env.DB
      .prepare(`INSERT INTO fleet_wrench_segments (user_id, entry_type, category, started_at, note) VALUES (?, 'shop', ?, ?, ?)`)
      .bind(user.id, category, new Date().toISOString(), body.note || null)
      .run();
    await writeAudit(c.env.DB, user, "create", "fleet_segment", ins.meta.last_row_id, `Shop time ${category}`);
    return c.json({ id: ins.meta.last_row_id }, 201);
  });

  api.post("/fleet-shop/shop-time/stop", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.workFleetShop);
    if (blocked) return blocked;
    await endOpen(c.env.DB, c.get("user").id, "done");
    return c.json({ ok: true });
  });

  api.get("/fleet-shop/clock", async (c) => {
    const blocked = (await ready(c)) || deny(c, ["admin", "mechanic"]);
    if (blocked) return blocked;
    const { getOpenShopSession } = await import("./shopClock");
    const session = await getOpenShopSession(c.env.DB, c.get("user").id);
    return c.json({ session });
  });

  api.post("/fleet-shop/clock/in", async (c) => {
    const blocked = (await ready(c)) || deny(c, ["admin", "mechanic"]);
    if (blocked) return blocked;
    const body = await c.req.json<{ client_ts?: string }>().catch(() => ({ client_ts: undefined as string | undefined }));
    const result = await clockShopIn(c.env as never, c.env.DB, c.get("user"), { kind: "shop", client_ts: body.client_ts || null });
    if (!result.ok) return c.json({ error: result.error, session: result.session }, result.status);
    await writeAudit(c.env.DB, c.get("user"), "create", "fleet_segment", result.session.id, "Fleet Shop clock in");
    return c.json(result);
  });

  api.post("/fleet-shop/clock/out", async (c) => {
    const blocked = (await ready(c)) || deny(c, ["admin", "mechanic"]);
    if (blocked) return blocked;
    const body = await c.req.json<{ client_ts?: string }>().catch(() => ({ client_ts: undefined as string | undefined }));
    await endOpen(c.env.DB, c.get("user").id, "clock_out");
    const result = await clockShopOut(c.env as never, c.env.DB, c.get("user"), { client_ts: body.client_ts || null });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    await writeAudit(c.env.DB, c.get("user"), "update", "fleet_segment", result.session.id, "Fleet Shop clock out");
    return c.json(result);
  });

  api.get("/fleet-shop/board", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.viewFleetBoard);
    if (blocked) return blocked;
    const day = (c.req.query("day") || chicagoYmd(Date.now())).slice(0, 10);
    const windowDays = Number(c.req.query("window") || (await getSetting(c.env.DB, "fleet_shop_stats_window_days", "90"))) || 90;
    const open = await c.env.DB
      .prepare(
        `SELECT i.id, i.vehicle_id, i.title, i.created_at, i.status, i.severity, v.unit_number
         FROM vehicle_issues i JOIN vehicles v ON v.id = i.vehicle_id
         WHERE i.status IN ('open','scheduled','in_progress')`
      )
      .all<Record<string, unknown>>();
    const done = await c.env.DB
      .prepare(
        `SELECT i.id, i.title, i.labor_hours, i.completed_at, v.unit_number, u.display_name AS finished_by
         FROM vehicle_issues i JOIN vehicles v ON v.id = i.vehicle_id
         LEFT JOIN users u ON u.id = i.completed_by_user_id
         WHERE i.status = 'completed' AND substr(i.completed_at, 1, 10) = ?`
      )
      .bind(day)
      .all();
    const ageRaw = validateAgeDays(await getSetting(c.env.DB, "fleet_shop_age_days", ""));
    const thresholds = ageRaw.ok ? ageRaw.value : undefined;
    const statsRows = (open.results || []).map((r) => ({
      issue_id: Number(r.id),
      vehicle_id: Number(r.vehicle_id),
      reported_at: String(r.created_at),
      status: String(r.status),
      parts_na: true,
    }));
    const stats = stepStats(statsRows, windowDays, thresholds, day);
    const hoursPeople = await c.env.DB
      .prepare(`SELECT id, display_name, role FROM users WHERE active = 1 AND role IN ('mechanic','admin') ORDER BY role = 'mechanic' DESC, display_name`)
      .all<{ id: number; display_name: string; role: string }>();
    const hours = [];
    for (const person of hoursPeople.results || []) {
      const segs = await c.env.DB
        .prepare(`SELECT entry_type, started_at, ended_at FROM fleet_wrench_segments WHERE user_id = ?`)
        .bind(person.id)
        .all<{ entry_type: string; started_at: string; ended_at: string | null }>();
      const clocks = await c.env.DB
        .prepare(`SELECT kind, clock_in_at, clock_out_at FROM fa_time_sessions WHERE user_id = ? AND kind = 'shop'`)
        .bind(person.id)
        .all<{ kind: string; clock_in_at: string; clock_out_at: string | null }>();
      hours.push({ user: person, ...hoursForDay(segs.results || [], clocks.results || [], day, Date.now()) });
    }
    return c.json({
      day,
      window_days: windowDays,
      open: open.results || [],
      done_today: done.results || [],
      hours,
      step_stats: stats,
      footnote: "Older work orders: scheduled/started times come from the change log when it has them; others show as unknown and are left out of the averages.",
    });
  });

  api.patch("/fleet-shop/segments/:id", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.manageFleetShopSettings);
    if (blocked) return blocked;
    const body = await c.req.json<{ started_at?: string; ended_at?: string | null; edit_reason?: string }>();
    const reason = String(body.edit_reason || "").trim();
    if (reason.length < 3) return c.json({ error: "Say why this time is being fixed" }, 400);
    await c.env.DB
      .prepare(
        `UPDATE fleet_wrench_segments SET started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at),
         edited_by_user_id = ?, edited_at = datetime('now'), edit_reason = ? WHERE id = ?`
      )
      .bind(body.started_at || null, body.ended_at || null, c.get("user").id, reason, Number(c.req.param("id")))
      .run();
    await writeAudit(c.env.DB, c.get("user"), "update", "fleet_segment", c.req.param("id"), `Time fix: ${reason}`);
    return c.json({ ok: true });
  });

  api.get("/fleet-shop/settings", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.manageFleetShopSettings);
    if (blocked) return blocked;
    const db = c.env.DB;
    return c.json({
      fleet_shop_pm_autogen: await getSetting(db, "fleet_shop_pm_autogen", "1"),
      fleet_shop_odo_max_miles_per_day: await getSetting(db, "fleet_shop_odo_max_miles_per_day", "400"),
      fleet_shop_odo_slack_miles: await getSetting(db, "fleet_shop_odo_slack_miles", "300"),
      fleet_shop_stats_window_days: await getSetting(db, "fleet_shop_stats_window_days", "90"),
      fleet_shop_age_days: await getSetting(db, "fleet_shop_age_days", ""),
    });
  });

  api.put("/fleet-shop/settings", async (c) => {
    const blocked = (await ready(c)) || deny(c, ROLE_PERMS.manageFleetShopSettings);
    if (blocked) return blocked;
    const body = await c.req.json<Record<string, unknown>>();
    const db = c.env.DB;
    const user = c.get("user");
    if (body.fleet_shop_age_days != null) {
      const parsed = validateAgeDays(body.fleet_shop_age_days);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      await setSetting(db, "fleet_shop_age_days", JSON.stringify(parsed.value));
    }
    if (body.fleet_shop_stats_window_days != null) {
      const n = Number(body.fleet_shop_stats_window_days);
      if (!Number.isInteger(n) || n < 7 || n > 365) return c.json({ error: "Stats window must be 7 to 365 days" }, 400);
      await setSetting(db, "fleet_shop_stats_window_days", String(n));
    }
    for (const key of ["fleet_shop_pm_autogen", "fleet_shop_odo_max_miles_per_day", "fleet_shop_odo_slack_miles"] as const) {
      if (body[key] != null) await setSetting(db, key, String(body[key]));
    }
    await writeAudit(db, user, "update", "fleet_pm", "settings", "Fleet Shop settings updated");
    return c.json({ ok: true });
  });
}

export async function recordRepairBoardStage(
  db: D1Database,
  issueId: number,
  beforeStatus: string,
  afterStatus: string,
  scheduledChanged: boolean,
  actorId: number
): Promise<void> {
  let stage: string | null = null;
  if (afterStatus === "scheduled" && (beforeStatus !== "scheduled" || scheduledChanged)) stage = "scheduled";
  else if (afterStatus === "in_progress" && beforeStatus !== "in_progress") stage = "started";
  else if (afterStatus === "completed" && beforeStatus !== "completed") stage = "done";
  else if (afterStatus === "cancelled" && beforeStatus !== "cancelled") stage = "cancelled";
  if (!stage) return;
  if (!(await fleetShopReady(db))) return;
  await addStage(db, issueId, stage, actorId, "repair_board");
}
