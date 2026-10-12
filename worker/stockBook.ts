/**
 * One quantity change per physical move.
 * Shop shelf, van, order put-away, and tomorrow's pull.
 */
import {
  adjustStockQty,
  ensureStockLocations,
  ensureVehicleStockLocation,
  issueStockStrict,
  shopBinForPart,
  transferStock,
} from "./inventory";

export type PullShelfNote = { description: string; note: string };

type PartHit = { id: number; code: string | null; name: string | null };

async function onHand(db: D1Database, locationId: number, partId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`)
    .bind(locationId, partId)
    .first<{ qty: number }>();
  return Number(row?.qty || 0);
}

/** One active pricebook row. A code match wins when the name is shared. */
export async function matchOnePart(
  db: D1Database,
  raw: string | null | undefined
): Promise<number | null> {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  const rows = await db
    .prepare(
      `SELECT id, code, name FROM parts
       WHERE active = 1 AND (
         lower(trim(code)) = lower(trim(?))
         OR lower(trim(name)) = lower(trim(?))
       )
       LIMIT 5`
    )
    .bind(text, text)
    .all<PartHit>();
  const hits = rows.results || [];
  if (hits.length === 1) return Number(hits[0].id);
  const codeHits = hits.filter((h) => String(h.code || "").trim().toLowerCase() === text.toLowerCase());
  if (codeHits.length === 1) return Number(codeHits[0].id);
  return null;
}

export async function applyCounterLineToVan(
  db: D1Database,
  userId: number,
  dropoffId: number,
  unitNumber: string,
  vanLocationId: number,
  code: string,
  qty: number
): Promise<{ moved: number; received: number }> {
  const partCode = code.trim();
  const n = Number(qty);
  if (!partCode || !Number.isFinite(n) || n <= 0) return { moved: 0, received: 0 };
  const found = await db
    .prepare(
      `SELECT id FROM parts WHERE active = 1 AND lower(trim(code)) = lower(trim(?))`
    )
    .bind(partCode)
    .all<{ id: number }>();
  const ids = found.results || [];
  if (ids.length !== 1) return { moved: 0, received: 0 };
  const partId = Number(ids[0].id);
  const note = `Shop counter ${dropoffId} onto van ${unitNumber}`;
  let moved = 0;
  const shopId = await shopBinForPart(db, partId);
  if (shopId && shopId !== vanLocationId) {
    const have = await onHand(db, shopId, partId);
    const move = Math.min(have, n);
    if (move > 0) {
      await transferStock(db, partId, shopId, vanLocationId, move, userId, note);
      moved = move;
    }
  }
  const rest = n - moved;
  if (rest > 0) {
    await adjustStockQty(db, partId, vanLocationId, rest, userId, "receive", note);
  }
  return { moved, received: rest > 0 ? rest : 0 };
}

export async function takePullOffShelf(
  db: D1Database,
  userId: number,
  lines: Array<{ description: string; qty: number }>
): Promise<PullShelfNote[]> {
  await ensureStockLocations(db);
  const notes: PullShelfNote[] = [];
  for (const line of lines) {
    const description = String(line.description || "").trim();
    const qty = Number(line.qty);
    if (!description || !Number.isFinite(qty) || qty <= 0) continue;
    const partId = await matchOnePart(db, description);
    if (!partId) {
      notes.push({
        description,
        note: `${description} is not one pricebook part, so the shelf was left as it is.`,
      });
      continue;
    }
    const bin = await shopBinForPart(db, partId);
    if (!bin) {
      notes.push({
        description,
        note: `${description} has no shop shelf, so the count was left as it is.`,
      });
      continue;
    }
    const have = await onHand(db, bin, partId);
    const take = Math.min(have, qty);
    if (take <= 0) {
      notes.push({
        description,
        note: `${description}: the shelf shows 0. The bag is still on the list.`,
      });
      continue;
    }
    try {
      await issueStockStrict(
        db,
        partId,
        bin,
        take,
        userId,
        `Pull for tomorrow: ${description}`
      );
    } catch {
      notes.push({
        description,
        note: `${description}: the shelf count could not be changed.`,
      });
      continue;
    }
    if (take < qty) {
      notes.push({
        description,
        note: `${description}: shelf had ${take}, list asked for ${qty}. Pulled ${take}.`,
      });
    } else {
      notes.push({
        description,
        note: `${qty} x ${description} came off the shelf.`,
      });
    }
  }
  return notes;
}

type ArrivalBook = {
  id: number;
  qty: number | null;
  placeKind: string | null;
  placeLocationId: number | null;
  partDescription: string;
  requestId: number | null;
};

async function requestPart(
  db: D1Database,
  requestId: number | null
): Promise<{
  part_number: string | null;
  part_description: string | null;
  deliver_to: string | null;
  vehicle_id: number | null;
} | null> {
  if (!requestId) return null;
  return db
    .prepare(
      `SELECT part_number, part_description, deliver_to, vehicle_id
       FROM parts_order_requests WHERE id = ?`
    )
    .bind(requestId)
    .first<{
      part_number: string | null;
      part_description: string | null;
      deliver_to: string | null;
      vehicle_id: number | null;
    }>();
}

async function putAwayLocation(
  db: D1Database,
  partId: number,
  arrival: ArrivalBook,
  deliverTo: string | null,
  vehicleId: number | null
): Promise<number | null> {
  if (
    arrival.placeLocationId &&
    arrival.placeKind !== "floor" &&
    (arrival.placeKind === "section" || arrival.placeKind === "truck")
  ) {
    return arrival.placeLocationId;
  }
  if (deliverTo === "truck" && vehicleId) {
    const vehicle = await db
      .prepare(`SELECT unit_number FROM vehicles WHERE id = ?`)
      .bind(vehicleId)
      .first<{ unit_number: string }>();
    return ensureVehicleStockLocation(
      db,
      vehicleId,
      vehicle?.unit_number || String(vehicleId)
    );
  }
  return shopBinForPart(db, partId);
}

/** Put a docked order onto the count at the place warehouse chose. */
export async function bookArrivalStock(
  db: D1Database,
  userId: number,
  arrival: ArrivalBook
): Promise<string> {
  await ensureStockLocations(db);
  const qty = Number(arrival.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return "No quantity was on the card, so the count was left as it is.";
  }
  const req = await requestPart(db, arrival.requestId);
  const partId =
    (await matchOnePart(db, req?.part_number)) ||
    (await matchOnePart(db, arrival.partDescription)) ||
    (await matchOnePart(db, req?.part_description));
  if (!partId) {
    return "This part is not one pricebook match, so the count was left as it is.";
  }
  const locationId = await putAwayLocation(
    db,
    partId,
    arrival,
    req?.deliver_to || null,
    req?.vehicle_id || null
  );
  if (!locationId) {
    return "No shelf is set up, so the count was left as it is.";
  }
  await adjustStockQty(
    db,
    partId,
    locationId,
    qty,
    userId,
    "receive",
    `Order arrival ${arrival.id}`
  );
  try {
    await db
      .prepare(
        `UPDATE parts_arrivals
         SET stock_part_id = ?, stock_location_id = ?, stock_qty = ?
         WHERE id = ?`
      )
      .bind(partId, locationId, qty, arrival.id)
      .run();
  } catch {
    /* columns arrive with the parts-order table setup */
  }
  return "That quantity is on the count.";
}

/** Take a returned box back off the count. */
export async function releaseArrivalStock(
  db: D1Database,
  userId: number,
  arrivalId: number
): Promise<string> {
  let row: { stock_part_id: number | null; stock_location_id: number | null; stock_qty: number | null } | null =
    null;
  try {
    row = await db
      .prepare(
        `SELECT stock_part_id, stock_location_id, stock_qty FROM parts_arrivals WHERE id = ?`
      )
      .bind(arrivalId)
      .first<{
        stock_part_id: number | null;
        stock_location_id: number | null;
        stock_qty: number | null;
      }>();
  } catch {
    return "";
  }
  const partId = Number(row?.stock_part_id || 0);
  const locationId = Number(row?.stock_location_id || 0);
  const qty = Number(row?.stock_qty || 0);
  if (!partId || !locationId || !qty) return "";
  try {
    await issueStockStrict(db, partId, locationId, qty, userId, `Order arrival ${arrivalId} returned`);
  } catch {
    return "The box is returned. The shelf count no longer has that full quantity.";
  }
  try {
    await db
      .prepare(
        `UPDATE parts_arrivals
         SET stock_part_id = NULL, stock_location_id = NULL, stock_qty = NULL
         WHERE id = ?`
      )
      .bind(arrivalId)
      .run();
  } catch {
    /* the issue already stands */
  }
  return "That quantity came off the count.";
}
