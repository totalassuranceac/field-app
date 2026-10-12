/**
 * Parts Ready — materials flagged on a scheduled job.
 * Speedy stages the day before. No ST parts writes. No customer SMS.
 */
import type { PublicUser } from "./types";
import { notifyUsers, usersByRoles } from "./notifications";

export type MaterialStatus = "needed" | "tbd" | "staged" | "ordered" | "cancelled";

export type JobMaterialRow = {
  id: number;
  job_id: string;
  job_number: string | null;
  customer_name: string | null;
  address: string | null;
  appointment_date: string | null;
  description: string;
  qty: number;
  status: MaterialStatus;
  note: string | null;
  created_by: string | null;
  staged_by: string | null;
  staged_at: string | null;
  created_at: string;
  updated_at: string;
};

const OPEN = new Set(["needed", "tbd", "ordered"]);

let ready = false;

export async function ensureJobMaterialsTable(db: D1Database): Promise<void> {
  if (ready) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS job_materials (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         job_id TEXT NOT NULL,
         job_number TEXT,
         customer_name TEXT,
         address TEXT,
         appointment_date TEXT,
         description TEXT NOT NULL,
         qty REAL NOT NULL DEFAULT 1,
         status TEXT NOT NULL DEFAULT 'needed',
         note TEXT,
         created_by TEXT,
         staged_by TEXT,
         staged_at TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();
  for (const sql of [
    `ALTER TABLE job_materials ADD COLUMN job_number TEXT`,
    `ALTER TABLE job_materials ADD COLUMN customer_name TEXT`,
    `ALTER TABLE job_materials ADD COLUMN address TEXT`,
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* column exists */
    }
  }
  try {
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_job_materials_date_status
         ON job_materials(appointment_date, status)`
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_job_materials_job ON job_materials(job_id)`
      )
      .run();
  } catch {
    /* ignore */
  }
  ready = true;
}

export function chicagoIso(offsetDays = 0): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(new Date());
  if (!offsetDays) return today;
  const [y, m, d] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + offsetDays, 12));
  return utc.toISOString().slice(0, 10);
}

export function canEditMaterials(user: PublicUser): boolean {
  if (user.role === "admin" || user.role === "office" || user.role === "supervisor") {
    return true;
  }
  return user.role === "warehouse" || Boolean(user.is_warehouse);
}

/** Order/pull is Speedy (warehouse) + admin only. Office does not buy. */
export function canOrderMaterials(user: PublicUser): boolean {
  if (user.role === "admin") return true;
  return user.role === "warehouse" || Boolean(user.is_warehouse);
}

export function canReadMaterials(user: PublicUser): boolean {
  return canEditMaterials(user) || user.role === "driver" || user.role === "mechanic";
}

function cleanStatus(raw: unknown, fallback: MaterialStatus = "needed"): MaterialStatus {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "needed" || s === "tbd" || s === "staged" || s === "ordered" || s === "cancelled") {
    return s;
  }
  return fallback;
}

export async function listMaterialsForDate(
  db: D1Database,
  date: string
): Promise<JobMaterialRow[]> {
  await ensureJobMaterialsTable(db);
  const q = await db
    .prepare(
      `SELECT * FROM job_materials
       WHERE appointment_date = ? AND status != 'cancelled'
       ORDER BY job_id, id`
    )
    .bind(date)
    .all<JobMaterialRow>();
  return q.results || [];
}

export async function listMaterialsForJob(
  db: D1Database,
  jobId: string
): Promise<JobMaterialRow[]> {
  await ensureJobMaterialsTable(db);
  const q = await db
    .prepare(
      `SELECT * FROM job_materials
       WHERE job_id = ? AND status != 'cancelled'
       ORDER BY id`
    )
    .bind(jobId)
    .all<JobMaterialRow>();
  return q.results || [];
}

/** Jobs on a date that still have an unstaged line (badge). */
export async function openMaterialFlags(
  db: D1Database,
  date: string
): Promise<Record<string, { open: number; staged: number }>> {
  const rows = await listMaterialsForDate(db, date);
  const out: Record<string, { open: number; staged: number }> = {};
  for (const r of rows) {
    const slot = out[r.job_id] || { open: 0, staged: 0 };
    if (r.status === "staged") slot.staged += 1;
    else if (OPEN.has(r.status)) slot.open += 1;
    out[r.job_id] = slot;
  }
  return out;
}

async function notifySpeedyFirstLine(
  db: D1Database,
  row: JobMaterialRow,
  actorId: number
): Promise<void> {
  if (!row.appointment_date) return;
  if (row.appointment_date !== chicagoIso(1)) return;
  if (row.status !== "needed" && row.status !== "tbd") return;
  const prior = await db
    .prepare(
      `SELECT COUNT(*) as c FROM job_materials
       WHERE job_id = ? AND appointment_date = ? AND id != ? AND status != 'cancelled'`
    )
    .bind(row.job_id, row.appointment_date, row.id)
    .first<{ c: number }>();
  if (Number(prior?.c || 0) > 0) return;
  const ids = await usersByRoles(db, ["warehouse"]);
  const who = (row.customer_name || row.address || `Job ${row.job_number || row.job_id}`).slice(0, 80);
  await notifyUsers(
    db,
    ids.filter((id) => id !== actorId),
    "materials_needed",
    `Materials for tomorrow - ${who}`,
    `${row.qty} x ${row.description}`.slice(0, 180),
    { type: "job_materials", id: row.job_id }
  );
}

export async function createMaterial(
  db: D1Database,
  user: PublicUser,
  input: {
    job_id: string;
    job_number?: string | null;
    customer_name?: string | null;
    address?: string | null;
    appointment_date?: string | null;
    description: string;
    qty?: number | null;
    status?: string | null;
    note?: string | null;
  }
): Promise<JobMaterialRow> {
  await ensureJobMaterialsTable(db);
  const status = cleanStatus(input.status, "needed");
  if (status === "ordered" && !canOrderMaterials(user)) {
    throw new Error("Only Speedy can mark Ordered");
  }
  const qty = Number(input.qty);
  const ins = await db
    .prepare(
      `INSERT INTO job_materials (
         job_id, job_number, customer_name, address, appointment_date,
         description, qty, status, note, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(
      input.job_id,
      input.job_number || null,
      input.customer_name || null,
      input.address || null,
      (input.appointment_date || "").slice(0, 10) || null,
      input.description.trim(),
      Number.isFinite(qty) && qty > 0 ? qty : 1,
      status,
      (input.note || "").trim() || null,
      user.display_name || user.username || String(user.id)
    )
    .run();
  const id = Number(ins.meta.last_row_id);
  const row = await db
    .prepare(`SELECT * FROM job_materials WHERE id = ?`)
    .bind(id)
    .first<JobMaterialRow>();
  if (!row) throw new Error("Could not save material");
  try {
    await notifySpeedyFirstLine(db, row, user.id);
  } catch {
    /* notify best-effort */
  }
  return row;
}

export async function patchMaterial(
  db: D1Database,
  user: PublicUser,
  id: number,
  patch: {
    description?: string;
    qty?: number;
    status?: string;
    note?: string | null;
    appointment_date?: string | null;
  }
): Promise<JobMaterialRow> {
  await ensureJobMaterialsTable(db);
  const before = await db
    .prepare(`SELECT * FROM job_materials WHERE id = ?`)
    .bind(id)
    .first<JobMaterialRow>();
  if (!before) throw new Error("Not found");
  const nextStatus = patch.status != null ? cleanStatus(patch.status, before.status) : before.status;
  if (nextStatus === "ordered" && before.status !== "ordered" && !canOrderMaterials(user)) {
    throw new Error("Only Speedy can mark Ordered");
  }
  const who = user.display_name || user.username || String(user.id);
  const staged = nextStatus === "staged";
  await db
    .prepare(
      `UPDATE job_materials SET
         description = ?,
         qty = ?,
         status = ?,
         note = ?,
         appointment_date = COALESCE(?, appointment_date),
         staged_by = CASE WHEN ? = 1 THEN ? ELSE staged_by END,
         staged_at = CASE WHEN ? = 1 THEN datetime('now') ELSE staged_at END,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(
      (patch.description ?? before.description).trim(),
      patch.qty != null && Number(patch.qty) > 0 ? Number(patch.qty) : before.qty,
      nextStatus,
      patch.note !== undefined ? patch.note : before.note,
      patch.appointment_date ? String(patch.appointment_date).slice(0, 10) : null,
      staged ? 1 : 0,
      who,
      staged ? 1 : 0,
      id
    )
    .run();
  const row = await db
    .prepare(`SELECT * FROM job_materials WHERE id = ?`)
    .bind(id)
    .first<JobMaterialRow>();
  if (!row) throw new Error("Not found");
  return row;
}
