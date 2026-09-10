import type { PublicUser } from "./types";

export type ShopKind = "shop" | "office";

export type ShopSession = {
  id: number;
  kind: ShopKind;
  clock_in_at: string;
  clock_out_at: string | null;
  open: boolean;
  st_timesheet_write: false;
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

function toPublic(row: {
  id: number;
  kind: string;
  clock_in_at: string;
  clock_out_at: string | null;
}): ShopSession {
  return {
    id: row.id,
    kind: row.kind === "office" ? "office" : "shop",
    clock_in_at: row.clock_in_at,
    clock_out_at: row.clock_out_at,
    open: !row.clock_out_at,
    st_timesheet_write: false,
  };
}

export async function loadShopSessionBrief(
  db: D1Database,
  userId: number,
  today: string
): Promise<ShopSession | null> {
  try {
    await ensureShopClockTables(db);
  } catch {
    /* ignore */
  }
  try {
    const open = await db
      .prepare(
        `SELECT id, kind, clock_in_at, clock_out_at
           FROM fa_time_sessions
           WHERE user_id = ? AND clock_out_at IS NULL
           ORDER BY clock_in_at DESC, id DESC LIMIT 1`
      )
      .bind(userId)
      .first<{ id: number; kind: string; clock_in_at: string; clock_out_at: string | null }>();
    if (open) return { ...toPublic(open), open: true };
    const todayRow = await db
      .prepare(
        `SELECT id, kind, clock_in_at, clock_out_at
           FROM fa_time_sessions
           WHERE user_id = ? AND substr(clock_in_at, 1, 10) = ?
           ORDER BY clock_in_at DESC, id DESC LIMIT 1`
      )
      .bind(userId, today)
      .first<{ id: number; kind: string; clock_in_at: string; clock_out_at: string | null }>();
    if (!todayRow) return null;
    return toPublic(todayRow);
  } catch {
    return null;
  }
}

export async function getOpenShopSession(
  db: D1Database,
  userId: number
): Promise<ShopSession | null> {
  try {
    await ensureShopClockTables(db);
    const open = await db
      .prepare(
        `SELECT id, kind, clock_in_at, clock_out_at
           FROM fa_time_sessions
           WHERE user_id = ? AND clock_out_at IS NULL
           ORDER BY clock_in_at DESC, id DESC LIMIT 1`
      )
      .bind(userId)
      .first<{ id: number; kind: string; clock_in_at: string; clock_out_at: string | null }>();
    return open ? { ...toPublic(open), open: true } : null;
  } catch {
    return null;
  }
}

export async function clockShopIn(
  _env: unknown,
  db: D1Database,
  user: PublicUser,
  body: Record<string, unknown>
): Promise<
  | { ok: false; status: number; error: string; session?: ShopSession }
  | { ok: true; deduped: boolean; session: ShopSession; label: string }
> {
  await ensureShopClockTables(db);
  const kind: ShopKind = String(body.kind || "shop") === "office" ? "office" : "shop";
  const clientTs =
    (body.client_ts && String(body.client_ts).trim()) || new Date().toISOString();
  const open = await getOpenShopSession(db, user.id);
  if (open) {
    return {
      ok: true,
      deduped: true,
      session: open,
      label: "Shop/Office already clocked in (Field App only)",
    };
  }
  const ins = await db
    .prepare(
      `INSERT INTO fa_time_sessions (user_id, kind, clock_in_at, client_in_ts, sync_status)
       VALUES (?, ?, ?, ?, 'fa_only')`
    )
    .bind(user.id, kind, clientTs, clientTs)
    .run();
  const row = await db
    .prepare(`SELECT id, kind, clock_in_at, clock_out_at FROM fa_time_sessions WHERE id = ?`)
    .bind(Number(ins.meta.last_row_id))
    .first<{ id: number; kind: string; clock_in_at: string; clock_out_at: string | null }>();
  if (!row) return { ok: false, status: 500, error: "Insert failed" };
  return {
    ok: true,
    deduped: false,
    session: toPublic(row),
    label: "Shop/Office clocked in (Field App only — ST timesheet write is phase 2)",
  };
}

export async function clockShopOut(
  _env: unknown,
  db: D1Database,
  user: PublicUser,
  body: Record<string, unknown>
): Promise<
  | { ok: false; status: number; error: string; session?: ShopSession }
  | { ok: true; deduped: boolean; session: ShopSession; label: string }
> {
  await ensureShopClockTables(db);
  const clientTs =
    (body.client_ts && String(body.client_ts).trim()) || new Date().toISOString();
  const open = await getOpenShopSession(db, user.id);
  if (!open) {
    return { ok: false, status: 400, error: "No open Shop/Office session to clock out." };
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
    .prepare(`SELECT id, kind, clock_in_at, clock_out_at FROM fa_time_sessions WHERE id = ?`)
    .bind(open.id)
    .first<{ id: number; kind: string; clock_in_at: string; clock_out_at: string | null }>();
  if (!row) return { ok: false, status: 500, error: "Update failed" };
  return {
    ok: true,
    deduped: false,
    session: toPublic(row),
    label: "Shop/Office clocked out (Field App only)",
  };
}
