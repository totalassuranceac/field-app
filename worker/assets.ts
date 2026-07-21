/**
 * Company-owned assets outside ServiceTitan pricebook.
 * - Gas bottles: full/empty counts per stock location
 * - Equipment: individual ladders, dollies, tools with condition history
 */

import { ensureStockLocations } from "./inventory";

export type AssetCategory = "ladder" | "dolly" | "tool" | "other";
export type AssetStatus = "in_service" | "repair" | "retired" | "missing";
export type AssetCondition =
  | "excellent"
  | "good"
  | "fair"
  | "poor"
  | "damaged"
  | "out_of_service";

const CONDITIONS: AssetCondition[] = [
  "excellent",
  "good",
  "fair",
  "poor",
  "damaged",
  "out_of_service",
];

export function isValidCondition(c: string): c is AssetCondition {
  return CONDITIONS.includes(c as AssetCondition);
}

/** Ensure bottle types exist and every active location has zeroed balances. */
export async function ensureCompanyAssets(db: D1Database): Promise<void> {
  await ensureStockLocations(db);

  // Tables may not exist yet on brand-new DBs — callers catch "no such table"
  const seeds = [
    ["O2", "Oxygen", 1],
    ["N2", "Nitrogen", 2],
    ["ACE", "Acetylene", 3],
  ] as const;
  for (const [code, name, sort] of seeds) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO bottle_types (code, name, sort_order, active)
         VALUES (?, ?, ?, 1)`
      )
      .bind(code, name, sort)
      .run();
  }

  const types = await db
    .prepare(`SELECT id FROM bottle_types WHERE active = 1`)
    .all<{ id: number }>();
  const locs = await db
    .prepare(`SELECT id FROM stock_locations WHERE active = 1`)
    .all<{ id: number }>();

  for (const loc of locs.results || []) {
    for (const t of types.results || []) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO bottle_balances (location_id, bottle_type_id, full_qty, empty_qty)
           VALUES (?, ?, 0, 0)`
        )
        .bind(loc.id, t.id)
        .run();
    }
  }
}

async function getWarehouseLocationId(db: D1Database): Promise<number> {
  const wh = await db
    .prepare(
      `SELECT id FROM stock_locations WHERE type = 'warehouse' AND active = 1 LIMIT 1`
    )
    .first<{ id: number }>();
  if (!wh) throw new Error("No warehouse location");
  return wh.id;
}

async function getBalance(
  db: D1Database,
  locationId: number,
  bottleTypeId: number
): Promise<{ full_qty: number; empty_qty: number }> {
  const row = await db
    .prepare(
      `SELECT full_qty, empty_qty FROM bottle_balances
       WHERE location_id = ? AND bottle_type_id = ?`
    )
    .bind(locationId, bottleTypeId)
    .first<{ full_qty: number; empty_qty: number }>();
  if (row) return row;
  await db
    .prepare(
      `INSERT OR IGNORE INTO bottle_balances (location_id, bottle_type_id, full_qty, empty_qty)
       VALUES (?, ?, 0, 0)`
    )
    .bind(locationId, bottleTypeId)
    .run();
  return { full_qty: 0, empty_qty: 0 };
}

async function writeBalance(
  db: D1Database,
  locationId: number,
  bottleTypeId: number,
  full: number,
  empty: number
): Promise<void> {
  if (full < 0 || empty < 0) throw new Error("Bottle counts cannot go negative");
  await db
    .prepare(
      `INSERT INTO bottle_balances (location_id, bottle_type_id, full_qty, empty_qty, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(location_id, bottle_type_id) DO UPDATE SET
         full_qty = excluded.full_qty,
         empty_qty = excluded.empty_qty,
         updated_at = datetime('now')`
    )
    .bind(locationId, bottleTypeId, full, empty)
    .run();
}

export async function bottleSummary(db: D1Database): Promise<{
  types: Array<{
    id: number;
    code: string;
    name: string;
    full_total: number;
    empty_total: number;
    total: number;
  }>;
  matrix: Array<{
    location_id: number;
    location_name: string;
    location_type: string;
    unit_number: string | null;
    vehicle_id: number | null;
    bottles: Array<{
      bottle_type_id: number;
      code: string;
      name: string;
      full_qty: number;
      empty_qty: number;
    }>;
  }>;
}> {
  await ensureCompanyAssets(db);

  const types = await db
    .prepare(
      `SELECT t.id, t.code, t.name,
         COALESCE(SUM(b.full_qty), 0) as full_total,
         COALESCE(SUM(b.empty_qty), 0) as empty_total
       FROM bottle_types t
       LEFT JOIN bottle_balances b ON b.bottle_type_id = t.id
       WHERE t.active = 1
       GROUP BY t.id
       ORDER BY t.sort_order, t.name`
    )
    .all<{
      id: number;
      code: string;
      name: string;
      full_total: number;
      empty_total: number;
    }>();

  const typeList = (types.results || []).map((t) => ({
    ...t,
    full_total: Number(t.full_total) || 0,
    empty_total: Number(t.empty_total) || 0,
    total: (Number(t.full_total) || 0) + (Number(t.empty_total) || 0),
  }));

  const locs = await db
    .prepare(
      `SELECT l.id, l.name, l.type, l.vehicle_id, v.unit_number
       FROM stock_locations l
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.active = 1 AND l.type IN ('warehouse', 'vehicle')
       ORDER BY CASE l.type WHEN 'warehouse' THEN 0 ELSE 1 END, v.unit_number, l.name`
    )
    .all<{
      id: number;
      name: string;
      type: string;
      vehicle_id: number | null;
      unit_number: string | null;
    }>();

  const balances = await db
    .prepare(
      `SELECT b.location_id, b.bottle_type_id, b.full_qty, b.empty_qty, t.code, t.name
       FROM bottle_balances b
       JOIN bottle_types t ON t.id = b.bottle_type_id
       WHERE t.active = 1`
    )
    .all<{
      location_id: number;
      bottle_type_id: number;
      full_qty: number;
      empty_qty: number;
      code: string;
      name: string;
    }>();

  const byLoc = new Map<
    number,
    Array<{
      bottle_type_id: number;
      code: string;
      name: string;
      full_qty: number;
      empty_qty: number;
    }>
  >();
  for (const row of balances.results || []) {
    const list = byLoc.get(row.location_id) || [];
    list.push({
      bottle_type_id: row.bottle_type_id,
      code: row.code,
      name: row.name,
      full_qty: row.full_qty,
      empty_qty: row.empty_qty,
    });
    byLoc.set(row.location_id, list);
  }

  const matrix = (locs.results || []).map((l) => {
    const bottles = byLoc.get(l.id) || [];
    // Ensure all types present
    for (const t of typeList) {
      if (!bottles.some((b) => b.bottle_type_id === t.id)) {
        bottles.push({
          bottle_type_id: t.id,
          code: t.code,
          name: t.name,
          full_qty: 0,
          empty_qty: 0,
        });
      }
    }
    bottles.sort((a, b) => a.code.localeCompare(b.code));
    return {
      location_id: l.id,
      location_name: l.unit_number ? `Unit ${l.unit_number}` : l.name,
      location_type: l.type,
      unit_number: l.unit_number,
      vehicle_id: l.vehicle_id,
      bottles,
    };
  });

  return { types: typeList, matrix };
}

export async function setBottleCounts(
  db: D1Database,
  userId: number,
  locationId: number,
  bottleTypeId: number,
  fullQty: number,
  emptyQty: number,
  notes?: string | null
): Promise<void> {
  if (fullQty < 0 || emptyQty < 0) throw new Error("Counts cannot be negative");
  const before = await getBalance(db, locationId, bottleTypeId);
  await writeBalance(db, locationId, bottleTypeId, fullQty, emptyQty);
  await db
    .prepare(
      `INSERT INTO bottle_events (
         bottle_type_id, event_type, to_location_id,
         full_delta, empty_delta, notes, created_by_user_id
       ) VALUES (?, 'set', ?, ?, ?, ?, ?)`
    )
    .bind(
      bottleTypeId,
      locationId,
      fullQty - before.full_qty,
      emptyQty - before.empty_qty,
      notes?.trim() || `Set to ${fullQty} full / ${emptyQty} empty`,
      userId
    )
    .run();
}

export async function adjustBottleCounts(
  db: D1Database,
  userId: number,
  locationId: number,
  bottleTypeId: number,
  fullDelta: number,
  emptyDelta: number,
  notes?: string | null
): Promise<{ full_qty: number; empty_qty: number }> {
  const before = await getBalance(db, locationId, bottleTypeId);
  const full = before.full_qty + fullDelta;
  const empty = before.empty_qty + emptyDelta;
  if (full < 0 || empty < 0) {
    throw new Error(
      `Would go negative (have ${before.full_qty} full / ${before.empty_qty} empty)`
    );
  }
  await writeBalance(db, locationId, bottleTypeId, full, empty);
  await db
    .prepare(
      `INSERT INTO bottle_events (
         bottle_type_id, event_type, to_location_id,
         full_delta, empty_delta, notes, created_by_user_id
       ) VALUES (?, 'adjust', ?, ?, ?, ?, ?)`
    )
    .bind(
      bottleTypeId,
      locationId,
      fullDelta,
      emptyDelta,
      notes?.trim() || null,
      userId
    )
    .run();
  return { full_qty: full, empty_qty: empty };
}

/**
 * Warehouse swap: tech brings empties from truck, takes fulls back.
 * - empties leave truck → warehouse
 * - fulls leave warehouse → truck
 */
export async function swapBottles(
  db: D1Database,
  userId: number,
  truckLocationId: number,
  lines: Array<{ bottle_type_id: number; empty_in: number; full_out: number }>,
  techUserId?: number | null,
  notes?: string | null
): Promise<void> {
  const truck = await db
    .prepare(
      `SELECT id, type FROM stock_locations WHERE id = ? AND active = 1`
    )
    .bind(truckLocationId)
    .first<{ id: number; type: string }>();
  if (!truck || truck.type !== "vehicle") {
    throw new Error("Select a truck stock location");
  }

  const warehouseId = await getWarehouseLocationId(db);
  const validLines = lines.filter(
    (l) =>
      l.bottle_type_id > 0 &&
      ((l.empty_in || 0) > 0 || (l.full_out || 0) > 0)
  );
  if (!validLines.length) throw new Error("Enter at least one empty-in or full-out count");

  for (const line of validLines) {
    const emptyIn = Math.max(0, Math.floor(Number(line.empty_in) || 0));
    const fullOut = Math.max(0, Math.floor(Number(line.full_out) || 0));
    if (!emptyIn && !fullOut) continue;

    const truckBal = await getBalance(db, truckLocationId, line.bottle_type_id);
    const whBal = await getBalance(db, warehouseId, line.bottle_type_id);

    if (emptyIn > truckBal.empty_qty) {
      throw new Error(
        `Truck only has ${truckBal.empty_qty} empty bottle(s) of that type`
      );
    }
    if (fullOut > whBal.full_qty) {
      throw new Error(
        `Warehouse only has ${whBal.full_qty} full bottle(s) of that type`
      );
    }

    // Empties: truck → warehouse
    if (emptyIn > 0) {
      await writeBalance(
        db,
        truckLocationId,
        line.bottle_type_id,
        truckBal.full_qty,
        truckBal.empty_qty - emptyIn
      );
      const whAfterEmpty = await getBalance(db, warehouseId, line.bottle_type_id);
      await writeBalance(
        db,
        warehouseId,
        line.bottle_type_id,
        whAfterEmpty.full_qty,
        whAfterEmpty.empty_qty + emptyIn
      );
    }

    // Fulls: warehouse → truck
    if (fullOut > 0) {
      const whNow = await getBalance(db, warehouseId, line.bottle_type_id);
      const truckNow = await getBalance(db, truckLocationId, line.bottle_type_id);
      await writeBalance(
        db,
        warehouseId,
        line.bottle_type_id,
        whNow.full_qty - fullOut,
        whNow.empty_qty
      );
      await writeBalance(
        db,
        truckLocationId,
        line.bottle_type_id,
        truckNow.full_qty + fullOut,
        truckNow.empty_qty
      );
    }

    await db
      .prepare(
        `INSERT INTO bottle_events (
           bottle_type_id, event_type, from_location_id, to_location_id,
           full_delta, empty_delta, tech_user_id, notes, created_by_user_id
         ) VALUES (?, 'swap', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        line.bottle_type_id,
        truckLocationId,
        warehouseId,
        fullOut,
        emptyIn,
        techUserId || null,
        notes?.trim() || null,
        userId
      )
      .run();
  }
}

export async function listBottleEvents(
  db: D1Database,
  limit = 50
): Promise<unknown[]> {
  const rows = await db
    .prepare(
      `SELECT e.*,
         t.code as bottle_code, t.name as bottle_name,
         fl.name as from_name, fv.unit_number as from_unit,
         tl.name as to_name, tv.unit_number as to_unit,
         u.display_name as created_by_name,
         tech.display_name as tech_name
       FROM bottle_events e
       JOIN bottle_types t ON t.id = e.bottle_type_id
       LEFT JOIN stock_locations fl ON fl.id = e.from_location_id
       LEFT JOIN vehicles fv ON fv.id = fl.vehicle_id
       LEFT JOIN stock_locations tl ON tl.id = e.to_location_id
       LEFT JOIN vehicles tv ON tv.id = tl.vehicle_id
       LEFT JOIN users u ON u.id = e.created_by_user_id
       LEFT JOIN users tech ON tech.id = e.tech_user_id
       ORDER BY e.created_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();
  return rows.results || [];
}

// ——— Company equipment (ladders, dollies, tools) ———

export async function listAssets(
  db: D1Database,
  opts: {
    category?: string;
    status?: string;
    location_id?: number;
    location_ids?: number[];
    q?: string;
    needs_attention?: boolean;
    limit?: number;
  } = {}
): Promise<unknown[]> {
  const limit = Math.min(opts.limit || 200, 500);
  const clauses: string[] = ["a.active = 1"];
  const binds: unknown[] = [];

  if (opts.category) {
    clauses.push("a.category = ?");
    binds.push(opts.category);
  }
  if (opts.status) {
    clauses.push("a.status = ?");
    binds.push(opts.status);
  }
  if (opts.location_id) {
    clauses.push("a.location_id = ?");
    binds.push(opts.location_id);
  }
  if (opts.location_ids && opts.location_ids.length) {
    clauses.push(
      `a.location_id IN (${opts.location_ids.map(() => "?").join(",")})`
    );
    binds.push(...opts.location_ids);
  }
  if (opts.q) {
    clauses.push(
      `(a.name LIKE ? OR IFNULL(a.asset_tag,'') LIKE ? OR IFNULL(a.serial_number,'') LIKE ?)`
    );
    const like = `%${opts.q}%`;
    binds.push(like, like, like);
  }
  if (opts.needs_attention) {
    clauses.push(
      `a.condition IN ('poor', 'damaged', 'out_of_service') OR a.status IN ('repair', 'missing')`
    );
  }

  const sql = `SELECT a.*,
      l.name as location_name, l.type as location_type, l.vehicle_id,
      v.unit_number,
      u.display_name as issued_to_name
    FROM company_assets a
    LEFT JOIN stock_locations l ON l.id = a.location_id
    LEFT JOIN vehicles v ON v.id = l.vehicle_id
    LEFT JOIN users u ON u.id = a.issued_to_user_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY
      CASE a.condition
        WHEN 'out_of_service' THEN 0
        WHEN 'damaged' THEN 1
        WHEN 'poor' THEN 2
        WHEN 'fair' THEN 3
        ELSE 4
      END,
      a.category, a.name
    LIMIT ?`;
  binds.push(limit);
  const rows = await db.prepare(sql).bind(...binds).all();
  return rows.results || [];
}

export async function getAsset(
  db: D1Database,
  id: number
): Promise<{ asset: Record<string, unknown>; events: unknown[] } | null> {
  const asset = await db
    .prepare(
      `SELECT a.*,
        l.name as location_name, l.type as location_type, l.vehicle_id,
        v.unit_number,
        u.display_name as issued_to_name
       FROM company_assets a
       LEFT JOIN stock_locations l ON l.id = a.location_id
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       LEFT JOIN users u ON u.id = a.issued_to_user_id
       WHERE a.id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!asset) return null;

  const events = await db
    .prepare(
      `SELECT e.*,
         u.display_name as created_by_name,
         fl.name as from_location_name, fv.unit_number as from_unit,
         tl.name as to_location_name, tv.unit_number as to_unit,
         fu.display_name as from_user_name,
         tu.display_name as to_user_name
       FROM company_asset_events e
       LEFT JOIN users u ON u.id = e.created_by_user_id
       LEFT JOIN stock_locations fl ON fl.id = e.from_location_id
       LEFT JOIN vehicles fv ON fv.id = fl.vehicle_id
       LEFT JOIN stock_locations tl ON tl.id = e.to_location_id
       LEFT JOIN vehicles tv ON tv.id = tl.vehicle_id
       LEFT JOIN users fu ON fu.id = e.from_user_id
       LEFT JOIN users tu ON tu.id = e.to_user_id
       WHERE e.asset_id = ?
       ORDER BY e.created_at DESC
       LIMIT 100`
    )
    .bind(id)
    .all();

  return { asset, events: events.results || [] };
}

export async function createAsset(
  db: D1Database,
  userId: number,
  body: {
    name: string;
    category: AssetCategory;
    asset_tag?: string | null;
    subcategory?: string | null;
    serial_number?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    location_id?: number | null;
    condition?: AssetCondition;
    condition_notes?: string | null;
    notes?: string | null;
    issued_to_user_id?: number | null;
  }
): Promise<number> {
  const name = body.name?.trim();
  if (!name) throw new Error("Name is required");
  const cat = body.category || "tool";
  if (!["ladder", "dolly", "tool", "other"].includes(cat)) {
    throw new Error("Invalid category");
  }
  const condition = body.condition && isValidCondition(body.condition) ? body.condition : "good";
  const locationId = body.location_id || (await getWarehouseLocationId(db));
  const tag = body.asset_tag?.trim() || null;
  const issuedTo = body.issued_to_user_id || null;
  const loc = await db
    .prepare(`SELECT type FROM stock_locations WHERE id = ?`)
    .bind(locationId)
    .first<{ type: string }>();
  const isTruck = loc?.type === "vehicle";

  const r = await db
    .prepare(
      `INSERT INTO company_assets (
         asset_tag, name, category, subcategory, serial_number, manufacturer, model,
         status, location_id, condition, condition_date, condition_notes,
         issued_at, issued_to_user_id, notes, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'in_service', ?, ?, date('now'), ?,
         ${isTruck ? "datetime('now')" : "NULL"}, ?, ?, 1)`
    )
    .bind(
      tag,
      name,
      cat,
      body.subcategory?.trim() || null,
      body.serial_number?.trim() || null,
      body.manufacturer?.trim() || null,
      body.model?.trim() || null,
      locationId,
      condition,
      body.condition_notes?.trim() || null,
      issuedTo,
      body.notes?.trim() || null
    )
    .run();

  const id = Number(r.meta.last_row_id);
  await db
    .prepare(
      `INSERT INTO company_asset_events (
         asset_id, event_type, to_location_id, to_user_id,
         condition_after, notes, created_by_user_id
       ) VALUES (?, 'create', ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      locationId,
      issuedTo,
      condition,
      body.notes?.trim() || `Created ${cat}: ${name}`,
      userId
    )
    .run();
  return id;
}

export async function updateAssetMeta(
  db: D1Database,
  id: number,
  patch: Record<string, unknown>
): Promise<void> {
  const allowed = [
    "asset_tag",
    "name",
    "category",
    "subcategory",
    "serial_number",
    "manufacturer",
    "model",
    "status",
    "notes",
    "photo_key",
    "active",
  ] as const;
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(patch[k] === "" ? null : patch[k]);
    }
  }
  if (vals.length === 0) return;
  vals.push(id);
  await db
    .prepare(`UPDATE company_assets SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

async function logAssetEvent(
  db: D1Database,
  opts: {
    asset_id: number;
    event_type: string;
    user_id: number;
    from_location_id?: number | null;
    to_location_id?: number | null;
    from_user_id?: number | null;
    to_user_id?: number | null;
    condition_before?: string | null;
    condition_after?: string | null;
    notes?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO company_asset_events (
         asset_id, event_type, from_location_id, to_location_id,
         from_user_id, to_user_id, condition_before, condition_after,
         notes, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      opts.asset_id,
      opts.event_type,
      opts.from_location_id ?? null,
      opts.to_location_id ?? null,
      opts.from_user_id ?? null,
      opts.to_user_id ?? null,
      opts.condition_before ?? null,
      opts.condition_after ?? null,
      opts.notes?.trim() || null,
      opts.user_id
    )
    .run();
}

export async function issueAsset(
  db: D1Database,
  userId: number,
  assetId: number,
  toLocationId: number,
  condition: AssetCondition,
  notes?: string | null,
  toUserId?: number | null
): Promise<void> {
  if (!isValidCondition(condition)) throw new Error("Invalid condition");
  const asset = await db
    .prepare(`SELECT * FROM company_assets WHERE id = ? AND active = 1`)
    .bind(assetId)
    .first<{
      id: number;
      location_id: number | null;
      condition: string;
      issued_to_user_id: number | null;
      name: string;
    }>();
  if (!asset) throw new Error("Asset not found");

  const loc = await db
    .prepare(
      `SELECT id, type FROM stock_locations WHERE id = ? AND active = 1`
    )
    .bind(toLocationId)
    .first<{ id: number; type: string }>();
  if (!loc) throw new Error("Location not found");

  await db
    .prepare(
      `UPDATE company_assets SET
         location_id = ?,
         condition = ?,
         condition_date = date('now'),
         condition_notes = ?,
         issued_at = datetime('now'),
         issued_to_user_id = ?,
         status = 'in_service',
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(
      toLocationId,
      condition,
      notes?.trim() || null,
      toUserId || null,
      assetId
    )
    .run();

  await logAssetEvent(db, {
    asset_id: assetId,
    event_type: "issue",
    user_id: userId,
    from_location_id: asset.location_id,
    to_location_id: toLocationId,
    from_user_id: asset.issued_to_user_id,
    to_user_id: toUserId || null,
    condition_before: asset.condition,
    condition_after: condition,
    notes: notes || `Issued ${asset.name}`,
  });
}

export async function returnAsset(
  db: D1Database,
  userId: number,
  assetId: number,
  condition: AssetCondition,
  notes?: string | null
): Promise<void> {
  if (!isValidCondition(condition)) throw new Error("Invalid condition");
  const asset = await db
    .prepare(`SELECT * FROM company_assets WHERE id = ? AND active = 1`)
    .bind(assetId)
    .first<{
      id: number;
      location_id: number | null;
      condition: string;
      issued_to_user_id: number | null;
      name: string;
    }>();
  if (!asset) throw new Error("Asset not found");
  const warehouseId = await getWarehouseLocationId(db);

  await db
    .prepare(
      `UPDATE company_assets SET
         location_id = ?,
         condition = ?,
         condition_date = date('now'),
         condition_notes = ?,
         issued_at = NULL,
         issued_to_user_id = NULL,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(warehouseId, condition, notes?.trim() || null, assetId)
    .run();

  await logAssetEvent(db, {
    asset_id: assetId,
    event_type: "return",
    user_id: userId,
    from_location_id: asset.location_id,
    to_location_id: warehouseId,
    from_user_id: asset.issued_to_user_id,
    condition_before: asset.condition,
    condition_after: condition,
    notes: notes || `Returned ${asset.name} to warehouse`,
  });
}

export async function transferAsset(
  db: D1Database,
  userId: number,
  assetId: number,
  toLocationId: number,
  notes?: string | null,
  toUserId?: number | null
): Promise<void> {
  const asset = await db
    .prepare(`SELECT * FROM company_assets WHERE id = ? AND active = 1`)
    .bind(assetId)
    .first<{
      id: number;
      location_id: number | null;
      condition: string;
      issued_to_user_id: number | null;
      name: string;
    }>();
  if (!asset) throw new Error("Asset not found");
  const loc = await db
    .prepare(`SELECT id, type FROM stock_locations WHERE id = ? AND active = 1`)
    .bind(toLocationId)
    .first<{ id: number; type: string }>();
  if (!loc) throw new Error("Location not found");

  const isTruck = loc.type === "vehicle";
  await db
    .prepare(
      `UPDATE company_assets SET
         location_id = ?,
         issued_at = ${isTruck ? "COALESCE(issued_at, datetime('now'))" : "NULL"},
         issued_to_user_id = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(toLocationId, isTruck ? toUserId || asset.issued_to_user_id : null, assetId)
    .run();

  await logAssetEvent(db, {
    asset_id: assetId,
    event_type: "transfer",
    user_id: userId,
    from_location_id: asset.location_id,
    to_location_id: toLocationId,
    from_user_id: asset.issued_to_user_id,
    to_user_id: toUserId || null,
    condition_before: asset.condition,
    condition_after: asset.condition,
    notes: notes || `Transferred ${asset.name}`,
  });
}

export async function updateAssetCondition(
  db: D1Database,
  userId: number,
  assetId: number,
  condition: AssetCondition,
  notes: string,
  isDamage = false
): Promise<void> {
  if (!isValidCondition(condition)) throw new Error("Invalid condition");
  if (!notes?.trim()) throw new Error("Notes required when updating condition");

  const asset = await db
    .prepare(`SELECT * FROM company_assets WHERE id = ? AND active = 1`)
    .bind(assetId)
    .first<{
      id: number;
      location_id: number | null;
      condition: string;
      name: string;
      status: string;
    }>();
  if (!asset) throw new Error("Asset not found");

  const bad = ["poor", "damaged", "out_of_service"].includes(condition);
  const nextStatus =
    condition === "out_of_service"
      ? "repair"
      : condition === "damaged" && asset.status === "in_service"
        ? "repair"
        : asset.status;

  await db
    .prepare(
      `UPDATE company_assets SET
         condition = ?,
         condition_date = date('now'),
         condition_notes = ?,
         status = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(condition, notes.trim(), nextStatus, assetId)
    .run();

  await logAssetEvent(db, {
    asset_id: assetId,
    event_type: isDamage || bad ? "damage" : "condition",
    user_id: userId,
    from_location_id: asset.location_id,
    to_location_id: asset.location_id,
    condition_before: asset.condition,
    condition_after: condition,
    notes: notes.trim(),
  });
}

export async function truckAssetsBundle(
  db: D1Database,
  vehicleId: number
): Promise<{
  location: { id: number; name: string; unit_number: string | null } | null;
  bottles: unknown[];
  assets: unknown[];
}> {
  await ensureCompanyAssets(db);
  const loc = await db
    .prepare(
      `SELECT l.id, l.name, v.unit_number
       FROM stock_locations l
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.type = 'vehicle' AND l.vehicle_id = ? AND l.active = 1
       LIMIT 1`
    )
    .bind(vehicleId)
    .first<{ id: number; name: string; unit_number: string | null }>();

  if (!loc) return { location: null, bottles: [], assets: [] };

  const bottles = await db
    .prepare(
      `SELECT b.*, t.code, t.name as bottle_name
       FROM bottle_balances b
       JOIN bottle_types t ON t.id = b.bottle_type_id
       WHERE b.location_id = ? AND t.active = 1
       ORDER BY t.sort_order`
    )
    .bind(loc.id)
    .all();

  const assets = await listAssets(db, { location_id: loc.id });
  return {
    location: loc,
    bottles: bottles.results || [],
    assets,
  };
}
