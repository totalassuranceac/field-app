/**
 * Tomorrow materials pull requests.
 * Create notifies Chris + warehouse. Parts ready notifies requester + techs.
 * In-app only. ASCII titles. No customer SMS. No ST parts writes.
 */
import type { Env, PublicUser } from "./types";
import { notifyUsers, usersByRoles } from "./notifications";
import { logSms, normalizePhone, sendSms } from "./sms";
import { canEditMaterials, canOrderMaterials, canReadMaterials, chicagoIso } from "./jobMaterials";
import { HARD_LOCK_INSTALL_PAIRS, namesMatchHint } from "./installCrewPairs";
import { takePullOffShelf, type PullShelfNote } from "./stockBook";

export { canEditMaterials, canOrderMaterials, canReadMaterials, chicagoIso };

export type MaterialsRequest = {
  id: number;
  appointment_date: string;
  address_text: string;
  job_id: string | null;
  tech_user_ids: string;
  tech_names_text: string | null;
  status: "needed" | "ordered" | "ready" | "cancelled";
  created_by_user_id: number;
  ready_by_user_id: number | null;
  ready_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  requester_name?: string | null;
  lines?: Array<{ id: number; description: string; qty: number }>;
};

let ready = false;

export async function ensureMaterialsRequests(db: D1Database): Promise<void> {
  if (ready) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS materials_requests (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         appointment_date TEXT NOT NULL,
         address_text TEXT NOT NULL,
         job_id TEXT,
         tech_user_ids TEXT NOT NULL,
         tech_names_text TEXT,
         status TEXT NOT NULL DEFAULT 'needed',
         created_by_user_id INTEGER NOT NULL,
         ready_by_user_id INTEGER,
         ready_at TEXT,
         note TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS materials_request_lines (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         request_id INTEGER NOT NULL,
         description TEXT NOT NULL,
         qty REAL NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();
  try {
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_mat_req_date_status
         ON materials_requests(appointment_date, status)`
      )
      .run();
  } catch {
    /* ignore */
  }
  ready = true;
}

function techIds(raw: string | null | undefined): number[] {
  const s = String(raw || "").trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s) as unknown;
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((n) => Number(n)).filter((n) => n > 0))];
    }
  } catch {
    /* comma list */
  }
  return [...new Set(s.split(/[,\s]+/).map((n) => Number(n)).filter((n) => n > 0))];
}

function summary(lines: Array<{ description: string; qty: number }>): string {
  return lines
    .map((l) => `${l.qty} x ${l.description}`)
    .join("; ")
    .slice(0, 180);
}

async function chrisIds(db: D1Database): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT id FROM users WHERE active = 1 AND (
         lower(IFNULL(display_name, '')) LIKE 'chris marroquin%'
         OR lower(IFNULL(username, '')) IN ('admin', 'chrismarroquin')
       )`
    )
    .all<{ id: number }>();
  return (rows.results || []).map((r) => r.id);
}

async function attachLines(db: D1Database, rows: MaterialsRequest[]): Promise<MaterialsRequest[]> {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");
  const lines = await db
    .prepare(
      `SELECT id, request_id, description, qty FROM materials_request_lines
       WHERE request_id IN (${ph}) ORDER BY id`
    )
    .bind(...ids)
    .all<{ id: number; request_id: number; description: string; qty: number }>();
  const by = new Map<number, Array<{ id: number; description: string; qty: number }>>();
  for (const line of lines.results || []) {
    const arr = by.get(line.request_id) || [];
    arr.push({ id: line.id, description: line.description, qty: line.qty });
    by.set(line.request_id, arr);
  }
  return rows.map((r) => ({ ...r, lines: by.get(r.id) || [] }));
}

export async function listRequests(db: D1Database, date: string): Promise<MaterialsRequest[]> {
  await ensureMaterialsRequests(db);
  const q = await db
    .prepare(
      `SELECT r.*, u.display_name AS requester_name
       FROM materials_requests r
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.appointment_date = ? AND r.status != 'cancelled'
       ORDER BY CASE r.status WHEN 'needed' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END, r.id`
    )
    .bind(date)
    .all<MaterialsRequest>();
  return attachLines(db, q.results || []);
}

export async function getRequest(db: D1Database, id: number): Promise<MaterialsRequest | null> {
  await ensureMaterialsRequests(db);
  const row = await db
    .prepare(
      `SELECT r.*, u.display_name AS requester_name
       FROM materials_requests r
       LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.id = ?`
    )
    .bind(id)
    .first<MaterialsRequest>();
  if (!row) return null;
  const [withLines] = await attachLines(db, [row]);
  return withLines || null;
}

export async function requestFlags(
  db: D1Database,
  date: string
): Promise<{ jobs: Record<string, { open: number }>; addresses: Record<string, { open: number }> }> {
  const rows = await listRequests(db, date);
  const jobs: Record<string, { open: number }> = {};
  const addresses: Record<string, { open: number }> = {};
  for (const r of rows) {
    if (r.status !== "needed" && r.status !== "ordered") continue;
    if (r.job_id) {
      jobs[r.job_id] = { open: (jobs[r.job_id]?.open || 0) + 1 };
    }
    const addr = r.address_text.trim().toLowerCase();
    if (addr) addresses[addr] = { open: (addresses[addr]?.open || 0) + 1 };
  }
  return { jobs, addresses };
}

/** Technicians (field) and lead installers only. No office, warehouse, helpers, or shop staff. */
const STREET_SUFFIX = new Set([
  "st",
  "street",
  "ave",
  "avenue",
  "dr",
  "drive",
  "blvd",
  "boulevard",
  "ln",
  "lane",
  "rd",
  "road",
  "ct",
  "court",
  "way",
  "pkwy",
  "parkway",
]);

function normAddress(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/#/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addressCore(raw: string): { num: string; street: string; full: string } {
  let t = normAddress(raw).replace(/\b(apt|unit|ste|suite)\b.*$/, "").trim();
  const full = t;
  const m = t.match(/^(\d+)\s+(.+)$/);
  if (!m) return { num: "", street: "", full };
  const tokens = m[2]
    .split(" ")
    .filter((w) => w && !STREET_SUFFIX.has(w));
  return { num: m[1], street: tokens.join(" "), full };
}

/** Confident street match only. No city/ZIP-only or single-word guesses. */
export function addressesConfidentMatch(a: string, b: string): boolean {
  const A = addressCore(a);
  const B = addressCore(b);
  if (!A.full || !B.full) return false;
  if (
    A.full.length >= 12 &&
    B.full.length >= 12 &&
    (A.full === B.full || A.full.includes(B.full) || B.full.includes(A.full))
  ) {
    return true;
  }
  if (!A.num || A.num !== B.num) return false;
  if (A.street.length < 4 || B.street.length < 4) return false;
  if (A.street === B.street) return true;
  const at = A.street.split(" ");
  const bt = B.street.split(" ");
  const [shorter, longer] = at.length <= bt.length ? [at, bt] : [bt, at];
  return shorter.every((tok) => tok.length >= 4 && longer.includes(tok));
}

export type PickupSuggest = {
  pickup_id: number;
  address: string;
  part_summary: string;
  picked_at: string | null;
};

export async function suggestPickupsForAddress(
  db: D1Database,
  address: string
): Promise<PickupSuggest[]> {
  const needle = address.trim();
  if (needle.length < 8) return [];
  const rows = await db
    .prepare(
      `SELECT t.id, t.notes AS address, t.updated_at,
         (SELECT group_concat(COALESCE(NULLIF(l.part_name, ''), l.part_code), '; ')
          FROM part_pickup_ticket_lines l
          WHERE l.ticket_id = t.id AND l.status = 'picked') AS part_summary,
         (SELECT MAX(l.resolved_at) FROM part_pickup_ticket_lines l
          WHERE l.ticket_id = t.id AND l.status = 'picked') AS picked_at
       FROM part_pickup_tickets t
       WHERE t.updated_at >= datetime('now', '-30 days')
         AND EXISTS (
           SELECT 1 FROM part_pickup_ticket_lines l
           WHERE l.ticket_id = t.id AND l.status = 'picked'
         )
       ORDER BY t.updated_at DESC
       LIMIT 200`
    )
    .all<{
      id: number;
      address: string | null;
      part_summary: string | null;
      picked_at: string | null;
      updated_at: string | null;
    }>();
  const matches: PickupSuggest[] = [];
  for (const row of rows.results || []) {
    const addr = (row.address || "").trim();
    if (!addr || !addressesConfidentMatch(needle, addr)) continue;
    matches.push({
      pickup_id: row.id,
      address: addr,
      part_summary: (row.part_summary || "Part").slice(0, 160),
      picked_at: row.picked_at || row.updated_at,
    });
    if (matches.length >= 5) break;
  }
  return matches;
}

export async function techOptions(db: D1Database): Promise<Array<{ id: number; name: string }>> {
  const rows = await db
    .prepare(
      `SELECT id, display_name, role FROM users
       WHERE active = 1
       ORDER BY display_name`
    )
    .all<{ id: number; display_name: string; role: string }>();
  const helperHints = HARD_LOCK_INSTALL_PAIRS.map((p) => p.helper);
  const leadHints = HARD_LOCK_INSTALL_PAIRS.map((p) => p.lead);
  const out: Array<{ id: number; name: string }> = [];
  for (const row of rows.results || []) {
    const name = row.display_name || "";
    const isHelper = helperHints.some((hint) => namesMatchHint(name, hint));
    if (isHelper) continue;
    const isLead = leadHints.some((hint) => namesMatchHint(name, hint));
    const isTech = row.role === "driver";
    if (!isTech && !isLead) continue;
    if (row.role === "office" || row.role === "warehouse" || row.role === "admin") continue;
    out.push({ id: row.id, name });
  }
  return out;
}

export async function createRequest(
  db: D1Database,
  user: PublicUser,
  input: {
    appointment_date?: string | null;
    address_text: string;
    job_id?: string | null;
    tech_user_ids: number[];
    lines: Array<{ description: string; qty?: number | null }>;
    note?: string | null;
  }
): Promise<MaterialsRequest> {
  await ensureMaterialsRequests(db);
  const date = (input.appointment_date || chicagoIso(1)).slice(0, 10);
  const techs = [...new Set(input.tech_user_ids.map((n) => Number(n)).filter((n) => n > 0))];
  if (!techs.length) throw new Error("Pick the tech on the job");
  const allowed = new Set((await techOptions(db)).map((t) => t.id));
  if (techs.some((id) => !allowed.has(id))) {
    throw new Error("Pick a technician or lead installer");
  }
  const lines = input.lines
    .map((l) => ({
      description: String(l.description || "").trim(),
      qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
    }))
    .filter((l) => l.description.length >= 2);
  if (!lines.length) throw new Error("Add at least one material");
  const names = await db
    .prepare(
      `SELECT id, display_name FROM users WHERE id IN (${techs.map(() => "?").join(",")})`
    )
    .bind(...techs)
    .all<{ id: number; display_name: string }>();
  const nameText = (names.results || []).map((r) => r.display_name).join(", ");
  const ins = await db
    .prepare(
      `INSERT INTO materials_requests (
         appointment_date, address_text, job_id, tech_user_ids, tech_names_text,
         status, created_by_user_id, note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'needed', ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(
      date,
      input.address_text.trim(),
      input.job_id || null,
      JSON.stringify(techs),
      nameText || null,
      user.id,
      (input.note || "").trim() || null
    )
    .run();
  const id = Number(ins.meta.last_row_id);
  for (const line of lines) {
    await db
      .prepare(
        `INSERT INTO materials_request_lines (request_id, description, qty, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      )
      .bind(id, line.description, line.qty)
      .run();
  }
  const row = await getRequest(db, id);
  if (!row) throw new Error("Could not save request");
  const who = [...new Set([...(await chrisIds(db)), ...(await usersByRoles(db, ["warehouse"]))])].filter(
    (uid) => uid !== user.id
  );
  const body = `${row.address_text} - ${nameText || "tech"} - ${summary(lines)} - requested by ${user.display_name}`;
  await notifyUsers(db, who, "materials_request", "Tomorrow materials - pull needed", body.slice(0, 240), {
    type: "materials_request",
    id,
  });
  return row;
}

/** One SMS to warehouse phones when a pull is created. No SMS on Parts ready. */
export async function smsSpeedyPull(
  env: Env,
  db: D1Database,
  row: MaterialsRequest,
  fromUserId: number
): Promise<void> {
  const people = await db
    .prepare(
      `SELECT id, phone FROM users
       WHERE active = 1 AND (
         role = 'warehouse' OR IFNULL(is_warehouse, 0) = 1
         OR lower(IFNULL(display_name, '')) LIKE '%speedy%'
         OR lower(IFNULL(username, '')) LIKE '%speedy%'
       )`
    )
    .all<{ id: number; phone: string | null }>();
  const targets: Array<{ userId: number | null; phone: string }> = [];
  const seen = new Set<string>();
  for (const person of people.results || []) {
    const phone = normalizePhone(person.phone || "");
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    targets.push({ userId: person.id, phone });
  }
  if (!targets.length) {
    const fallback = normalizePhone("3615223308");
    if (fallback) targets.push({ userId: null, phone: fallback });
  }
  const techs = row.tech_names_text || "tech";
  const parts = summary(row.lines || []);
  const text = `TA: Pull for tomorrow - ${row.address_text} - ${techs} - ${parts}. Open Field App -> Pull for tomorrow.`.slice(
    0,
    300
  );
  for (const target of targets) {
    const sent = await sendSms(env, target.phone, text);
    await logSms(db, {
      from_user_id: fromUserId > 0 ? fromUserId : null,
      to_user_id: target.userId,
      to_phone: target.phone,
      body: text,
      status: sent.ok ? "sent" : "failed",
      provider_sid: sent.ok ? sent.sid : null,
      error: sent.ok ? null : sent.error,
      context: `materials_request:${row.id}`,
    });
  }
}

export async function openPullCount(db: D1Database): Promise<number> {
  await ensureMaterialsRequests(db);
  const tomorrow = chicagoIso(1);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM materials_requests
       WHERE status IN ('needed', 'ordered') AND appointment_date <= ?`
    )
    .bind(tomorrow)
    .first<{ c: number }>();
  return Number(row?.c || 0);
}

export async function markPartsReady(
  db: D1Database,
  user: PublicUser,
  id: number
): Promise<{ row: MaterialsRequest; notified: boolean; shelf: PullShelfNote[] }> {
  const before = await getRequest(db, id);
  if (!before) throw new Error("Not found");
  if (before.status === "ready") return { row: before, notified: false, shelf: [] };
  if (before.status === "cancelled") throw new Error("Cancelled");
  const marked = await db
    .prepare(
      `UPDATE materials_requests
       SET status = 'ready', ready_by_user_id = ?, ready_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status != 'ready'`
    )
    .bind(user.id, id)
    .run();
  if (!Number(marked.meta?.changes || 0)) {
    const current = await getRequest(db, id);
    if (!current) throw new Error("Not found");
    return { row: current, notified: false, shelf: [] };
  }
  let shelf: PullShelfNote[] = [];
  try {
    shelf = await takePullOffShelf(db, user.id, before.lines || []);
  } catch {
    shelf = [];
  }
  const row = await getRequest(db, id);
  if (!row) throw new Error("Not found");
  const ids = [
    ...new Set([row.created_by_user_id, ...techIds(row.tech_user_ids)].filter((n) => n > 0 && n !== user.id)),
  ];
  const body = `${row.address_text} - ${summary(row.lines || [])} - Warehouse marked ready - load before leaving.`;
  await notifyUsers(db, ids, "materials_ready", "Parts ready to load", body.slice(0, 240), {
    type: "materials_request",
    id,
  });
  return { row, notified: true, shelf };
}

export async function markOrdered(
  db: D1Database,
  user: PublicUser,
  id: number,
  note?: string | null
): Promise<MaterialsRequest> {
  if (!canOrderMaterials(user)) throw new Error("Only warehouse can mark Ordered");
  const before = await getRequest(db, id);
  if (!before) throw new Error("Not found");
  if (before.status === "ready" || before.status === "cancelled") {
    throw new Error("Cannot order a ready or cancelled request");
  }
  await db
    .prepare(
      `UPDATE materials_requests
       SET status = 'ordered', note = COALESCE(?, note), updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind((note || "").trim() || null, id)
    .run();
  const row = await getRequest(db, id);
  if (!row) throw new Error("Not found");
  return row;
}
