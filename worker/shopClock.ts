/**
 * FA Shop / Office clock â€” non-job time sessions.
 * V1: Field App punches only. Soft: never invent ST jobs / $0 jobs / timesheet invent.
 * Phase 2: ST Non-Job Event / activity types (Shop/Office/Training) if Gauge confirms.
 */

import type { Env, PublicUser } from "./types";
import { chicagoDayBounds } from "./jobClock";
import { openJobClockBlock, recordDayClockOut } from "./clockDay";

export type ShopKind = "shop" | "office";

export type ShopSessionRow = {
  id: number;
  user_id: number;
  kind: string;
  clock_in_at: string;
  clock_out_at: string | null;
  client_in_ts: string | null;
  client_out_ts: string | null;
  created_at: string;
  note: string | null;
  sync_status: string;
  sync_error: string | null;
};

export type ShopSessionPublic = {
  id: number;
  kind: ShopKind;
  clock_in_at: string;
  clock_out_at: string | null;
  open: boolean;
  /** Always false in v1 â€” ST Non-Job write is phase 2 */
  st_timesheet_write: false,
};

let tablesReady = false;

export async function ensureShopClockTables(db: D1Database): Promise<void> {
  if (tablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS fa_time_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('shop', 'office')),
      clock_in_at TEXT NOT NULL,
      clock_out_at TEXT,
      client_in_ts TEXT,
      client_out_ts TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      note TEXT,
      sync_status TEXT NOT NULL DEFAULT 'fa_only'
        CHECK (sync_status IN ('fa_only', 'queued', 'synced', 'error')),
      sync_error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fa_time_sessions_user_open
      ON fa_time_sessions(user_id, clock_out_at, clock_in_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_fa_time_sessions_user_day
      ON fa_time_sessions(user_id, clock_in_at DESC)`,
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

function asKind(raw: string | null | undefined): ShopKind {
  const k = String(raw || "shop").trim().toLowerCase();
  return k === "office" ? "office" : "shop";
}

function toPublic(row: ShopSessionRow): ShopSessionPublic {
  return {
    id: row.id,
    kind: asKind(row.kind),
    clock_in_at: row.clock_in_at,
    clock_out_at: row.clock_out_at,
    open: !row.clock_out_at,
    st_timesheet_write: false,
  };
}

export async function getOpenShopSession(
  db: D1Database,
  userId: number
): Promise<ShopSessionRow | null> {
  await ensureShopClockTables(db);
  try {
    const row = await db
      .prepare(
        `SELECT id, user_id, kind, clock_in_at, clock_out_at, client_in_ts, client_out_ts,
                created_at, note, sync_status, sync_error
         FROM fa_time_sessions
         WHERE user_id = ? AND clock_out_at IS NULL
         ORDER BY clock_in_at DESC, id DESC
         LIMIT 1`
      )
      .bind(userId)
      .first<ShopSessionRow>();
    return row || null;
  } catch {
    return null;
  }
}

export async function getShopSessionPublic(
  db: D1Database,
  userId: number
): Promise<ShopSessionPublic | null> {
  const open = await getOpenShopSession(db, userId);
  if (open) return toPublic(open);
  const { today } = chicagoDayBounds();
  try {
    const row = await db
      .prepare(
        `SELECT id, user_id, kind, clock_in_at, clock_out_at, client_in_ts, client_out_ts,
                created_at, note, sync_status, sync_error
         FROM fa_time_sessions
         WHERE user_id = ?
           AND substr(clock_in_at, 1, 10) = ?
         ORDER BY clock_in_at DESC, id DESC
         LIMIT 1`
      )
      .bind(userId, today)
      .first<ShopSessionRow>();
    return row ? toPublic(row) : null;
  } catch {
    return null;
  }
}

export async function clockShopIn(
  _env: Env,
  db: D1Database,
  user: PublicUser,
  body: { kind?: string | null; client_ts?: string | null; note?: string | null }
): Promise<
  | { ok: true; deduped: boolean; session: ShopSessionPublic; label: string }
  | { ok: false; status: number; error: string; session?: ShopSessionPublic }
> {
  await ensureShopClockTables(db);
  const kind = asKind(body.kind);
  const clientTs =
    (body.client_ts && String(body.client_ts).trim()) || new Date().toISOString();
  const note =
    body.note != null && String(body.note).trim()
      ? String(body.note).trim().slice(0, 200)
      : null;

  const open = await getOpenShopSession(db, user.id);
  if (open) {
    await rememberShopClockin(db, user.id);
    return {
      ok: false,
      status: 409,
      error: "Already clocked in for Shop/Office. Clock out first.",
      session: toPublic(open),
    };
  }

  const ins = await db
    .prepare(
      `INSERT INTO fa_time_sessions
        (user_id, kind, clock_in_at, client_in_ts, note, sync_status)
       VALUES (?, ?, ?, ?, ?, 'fa_only')`
    )
    .bind(user.id, kind, clientTs, clientTs, note)
    .run();

  const id = Number(ins.meta.last_row_id);
  const row = await db
    .prepare(
      `SELECT id, user_id, kind, clock_in_at, clock_out_at, client_in_ts, client_out_ts,
              created_at, note, sync_status, sync_error
       FROM fa_time_sessions WHERE id = ?`
    )
    .bind(id)
    .first<ShopSessionRow>();

  if (!row) return { ok: false, status: 500, error: "Insert failed" };

  await rememberShopClockin(db, user.id);
  return {
    ok: true,
    deduped: false,
    session: toPublic(row),
    label: "Shop/Office clocked in (Field App only â€” ST timesheet write is phase 2)",
  };
}

async function rememberShopClockin(db: D1Database, userId: number): Promise<void> {
  try {
    const { markClockinNudgesResolved } = await import("./clockinNudge");
    await markClockinNudgesResolved(db, userId);
  } catch {
    /* nudge bookkeeping must not fail the punch */
  }
}

export async function clockShopOut(
  _env: Env,
  db: D1Database,
  user: PublicUser,
  body: { client_ts?: string | null }
): Promise<
  | { ok: true; deduped: boolean; session: ShopSessionPublic; label: string }
  | {
      ok: false;
      status: number;
      error: string;
      session?: ShopSessionPublic | null;
      appt_id?: string;
      job_label?: string;
    }
> {
  await ensureShopClockTables(db);
  const clientTs =
    (body.client_ts && String(body.client_ts).trim()) || new Date().toISOString();

  const block = await openJobClockBlock(db, user.id);
  if (block) {
    return {
      ok: false,
      status: 409,
      error: block.message,
      session: null,
      appt_id: block.apptId,
      job_label: block.jobLabel,
    };
  }

  const open = await getOpenShopSession(db, user.id);
  if (!open) {
    return {
      ok: false,
      status: 409,
      error: "No open Shop/Office session to clock out.",
      session: null,
    };
  }

  const inMs = Date.parse(open.clock_in_at);
  const outMs = Date.parse(clientTs);
  if (Number.isFinite(inMs) && Number.isFinite(outMs) && outMs < inMs) {
    return {
      ok: false,
      status: 400,
      error: "Clock-out time is before clock-in.",
      session: toPublic(open),
    };
  }

  await db
    .prepare(
      `UPDATE fa_time_sessions
       SET clock_out_at = ?, client_out_ts = ?
       WHERE id = ? AND user_id = ? AND clock_out_at IS NULL`
    )
    .bind(clientTs, clientTs, open.id, user.id)
    .run();

  const row = await db
    .prepare(
      `SELECT id, user_id, kind, clock_in_at, clock_out_at, client_in_ts, client_out_ts,
              created_at, note, sync_status, sync_error
       FROM fa_time_sessions WHERE id = ?`
    )
    .bind(open.id)
    .first<ShopSessionRow>();

  if (!row) return { ok: false, status: 500, error: "Update failed" };

  try {
    await recordDayClockOut(db, user.id, clientTs);
  } catch {
    /* day marker must not undo a shop clock-out that already saved */
  }

  return {
    ok: true,
    deduped: false,
    session: toPublic(row),
    label: "Shop/Office clocked out (Field App only)",
  };
}
