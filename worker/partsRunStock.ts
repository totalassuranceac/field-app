/**
 * Parts-run catalog lines and the stock move they make on Delivered.
 * Field App tables only. No ServiceTitan. No texts, email, or push.
 */

import type { Hono } from "hono";
import type { Env, PublicUser, Role, Variables } from "./types";
import { getSetting, writeAudit } from "./audit";
import { ROLE_PERMS, roleAtLeast } from "./auth";
import { ensureStockLocations, ensureVehicleStockLocation, issueStockStrict } from "./inventory";
import {
  ShortStockError,
  planPartsRunLine,
  planUndo,
  shortFlag,
  sourceLabel,
  statusLabel,
  stockMovesEnabled,
  normalizeMoveQty,
} from "./stockMoves";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

type RunRow = {
  id: number;
  user_id: number;
  vehicle_id: number | null;
  status: string;
  part_needed: string;
};

type LineRow = {
  id: number;
  part_id: number | null;
  part_code: string | null;
  part_name: string;
  qty: number;
  transferred: number;
};

export type PartsRunTransferResult = {
  transferred: number;
  blocked: { part: string; have: number; need: number }[];
  errors: string[];
};

function isDispatcher(role: string): boolean {
  return role === "admin" || role === "office" || role === "warehouse" || role === "mechanic";
}

function canViewInventory(role: string): boolean {
  return roleAtLeast(role as Role, ROLE_PERMS.viewInventory);
}

function canManageInventory(role: string): boolean {
  return roleAtLeast(role as Role, ROLE_PERMS.manageInventory);
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function qtyAt(db: D1Database, locationId: number, partId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`)
    .bind(locationId, partId)
    .first<{ qty: number }>();
  return Number(row?.qty ?? 0) || 0;
}

function balanceStmt(db: D1Database, locationId: number, partId: number, qty: number) {
  return db
    .prepare(
      `INSERT INTO stock_balances (location_id, part_id, qty, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(location_id, part_id) DO UPDATE SET
         qty = excluded.qty, updated_at = datetime('now')`
    )
    .bind(locationId, partId, qty);
}

async function loadRun(db: D1Database, id: number): Promise<RunRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, vehicle_id, status, part_needed FROM parts_run_requests WHERE id = ?`
    )
    .bind(id)
    .first<RunRow>();
}

function canTouchRun(user: PublicUser, run: RunRow, write: boolean): boolean {
  if (write && user.role === "viewer") return false;
  if (user.id === run.user_id) return true;
  if (isDispatcher(user.role)) return true;
  if (!write && user.role === "viewer") return true;
  return false;
}

export async function applyPartsRunTransfer(
  db: D1Database,
  run: { id: number; user_id: number; vehicle_id: number | null; part_needed: string },
  actorUserId: number,
  techName: string
): Promise<PartsRunTransferResult> {
  const setting = await getSetting(db, "parts_run_stock_moves", "0");
  if (!stockMovesEnabled(setting)) {
    return { transferred: 0, blocked: [], errors: [] };
  }

  await ensureStockLocations(db);
  const wh = await db
    .prepare(`SELECT id FROM stock_locations WHERE type = 'warehouse' AND active = 1 LIMIT 1`)
    .first<{ id: number }>();
  if (!wh) {
    return { transferred: 0, blocked: [], errors: ["No warehouse location configured"] };
  }

  let destLocId: number | null = null;
  let destLabel = "the truck";
  if (run.vehicle_id) {
    const v = await db
      .prepare(`SELECT id, unit_number FROM vehicles WHERE id = ?`)
      .bind(run.vehicle_id)
      .first<{ id: number; unit_number: string }>();
    if (v) {
      destLocId = await ensureVehicleStockLocation(db, v.id, v.unit_number, { seedTruckParts: false });
      destLabel = `Unit ${v.unit_number}`;
    }
  }

  const lines = (
    await db
      .prepare(
        `SELECT id, part_id, part_code, part_name, qty, transferred
         FROM parts_run_lines WHERE run_id = ? ORDER BY line_no, id`
      )
      .bind(run.id)
      .all<LineRow>()
  ).results || [];

  const errors: string[] = [];
  const blocked: { part: string; have: number; need: number }[] = [];
  let transferred = 0;
  const note = `Parts run #${run.id}: ${techName} - ${run.part_needed.slice(0, 60)} -> ${destLabel}`;

  for (const line of lines) {
    const partLabel = line.part_code || line.part_name;
    const already = await db
      .prepare(
        `SELECT id FROM stock_move_log
         WHERE source_kind = 'parts_run' AND source_line_id = ?
           AND status = 'moved' AND undo_of_log_id IS NULL
         LIMIT 1`
      )
      .bind(line.id)
      .first<{ id: number }>()
      .catch(() => null);

    if (Number(line.transferred) === 1 || already) {
      if (Number(line.transferred) !== 1) {
        await db
          .prepare(`UPDATE parts_run_lines SET transferred = 1 WHERE id = ?`)
          .bind(line.id)
          .run();
      }
      transferred += 1;
      continue;
    }

    let partId = line.part_id ? Number(line.part_id) : 0;
    if (!partId && line.part_code) {
      const hit = await db
        .prepare(
          `SELECT id FROM parts WHERE active = 1 AND upper(code) = upper(?) LIMIT 1`
        )
        .bind(line.part_code.trim())
        .first<{ id: number }>();
      if (hit) {
        partId = hit.id;
        await db
          .prepare(`UPDATE parts_run_lines SET part_id = ? WHERE id = ?`)
          .bind(partId, line.id)
          .run();
      }
    }
    if (!partId) {
      errors.push(`${partLabel}: not found in inventory catalog`);
      await db
        .prepare(`UPDATE parts_run_lines SET transfer_note = ? WHERE id = ?`)
        .bind("No catalog match", line.id)
        .run();
      continue;
    }

    const fromBefore = await qtyAt(db, wh.id, partId);
    const toBefore = destLocId ? await qtyAt(db, destLocId, partId) : null;
    const plan = planPartsRunLine({
      killSwitchOn: true,
      alreadyTransferred: false,
      qty: Number(line.qty) || 0,
      fromBefore,
      toBefore,
    });

    if (plan.action === "bad_qty") {
      errors.push(`${partLabel}: quantity must be greater than 0 and at most 999`);
      continue;
    }
    if (plan.action === "blocked_short") {
      blocked.push({ part: partLabel, have: plan.have, need: plan.need });
      await db.batch([
        db
          .prepare(
            `INSERT INTO stock_move_log (
               source_kind, source_id, source_line_id, part_id, from_location_id, to_location_id,
               qty, from_before, from_after, to_before, to_after, status, flag_text, created_by_user_id
             ) VALUES ('parts_run', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked_short', ?, ?)`
          )
          .bind(
            run.id,
            line.id,
            partId,
            wh.id,
            destLocId,
            plan.need,
            plan.have,
            plan.have,
            toBefore,
            toBefore,
            plan.flag,
            actorUserId
          ),
        db
          .prepare(`UPDATE parts_run_lines SET transferred = 0, transfer_note = ? WHERE id = ?`)
          .bind(plan.flag, line.id),
      ]);
      continue;
    }
    if (plan.action !== "move" && plan.action !== "issue") continue;

    const lineNote = plan.action === "move" ? `-> ${destLabel}` : "issued from warehouse";
    try {
      if (plan.action === "move" && destLocId) {
        await db.batch([
          balanceStmt(db, wh.id, partId, plan.fromAfter),
          balanceStmt(db, destLocId, partId, plan.toAfter),
          db
            .prepare(
              `INSERT INTO stock_movements
                (part_id, from_location_id, to_location_id, qty, reason, notes, created_by_user_id)
               VALUES (?, ?, ?, ?, 'transfer', ?, ?)`
            )
            .bind(partId, wh.id, destLocId, plan.qty, note, actorUserId),
          db
            .prepare(
              `INSERT INTO stock_move_log (
                 source_kind, source_id, source_line_id, part_id, from_location_id, to_location_id,
                 qty, from_before, from_after, to_before, to_after, status, flag_text,
                 stock_movement_id, created_by_user_id
               ) VALUES ('parts_run', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'moved', NULL, last_insert_rowid(), ?)`
            )
            .bind(
              run.id,
              line.id,
              partId,
              wh.id,
              destLocId,
              plan.qty,
              plan.fromBefore,
              plan.fromAfter,
              plan.toBefore,
              plan.toAfter,
              actorUserId
            ),
          db
            .prepare(
              `UPDATE parts_run_lines SET transferred = 1, transfer_note = ?, part_id = ? WHERE id = ?`
            )
            .bind(lineNote, partId, line.id),
        ]);
      } else {
        await issueStockStrict(db, partId, wh.id, plan.qty, actorUserId, note, [
          db
            .prepare(
              `INSERT INTO stock_move_log (
                 source_kind, source_id, source_line_id, part_id, from_location_id, to_location_id,
                 qty, from_before, from_after, to_before, to_after, status, flag_text,
                 stock_movement_id, created_by_user_id
               ) VALUES ('parts_run', ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, 'moved', NULL, last_insert_rowid(), ?)`
            )
            .bind(
              run.id,
              line.id,
              partId,
              wh.id,
              plan.qty,
              plan.fromBefore,
              plan.fromAfter,
              actorUserId
            ),
          db
            .prepare(
              `UPDATE parts_run_lines SET transferred = 1, transfer_note = ?, part_id = ? WHERE id = ?`
            )
            .bind(lineNote, partId, line.id),
        ]);
      }
      transferred += 1;
    } catch (e) {
      if (e instanceof ShortStockError) {
        const flag = shortFlag(e.have, e.need);
        blocked.push({ part: partLabel, have: e.have, need: e.need });
        await db
          .prepare(
            `INSERT INTO stock_move_log (
               source_kind, source_id, source_line_id, part_id, from_location_id,
               qty, from_before, from_after, status, flag_text, created_by_user_id
             ) VALUES ('parts_run', ?, ?, ?, ?, ?, ?, ?, 'blocked_short', ?, ?)`
          )
          .bind(run.id, line.id, partId, wh.id, e.need, e.have, e.have, flag, actorUserId)
          .run();
        await db
          .prepare(`UPDATE parts_run_lines SET transferred = 0, transfer_note = ? WHERE id = ?`)
          .bind(flag, line.id)
          .run();
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${partLabel}: ${msg}`);
        await db
          .prepare(`UPDATE parts_run_lines SET transfer_note = ? WHERE id = ?`)
          .bind(msg.slice(0, 200), line.id)
          .run();
      }
    }
  }

  await db
    .prepare(
      `UPDATE parts_run_requests SET
         inventory_transferred = CASE
           WHEN EXISTS (SELECT 1 FROM parts_run_lines WHERE run_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM parts_run_lines WHERE run_id = ? AND COALESCE(transferred, 0) = 0
            )
           THEN 1 ELSE 0 END,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(run.id, run.id, run.id)
    .run();

  return { transferred, blocked, errors };
}

const STATUS_FILTER: Record<string, string> = {
  moved: "moved",
  short: "blocked_short",
  blocked_short: "blocked_short",
  flagged: "clamped",
  clamped: "clamped",
  undone: "undone",
  undo: "undo",
};

export function registerPartsRunStockRoutes(api: App): void {
  api.get("/parts-runs/part-search", async (c) => {
    const q = (c.req.query("q") || "").trim().toLowerCase();
    if (q.length < 2) return c.json({ parts: [] });
    const like = `%${q.replace(/%/g, "")}%`;
    try {
      const rows = await c.env.DB.prepare(
        `SELECT p.id, p.code, p.name,
            COALESCE((
              SELECT b.qty FROM stock_balances b
              JOIN stock_locations s ON s.id = b.location_id
              WHERE b.part_id = p.id AND s.type = 'warehouse' AND s.active = 1
              ORDER BY s.id LIMIT 1
            ), 0) AS warehouse_qty
         FROM parts p
         WHERE p.active = 1 AND (lower(p.code) LIKE ? OR lower(p.name) LIKE ?)
         ORDER BY
           CASE WHEN lower(p.code) LIKE ? OR lower(p.name) LIKE ? THEN 0 ELSE 1 END,
           p.name
         LIMIT 20`
      )
        .bind(like, like, `${q.replace(/%/g, "")}%`, `${q.replace(/%/g, "")}%`)
        .all();
      return c.json({ parts: rows.results || [] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg.slice(0, 160) }, 500);
    }
  });

  api.get("/parts-runs/:id/lines", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const run = await loadRun(c.env.DB, id);
    if (!run) return c.json({ error: "Not found" }, 404);
    if (!canTouchRun(user, run, false)) return c.json({ error: "Not allowed" }, 403);
    const rows = await c.env.DB.prepare(
      `SELECT l.*,
          (SELECT b.qty FROM stock_balances b
           JOIN stock_locations s ON s.id = b.location_id
           WHERE b.part_id = l.part_id AND s.type = 'warehouse' AND s.active = 1
           ORDER BY s.id LIMIT 1) AS warehouse_qty
       FROM parts_run_lines l
       WHERE l.run_id = ?
       ORDER BY l.line_no, l.id`
    )
      .bind(id)
      .all();
    return c.json({ lines: rows.results || [] });
  });

  api.post("/parts-runs/:id/lines", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const run = await loadRun(c.env.DB, id);
    if (!run) return c.json({ error: "Not found" }, 404);
    if (!canTouchRun(user, run, true)) return c.json({ error: "Not allowed" }, 403);
    if (run.status === "delivered" || run.status === "cancelled") {
      return c.json({ error: "Lines can be changed only before the run is delivered or cancelled" }, 400);
    }
    const body = await readJson(c);
    const partId = Number(body.part_id);
    const qty = normalizeMoveQty(Number(body.qty));
    if (!Number.isInteger(partId) || partId <= 0) return c.json({ error: "Pick a catalog part" }, 400);
    if (qty == null) return c.json({ error: "Quantity must be greater than 0 and at most 999" }, 400);
    const part = await c.env.DB.prepare(
      `SELECT id, code, name FROM parts WHERE id = ? AND active = 1`
    )
      .bind(partId)
      .first<{ id: number; code: string; name: string }>();
    if (!part) return c.json({ error: "That part is not in the catalog" }, 400);
    const nextNo = await c.env.DB.prepare(
      `SELECT COALESCE(MAX(line_no), 0) + 1 AS n FROM parts_run_lines WHERE run_id = ?`
    )
      .bind(id)
      .first<{ n: number }>();
    const ins = await c.env.DB.prepare(
      `INSERT INTO parts_run_lines (run_id, line_no, part_id, part_code, part_name, qty, transferred)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
      .bind(id, nextNo?.n ?? 1, part.id, part.code, part.name, qty)
      .run();
    await writeAudit(
      c.env.DB,
      user,
      "create",
      "parts_run_line",
      Number(ins.meta.last_row_id),
      `Parts run #${id} line ${part.code}`
    );
    return c.json({ ok: true, id: Number(ins.meta.last_row_id) }, 201);
  });

  api.delete("/parts-runs/:id/lines/:lineId", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const lineId = Number(c.req.param("lineId"));
    const run = await loadRun(c.env.DB, id);
    if (!run) return c.json({ error: "Not found" }, 404);
    if (!canTouchRun(user, run, true)) return c.json({ error: "Not allowed" }, 403);
    if (run.status === "delivered" || run.status === "cancelled") {
      return c.json({ error: "Lines can be changed only before the run is delivered or cancelled" }, 400);
    }
    const line = await c.env.DB.prepare(
      `SELECT id, transferred FROM parts_run_lines WHERE id = ? AND run_id = ?`
    )
      .bind(lineId, id)
      .first<{ id: number; transferred: number }>();
    if (!line) return c.json({ error: "Not found" }, 404);
    if (Number(line.transferred) === 1) return c.json({ error: "That line already moved" }, 400);
    await c.env.DB.prepare(`DELETE FROM parts_run_lines WHERE id = ? AND run_id = ?`)
      .bind(lineId, id)
      .run();
    await writeAudit(c.env.DB, user, "delete", "parts_run_line", lineId, `Removed line from parts run #${id}`);
    return c.json({ ok: true });
  });

  api.post("/parts-runs/:id/retry-move", async (c) => {
    const user = c.get("user");
    if (!isDispatcher(user.role)) return c.json({ error: "Not allowed" }, 403);
    const id = Number(c.req.param("id"));
    const run = await c.env.DB.prepare(`SELECT * FROM parts_run_requests WHERE id = ?`)
      .bind(id)
      .first<{
        id: number;
        user_id: number;
        vehicle_id: number | null;
        status: string;
        part_needed: string;
      }>();
    if (!run) return c.json({ error: "Not found" }, 404);
    if (run.status !== "delivered") return c.json({ error: "Retry move is for a delivered run" }, 400);
    const tech = await c.env.DB.prepare(`SELECT display_name FROM users WHERE id = ?`)
      .bind(run.user_id)
      .first<{ display_name: string }>();
    const inventory = await applyPartsRunTransfer(
      c.env.DB,
      run,
      user.id,
      tech?.display_name || `user ${run.user_id}`
    );
    await writeAudit(
      c.env.DB,
      user,
      "update",
      "parts_run_request",
      id,
      `Retry stock move · ${inventory.transferred} moved · ${inventory.blocked.length} short`
    );
    return c.json({ ok: true, inventory });
  });

  api.get("/inventory/stock-moves", async (c) => {
    const user = c.get("user");
    if (!canViewInventory(user.role)) return c.json({ error: "Not allowed" }, 403);
    return c.json(await listStockMoves(c.env.DB, c.req.query("status") || "", c.req.query("part") || ""));
  });

  api.get("/inventory/stock-moves.csv", async (c) => {
    const user = c.get("user");
    if (!canViewInventory(user.role)) return c.json({ error: "Not allowed" }, 403);
    const data = await listStockMoves(c.env.DB, c.req.query("status") || "", c.req.query("part") || "");
    const header = [
      "time",
      "user",
      "part",
      "from",
      "to",
      "qty",
      "from_before",
      "from_after",
      "to_before",
      "to_after",
      "status",
      "flag",
      "source",
    ];
    const lines = [header.join(",")];
    for (const row of data.rows) {
      lines.push(
        [
          row.created_at,
          row.user_name,
          row.part_label,
          row.from_name,
          row.to_name,
          row.qty,
          row.from_before,
          row.from_after,
          row.to_before,
          row.to_after,
          statusLabel(row.status),
          row.flag_text,
          sourceLabel(row),
        ]
          .map(csvCell)
          .join(",")
      );
    }
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=stock-moves.csv",
      },
    });
  });

  api.post("/inventory/stock-moves/:id/undo", async (c) => {
    const user = c.get("user");
    if (!canManageInventory(user.role)) return c.json({ error: "Not allowed" }, 403);
    const id = Number(c.req.param("id"));
    const result = await undoStockMove(c.env.DB, id, user.id);
    if (!result.ok) return c.json({ error: result.message }, 409);
    await writeAudit(c.env.DB, user, "undo", "stock_move", id, `Undo stock move #${id}`);
    return c.json({ ok: true, undo_id: result.undoId });
  });
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

type MoveListRow = {
  id: number;
  source_kind: string;
  source_id: number | null;
  source_line_id: number | null;
  undo_of_log_id: number | null;
  part_id: number;
  part_code: string | null;
  part_name: string | null;
  part_label: string;
  from_name: string | null;
  to_name: string | null;
  qty: number;
  from_before: number | null;
  from_after: number | null;
  to_before: number | null;
  to_after: number | null;
  status: string;
  flag_text: string | null;
  user_name: string | null;
  created_at: string;
};

async function listStockMoves(db: D1Database, statusRaw: string, partRaw: string) {
  const status = STATUS_FILTER[(statusRaw || "").trim().toLowerCase()] || "";
  const part = (partRaw || "").trim();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push("l.status = ?");
    binds.push(status);
  }
  if (part) {
    if (/^\d+$/.test(part)) {
      where.push("(l.part_id = ? OR lower(p.code) LIKE ? OR lower(p.name) LIKE ?)");
      binds.push(Number(part), `%${part.toLowerCase()}%`, `%${part.toLowerCase()}%`);
    } else {
      where.push("(lower(p.code) LIKE ? OR lower(p.name) LIKE ?)");
      const like = `%${part.toLowerCase().replace(/%/g, "")}%`;
      binds.push(like, like);
    }
  }
  const sql = `SELECT l.*, p.code AS part_code, p.name AS part_name,
      u.display_name AS user_name,
      fl.name AS from_name, tl.name AS to_name
    FROM stock_move_log l
    JOIN parts p ON p.id = l.part_id
    LEFT JOIN users u ON u.id = l.created_by_user_id
    LEFT JOIN stock_locations fl ON fl.id = l.from_location_id
    LEFT JOIN stock_locations tl ON tl.id = l.to_location_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 300`;
  let rows: MoveListRow[] = [];
  try {
    const got = await db.prepare(sql).bind(...binds).all<MoveListRow>();
    rows = (got.results || []).map((row) => ({
      ...row,
      part_label: [row.part_code, row.part_name].filter(Boolean).join(" "),
    }));
  } catch {
    rows = [];
  }
  let shortCount = 0;
  let flaggedCount = 0;
  try {
    const counts = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'blocked_short' THEN 1 ELSE 0 END) AS short_count,
           SUM(CASE WHEN status = 'clamped' THEN 1 ELSE 0 END) AS flagged_count
         FROM stock_move_log`
      )
      .first<{ short_count: number; flagged_count: number }>();
    shortCount = Number(counts?.short_count) || 0;
    flaggedCount = Number(counts?.flagged_count) || 0;
  } catch {
    /* table not installed yet */
  }
  return { rows, short_count: shortCount, flagged_count: flaggedCount };
}

async function undoStockMove(
  db: D1Database,
  id: number,
  userId: number
): Promise<{ ok: true; undoId: number } | { ok: false; message: string }> {
  const row = await db
    .prepare(`SELECT * FROM stock_move_log WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      source_kind: string;
      source_id: number | null;
      source_line_id: number | null;
      part_id: number;
      from_location_id: number | null;
      to_location_id: number | null;
      qty: number;
      status: string;
    }>();
  if (!row) return { ok: false, message: "Not found" };
  const hasDest = row.to_location_id != null;
  const destOnHand = hasDest ? await qtyAt(db, Number(row.to_location_id), row.part_id) : null;
  const sourceOnHand =
    row.from_location_id != null ? await qtyAt(db, Number(row.from_location_id), row.part_id) : 0;
  let label = "Truck";
  if (hasDest) {
    const loc = await db
      .prepare(`SELECT name, type FROM stock_locations WHERE id = ?`)
      .bind(row.to_location_id)
      .first<{ name: string; type: string }>();
    if (loc && loc.type !== "vehicle") label = loc.name || "Location";
  }
  const plan = planUndo({
    status: row.status,
    qty: Number(row.qty) || 0,
    destOnHand,
    sourceOnHand,
    hasDestination: hasDest,
    label,
  });
  if (!plan.ok) return plan;

  const note = `Undo stock move #${row.id}`;
  if (hasDest && row.from_location_id != null && row.to_location_id != null) {
    const results = await db.batch([
      balanceStmt(db, row.to_location_id, row.part_id, plan.destAfter),
      balanceStmt(db, row.from_location_id, row.part_id, plan.sourceAfter),
      db
        .prepare(
          `INSERT INTO stock_movements
            (part_id, from_location_id, to_location_id, qty, reason, notes, created_by_user_id)
           VALUES (?, ?, ?, ?, 'undo', ?, ?)`
        )
        .bind(row.part_id, row.to_location_id, row.from_location_id, plan.qty, note, userId),
      db
        .prepare(
          `INSERT INTO stock_move_log (
             source_kind, source_id, source_line_id, part_id, from_location_id, to_location_id,
             qty, from_before, from_after, to_before, to_after, status, flag_text,
             stock_movement_id, undo_of_log_id, created_by_user_id
           ) VALUES ('undo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'undo', NULL, last_insert_rowid(), ?, ?)`
        )
        .bind(
          row.source_id,
          row.source_line_id,
          row.part_id,
          row.to_location_id,
          row.from_location_id,
          plan.qty,
          plan.destBefore,
          plan.destAfter,
          plan.sourceBefore,
          plan.sourceAfter,
          row.id,
          userId
        ),
      db
        .prepare(
          `UPDATE stock_move_log SET status = 'undone', undone_by_log_id = last_insert_rowid() WHERE id = ?`
        )
        .bind(row.id),
      ...(row.source_line_id
        ? [
            db
              .prepare(`UPDATE parts_run_lines SET transferred = 0, transfer_note = ? WHERE id = ?`)
              .bind("Undone", row.source_line_id),
          ]
        : []),
      ...(row.source_kind === "parts_run" && row.source_id
        ? [
            db
              .prepare(
                `UPDATE parts_run_requests SET inventory_transferred = 0, updated_at = datetime('now') WHERE id = ?`
              )
              .bind(row.source_id),
          ]
        : []),
    ]);
    const undoId = Number(results[3]?.meta?.last_row_id) || 0;
    return { ok: true, undoId };
  }

  if (row.from_location_id == null) return { ok: false, message: "This move has nowhere to put the parts back" };
  const backTo = row.from_location_id;
  const results = await db.batch([
    balanceStmt(db, backTo, row.part_id, plan.sourceAfter),
    db
      .prepare(
        `INSERT INTO stock_movements
          (part_id, from_location_id, to_location_id, qty, reason, notes, created_by_user_id)
         VALUES (?, NULL, ?, ?, 'undo', ?, ?)`
      )
      .bind(row.part_id, backTo, plan.qty, note, userId),
    db
      .prepare(
        `INSERT INTO stock_move_log (
           source_kind, source_id, source_line_id, part_id, from_location_id, to_location_id,
           qty, from_before, from_after, to_before, to_after, status,
           stock_movement_id, undo_of_log_id, created_by_user_id
         ) VALUES ('undo', ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, 'undo', last_insert_rowid(), ?, ?)`
      )
      .bind(
        row.source_id,
        row.source_line_id,
        row.part_id,
        backTo,
        plan.qty,
        plan.sourceBefore,
        plan.sourceAfter,
        row.id,
        userId
      ),
    db
      .prepare(
        `UPDATE stock_move_log SET status = 'undone', undone_by_log_id = last_insert_rowid() WHERE id = ?`
      )
      .bind(row.id),
    ...(row.source_line_id
      ? [
          db
            .prepare(`UPDATE parts_run_lines SET transferred = 0, transfer_note = ? WHERE id = ?`)
            .bind("Undone", row.source_line_id),
        ]
      : []),
  ]);
  return { ok: true, undoId: Number(results[2]?.meta?.last_row_id) || 0 };
}
