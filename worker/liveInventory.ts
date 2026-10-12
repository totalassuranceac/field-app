/**
 * Live inventory on top of stock_locations / stock_balances / stock_movements.
 * No ServiceTitan writes. Push only.
 */
import { getDriverHomeVehicleIds, getDriverVehicleIds } from "./auth";
import { adjustStockQty, ensureStockLocations, ensureVehicleStockLocation, setStockQty, transferStock } from "./inventory";
import { notifyUsers, usersByRoles } from "./notifications";
import { addDaysYmd, chicagoTodayYmd } from "./partsReceivePlan";
import {
  adjustReasonError,
  canEditPartsUsed,
  lineSettled,
  parseQty,
  transferQty,
} from "./liveInventoryPlan";
import type { PublicUser } from "./types";

export type LiveResult = { status: number; body: Record<string, unknown> };

let liveReady = false;

export async function ensureLiveInventory(db: D1Database): Promise<void> {
  if (liveReady) return;
  await ensureStockLocations(db);
  const stmts = [
    `ALTER TABLE stock_locations ADD COLUMN counted_live_at TEXT`,
    `ALTER TABLE stock_locations ADD COLUMN counted_by_user_id INTEGER`,
    `ALTER TABLE stock_movements ADD COLUMN job_ref TEXT`,
    `CREATE TABLE IF NOT EXISTS inventory_count_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL,
      part_id INTEGER NOT NULL,
      qty REAL NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (location_id, part_id)
    )`,
    `CREATE TABLE IF NOT EXISTS job_parts_used (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      location_id INTEGER NOT NULL,
      part_id INTEGER,
      other_text TEXT,
      photo_key TEXT,
      qty REAL NOT NULL,
      job_ref TEXT,
      st_appointment_id TEXT,
      status TEXT NOT NULL DEFAULT 'posted',
      usage_ymd TEXT,
      client_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      edited_at TEXT,
      voided_at TEXT,
      voided_by_user_id INTEGER,
      matched_by_user_id INTEGER,
      matched_at TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_job_parts_used_token ON job_parts_used(client_token)`,
    `CREATE INDEX IF NOT EXISTS idx_job_parts_used_job ON job_parts_used(job_ref, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_job_parts_used_usage ON job_parts_used(usage_ymd, vehicle_id, status)`,
    `ALTER TABLE job_parts_used ADD COLUMN stock_applied INTEGER NOT NULL DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS truck_restocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      usage_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      filled_at TEXT,
      filled_by_user_id INTEGER,
      confirmed_at TEXT,
      confirmed_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (vehicle_id, usage_date)
    )`,
    `CREATE TABLE IF NOT EXISTS truck_restock_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restock_id INTEGER NOT NULL,
      part_id INTEGER,
      qty REAL NOT NULL,
      pulled INTEGER NOT NULL DEFAULT 0,
      short_qty REAL NOT NULL DEFAULT 0,
      parts_order_id INTEGER,
      other_text TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_truck_restock_lines_restock ON truck_restock_lines(restock_id)`,
    `ALTER TABLE parts_order_requests ADD COLUMN job_ref TEXT`,
    `ALTER TABLE parts_order_requests ADD COLUMN needed_by TEXT`,
    `ALTER TABLE parts_order_requests ADD COLUMN deliver_to TEXT`,
    `CREATE TABLE IF NOT EXISTS parts_order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      arrival_id INTEGER,
      actor_user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists */
    }
  }
  liveReady = true;
}

function isWarehouseSide(role: string): boolean {
  return role === "admin" || role === "warehouse";
}

async function stampLastMovement(
  db: D1Database,
  partId: number,
  userId: number,
  reason: string,
  jobRef: string | null
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE stock_movements
         SET reason = ?, job_ref = ?
         WHERE id = (
           SELECT id FROM stock_movements
           WHERE part_id = ? AND IFNULL(created_by_user_id, 0) = ?
           ORDER BY id DESC LIMIT 1
         )`
      )
      .bind(reason, jobRef, partId, userId)
      .run();
  } catch {
    try {
      await db
        .prepare(
          `UPDATE stock_movements SET reason = ?
           WHERE id = (
             SELECT id FROM stock_movements WHERE part_id = ? ORDER BY id DESC LIMIT 1
           )`
        )
        .bind(reason, partId)
        .run();
    } catch {
      /* movement row is still the qty audit */
    }
  }
}

/** Usage row for the log only. On-hand stays at the physical count. */
async function logUsageHistory(
  db: D1Database,
  partId: number,
  locationId: number,
  qty: number,
  userId: number,
  jobRef: string | null
): Promise<void> {
  const note = jobRef
    ? `Job ${jobRef}. Already in the physical count.`
    : "Already in the physical count.";
  const n = Math.abs(Number(qty) || 0);
  if (!n) return;
  try {
    await db
      .prepare(
        `INSERT INTO stock_movements
          (part_id, from_location_id, to_location_id, qty, reason, notes, created_by_user_id, job_ref)
         VALUES (?, ?, NULL, ?, 'job_use', ?, ?, ?)`
      )
      .bind(partId, locationId, n, note, userId, jobRef)
      .run();
  } catch {
    await db
      .prepare(
        `INSERT INTO stock_movements
          (part_id, from_location_id, to_location_id, qty, reason, notes, created_by_user_id)
         VALUES (?, ?, NULL, ?, 'job_use', ?, ?)`
      )
      .bind(partId, locationId, n, note, userId)
      .run();
  }
}

function affectsOnHand(row: { stock_applied?: number | null }): boolean {
  return Number(row.stock_applied ?? 1) !== 0;
}

type TruckHit = {
  error?: string;
  vehicleId?: number;
  locationId?: number;
  unit?: string;
  live?: boolean;
  choices?: { id: number; unit_number: string; live: boolean }[];
};

async function resolveTechTruck(
  db: D1Database,
  user: PublicUser,
  requested?: number | null
): Promise<TruckHit> {
  let ids: number[] = [];
  if (user.role === "driver") {
    ids = await getDriverHomeVehicleIds(db, user);
    if (!ids.length) {
      const any = await getDriverVehicleIds(db, user);
      ids = any || [];
    }
  }
  let vehicleId = 0;
  if (requested && requested > 0) {
    if (user.role === "admin" || ids.includes(requested)) vehicleId = requested;
    else return { error: "That truck is not assigned to you." };
  } else if (ids.length === 1) vehicleId = ids[0];
  else if (ids.length > 1) {
    const choices = await truckChoices(db, ids);
    return { error: "More than one truck is assigned to you. Pick the truck.", choices };
  } else return { error: "No truck is assigned to you in Field App." };

  const ready = await ensureTruckLocation(db, vehicleId);
  if (ready.error || !ready.locationId) return { error: ready.error || "This truck has no stock location yet." };
  return { vehicleId, locationId: ready.locationId, unit: ready.unit, live: Boolean(ready.live) };
}

async function truckChoices(db: D1Database, ids: number[]) {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT v.id, v.unit_number, l.counted_live_at
       FROM vehicles v
       LEFT JOIN stock_locations l ON l.type = 'vehicle' AND l.vehicle_id = v.id AND l.active = 1
       WHERE v.id IN (${ph})`
    )
    .bind(...ids)
    .all<{ id: number; unit_number: string; counted_live_at: string | null }>();
  return (rows.results || []).map((r) => ({
    id: r.id,
    unit_number: r.unit_number,
    live: Boolean(r.counted_live_at),
  }));
}

async function ensureTruckLocation(
  db: D1Database,
  vehicleId: number
): Promise<{ error?: string; locationId?: number; unit?: string; live?: boolean }> {
  const vehicle = await db
    .prepare(`SELECT id, unit_number FROM vehicles WHERE id = ?`)
    .bind(vehicleId)
    .first<{ id: number; unit_number: string }>();
  if (!vehicle) return { error: "Truck not found." };
  let loc = await db
    .prepare(
      `SELECT id, counted_live_at FROM stock_locations
       WHERE type = 'vehicle' AND vehicle_id = ? AND active = 1 LIMIT 1`
    )
    .bind(vehicleId)
    .first<{ id: number; counted_live_at: string | null }>();
  if (!loc) {
    await ensureVehicleStockLocation(db, vehicleId, vehicle.unit_number, { seedTruckParts: false });
    loc = await db
      .prepare(
        `SELECT id, counted_live_at FROM stock_locations
         WHERE type = 'vehicle' AND vehicle_id = ? AND active = 1 LIMIT 1`
      )
      .bind(vehicleId)
      .first<{ id: number; counted_live_at: string | null }>();
  }
  if (!loc) return { error: "This truck has no stock location yet." };
  return {
    locationId: loc.id,
    unit: vehicle.unit_number,
    live: Boolean(loc.counted_live_at),
  };
}

async function usersForVehicle(db: D1Database, vehicleId: number): Promise<number[]> {
  const v = await db
    .prepare(
      `SELECT assigned_employee_id, helper_employee_id, assigned_driver
       FROM vehicles WHERE id = ?`
    )
    .bind(vehicleId)
    .first<{
      assigned_employee_id: number | null;
      helper_employee_id: number | null;
      assigned_driver: string | null;
    }>();
  const ids = new Set<number>();
  const empIds = [v?.assigned_employee_id, v?.helper_employee_id].filter((n) => Number(n) > 0);
  if (empIds.length) {
    const ph = empIds.map(() => "?").join(",");
    try {
      const rows = await db
        .prepare(`SELECT id FROM users WHERE active = 1 AND employee_id IN (${ph})`)
        .bind(...empIds)
        .all<{ id: number }>();
      for (const r of rows.results || []) ids.add(r.id);
    } catch {
      /* helper column optional */
    }
  }
  const name = String(v?.assigned_driver || "").trim();
  if (!ids.size && name) {
    const rows = await db
      .prepare(
        `SELECT id FROM users WHERE active = 1 AND lower(display_name) = lower(?)`
      )
      .bind(name)
      .all<{ id: number }>();
    for (const r of rows.results || []) ids.add(r.id);
  }
  return [...ids];
}

async function warehouseBinForPart(db: D1Database, partId: number): Promise<number | null> {
  try {
    const home = await db
      .prepare(
        `SELECT p.home_location_id as id, l.type
         FROM parts p
         LEFT JOIN stock_locations l ON l.id = p.home_location_id AND l.active = 1
         WHERE p.id = ?`
      )
      .bind(partId)
      .first<{ id: number | null; type: string | null }>();
    if (home?.id && home.type && home.type !== "vehicle") return home.id;
  } catch {
    /* home bin optional */
  }
  const wh = await db
    .prepare(
      `SELECT id FROM stock_locations
       WHERE active = 1 AND type = 'warehouse'
       ORDER BY id LIMIT 1`
    )
    .first<{ id: number }>();
  return wh?.id ?? null;
}

async function onHand(db: D1Database, locationId: number, partId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`)
    .bind(locationId, partId)
    .first<{ qty: number }>();
  return Number(row?.qty || 0);
}

export async function listLiveLocations(db: D1Database): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const locationSql = `SELECT l.id, l.type, l.name, l.zone, l.sort_order, l.vehicle_id, l.counted_live_at, l.counted_by_user_id,
              v.unit_number, v.assigned_driver,
              u.display_name as counted_by_name
       FROM stock_locations l
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       LEFT JOIN users u ON u.id = l.counted_by_user_id
       WHERE l.active = 1 AND l.type IN ('warehouse', 'attic', 'vehicle')
       ORDER BY CASE l.type WHEN 'warehouse' THEN 0 WHEN 'attic' THEN 1 ELSE 2 END, l.name`;
  const locationSqlPlain = `SELECT l.id, l.type, l.name, l.zone, l.vehicle_id, l.counted_live_at, l.counted_by_user_id,
              v.unit_number, v.assigned_driver,
              u.display_name as counted_by_name
       FROM stock_locations l
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       LEFT JOIN users u ON u.id = l.counted_by_user_id
       WHERE l.active = 1 AND l.type IN ('warehouse', 'attic', 'vehicle')
       ORDER BY CASE l.type WHEN 'warehouse' THEN 0 WHEN 'attic' THEN 1 ELSE 2 END, l.name`;
  let rows;
  try {
    rows = await db.prepare(locationSql).all();
  } catch {
    rows = await db.prepare(locationSqlPlain).all();
  }
  const locations = (rows.results || []).map((r) => {
    const row = r as {
      counted_live_at?: string | null;
    };
    return { ...row, live: Boolean(row.counted_live_at) };
  });
  return { status: 200, body: { locations } };
}

export async function searchLiveParts(db: D1Database, q: string): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const query = q.trim();
  if (query.length < 2) return { status: 200, body: { parts: [] } };
  const like = `%${query.replace(/[%_]/g, "")}%`;
  try {
    const rows = await db
      .prepare(
        `SELECT p.id, p.code, p.name,
                hl.name as home_name, hl.zone as home_zone, hl.type as home_type
         FROM parts p
         LEFT JOIN stock_locations hl ON hl.id = p.home_location_id AND hl.active = 1
         WHERE p.active = 1 AND (p.code LIKE ? OR p.name LIKE ?)
         ORDER BY CASE WHEN lower(p.code) = lower(?) THEN 0 ELSE 1 END, p.name
         LIMIT 20`
      )
      .bind(like, like, query)
      .all();
    return { status: 200, body: { parts: rows.results || [] } };
  } catch {
    const rows = await db
      .prepare(
        `SELECT id, code, name FROM parts
         WHERE active = 1 AND (code LIKE ? OR name LIKE ?)
         ORDER BY CASE WHEN lower(code) = lower(?) THEN 0 ELSE 1 END, name
         LIMIT 20`
      )
      .bind(like, like, query)
      .all();
    return { status: 200, body: { parts: rows.results || [] } };
  }
}

export async function myTrucks(db: D1Database, user: PublicUser): Promise<LiveResult> {
  await ensureLiveInventory(db);
  let ids: number[] = [];
  if (user.role === "driver") {
    ids = await getDriverHomeVehicleIds(db, user);
    if (!ids.length) {
      const any = await getDriverVehicleIds(db, user);
      ids = any || [];
    }
  }
  const trucks = await truckChoices(db, ids);
  return { status: 200, body: { trucks } };
}

async function readHomeBin(
  db: D1Database,
  partId: number
): Promise<{ id: number; active: number } | null> {
  try {
    const row = await db
      .prepare(
        `SELECT p.home_location_id as id, l.active
         FROM parts p
         LEFT JOIN stock_locations l ON l.id = p.home_location_id
         WHERE p.id = ?`
      )
      .bind(partId)
      .first<{ id: number | null; active: number | null }>();
    if (!row?.id) return null;
    return { id: Number(row.id), active: Number(row.active ?? 0) };
  } catch {
    return null;
  }
}

async function writeHomeBin(db: D1Database, partId: number, sectionId: number): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE parts SET home_location_id = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(sectionId, partId)
      .run();
  } catch {
    /* home bin column is optional until migration 029 */
  }
}

export async function saveCountLine(
  db: D1Database,
  user: PublicUser,
  locationId: number,
  partId: number,
  qtyRaw: unknown,
  opts?: { sectionId?: number | null; moveHome?: boolean }
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  if (!isWarehouseSide(user.role)) return { status: 403, body: { error: "Not allowed" } };
  const qty = parseQty(qtyRaw);
  if (qty == null) return { status: 400, body: { error: "Enter a quantity." } };
  const loc = await db
    .prepare(
      `SELECT id, type, counted_live_at, name FROM stock_locations WHERE id = ? AND active = 1`
    )
    .bind(locationId)
    .first<{ id: number; type: string; counted_live_at: string | null; name: string }>();
  if (!loc) return { status: 404, body: { error: "Location not found." } };
  let target = loc;
  if (loc.type !== "vehicle") {
    const sectionId = Number(opts?.sectionId) > 0 ? Number(opts?.sectionId) : loc.id;
    if (sectionId !== loc.id) {
      const section = await db
        .prepare(
          `SELECT id, type, counted_live_at, name FROM stock_locations WHERE id = ? AND active = 1`
        )
        .bind(sectionId)
        .first<{ id: number; type: string; counted_live_at: string | null; name: string }>();
      if (!section || section.type === "vehicle") {
        return { status: 400, body: { error: "Pick a section." } };
      }
      target = section;
    }
  }
  if (target.counted_live_at) {
    return {
      status: 400,
      body: { error: "This location is already live. Use Adjust for a mismatch." },
    };
  }
  const part = await db
    .prepare(`SELECT id FROM parts WHERE id = ? AND active = 1`)
    .bind(partId)
    .first<{ id: number }>();
  if (!part) return { status: 400, body: { error: "That part is not in the pricebook." } };
  if (target.type !== "vehicle") {
    const home = await readHomeBin(db, partId);
    const homeSet = Boolean(home && home.active === 1);
    if (homeSet && home && home.id !== target.id) {
      if (opts?.moveHome === true) {
        await writeHomeBin(db, partId, target.id);
      } else if (opts?.moveHome !== false) {
        return {
          status: 409,
          body: {
            error: `Move home bin to ${target.name}?`,
            confirm_home: true,
            section_name: target.name,
          },
        };
      }
    } else {
      await writeHomeBin(db, partId, target.id);
    }
  }
  const before = await onHand(db, target.id, partId);
  await setStockQty(db, partId, target.id, qty, user.id, "Starting count");
  if (before !== qty) await stampLastMovement(db, partId, user.id, "count", null);
  await db
    .prepare(
      `INSERT INTO inventory_count_lines (location_id, part_id, qty, user_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(location_id, part_id) DO UPDATE SET
         qty = excluded.qty, user_id = excluded.user_id, created_at = datetime('now')`
    )
    .bind(target.id, partId, qty, user.id)
    .run();
  return { status: 200, body: { ok: true, qty, location_id: target.id } };
}

export async function listCountLines(db: D1Database, locationId: number): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const rows = await db
    .prepare(
      `SELECT c.part_id, c.qty, c.created_at, p.code, p.name
       FROM inventory_count_lines c
       JOIN parts p ON p.id = c.part_id
       WHERE c.location_id = ?
       ORDER BY p.name`
    )
    .bind(locationId)
    .all();
  let pending: unknown[] = [];
  try {
    const waiting = await db
      .prepare(
        `SELECT u.id, u.qty, u.job_ref, u.other_text, u.status, p.code, p.name,
                uu.display_name as user_name
         FROM job_parts_used u
         LEFT JOIN parts p ON p.id = u.part_id
         LEFT JOIN users uu ON uu.id = u.user_id
         WHERE u.location_id = ? AND u.status = 'pending'
         ORDER BY u.id`
      )
      .bind(locationId)
      .all();
    pending = waiting.results || [];
  } catch {
    pending = [];
  }
  return { status: 200, body: { lines: rows.results || [], pending } };
}

/**
 * Post pending parts-used onto the movement log and the restock list.
 * On-hand stays at the typed physical count.
 * Unmatched Other stays pending so a later match does not deduct it.
 */
async function applyPendingUses(
  db: D1Database,
  userId: number,
  locationId: number
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT id, part_id, qty, job_ref, vehicle_id, usage_ymd, user_id
       FROM job_parts_used
       WHERE location_id = ? AND status = 'pending'
       ORDER BY id`
    )
    .bind(locationId)
    .all<{
      id: number;
      part_id: number | null;
      qty: number;
      job_ref: string | null;
      vehicle_id: number | null;
      usage_ymd: string | null;
      user_id: number | null;
    }>();
  let posted = 0;
  const dates = new Set<string>();
  for (const row of rows.results || []) {
    if (row.part_id) {
      const claim = await db
        .prepare(
          `UPDATE job_parts_used
           SET status = 'posted', stock_applied = 0, updated_at = datetime('now')
           WHERE id = ? AND status = 'pending'`
        )
        .bind(row.id)
        .run();
      if (!Number(claim.meta?.changes || 0)) continue;
      try {
        const actor = Number(row.user_id) > 0 ? Number(row.user_id) : userId;
        await logUsageHistory(db, row.part_id, locationId, Number(row.qty), actor, row.job_ref);
      } catch (e) {
        await db
          .prepare(
            `UPDATE job_parts_used
             SET status = 'pending', stock_applied = 0, updated_at = datetime('now')
             WHERE id = ? AND status = 'posted'`
          )
          .bind(row.id)
          .run();
        throw e;
      }
      posted += 1;
      if (row.usage_ymd) dates.add(row.usage_ymd);
    }
  }
  for (const ymd of dates) {
    try {
      await buildRestockForDate(db, ymd);
    } catch {
      /* the open Restock tab still rebuilds yesterday */
    }
  }
  return posted;
}

export async function markLocationLive(
  db: D1Database,
  user: PublicUser,
  locationId: number
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  if (!isWarehouseSide(user.role)) return { status: 403, body: { error: "Not allowed" } };
  const loc = await db
    .prepare(`SELECT id, counted_live_at, name FROM stock_locations WHERE id = ? AND active = 1`)
    .bind(locationId)
    .first<{ id: number; counted_live_at: string | null; name: string }>();
  if (!loc) return { status: 404, body: { error: "Location not found." } };
  if (!loc.counted_live_at) {
    const counted = await db
      .prepare(`SELECT COUNT(*) as c FROM inventory_count_lines WHERE location_id = ?`)
      .bind(locationId)
      .first<{ c: number }>();
    if (!Number(counted?.c || 0)) {
      return { status: 400, body: { error: "Count at least one item before this location goes live." } };
    }
  }
  const pendingPosted = await applyPendingUses(db, user.id, locationId);
  if (!loc.counted_live_at) {
    await db
      .prepare(
        `UPDATE stock_locations
         SET counted_live_at = datetime('now'), counted_by_user_id = ?
         WHERE id = ?`
      )
      .bind(user.id, locationId)
      .run();
  }
  return {
    status: 200,
    body: {
      ok: true,
      name: loc.name,
      already: Boolean(loc.counted_live_at),
      pending_posted: pendingPosted,
    },
  };
}

type UsedInput = {
  part_id?: number | null;
  other_text?: string | null;
  qty?: unknown;
  job_ref?: string | null;
  st_appointment_id?: string | null;
  vehicle_id?: number | null;
  photo_key?: string | null;
  client_token?: string | null;
};

export async function postPartsUsed(
  db: D1Database,
  user: PublicUser,
  input: UsedInput
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const qty = parseQty(input.qty);
  if (qty == null || qty <= 0) return { status: 400, body: { error: "Enter a quantity." } };
  const jobRef = String(input.job_ref || "").replace(/\s+/g, " ").trim();
  if (!jobRef) return { status: 400, body: { error: "Job number is missing." } };
  const token = String(input.client_token || "").trim() || null;
  if (token) {
    const existing = await db
      .prepare(`SELECT id, status FROM job_parts_used WHERE client_token = ?`)
      .bind(token)
      .first<{ id: number; status: string }>();
    if (existing) {
      return { status: 200, body: { ok: true, id: existing.id, status: existing.status, already: true } };
    }
  }
  const truck = await resolveTechTruck(db, user, input.vehicle_id);
  if (truck.error || !truck.locationId || !truck.vehicleId) {
    return { status: 400, body: { error: truck.error || "No truck", choices: truck.choices || [] } };
  }
  const partId = Number(input.part_id) > 0 ? Number(input.part_id) : null;
  const other = String(input.other_text || "").replace(/\s+/g, " ").trim();
  const photo = String(input.photo_key || "").trim();
  if (!partId && other.length < 2) {
    return { status: 400, body: { error: "Search a part, or describe Other." } };
  }
  if (!partId && !photo) return { status: 400, body: { error: "Other needs a photo." } };
  if (photo && !photo.startsWith("inventory-other/")) {
    return { status: 400, body: { error: "Photo was not saved for this part." } };
  }
  if (partId) {
    const part = await db
      .prepare(`SELECT id FROM parts WHERE id = ? AND active = 1`)
      .bind(partId)
      .first();
    if (!part) return { status: 400, body: { error: "That part is not in the pricebook." } };
  }
  const usageYmd = chicagoTodayYmd();
  const pending = !truck.live;
  const status = pending ? "pending" : partId ? "posted" : "needs_match";
  let id = 0;
  try {
    const ins = await db
      .prepare(
        `INSERT INTO job_parts_used (
           user_id, vehicle_id, location_id, part_id, other_text, photo_key, qty,
           job_ref, st_appointment_id, status, usage_ymd, client_token, stock_applied,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(
        user.id,
        truck.vehicleId,
        truck.locationId,
        partId,
        other || null,
        photo || null,
        qty,
        jobRef,
        String(input.st_appointment_id || "").trim() || null,
        status,
        usageYmd,
        token,
        pending ? 0 : 1
      )
      .run();
    id = Number(ins.meta.last_row_id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (token && /unique/i.test(msg)) {
      const existing = await db
        .prepare(`SELECT id, status FROM job_parts_used WHERE client_token = ?`)
        .bind(token)
        .first<{ id: number; status: string }>();
      if (existing) {
        return { status: 200, body: { ok: true, id: existing.id, status: existing.status, already: true } };
      }
    }
    return { status: 500, body: { error: "Could not save parts used." } };
  }
  if (status === "posted" && partId) {
    await adjustStockQty(db, partId, truck.locationId, -qty, user.id, "job_use", `Job ${jobRef}`);
    await stampLastMovement(db, partId, user.id, "job_use", jobRef);
  }
  return { status: 201, body: { ok: true, id, status, unit: truck.unit } };
}

export async function listPartsUsed(
  db: D1Database,
  user: PublicUser,
  jobRef: string
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const job = jobRef.trim();
  if (!job) return { status: 200, body: { entries: [] } };
  const rows = await db
    .prepare(
      `SELECT u.id, u.part_id, u.other_text, u.photo_key, u.qty, u.job_ref, u.status,
              u.created_at, u.usage_ymd, p.code, p.name,
              uu.display_name as user_name
       FROM job_parts_used u
       LEFT JOIN parts p ON p.id = u.part_id
       LEFT JOIN users uu ON uu.id = u.user_id
       WHERE u.job_ref = ? AND u.user_id = ? AND u.status != 'voided'
       ORDER BY u.id DESC
       LIMIT 40`
    )
    .bind(job, user.id)
    .all();
  const now = Date.now();
  const warehouse = isWarehouseSide(user.role);
  const entries = (rows.results || []).map((r) => {
    const row = r as { created_at?: string };
    return {
      ...row,
      can_edit: canEditPartsUsed(String(row.created_at || ""), now, warehouse),
    };
  });
  return { status: 200, body: { entries } };
}

async function loadUsed(db: D1Database, id: number) {
  return db
    .prepare(`SELECT * FROM job_parts_used WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      user_id: number;
      location_id: number;
      part_id: number | null;
      qty: number;
      status: string;
      job_ref: string | null;
      created_at: string;
      usage_ymd: string | null;
      vehicle_id: number | null;
      other_text: string | null;
      stock_applied?: number | null;
    }>();
}

export async function editPartsUsed(
  db: D1Database,
  user: PublicUser,
  id: number,
  qtyRaw: unknown
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const row = await loadUsed(db, id);
  if (!row) return { status: 404, body: { error: "Not found." } };
  if (row.status === "voided") return { status: 400, body: { error: "That entry was undone." } };
  const warehouse = isWarehouseSide(user.role);
  if (row.user_id !== user.id && !warehouse) {
    return { status: 403, body: { error: "You can only change your own parts used." } };
  }
  if (!canEditPartsUsed(row.created_at, Date.now(), warehouse)) {
    return { status: 403, body: { error: "Warehouse has to change this after 24 hours." } };
  }
  const qty = parseQty(qtyRaw);
  if (qty == null || qty <= 0) return { status: 400, body: { error: "Enter a quantity." } };
  if (row.status === "posted" && row.part_id && affectsOnHand(row)) {
    const delta = qty - Number(row.qty);
    if (delta !== 0) {
      await adjustStockQty(
        db,
        row.part_id,
        row.location_id,
        -delta,
        user.id,
        "job_use",
        `Job ${row.job_ref || ""} edit`
      );
      await stampLastMovement(db, row.part_id, user.id, "job_use", row.job_ref);
    }
  }
  await db
    .prepare(
      `UPDATE job_parts_used
       SET qty = ?, edited_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(qty, id)
    .run();
  return { status: 200, body: { ok: true, qty } };
}

export async function voidPartsUsed(
  db: D1Database,
  user: PublicUser,
  id: number
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const row = await loadUsed(db, id);
  if (!row) return { status: 404, body: { error: "Not found." } };
  if (row.status === "voided") return { status: 200, body: { ok: true, already: true } };
  const warehouse = isWarehouseSide(user.role);
  if (row.user_id !== user.id && !warehouse) {
    return { status: 403, body: { error: "You can only undo your own parts used." } };
  }
  if (!canEditPartsUsed(row.created_at, Date.now(), warehouse)) {
    return { status: 403, body: { error: "Warehouse has to change this after 24 hours." } };
  }
  if (row.status === "posted" && row.part_id && affectsOnHand(row)) {
    await adjustStockQty(
      db,
      row.part_id,
      row.location_id,
      Number(row.qty),
      user.id,
      "job_use_void",
      `Job ${row.job_ref || ""} undo`
    );
    await stampLastMovement(db, row.part_id, user.id, "job_use_void", row.job_ref);
  }
  await db
    .prepare(
      `UPDATE job_parts_used
       SET status = 'voided', voided_at = datetime('now'), voided_by_user_id = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(user.id, id)
    .run();
  return { status: 200, body: { ok: true } };
}

export async function matchPartsUsed(
  db: D1Database,
  user: PublicUser,
  id: number,
  partId: number
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  if (!isWarehouseSide(user.role)) return { status: 403, body: { error: "Not allowed" } };
  const row = await loadUsed(db, id);
  if (!row) return { status: 404, body: { error: "Not found." } };
  const waitingMatch = row.status === "needs_match" || (row.status === "pending" && !row.part_id);
  if (!waitingMatch) {
    return { status: 400, body: { error: "That entry is already matched." } };
  }
  const part = await db
    .prepare(`SELECT id, code, name FROM parts WHERE id = ? AND active = 1`)
    .bind(partId)
    .first<{ id: number; code: string; name: string }>();
  if (!part) return { status: 400, body: { error: "That part is not in the pricebook." } };
  const locLive = await db
    .prepare(`SELECT counted_live_at FROM stock_locations WHERE id = ?`)
    .bind(row.location_id)
    .first<{ counted_live_at: string | null }>();
  if (!locLive?.counted_live_at) {
    await db
      .prepare(
        `UPDATE job_parts_used
         SET part_id = ?, status = 'pending', stock_applied = 0, matched_by_user_id = ?,
             matched_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(partId, user.id, id)
      .run();
    return { status: 200, body: { ok: true, part, pending: true } };
  }
  if (row.status === "pending") {
    await db
      .prepare(
        `UPDATE job_parts_used
         SET part_id = ?, status = 'posted', stock_applied = 0, matched_by_user_id = ?,
             matched_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(partId, user.id, id)
      .run();
    const actor = Number(row.user_id) > 0 ? Number(row.user_id) : user.id;
    await logUsageHistory(db, partId, row.location_id, Number(row.qty), actor, row.job_ref);
    if (row.vehicle_id && row.usage_ymd) {
      await addMatchedToOpenRestock(
        db,
        row.vehicle_id,
        row.location_id,
        row.usage_ymd,
        partId,
        Number(row.qty),
        false
      );
    }
    return { status: 200, body: { ok: true, part } };
  }
  await db
    .prepare(
      `UPDATE job_parts_used
       SET part_id = ?, status = 'posted', matched_by_user_id = ?, matched_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(partId, user.id, id)
    .run();
  await adjustStockQty(
    db,
    partId,
    row.location_id,
    -Number(row.qty),
    user.id,
    "job_use",
    `Job ${row.job_ref || ""} matched`
  );
  await stampLastMovement(db, partId, user.id, "job_use", row.job_ref);
  if (row.vehicle_id && row.usage_ymd) {
    await addMatchedToOpenRestock(
      db,
      row.vehicle_id,
      row.location_id,
      row.usage_ymd,
      partId,
      Number(row.qty),
      true
    );
  }
  return { status: 200, body: { ok: true, part } };
}

async function addLineToRestock(
  db: D1Database,
  restockId: number,
  partId: number,
  qty: number
): Promise<void> {
  const line = await db
    .prepare(
      `SELECT id, qty, pulled, short_qty FROM truck_restock_lines
       WHERE restock_id = ? AND part_id = ?`
    )
    .bind(restockId, partId)
    .first<{ id: number; qty: number; pulled: number; short_qty: number }>();
  if (line) {
    if (line.pulled || Number(line.short_qty) > 0) return;
    await db
      .prepare(`UPDATE truck_restock_lines SET qty = qty + ? WHERE id = ?`)
      .bind(qty, line.id)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO truck_restock_lines (restock_id, part_id, qty, pulled, short_qty)
       VALUES (?, ?, ?, 0, 0)`
    )
    .bind(restockId, partId, qty)
    .run();
}

async function openRestockId(
  db: D1Database,
  vehicleId: number,
  locationId: number,
  usageDate: string
): Promise<number | null> {
  const header = await db
    .prepare(`SELECT id, status FROM truck_restocks WHERE vehicle_id = ? AND usage_date = ?`)
    .bind(vehicleId, usageDate)
    .first<{ id: number; status: string }>();
  if (!header) {
    try {
      const ins = await db
        .prepare(
          `INSERT INTO truck_restocks (vehicle_id, location_id, usage_date, status, created_at)
           VALUES (?, ?, ?, 'open', datetime('now'))`
        )
        .bind(vehicleId, locationId, usageDate)
        .run();
      return Number(ins.meta.last_row_id) || null;
    } catch {
      const again = await db
        .prepare(`SELECT id, status FROM truck_restocks WHERE vehicle_id = ? AND usage_date = ?`)
        .bind(vehicleId, usageDate)
        .first<{ id: number; status: string }>();
      if (again?.status === "open") return again.id;
      return null;
    }
  }
  if (header.status === "open") return header.id;
  return null;
}

async function addMatchedToOpenRestock(
  db: D1Database,
  vehicleId: number,
  locationId: number,
  usageDate: string,
  partId: number,
  qty: number,
  createIfClosed: boolean
): Promise<void> {
  const sameDay = await db
    .prepare(`SELECT id, status FROM truck_restocks WHERE vehicle_id = ? AND usage_date = ?`)
    .bind(vehicleId, usageDate)
    .first<{ id: number; status: string }>();
  if (sameDay?.status === "open") {
    await addLineToRestock(db, sameDay.id, partId, qty);
    return;
  }
  if (!createIfClosed) return;
  const today = chicagoTodayYmd();
  const dates: string[] = [];
  for (let day = 0; day <= 3; day += 1) {
    const ymd = day === 0 ? today : addDaysYmd(today, day);
    if (ymd && !dates.includes(ymd)) dates.push(ymd);
  }
  for (const ymd of dates) {
    const id = await openRestockId(db, vehicleId, locationId, ymd);
    if (!id) continue;
    await addLineToRestock(db, id, partId, qty);
    return;
  }
}

export async function listNeedsMatch(db: D1Database): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const rows = await db
    .prepare(
      `SELECT u.id, u.other_text, u.photo_key, u.qty, u.job_ref, u.status, u.created_at,
              v.unit_number, uu.display_name as user_name
       FROM job_parts_used u
       LEFT JOIN vehicles v ON v.id = u.vehicle_id
       LEFT JOIN users uu ON uu.id = u.user_id
       WHERE u.status = 'needs_match' OR (u.status = 'pending' AND u.part_id IS NULL)
       ORDER BY u.id DESC
       LIMIT 50`
    )
    .all();
  return { status: 200, body: { entries: rows.results || [] } };
}

export async function buildRestockForDate(db: D1Database, usageDate: string): Promise<number> {
  await ensureLiveInventory(db);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) return 0;
  const groups = await db
    .prepare(
      `SELECT vehicle_id, location_id, part_id, SUM(qty) as qty
       FROM job_parts_used
       WHERE usage_ymd = ? AND status = 'posted' AND part_id IS NOT NULL AND vehicle_id IS NOT NULL
       GROUP BY vehicle_id, location_id, part_id`
    )
    .bind(usageDate)
    .all<{ vehicle_id: number; location_id: number; part_id: number; qty: number }>();
  const byVehicle = new Map<number, { locationId: number; lines: { partId: number; qty: number }[] }>();
  for (const g of groups.results || []) {
    const cur = byVehicle.get(g.vehicle_id) || { locationId: g.location_id, lines: [] };
    cur.lines.push({ partId: g.part_id, qty: Number(g.qty) });
    byVehicle.set(g.vehicle_id, cur);
  }
  let built = 0;
  for (const [vehicleId, pack] of byVehicle) {
    let header = await db
      .prepare(`SELECT id, status FROM truck_restocks WHERE vehicle_id = ? AND usage_date = ?`)
      .bind(vehicleId, usageDate)
      .first<{ id: number; status: string }>();
    if (header && header.status !== "open") continue;
    if (!header) {
      const ins = await db
        .prepare(
          `INSERT INTO truck_restocks (vehicle_id, location_id, usage_date, status, created_at)
           VALUES (?, ?, ?, 'open', datetime('now'))`
        )
        .bind(vehicleId, pack.locationId, usageDate)
        .run();
      header = { id: Number(ins.meta.last_row_id), status: "open" };
      built += 1;
    } else {
      const touched = await db
        .prepare(
          `SELECT COUNT(*) as c FROM truck_restock_lines
           WHERE restock_id = ? AND (pulled = 1 OR short_qty > 0)`
        )
        .bind(header.id)
        .first<{ c: number }>();
      if (Number(touched?.c || 0) > 0) continue;
      await db.prepare(`DELETE FROM truck_restock_lines WHERE restock_id = ?`).bind(header.id).run();
    }
    for (const line of pack.lines) {
      await db
        .prepare(
          `INSERT INTO truck_restock_lines (restock_id, part_id, qty, pulled, short_qty)
           VALUES (?, ?, ?, 0, 0)`
        )
        .bind(header.id, line.partId, line.qty)
        .run();
    }
  }
  return built;
}

export async function buildYesterdayRestock(db: D1Database): Promise<number> {
  const ymd = addDaysYmd(chicagoTodayYmd(), -1);
  if (!ymd) return 0;
  return buildRestockForDate(db, ymd);
}

export async function listRestocks(
  db: D1Database,
  user: PublicUser,
  mine: boolean
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  if (!mine && isWarehouseSide(user.role)) {
    await buildYesterdayRestock(db);
  }
  if (mine) {
    let ids: number[] = [];
    if (user.role === "driver") {
      ids = await getDriverHomeVehicleIds(db, user);
      if (!ids.length) {
        const any = await getDriverVehicleIds(db, user);
        ids = any || [];
      }
    }
    if (!ids.length) return { status: 200, body: { restocks: [] } };
    const ph = ids.map(() => "?").join(",");
    const headers = await db
      .prepare(
        `SELECT r.*, v.unit_number
         FROM truck_restocks r
         JOIN vehicles v ON v.id = r.vehicle_id
         WHERE r.vehicle_id IN (${ph}) AND r.status = 'filled'
         ORDER BY r.usage_date DESC
         LIMIT 10`
      )
      .bind(...ids)
      .all();
    return { status: 200, body: { restocks: await attachLines(db, headers.results || []) } };
  }
  if (!isWarehouseSide(user.role)) return { status: 403, body: { error: "Not allowed" } };
  const headers = await db
    .prepare(
      `SELECT r.*, v.unit_number, v.assigned_driver
       FROM truck_restocks r
       JOIN vehicles v ON v.id = r.vehicle_id
       WHERE r.status IN ('open', 'filled')
       ORDER BY r.usage_date DESC, v.unit_number
       LIMIT 40`
    )
    .all();
  return { status: 200, body: { restocks: await attachLines(db, headers.results || []) } };
}

function homeZoneRank(zone: unknown): number {
  const z = String(zone || "").toLowerCase();
  if (z === "main") return 0;
  if (z === "overhead") return 1;
  if (z === "attic") return 2;
  return 3;
}

function sortRestockLines(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.slice().sort((a, b) => {
    const aNamed = String(a.home_name || "").trim() ? 0 : 1;
    const bNamed = String(b.home_name || "").trim() ? 0 : 1;
    if (aNamed !== bNamed) return aNamed - bNamed;
    const so = Number(a.home_sort || 0) - Number(b.home_sort || 0);
    if (so) return so;
    const zr = homeZoneRank(a.home_zone) - homeZoneRank(b.home_zone);
    if (zr) return zr;
    const hn = String(a.home_name || "").localeCompare(String(b.home_name || ""));
    if (hn) return hn;
    return String(a.name || a.code || "").localeCompare(String(b.name || b.code || ""));
  });
}

async function attachLines(db: D1Database, headers: Record<string, unknown>[]) {
  const out = [];
  for (const h of headers) {
    const id = Number(h.id);
    let rows: Record<string, unknown>[] = [];
    try {
      const lines = await db
        .prepare(
          `SELECT l.*, p.code, p.name,
                  hl.name as home_name, hl.zone as home_zone, hl.type as home_type,
                  hl.sort_order as home_sort
           FROM truck_restock_lines l
           LEFT JOIN parts p ON p.id = l.part_id
           LEFT JOIN stock_locations hl ON hl.id = p.home_location_id AND hl.active = 1
           WHERE l.restock_id = ?`
        )
        .bind(id)
        .all<Record<string, unknown>>();
      rows = lines.results || [];
    } catch {
      const lines = await db
        .prepare(
          `SELECT l.*, p.code, p.name
           FROM truck_restock_lines l
           LEFT JOIN parts p ON p.id = l.part_id
           WHERE l.restock_id = ?`
        )
        .bind(id)
        .all<Record<string, unknown>>();
      rows = lines.results || [];
    }
    out.push({ ...h, lines: sortRestockLines(rows) });
  }
  return out;
}

async function openRestock(db: D1Database, id: number) {
  return db
    .prepare(`SELECT * FROM truck_restocks WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      vehicle_id: number;
      location_id: number;
      usage_date: string;
      status: string;
    }>();
}

export async function pullRestockLine(
  db: D1Database,
  user: PublicUser,
  restockId: number,
  lineId: number,
  pulled: boolean
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  if (!isWarehouseSide(user.role)) return { status: 403, body: { error: "Not allowed" } };
  const header = await openRestock(db, restockId);
  if (!header) return { status: 404, body: { error: "Not found." } };
  if (header.status !== "open") return { status: 400, body: { error: "This restock is already filled." } };
  await db
    .prepare(`UPDATE truck_restock_lines SET pulled = ? WHERE id = ? AND restock_id = ?`)
    .bind(pulled ? 1 : 0, lineId, restockId)
    .run();
  return { status: 200, body: { ok: true } };
}

export async function shortRestockLine(
  db: D1Database,
  user: PublicUser,
  restockId: number,
  lineId: number,
  shortRaw: unknown
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  if (!isWarehouseSide(user.role)) return { status: 403, body: { error: "Not allowed" } };
  const header = await openRestock(db, restockId);
  if (!header) return { status: 404, body: { error: "Not found." } };
  if (header.status !== "open") return { status: 400, body: { error: "This restock is already filled." } };
  const line = await db
    .prepare(
      `SELECT l.*, p.code, p.name
       FROM truck_restock_lines l
       LEFT JOIN parts p ON p.id = l.part_id
       WHERE l.id = ? AND l.restock_id = ?`
    )
    .bind(lineId, restockId)
    .first<{
      id: number;
      part_id: number | null;
      qty: number;
      short_qty: number;
      parts_order_id: number | null;
      code: string | null;
      name: string | null;
    }>();
  if (!line) return { status: 404, body: { error: "Line not found." } };
  const shortQty = parseQty(shortRaw);
  if (shortQty == null || shortQty <= 0) return { status: 400, body: { error: "Enter how many are short." } };
  if (shortQty > Number(line.qty)) {
    return { status: 400, body: { error: "Short qty cannot be more than the line." } };
  }
  let orderId = line.parts_order_id;
  if (!orderId && line.part_id) {
    const vehicle = await db
      .prepare(`SELECT unit_number FROM vehicles WHERE id = ?`)
      .bind(header.vehicle_id)
      .first<{ unit_number: string }>();
    const unit = vehicle?.unit_number || String(header.vehicle_id);
    const partName = line.name || line.code || "part";
    const ins = await db
      .prepare(
        `INSERT INTO parts_order_requests (
           user_id, vehicle_id, vehicle_label, part_description, part_number,
           vendor_preference, notes, status, job_ref, needed_by, deliver_to,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'either', ?, 'needed', ?, ?, 'truck', datetime('now'), datetime('now'))`
      )
      .bind(
        user.id,
        header.vehicle_id,
        `Unit ${unit}`,
        `${partName} short ${shortQty}`,
        line.code,
        `Short on morning restock ${header.usage_date}`,
        `Truck ${unit}`,
        chicagoTodayYmd()
      )
      .run();
    orderId = Number(ins.meta.last_row_id);
    try {
      await db
        .prepare(
          `INSERT INTO parts_order_events (
             request_id, actor_user_id, event_type, from_status, to_status, note, created_at
           ) VALUES (?, ?, 'status', NULL, 'needed', ?, datetime('now'))`
        )
        .bind(orderId, user.id, `Short on truck ${unit}`)
        .run();
    } catch {
      /* event log is best-effort */
    }
    const notifyIds = new Set(await usersByRoles(db, ["admin", "office", "warehouse"]));
    notifyIds.delete(user.id);
    if (notifyIds.size) {
      await notifyUsers(
        db,
        [...notifyIds],
        "parts_order_request",
        `Part short - ${partName.slice(0, 60)}`,
        `Truck ${unit} is short ${shortQty}. Warehouse orders.`,
        { type: "parts_order", id: orderId }
      );
    }
  }
  await db
    .prepare(
      `UPDATE truck_restock_lines SET short_qty = ?, parts_order_id = ? WHERE id = ?`
    )
    .bind(shortQty, orderId, lineId)
    .run();
  return { status: 200, body: { ok: true, parts_order_id: orderId } };
}

export async function fillRestock(
  db: D1Database,
  user: PublicUser,
  restockId: number
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  if (!isWarehouseSide(user.role)) return { status: 403, body: { error: "Not allowed" } };
  const header = await openRestock(db, restockId);
  if (!header) return { status: 404, body: { error: "Not found." } };
  if (header.status !== "open") return { status: 400, body: { error: "This restock is already filled." } };
  const lines = await db
    .prepare(
      `SELECT l.*, p.code, p.name
       FROM truck_restock_lines l
       LEFT JOIN parts p ON p.id = l.part_id
       WHERE l.restock_id = ?`
    )
    .bind(restockId)
    .all<{
      id: number;
      part_id: number | null;
      qty: number;
      pulled: number;
      short_qty: number;
      code: string | null;
      name: string | null;
    }>();
  const rows = lines.results || [];
  if (!rows.length) return { status: 400, body: { error: "Nothing to fill." } };
  for (const line of rows) {
    if (!lineSettled(line.pulled, Number(line.qty), Number(line.short_qty))) {
      return {
        status: 400,
        body: { error: "Check off every line or mark it short before Filled." },
      };
    }
  }
  const moves: { partId: number; fromId: number; qty: number }[] = [];
  for (const line of rows) {
    if (!line.part_id) continue;
    const n = transferQty(Number(line.qty), Number(line.short_qty));
    if (n <= 0) continue;
    if (!line.pulled) {
      return {
        status: 400,
        body: { error: `Check off ${line.name || line.code || "the part"} before Filled.` },
      };
    }
    const fromId = await warehouseBinForPart(db, line.part_id);
    if (!fromId) return { status: 400, body: { error: "No warehouse location is set up." } };
    const have = await onHand(db, fromId, line.part_id);
    if (have < n) {
      const label = line.name || line.code || "that part";
      return {
        status: 400,
        body: { error: `Warehouse does not have enough ${label}. Mark the rest short.` },
      };
    }
    moves.push({ partId: line.part_id, fromId, qty: n });
  }
  for (const m of moves) {
    try {
      await transferStock(
        db,
        m.partId,
        m.fromId,
        header.location_id,
        m.qty,
        user.id,
        `Restock ${header.usage_date}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not move stock.";
      return { status: 400, body: { error: msg } };
    }
    await stampLastMovement(db, m.partId, user.id, "restock", null);
  }
  await db
    .prepare(
      `UPDATE truck_restocks
       SET status = 'filled', filled_at = datetime('now'), filled_by_user_id = ?
       WHERE id = ?`
    )
    .bind(user.id, restockId)
    .run();
  const techIds = (await usersForVehicle(db, header.vehicle_id)).filter((id) => id !== user.id);
  if (techIds.length) {
    const vehicle = await db
      .prepare(`SELECT unit_number FROM vehicles WHERE id = ?`)
      .bind(header.vehicle_id)
      .first<{ unit_number: string }>();
    await notifyUsers(
      db,
      techIds,
      "truck_restock_filled",
      "Restock is on your truck",
      `Unit ${vehicle?.unit_number || header.vehicle_id} was filled. Confirm the bin in Field App.`,
      { type: "truck_restock", id: restockId }
    );
  }
  return { status: 200, body: { ok: true } };
}

export async function confirmRestock(
  db: D1Database,
  user: PublicUser,
  restockId: number
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const header = await openRestock(db, restockId);
  if (!header) return { status: 404, body: { error: "Not found." } };
  if (header.status === "confirmed") return { status: 200, body: { ok: true, already: true } };
  if (header.status !== "filled") {
    return { status: 400, body: { error: "Warehouse has to mark this filled first." } };
  }
  if (user.role !== "admin") {
    let ids = await getDriverHomeVehicleIds(db, user);
    if (!ids.length) {
      const any = await getDriverVehicleIds(db, user);
      ids = any || [];
    }
    if (!ids.includes(header.vehicle_id)) {
      return { status: 403, body: { error: "Only the tech on this truck can confirm the bin." } };
    }
  }
  await db
    .prepare(
      `UPDATE truck_restocks
       SET status = 'confirmed', confirmed_at = datetime('now'), confirmed_by_user_id = ?
       WHERE id = ?`
    )
    .bind(user.id, restockId)
    .run();
  const wh = (await usersByRoles(db, ["warehouse", "admin"])).filter((id) => id !== user.id);
  if (wh.length) {
    await notifyUsers(
      db,
      wh,
      "truck_restock_confirmed",
      "Tech confirmed the bin",
      `${user.display_name} confirmed restock ${header.usage_date}.`,
      { type: "truck_restock", id: restockId }
    );
  }
  return { status: 200, body: { ok: true } };
}

export async function adjustLiveQty(
  db: D1Database,
  user: PublicUser,
  input: { location_id?: number; part_id?: number; qty?: unknown; reason?: string; note?: string }
): Promise<LiveResult> {
  await ensureLiveInventory(db);
  if (!isWarehouseSide(user.role)) return { status: 403, body: { error: "Not allowed" } };
  const reason = String(input.reason || "").trim();
  const note = String(input.note || "").replace(/\s+/g, " ").trim();
  const reasonErr = adjustReasonError(reason, note);
  if (reasonErr) return { status: 400, body: { error: reasonErr } };
  const qty = parseQty(input.qty);
  if (qty == null) return { status: 400, body: { error: "Enter the new quantity." } };
  const locationId = Number(input.location_id);
  const partId = Number(input.part_id);
  if (!locationId || !partId) return { status: 400, body: { error: "Pick a location and a part." } };
  const loc = await db
    .prepare(`SELECT id, counted_live_at FROM stock_locations WHERE id = ? AND active = 1`)
    .bind(locationId)
    .first<{ id: number; counted_live_at: string | null }>();
  if (!loc) return { status: 404, body: { error: "Location not found." } };
  if (!loc.counted_live_at) {
    return { status: 400, body: { error: "Count this location and save it live first." } };
  }
  const before = await onHand(db, locationId, partId);
  const delta = qty - before;
  if (delta !== 0) {
    await adjustStockQty(db, partId, locationId, delta, user.id, reason, note || null);
    await stampLastMovement(db, partId, user.id, reason, null);
  }
  return { status: 200, body: { ok: true, before, qty } };
}

export async function liveReport(db: D1Database): Promise<LiveResult> {
  await ensureLiveInventory(db);
  const locations = await listLiveLocations(db);
  let onHandRows: unknown[] = [];
  let usage: unknown[] = [];
  let requests: unknown[] = [];
  let unmatched: unknown[] = [];
  try {
    const rows = await db
      .prepare(
        `SELECT l.name as location_name, l.type, v.unit_number, p.code, p.name as part_name, b.qty
         FROM stock_balances b
         JOIN stock_locations l ON l.id = b.location_id
         JOIN parts p ON p.id = b.part_id
         LEFT JOIN vehicles v ON v.id = l.vehicle_id
         WHERE l.counted_live_at IS NOT NULL AND b.qty != 0
         ORDER BY l.type, l.name, p.name
         LIMIT 400`
      )
      .all();
    onHandRows = rows.results || [];
  } catch {
    onHandRows = [];
  }
  try {
    const rows = await db
      .prepare(
        `SELECT u.id, u.usage_ymd, u.job_ref, u.qty, u.status, uu.display_name as tech,
                v.unit_number, p.code, p.name as part_name, u.other_text
         FROM job_parts_used u
         LEFT JOIN users uu ON uu.id = u.user_id
         LEFT JOIN vehicles v ON v.id = u.vehicle_id
         LEFT JOIN parts p ON p.id = u.part_id
         WHERE u.status != 'voided'
         ORDER BY u.id DESC
         LIMIT 200`
      )
      .all();
    usage = rows.results || [];
  } catch {
    usage = [];
  }
  try {
    const rows = await db
      .prepare(
        `SELECT r.id, r.part_description, r.status, r.job_ref, r.needed_by, r.deliver_to,
                r.created_at, u.display_name as requested_by
         FROM parts_order_requests r
         JOIN users u ON u.id = r.user_id
         WHERE r.status IN ('needed', 'ordered', 'arriving')
         ORDER BY r.created_at DESC
         LIMIT 50`
      )
      .all();
    requests = rows.results || [];
  } catch {
    requests = [];
  }
  try {
    const rows = await db
      .prepare(
        `SELECT id, part_description, vendor_name, po_number, status, created_at
         FROM parts_arrivals
         WHERE status = 'unmatched'
         ORDER BY created_at DESC
         LIMIT 40`
      )
      .all();
    unmatched = rows.results || [];
  } catch {
    unmatched = [];
  }
  return {
    status: 200,
    body: {
      locations: (locations.body.locations as unknown[]) || [],
      on_hand: onHandRows,
      usage,
      open_requests: requests,
      unmatched,
    },
  };
}
