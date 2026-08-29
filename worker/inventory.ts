/**
 * Inventory helpers — catalog from ServiceTitan Materials export + multi-location qty.
 */

export type StockLocationType = "warehouse" | "attic" | "vehicle";

export interface PartImportVendor {
  vendor_name: string;
  vendor_part_number?: string | null;
  cost?: number | null;
  available?: boolean | number;
  is_primary?: boolean;
  notes?: string | null;
}

export interface PartImportRow {
  external_st_id?: string | number | null;
  code: string;
  name: string;
  description_text?: string | null;
  category?: string | null;
  cost?: number | null;
  price?: number | null;
  unit_of_measure?: string | null;
  is_inventory?: boolean | number | null;
  active?: boolean | number | null;
  primary_vendor?: string | null;
  image_url?: string | null;
  vendors?: PartImportVendor[];
}

function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const t = String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

function boolish(v: unknown, defaultVal = true): number {
  if (v === null || v === undefined || v === "") return defaultVal ? 1 : 0;
  if (v === true || v === 1 || v === "1") return 1;
  if (v === false || v === 0 || v === "0") return 0;
  return defaultVal ? 1 : 0;
}

export type WarehouseZone = "main" | "overhead" | "attic" | "other" | "truck";

/**
 * Ensure default Warehouse + Attic exist; add missing vehicle locations only.
 * Fast path: skips full vehicle re-scan / truck-part seeding (was O(trucks×parts) every page load).
 */
export async function ensureStockLocations(db: D1Database): Promise<void> {
  // Only merge true duplicates of the *default* names — never collapse custom sections
  await dedupeDefaultNamedLocations(db);

  const warehouse = await db
    .prepare(
      `SELECT id FROM stock_locations WHERE type = 'warehouse' AND active = 1 LIMIT 1`
    )
    .first<{ id: number }>();
  if (!warehouse) {
    try {
      await db
        .prepare(
          `INSERT INTO stock_locations (type, vehicle_id, name, active, zone, sort_order)
           VALUES ('warehouse', NULL, 'Warehouse', 1, 'main', 0)`
        )
        .run();
    } catch {
      await db
        .prepare(
          `INSERT INTO stock_locations (type, vehicle_id, name, active)
           VALUES ('warehouse', NULL, 'Warehouse', 1)`
        )
        .run();
    }
  }

  const attic = await db
    .prepare(`SELECT id FROM stock_locations WHERE type = 'attic' AND active = 1 LIMIT 1`)
    .first<{ id: number }>();
  if (!attic) {
    try {
      await db
        .prepare(
          `INSERT INTO stock_locations (type, vehicle_id, name, active, zone, sort_order)
           VALUES ('attic', NULL, 'Attic', 1, 'attic', 10)`
        )
        .run();
    } catch {
      await db
        .prepare(
          `INSERT INTO stock_locations (type, vehicle_id, name, active)
           VALUES ('attic', NULL, 'Attic', 1)`
        )
        .run();
    }
  }

  // Only create stock rows for trucks that do not have one yet (no mass balance seed)
  try {
    const missing = await db
      .prepare(
        `SELECT v.id, v.unit_number FROM vehicles v
         WHERE v.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM stock_locations l
             WHERE l.type = 'vehicle' AND l.vehicle_id = v.id
           )`
      )
      .all<{ id: number; unit_number: string }>();
    for (const v of missing.results || []) {
      await ensureVehicleStockLocation(db, v.id, v.unit_number, { seedTruckParts: false });
    }
  } catch {
    /* vehicles / locations may be missing mid-migration */
  }
}

/** Create (or refresh name for) one truck stock location when a vehicle is added/updated. */
export async function ensureVehicleStockLocation(
  db: D1Database,
  vehicleId: number,
  unitNumber: string,
  opts?: { seedTruckParts?: boolean }
): Promise<number | null> {
  const seed = opts?.seedTruckParts === true;
  await db
    .prepare(
      `INSERT OR IGNORE INTO stock_locations (type, vehicle_id, name, active)
       VALUES ('vehicle', ?, ?, 1)`
    )
    .bind(vehicleId, `Unit ${unitNumber}`)
    .run();
  try {
    await db
      .prepare(
        `UPDATE stock_locations SET name = ?, active = 1, zone = 'truck'
         WHERE type = 'vehicle' AND vehicle_id = ?`
      )
      .bind(`Unit ${unitNumber}`, vehicleId)
      .run();
  } catch {
    await db
      .prepare(
        `UPDATE stock_locations SET name = ?, active = 1 WHERE type = 'vehicle' AND vehicle_id = ?`
      )
      .bind(`Unit ${unitNumber}`, vehicleId)
      .run();
  }
  const loc = await db
    .prepare(
      `SELECT id FROM stock_locations WHERE type = 'vehicle' AND vehicle_id = ? LIMIT 1`
    )
    .bind(vehicleId)
    .first<{ id: number }>();
  if (!loc) return null;

  // Seed zero balances only when explicitly requested (new vehicle or truck-stock toggle)
  if (seed) {
    try {
      const truckParts = await db
        .prepare(`SELECT id FROM parts WHERE active = 1 AND truck_stock = 1`)
        .all<{ id: number }>();
      for (const p of truckParts.results || []) {
        await db
          .prepare(
            `INSERT OR IGNORE INTO stock_balances (location_id, part_id, qty, updated_at)
             VALUES (?, ?, 0, datetime('now'))`
          )
          .bind(loc.id, p.id)
          .run();
      }
    } catch {
      /* truck_stock column may not exist yet */
    }
  }
  return loc.id;
}

/** Create a named warehouse section (shelf, overhead bay, attic rack, etc.). */
export async function createWarehouseSection(
  db: D1Database,
  input: {
    name: string;
    zone?: WarehouseZone | string | null;
    type?: "warehouse" | "attic";
    notes?: string | null;
    sort_order?: number;
  }
): Promise<{ id: number; name: string; type: string; zone: string | null }> {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Section name required");
  if (name.length > 80) throw new Error("Section name too long (max 80)");

  const zoneRaw = String(input.zone || "main").toLowerCase().trim();
  const zone: WarehouseZone =
    zoneRaw === "attic" || zoneRaw === "overhead" || zoneRaw === "other" || zoneRaw === "main"
      ? zoneRaw
      : "main";
  const type: "warehouse" | "attic" =
    input.type === "attic" || zone === "attic" ? "attic" : "warehouse";
  const sort =
    input.sort_order != null && Number.isFinite(Number(input.sort_order))
      ? Number(input.sort_order)
      : zone === "attic"
        ? 10
        : zone === "overhead"
          ? 5
          : 0;
  const notes = input.notes?.trim() || null;

  // Avoid exact-name dups (case-insensitive) among active non-vehicle locations
  const existing = await db
    .prepare(
      `SELECT id, name, type, zone FROM stock_locations
       WHERE active = 1 AND type IN ('warehouse', 'attic') AND lower(name) = lower(?)
       LIMIT 1`
    )
    .bind(name)
    .first<{ id: number; name: string; type: string; zone: string | null }>();
  if (existing) {
    throw new Error(`Section “${existing.name}” already exists`);
  }

  try {
    const r = await db
      .prepare(
        `INSERT INTO stock_locations (type, vehicle_id, name, active, zone, sort_order, notes)
         VALUES (?, NULL, ?, 1, ?, ?, ?)`
      )
      .bind(type, name, zone, sort, notes)
      .run();
    const id = Number(r.meta.last_row_id);
    return { id, name, type, zone };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such column/i.test(msg)) {
      const r = await db
        .prepare(
          `INSERT INTO stock_locations (type, vehicle_id, name, active)
           VALUES (?, NULL, ?, 1)`
        )
        .bind(type, name)
        .run();
      return { id: Number(r.meta.last_row_id), name, type, zone };
    }
    throw e;
  }
}

/** Soft-deactivate a non-vehicle section (does not delete history). */
export async function deactivateWarehouseSection(
  db: D1Database,
  locationId: number
): Promise<void> {
  const loc = await db
    .prepare(`SELECT id, type, name FROM stock_locations WHERE id = ?`)
    .bind(locationId)
    .first<{ id: number; type: string; name: string }>();
  if (!loc) throw new Error("Location not found");
  if (loc.type === "vehicle") throw new Error("Cannot remove truck locations here");

  const remaining = await db
    .prepare(
      `SELECT COUNT(*) as c FROM stock_locations
       WHERE active = 1 AND type IN ('warehouse', 'attic') AND id != ?`
    )
    .bind(locationId)
    .first<{ c: number }>();
  if ((remaining?.c ?? 0) < 1) {
    throw new Error("Keep at least one warehouse / attic location");
  }

  // Clear home pointers that referenced this section
  try {
    await db
      .prepare(
        `UPDATE parts SET home_location_id = NULL, updated_at = datetime('now')
         WHERE home_location_id = ?`
      )
      .bind(locationId)
      .run();
  } catch {
    /* column may not exist yet */
  }

  await db
    .prepare(`UPDATE stock_locations SET active = 0 WHERE id = ?`)
    .bind(locationId)
    .run();
}

/** Soft-delete a part in this app (active=0). Call ST deactivate separately. */
export async function softDeletePart(
  db: D1Database,
  partId: number
): Promise<{ code: string; name: string; external_st_id: string | null }> {
  const part = await db
    .prepare(`SELECT id, code, name, external_st_id, active FROM parts WHERE id = ?`)
    .bind(partId)
    .first<{
      id: number;
      code: string;
      name: string;
      external_st_id: string | null;
      active: number;
    }>();
  if (!part) throw new Error("Part not found");
  if (part.active === 0) {
    return {
      code: part.code,
      name: part.name,
      external_st_id: part.external_st_id,
    };
  }
  await db
    .prepare(`UPDATE parts SET active = 0, updated_at = datetime('now') WHERE id = ?`)
    .bind(partId)
    .run();
  return {
    code: part.code,
    name: part.name,
    external_st_id: part.external_st_id,
  };
}

/**
 * Turn truck-stock on/off for a part.
 * ON  → ensure balance row (qty 0) on every active truck location
 * OFF → remove this part from all truck locations (warehouse/attic untouched)
 */
export async function setPartTruckStock(
  db: D1Database,
  partId: number,
  enabled: boolean
): Promise<{ truck_locations: number }> {
  await ensureStockLocations(db);

  try {
    await db
      .prepare(`UPDATE parts SET truck_stock = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(enabled ? 1 : 0, partId)
      .run();
  } catch (e) {
    throw new Error(
      e instanceof Error && /no such column/i.test(e.message)
        ? "Run migration 021_truck_stock.sql"
        : e instanceof Error
          ? e.message
          : "Could not update truck_stock"
    );
  }

  const truckLocs = await db
    .prepare(
      `SELECT id FROM stock_locations WHERE type = 'vehicle' AND active = 1`
    )
    .all<{ id: number }>();
  const locs = truckLocs.results || [];

  if (enabled) {
    for (const loc of locs) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO stock_balances (location_id, part_id, qty, updated_at)
           VALUES (?, ?, 0, datetime('now'))`
        )
        .bind(loc.id, partId)
        .run();
    }
  } else {
    for (const loc of locs) {
      await db
        .prepare(`DELETE FROM stock_balances WHERE location_id = ? AND part_id = ?`)
        .bind(loc.id, partId)
        .run();
    }
  }

  return { truck_locations: locs.length };
}

/**
 * Merge only accidental duplicate *default* Warehouse / Attic rows that share the same name.
 * Custom named sections (shelves, overheads) are never collapsed.
 */
async function dedupeDefaultNamedLocations(db: D1Database): Promise<void> {
  for (const type of ["warehouse", "attic"] as const) {
    const defaultName = type === "warehouse" ? "Warehouse" : "Attic";
    const rows = await db
      .prepare(
        `SELECT id FROM stock_locations
         WHERE type = ? AND lower(trim(name)) = lower(?)
         ORDER BY id ASC`
      )
      .bind(type, defaultName)
      .all<{ id: number }>();
    const ids = (rows.results || []).map((r) => r.id);
    if (ids.length <= 1) continue;

    const keepId = ids[0];
    const dropIds = ids.slice(1);

    for (const dropId of dropIds) {
      try {
        const bals = await db
          .prepare(`SELECT part_id, qty FROM stock_balances WHERE location_id = ?`)
          .bind(dropId)
          .all<{ part_id: number; qty: number }>();
        for (const b of bals.results || []) {
          const existing = await db
            .prepare(
              `SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`
            )
            .bind(keepId, b.part_id)
            .first<{ qty: number }>();
          if (existing) {
            await db
              .prepare(
                `UPDATE stock_balances SET qty = ?, updated_at = datetime('now')
                 WHERE location_id = ? AND part_id = ?`
              )
              .bind(Number(existing.qty || 0) + Number(b.qty || 0), keepId, b.part_id)
              .run();
            await db
              .prepare(
                `DELETE FROM stock_balances WHERE location_id = ? AND part_id = ?`
              )
              .bind(dropId, b.part_id)
              .run();
          } else {
            await db
              .prepare(
                `UPDATE stock_balances SET location_id = ? WHERE location_id = ? AND part_id = ?`
              )
              .bind(keepId, dropId, b.part_id)
              .run();
          }
        }
      } catch {
        /* balances may not exist yet */
      }
      try {
        await db
          .prepare(
            `UPDATE stock_movements SET from_location_id = ? WHERE from_location_id = ?`
          )
          .bind(keepId, dropId)
          .run();
        await db
          .prepare(
            `UPDATE stock_movements SET to_location_id = ? WHERE to_location_id = ?`
          )
          .bind(keepId, dropId)
          .run();
      } catch {
        /* ok */
      }
      await db.prepare(`DELETE FROM stock_locations WHERE id = ?`).bind(dropId).run();
    }
  }
}

export interface PartVendorRow {
  id: number;
  part_id: number;
  vendor_name: string;
  vendor_part_number: string | null;
  cost: number | null;
  available: number;
  notes: string | null;
  updated_at?: string;
}

/**
 * Pick default vendor among *available* quotes only, then lowest cost.
 * Quotes without a cost rank after ones with a cost. Ties: name A→Z.
 * Returns null if nobody is available.
 */
export function pickDefaultVendor(
  vendors: Array<{
    vendor_name: string;
    cost: number | null;
    available: number | boolean;
  }>
): { vendor_name: string; cost: number | null } | null {
  const available = vendors.filter((v) => v.available === true || v.available === 1);
  if (!available.length) return null;
  const ranked = [...available].sort((a, b) => {
    const aCost = a.cost != null && Number.isFinite(Number(a.cost)) ? Number(a.cost) : null;
    const bCost = b.cost != null && Number.isFinite(Number(b.cost)) ? Number(b.cost) : null;
    if (aCost != null && bCost != null && aCost !== bCost) return aCost - bCost;
    if (aCost != null && bCost == null) return -1;
    if (aCost == null && bCost != null) return 1;
    return a.vendor_name.localeCompare(b.vendor_name);
  });
  const best = ranked[0];
  return {
    vendor_name: best.vendor_name,
    cost: best.cost != null && Number.isFinite(Number(best.cost)) ? Number(best.cost) : null,
  };
}

/** Write parts.primary_vendor + parts.cost from part_vendors (cheapest available). */
export async function applyDefaultVendor(
  db: D1Database,
  partId: number
): Promise<{ vendor_name: string; cost: number | null } | null> {
  const rows = await db
    .prepare(
      `SELECT vendor_name, cost, available FROM part_vendors WHERE part_id = ? ORDER BY vendor_name`
    )
    .bind(partId)
    .all<{ vendor_name: string; cost: number | null; available: number }>();
  const list = rows.results || [];
  if (!list.length) return null;
  const best = pickDefaultVendor(list);
  if (!best) {
    // All marked unavailable — clear default so order report does not pretend we can buy
    await db
      .prepare(
        `UPDATE parts SET primary_vendor = NULL, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(partId)
      .run();
    return null;
  }
  await db
    .prepare(
      `UPDATE parts SET primary_vendor = ?, cost = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .bind(best.vendor_name, best.cost, partId)
    .run();
  return best;
}

/** Upsert a vendor quote for a part, then refresh default. */
export async function upsertPartVendor(
  db: D1Database,
  partId: number,
  input: {
    vendor_name: string;
    vendor_part_number?: string | null;
    cost?: number | null;
    available?: boolean | number;
    notes?: string | null;
  }
): Promise<PartVendorRow | null> {
  const name = String(input.vendor_name || "").trim();
  if (!name) throw new Error("vendor_name required");
  const cost =
    input.cost != null && input.cost !== ("" as unknown) && Number.isFinite(Number(input.cost))
      ? Number(input.cost)
      : null;
  const available = boolish(input.available, true);
  const vpn = input.vendor_part_number?.trim() || null;
  const notes = input.notes?.trim() || null;

  await db
    .prepare(
      `INSERT INTO part_vendors (part_id, vendor_name, vendor_part_number, cost, available, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(part_id, vendor_name) DO UPDATE SET
         vendor_part_number = COALESCE(excluded.vendor_part_number, part_vendors.vendor_part_number),
         cost = excluded.cost,
         available = excluded.available,
         notes = COALESCE(excluded.notes, part_vendors.notes),
         updated_at = datetime('now')`
    )
    .bind(partId, name, vpn, cost, available, notes)
    .run();

  await applyDefaultVendor(db, partId);

  return db
    .prepare(`SELECT * FROM part_vendors WHERE part_id = ? AND vendor_name = ?`)
    .bind(partId, name)
    .first<PartVendorRow>();
}

export async function deletePartVendor(db: D1Database, partId: number, vendorId: number): Promise<void> {
  await db
    .prepare(`DELETE FROM part_vendors WHERE id = ? AND part_id = ?`)
    .bind(vendorId, partId)
    .run();
  const remaining = await db
    .prepare(`SELECT COUNT(*) as c FROM part_vendors WHERE part_id = ?`)
    .bind(partId)
    .first<{ c: number }>();
  if ((remaining?.c ?? 0) > 0) {
    await applyDefaultVendor(db, partId);
  } else {
    // Leave primary_vendor/cost as last known unless you want to clear — clear vendor only
    await db
      .prepare(`UPDATE parts SET primary_vendor = NULL, updated_at = datetime('now') WHERE id = ?`)
      .bind(partId)
      .run();
  }
}

/**
 * Import ST Materials rows.
 * - insert_only: never create a second row for an existing code / ST id; skip batch dups
 * - upsert: update existing catalog fields (still does not wipe qty / min / max)
 *
 * Optimized for Worker time limits: preload existing keys, one write path per row,
 * light vendor upsert (no re-select + default refresh per vendor).
 */
export type ImportPartResult = {
  code: string;
  id: number | null;
  status: "inserted" | "updated" | "skipped" | "duplicate" | "error";
  image_url?: string | null;
  error?: string;
};

/** Cap description so large ST HTML does not blow request/DB time. */
function clipDesc(s: string | null | undefined, max = 2000): string | null {
  const t = stripHtml(s);
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** Vendor upsert without applyDefaultVendor (import uses cheaper default later). */
async function upsertPartVendorLight(
  db: D1Database,
  partId: number,
  input: {
    vendor_name: string;
    vendor_part_number?: string | null;
    cost?: number | null;
    available?: boolean | number;
    notes?: string | null;
  }
): Promise<void> {
  const name = String(input.vendor_name || "").trim();
  if (!name) return;
  const cost =
    input.cost != null && Number.isFinite(Number(input.cost)) ? Number(input.cost) : null;
  const available = boolish(input.available, true);
  const vpn = input.vendor_part_number?.trim() || null;
  const notes = input.notes?.trim() || null;
  await db
    .prepare(
      `INSERT INTO part_vendors (part_id, vendor_name, vendor_part_number, cost, available, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(part_id, vendor_name) DO UPDATE SET
         vendor_part_number = COALESCE(excluded.vendor_part_number, part_vendors.vendor_part_number),
         cost = excluded.cost,
         available = excluded.available,
         notes = COALESCE(excluded.notes, part_vendors.notes),
         updated_at = datetime('now')`
    )
    .bind(partId, name, vpn, cost, available, notes)
    .run();
}

export async function importParts(
  db: D1Database,
  rows: PartImportRow[],
  opts?: { mode?: "insert_only" | "upsert" }
): Promise<{
  inserted: number;
  updated: number;
  skipped: number;
  duplicates: number;
  errors: number;
  results: ImportPartResult[];
}> {
  const mode = opts?.mode || "insert_only";
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let duplicates = 0;
  let errors = 0;
  const seenCodes = new Set<string>();
  const seenExternal = new Set<string>();
  const results: ImportPartResult[] = [];

  // One read: existing catalog map (avoids SELECT per row — was timing out at ~200 rows)
  const existingRows = await db
    .prepare(`SELECT id, code, external_st_id FROM parts`)
    .all<{ id: number; code: string; external_st_id: string | null }>();
  const byCode = new Map<string, number>();
  const byExternal = new Map<string, number>();
  for (const r of existingRows.results || []) {
    if (r.code) byCode.set(String(r.code).toLowerCase(), r.id);
    if (r.external_st_id) byExternal.set(String(r.external_st_id).trim(), r.id);
  }

  for (const row of rows) {
    const code = String(row.code || "").trim();
    const name = String(row.name || "").trim();
    if (!code || !name) {
      skipped++;
      results.push({ code: code || "(blank)", id: null, status: "skipped" });
      continue;
    }
    const codeKey = code.toLowerCase();
    const external =
      row.external_st_id != null && String(row.external_st_id).trim() !== ""
        ? String(row.external_st_id).trim()
        : null;
    const rowImage =
      row.image_url != null && String(row.image_url).trim() !== ""
        ? String(row.image_url).trim()
        : null;

    // De-dupe within this batch
    if (seenCodes.has(codeKey) || (external && seenExternal.has(external))) {
      duplicates++;
      skipped++;
      results.push({ code, id: null, status: "duplicate", image_url: rowImage });
      continue;
    }
    seenCodes.add(codeKey);
    if (external) seenExternal.add(external);

    const desc = clipDesc(row.description_text);
    const category = row.category
      ? String(row.category).replace(/\n+/g, " · ").trim().slice(0, 500)
      : null;
    const cost = row.cost != null && Number.isFinite(Number(row.cost)) ? Number(row.cost) : null;
    const price = row.price != null && Number.isFinite(Number(row.price)) ? Number(row.price) : null;
    const uom = row.unit_of_measure ? String(row.unit_of_measure).trim().slice(0, 50) : null;
    const isInv = boolish(row.is_inventory, true);
    const active = boolish(row.active, true);
    const vendor = row.primary_vendor ? String(row.primary_vendor).trim().slice(0, 200) : null;
    const imageUrl = rowImage;

    const existingId =
      byCode.get(codeKey) ?? (external ? byExternal.get(external) : undefined) ?? null;

    let partId: number;

    try {
      if (existingId != null) {
        if (mode === "insert_only") {
          duplicates++;
          skipped++;
          results.push({
            code,
            id: existingId,
            status: "skipped",
            image_url: rowImage,
          });
          continue;
        }
        try {
          await db
            .prepare(
              `UPDATE parts SET
                external_st_id = COALESCE(?, external_st_id),
                code = ?, name = ?, description_text = ?, category = ?,
                price = ?, unit_of_measure = ?,
                is_inventory = ?, active = ?,
                cost = COALESCE(?, cost),
                primary_vendor = COALESCE(?, primary_vendor),
                image_url = COALESCE(?, image_url),
                updated_at = datetime('now')
               WHERE id = ?`
            )
            .bind(
              external,
              code,
              name,
              desc,
              category,
              price,
              uom,
              isInv,
              active,
              cost,
              vendor,
              imageUrl,
              existingId
            )
            .run();
        } catch {
          await db
            .prepare(
              `UPDATE parts SET
                external_st_id = COALESCE(?, external_st_id),
                code = ?, name = ?, description_text = ?, category = ?,
                price = ?, unit_of_measure = ?,
                is_inventory = ?, active = ?,
                cost = COALESCE(?, cost),
                primary_vendor = COALESCE(?, primary_vendor),
                updated_at = datetime('now')
               WHERE id = ?`
            )
            .bind(
              external,
              code,
              name,
              desc,
              category,
              price,
              uom,
              isInv,
              active,
              cost,
              vendor,
              existingId
            )
            .run();
        }
        partId = existingId;
        updated++;
        results.push({ code, id: partId, status: "updated", image_url: imageUrl || rowImage });
      } else {
        let ins;
        try {
          ins = await db
            .prepare(
              `INSERT INTO parts
                (external_st_id, code, name, description_text, category, cost, price,
                 unit_of_measure, is_inventory, active, primary_vendor, image_url)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              external,
              code,
              name,
              desc,
              category,
              cost,
              price,
              uom,
              isInv,
              active,
              vendor,
              imageUrl
            )
            .run();
        } catch (e1) {
          // Fallback without image_url column
          try {
            ins = await db
              .prepare(
                `INSERT INTO parts
                  (external_st_id, code, name, description_text, category, cost, price,
                   unit_of_measure, is_inventory, active, primary_vendor)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(external, code, name, desc, category, cost, price, uom, isInv, active, vendor)
              .run();
          } catch (e2) {
            const msg = e2 instanceof Error ? e2.message : String(e2);
            if (/unique|constraint/i.test(msg)) {
              duplicates++;
              skipped++;
              results.push({ code, id: null, status: "duplicate", image_url: rowImage });
              continue;
            }
            throw e2;
          }
        }
        partId = Number(ins.meta.last_row_id);
        inserted++;
        byCode.set(codeKey, partId);
        if (external) byExternal.set(external, partId);
        results.push({ code, id: partId, status: "inserted", image_url: imageUrl || rowImage });
      }

      // Vendors (light path — no SELECT + default per quote)
      if (partId) {
        const vendorList =
          row.vendors && row.vendors.length
            ? row.vendors
            : vendor
              ? [
                  {
                    vendor_name: vendor,
                    cost,
                    available: true,
                    vendor_part_number: null as string | null,
                    notes: "From ServiceTitan import",
                  },
                ]
              : [];

        // Prefer cheapest available from payload for parts.primary_vendor/cost (no extra queries)
        let bestName = vendor;
        let bestCost = cost;
        for (const v of vendorList) {
          if (!v.vendor_name?.trim()) continue;
          try {
            await upsertPartVendorLight(db, partId, {
              vendor_name: v.vendor_name.trim(),
              cost: v.cost != null ? v.cost : null,
              available: v.available !== false && v.available !== 0,
              vendor_part_number: v.vendor_part_number || null,
              notes: v.notes || "From ServiceTitan import",
            });
          } catch {
            /* part_vendors missing or conflict — ignore */
          }
          const vAvail = v.available !== false && v.available !== 0;
          const vCost = v.cost != null && Number.isFinite(Number(v.cost)) ? Number(v.cost) : null;
          if (vAvail && vCost != null && (bestCost == null || vCost < bestCost)) {
            bestName = v.vendor_name.trim();
            bestCost = vCost;
          }
        }
        if (bestName && mode !== "insert_only") {
          // insert path already set primary on INSERT; upsert may need refresh
          try {
            await db
              .prepare(
                `UPDATE parts SET primary_vendor = ?, cost = COALESCE(?, cost), updated_at = datetime('now') WHERE id = ?`
              )
              .bind(bestName, bestCost, partId)
              .run();
          } catch {
            /* ignore */
          }
        } else if (bestName && bestCost != null && !vendor) {
          try {
            await db
              .prepare(
                `UPDATE parts SET primary_vendor = ?, cost = ?, updated_at = datetime('now') WHERE id = ?`
              )
              .bind(bestName, bestCost, partId)
              .run();
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      errors++;
      skipped++;
      results.push({
        code,
        id: null,
        status: "error",
        image_url: rowImage,
        error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
      });
    }
  }

  return { inserted, updated, skipped, duplicates, errors, results };
}

/**
 * Set absolute qty at a location (cycle count / initial stock).
 * Records a movement for audit.
 */
export async function setStockQty(
  db: D1Database,
  partId: number,
  locationId: number,
  qty: number,
  userId: number | null,
  notes?: string | null
): Promise<void> {
  const prev = await db
    .prepare(`SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`)
    .bind(locationId, partId)
    .first<{ qty: number }>();
  const before = prev?.qty ?? 0;
  const next = Math.max(0, qty);
  const delta = next - before;

  await db
    .prepare(
      `INSERT INTO stock_balances (location_id, part_id, qty, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(location_id, part_id) DO UPDATE SET
         qty = excluded.qty, updated_at = datetime('now')`
    )
    .bind(locationId, partId, next)
    .run();

  if (delta !== 0) {
    await db
      .prepare(
        `INSERT INTO stock_movements
          (part_id, from_location_id, to_location_id, qty, reason, notes, created_by_user_id)
         VALUES (?, ?, ?, ?, 'adjust', ?, ?)`
      )
      .bind(
        partId,
        delta < 0 ? locationId : null,
        delta > 0 ? locationId : null,
        Math.abs(delta),
        notes || `Set qty ${before} → ${next}`,
        userId
      )
      .run();
  }
}

/** Add delta to qty (receive positive / issue negative). */
export async function adjustStockQty(
  db: D1Database,
  partId: number,
  locationId: number,
  delta: number,
  userId: number | null,
  reason = "adjust",
  notes?: string | null
): Promise<number> {
  const prev = await db
    .prepare(`SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`)
    .bind(locationId, partId)
    .first<{ qty: number }>();
  const before = prev?.qty ?? 0;
  const next = Math.max(0, before + delta);

  await db
    .prepare(
      `INSERT INTO stock_balances (location_id, part_id, qty, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(location_id, part_id) DO UPDATE SET
         qty = excluded.qty, updated_at = datetime('now')`
    )
    .bind(locationId, partId, next)
    .run();

  if (delta !== 0) {
    await db
      .prepare(
        `INSERT INTO stock_movements
          (part_id, from_location_id, to_location_id, qty, reason, notes, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        partId,
        delta < 0 ? locationId : null,
        delta > 0 ? locationId : null,
        Math.abs(delta),
        reason,
        notes || null,
        userId
      )
      .run();
  }
  return next;
}

/**
 * Move qty from one location to another (warehouse → truck issue).
 * Fails if from location does not have enough on hand.
 */
export async function transferStock(
  db: D1Database,
  partId: number,
  fromLocationId: number,
  toLocationId: number,
  qty: number,
  userId: number | null,
  notes?: string | null
): Promise<{ from_qty: number; to_qty: number }> {
  const n = Math.abs(Number(qty) || 0);
  if (!n || fromLocationId === toLocationId) {
    throw new Error("Need two locations and a quantity > 0");
  }
  const fromPrev = await db
    .prepare(`SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`)
    .bind(fromLocationId, partId)
    .first<{ qty: number }>();
  const fromBefore = fromPrev?.qty ?? 0;
  if (fromBefore < n) {
    throw new Error(`Only ${fromBefore} available at source location`);
  }
  const fromNext = fromBefore - n;
  const toPrev = await db
    .prepare(`SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`)
    .bind(toLocationId, partId)
    .first<{ qty: number }>();
  const toNext = (toPrev?.qty ?? 0) + n;

  await db
    .prepare(
      `INSERT INTO stock_balances (location_id, part_id, qty, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(location_id, part_id) DO UPDATE SET
         qty = excluded.qty, updated_at = datetime('now')`
    )
    .bind(fromLocationId, partId, fromNext)
    .run();
  await db
    .prepare(
      `INSERT INTO stock_balances (location_id, part_id, qty, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(location_id, part_id) DO UPDATE SET
         qty = excluded.qty, updated_at = datetime('now')`
    )
    .bind(toLocationId, partId, toNext)
    .run();
  await db
    .prepare(
      `INSERT INTO stock_movements
        (part_id, from_location_id, to_location_id, qty, reason, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, 'transfer', ?, ?)`
    )
    .bind(partId, fromLocationId, toLocationId, n, notes || "Issue to truck", userId)
    .run();
  return { from_qty: fromNext, to_qty: toNext };
}

/** Update reorder low (min) / high (max). Null clears the level. */
export async function updatePartLevels(
  db: D1Database,
  partId: number,
  minQty: number | null | undefined,
  maxQty: number | null | undefined
): Promise<void> {
  const sets: string[] = ["updated_at = datetime('now')"];
  const binds: unknown[] = [];
  if (minQty !== undefined) {
    sets.push("min_qty = ?");
    binds.push(minQty != null && Number.isFinite(minQty) ? Math.max(0, minQty) : null);
  }
  if (maxQty !== undefined) {
    sets.push("max_qty = ?");
    binds.push(maxQty != null && Number.isFinite(maxQty) ? Math.max(0, maxQty) : null);
  }
  if (binds.length === 0) return;
  binds.push(partId);
  await db
    .prepare(`UPDATE parts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/**
 * Suggested order qty when below min (low):
 * - if max (high) set → bring up to max
 * - else → bring up to min
 */
export function suggestedOrderQty(
  onHand: number,
  minQty: number | null,
  maxQty: number | null
): number {
  if (minQty == null || !Number.isFinite(minQty)) return 0;
  if (onHand >= minQty) return 0;
  const target = maxQty != null && Number.isFinite(maxQty) && maxQty > 0 ? maxQty : minQty;
  return Math.max(0, Math.ceil(target - onHand));
}

/** Set min/max for a part at one location (truck/warehouse). Null clears. */
export async function updateLocationLevels(
  db: D1Database,
  partId: number,
  locationId: number,
  minQty: number | null | undefined,
  maxQty: number | null | undefined
): Promise<void> {
  const existing = await db
    .prepare(
      `SELECT min_qty, max_qty FROM stock_location_levels WHERE location_id = ? AND part_id = ?`
    )
    .bind(locationId, partId)
    .first<{ min_qty: number | null; max_qty: number | null }>();

  const nextMin =
    minQty !== undefined
      ? minQty != null && Number.isFinite(minQty)
        ? Math.max(0, minQty)
        : null
      : (existing?.min_qty ?? null);
  const nextMax =
    maxQty !== undefined
      ? maxQty != null && Number.isFinite(maxQty)
        ? Math.max(0, maxQty)
        : null
      : (existing?.max_qty ?? null);

  if (nextMin == null && nextMax == null) {
    await db
      .prepare(`DELETE FROM stock_location_levels WHERE location_id = ? AND part_id = ?`)
      .bind(locationId, partId)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO stock_location_levels (location_id, part_id, min_qty, max_qty, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(location_id, part_id) DO UPDATE SET
         min_qty = excluded.min_qty,
         max_qty = excluded.max_qty,
         updated_at = datetime('now')`
    )
    .bind(locationId, partId, nextMin, nextMax)
    .run();
}

/**
 * Low-stock report:
 * - warehouse lines below warehouse (or part default) min
 * - truck lines below per-truck min (or part default for truck_stock parts)
 * Staging list = truck shortfalls for warehouse to pull.
 */
export async function lowStockReport(db: D1Database): Promise<{
  warehouse: Array<{
    part_id: number;
    code: string;
    name: string;
    location_id: number;
    location_name: string;
    qty: number;
    min_qty: number;
    max_qty: number | null;
    order_qty: number;
  }>;
  trucks: Array<{
    part_id: number;
    code: string;
    name: string;
    image_url: string | null;
    location_id: number;
    location_name: string;
    unit_number: string | null;
    qty: number;
    min_qty: number;
    max_qty: number | null;
    stage_qty: number;
  }>;
}> {
  // Effective levels: COALESCE(location override, part default)
  const rows = await db
    .prepare(
      `SELECT
         p.id as part_id, p.code, p.name, p.image_url, p.min_qty as part_min, p.max_qty as part_max,
         p.truck_stock,
         l.id as location_id, l.type as location_type, l.name as location_name,
         v.unit_number,
         COALESCE(b.qty, 0) as qty,
         ll.min_qty as loc_min, ll.max_qty as loc_max
       FROM parts p
       CROSS JOIN stock_locations l
       LEFT JOIN stock_balances b ON b.part_id = p.id AND b.location_id = l.id
       LEFT JOIN stock_location_levels ll ON ll.part_id = p.id AND ll.location_id = l.id
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE p.active = 1 AND l.active = 1
         AND (l.type IN ('warehouse', 'attic') OR (l.type = 'vehicle' AND IFNULL(p.truck_stock, 0) = 1))
       ORDER BY p.name, l.type, l.name`
    )
    .all<{
      part_id: number;
      code: string;
      name: string;
      image_url: string | null;
      part_min: number | null;
      part_max: number | null;
      truck_stock: number;
      location_id: number;
      location_type: string;
      location_name: string;
      unit_number: string | null;
      qty: number;
      loc_min: number | null;
      loc_max: number | null;
    }>();

  const warehouse: Awaited<ReturnType<typeof lowStockReport>>["warehouse"] = [];
  const trucks: Awaited<ReturnType<typeof lowStockReport>>["trucks"] = [];

  for (const r of rows.results || []) {
    const min = r.loc_min != null ? r.loc_min : r.part_min;
    const max = r.loc_max != null ? r.loc_max : r.part_max;
    if (min == null || !Number.isFinite(min)) continue;
    const qty = Number(r.qty) || 0;
    if (qty >= min) continue;
    const need = suggestedOrderQty(qty, min, max);
    if (need <= 0) continue;

    if (r.location_type === "warehouse" || r.location_type === "attic") {
      warehouse.push({
        part_id: r.part_id,
        code: r.code,
        name: r.name,
        location_id: r.location_id,
        location_name: r.location_name,
        qty,
        min_qty: min,
        max_qty: max,
        order_qty: need,
      });
    } else if (r.location_type === "vehicle") {
      trucks.push({
        part_id: r.part_id,
        code: r.code,
        name: r.name,
        image_url: r.image_url || null,
        location_id: r.location_id,
        location_name: r.location_name,
        unit_number: r.unit_number,
        qty,
        min_qty: min,
        max_qty: max,
        stage_qty: need,
      });
    }
  }

  // Stage list: group by truck unit first so warehouse can fill one unit at a time
  trucks.sort((a, b) => {
    const au = String(a.unit_number || a.location_name || "");
    const bu = String(b.unit_number || b.location_name || "");
    const byUnit = au.localeCompare(bu, undefined, { numeric: true, sensitivity: "base" });
    if (byUnit !== 0) return byUnit;
    return (a.name || a.code || "").localeCompare(b.name || b.code || "", undefined, {
      sensitivity: "base",
    });
  });

  warehouse.sort((a, b) => {
    const byLoc = (a.location_name || "").localeCompare(b.location_name || "", undefined, {
      sensitivity: "base",
    });
    if (byLoc !== 0) return byLoc;
    return (a.name || a.code || "").localeCompare(b.name || b.code || "", undefined, {
      sensitivity: "base",
    });
  });

  return { warehouse, trucks };
}

/**
 * Patch name + description_text on existing parts only.
 * Match by code (case-insensitive) or external_st_id, same as importParts.
 * Never writes price, cost, or any other catalog field.
 */
export async function refreshPartNamesDescriptions(
  db: D1Database,
  rows: Array<{
    code?: string | null;
    name?: string | null;
    description_text?: string | null;
    external_st_id?: string | number | null;
  }>
): Promise<{ updated: number; skipped: number; unmatched: number }> {
  let updated = 0;
  let skipped = 0;
  let unmatched = 0;
  const existingRows = await db
    .prepare(`SELECT id, code, external_st_id FROM parts`)
    .all<{ id: number; code: string; external_st_id: string | null }>();
  const byCode = new Map<string, number>();
  const byExternal = new Map<string, number>();
  for (const r of existingRows.results || []) {
    if (r.code) byCode.set(String(r.code).toLowerCase(), r.id);
    if (r.external_st_id) byExternal.set(String(r.external_st_id).trim(), r.id);
  }
  const seen = new Set<number>();
  for (const row of rows) {
    const code = String(row.code || "").trim();
    const name = String(row.name || "").trim();
    if (!name) {
      skipped++;
      continue;
    }
    const codeKey = code.toLowerCase();
    const external =
      row.external_st_id != null && String(row.external_st_id).trim() !== ""
        ? String(row.external_st_id).trim()
        : null;
    const existingId =
      (codeKey ? byCode.get(codeKey) : undefined) ??
      (external ? byExternal.get(external) : undefined) ??
      null;
    if (existingId == null) {
      unmatched++;
      continue;
    }
    if (seen.has(existingId)) {
      skipped++;
      continue;
    }
    seen.add(existingId);
    const desc = clipDesc(row.description_text);
    await db
      .prepare(
        `UPDATE parts SET name = ?, description_text = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(name, desc, existingId)
      .run();
    updated++;
  }
  return { updated, skipped, unmatched };
}
