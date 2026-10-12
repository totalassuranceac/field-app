/**
 * After a part-pickup ticket is fully picked up:
 * notify the tech, and if it needs an install date notify Chris Miller.
 * In-app only. ASCII. No ServiceTitan write.
 */
import type { PublicUser } from "./types";
import { notifyUsers, usersByRoles } from "./notifications";

let colsReady = false;

export async function ensurePickupScheduleColumns(db: D1Database): Promise<void> {
  if (colsReady) return;
  const alters = [
    `ALTER TABLE part_pickup_tickets ADD COLUMN needs_install_schedule INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE part_pickup_tickets ADD COLUMN schedule_status TEXT`,
    `ALTER TABLE part_pickup_tickets ADD COLUMN contact_user_id INTEGER`,
    `ALTER TABLE part_pickup_tickets ADD COLUMN miller_assigned_user_id INTEGER`,
    `ALTER TABLE part_pickup_tickets ADD COLUMN miller_assigned_at TEXT`,
    `ALTER TABLE part_pickup_tickets ADD COLUMN miller_assigned_by INTEGER`,
    `ALTER TABLE part_pickup_tickets ADD COLUMN picked_notified INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE part_pickup_tickets ADD COLUMN miller_reminded_at TEXT`,
  ];
  for (const sql of alters) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* column exists */
    }
  }
  colsReady = true;
}

export function isMillerUser(user: PublicUser): boolean {
  if (user.role === "admin") return true;
  const name = `${user.display_name || ""} ${user.username || ""}`.toLowerCase();
  return name.includes("miller");
}

async function millerIds(db: D1Database): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT id FROM users WHERE active = 1 AND (
         lower(IFNULL(display_name, '')) LIKE '%miller%'
         OR lower(IFNULL(username, '')) LIKE '%miller%'
       )`
    )
    .all<{ id: number }>();
  return (rows.results || []).map((r) => r.id);
}

export async function availableTechs(db: D1Database): Promise<Array<{ id: number; name: string }>> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  try {
    const rows = await db
      .prepare(
        `SELECT u.id, u.display_name AS name
         FROM users u
         WHERE u.active = 1 AND u.role IN ('driver', 'mechanic')
           AND u.id NOT IN (
             SELECT user_id FROM time_off_requests
             WHERE status = 'approved' AND start_date <= ? AND end_date >= ?
           )
         ORDER BY u.display_name`
      )
      .bind(today, today)
      .all<{ id: number; name: string }>();
    return rows.results || [];
  } catch {
    const rows = await db
      .prepare(
        `SELECT id, display_name AS name FROM users
         WHERE active = 1 AND role IN ('driver', 'mechanic')
         ORDER BY display_name`
      )
      .all<{ id: number; name: string }>();
    return rows.results || [];
  }
}

type TicketBits = {
  id: number;
  vendor_name: string;
  notes: string | null;
  purchase_order: string | null;
  logged_by_user_id: number | null;
  contact_user_id: number | null;
  needs_install_schedule: number | null;
  schedule_status: string | null;
  picked_notified: number | null;
  miller_reminded_at: string | null;
};

async function partSummary(db: D1Database, ticketId: number): Promise<string> {
  const lines = await db
    .prepare(
      `SELECT part_name, part_code FROM part_pickup_ticket_lines WHERE ticket_id = ? ORDER BY line_no, id`
    )
    .bind(ticketId)
    .all<{ part_name: string | null; part_code: string | null }>();
  return (lines.results || [])
    .map((l) => (l.part_name || l.part_code || "Part").trim())
    .filter(Boolean)
    .join("; ")
    .slice(0, 160);
}

/** Call after a line resolve. Idempotent. */
export async function afterPickupLineResolved(
  db: D1Database,
  ticketId: number,
  actorId: number,
  lineStatus: string
): Promise<void> {
  await ensurePickupScheduleColumns(db);
  const ticket = await db
    .prepare(`SELECT * FROM part_pickup_tickets WHERE id = ?`)
    .bind(ticketId)
    .first<TicketBits>();
  if (!ticket) return;
  const open = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM part_pickup_ticket_lines
       WHERE ticket_id = ? AND status IN ('pending', 'not_ready', 'partial')`
    )
    .bind(ticketId)
    .first<{ c: number }>();
  const openN = Number(open?.c || 0);
  const parts = await partSummary(db, ticketId);
  const address = (ticket.notes || "").trim() || "job";
  const vendor = ticket.vendor_name || "vendor";

  if (lineStatus === "partial" && openN > 0) {
    const ids = [
      ...new Set(
        [ticket.logged_by_user_id, ticket.contact_user_id].filter(
          (n): n is number => !!n && n > 0 && n !== actorId
        )
      ),
    ];
    if (ids.length) {
      await notifyUsers(
        db,
        ids,
        "part_pickup_partial",
        "Partial - still waiting on parts",
        `${address} - ${vendor} - ${parts}`.slice(0, 220),
        { type: "part_pickup", id: ticketId }
      );
    }
    return;
  }

  if (openN > 0) return;

  const picked = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM part_pickup_ticket_lines
       WHERE ticket_id = ? AND status = 'picked'`
    )
    .bind(ticketId)
    .first<{ c: number }>();
  if (Number(picked?.c || 0) < 1) return;

  if (!Number(ticket.picked_notified || 0)) {
    await db
      .prepare(`UPDATE part_pickup_tickets SET picked_notified = 1, updated_at = datetime('now') WHERE id = ?`)
      .bind(ticketId)
      .run();
    const ids = [
      ...new Set(
        [ticket.logged_by_user_id, ticket.contact_user_id].filter(
          (n): n is number => !!n && n > 0 && n !== actorId
        )
      ),
    ];
    // Tech-only: also tell warehouse. Install tickets do not ping warehouse again.
    if (!Number(ticket.needs_install_schedule || 0)) {
      try {
        for (const id of await usersByRoles(db, ["warehouse"])) {
          if (id !== actorId) ids.push(id);
        }
      } catch {
        /* ignore */
      }
    }
    const uniq = [...new Set(ids)];
    if (uniq.length) {
      await notifyUsers(
        db,
        uniq,
        "part_pickup_picked",
        "Parts picked up",
        `${address} - ${parts} - ${vendor}`.slice(0, 220),
        { type: "part_pickup", id: ticketId }
      );
    }
  }

  // HARD: Miller only when the install checkbox was on. Tech-only never enters the queue.
  if (Number(ticket.needs_install_schedule || 0) === 1 && !ticket.schedule_status) {
    await db
      .prepare(
        `UPDATE part_pickup_tickets
         SET schedule_status = 'needs_miller', updated_at = datetime('now')
         WHERE id = ? AND schedule_status IS NULL`
      )
      .bind(ticketId)
      .run();
    const millers = (await millerIds(db)).filter((id) => id !== actorId);
    const requester = ticket.logged_by_user_id
      ? await db
          .prepare(`SELECT display_name FROM users WHERE id = ?`)
          .bind(ticket.logged_by_user_id)
          .first<{ display_name: string }>()
      : null;
    await notifyUsers(
      db,
      millers,
      "part_pickup_schedule",
      "Parts ready - put on schedule",
      `${address} - ${parts} - ${requester?.display_name || "requester"} - All parts picked up. Pick a tech and book the install.`.slice(
        0,
        240
      ),
      { type: "part_pickup_schedule", id: ticketId }
    );
  }
}

export async function listScheduleQueue(db: D1Database): Promise<
  Array<TicketBits & { parts: string; requester_name: string | null; assigned_name: string | null }>
> {
  await ensurePickupScheduleColumns(db);
  const rows = await db
    .prepare(
      `SELECT t.*, u.display_name AS requester_name, a.display_name AS assigned_name
       FROM part_pickup_tickets t
       LEFT JOIN users u ON u.id = t.logged_by_user_id
       LEFT JOIN users a ON a.id = t.miller_assigned_user_id
       WHERE t.schedule_status IN ('needs_miller', 'assigned')
       ORDER BY CASE t.schedule_status WHEN 'needs_miller' THEN 0 ELSE 1 END, t.id DESC
       LIMIT 40`
    )
    .all<TicketBits & { requester_name: string | null; assigned_name: string | null }>();
  const out = [];
  for (const row of rows.results || []) {
    out.push({ ...row, parts: await partSummary(db, row.id) });
    if (row.schedule_status === "needs_miller" && !row.miller_reminded_at) {
      const created = await db
        .prepare(`SELECT updated_at FROM part_pickup_tickets WHERE id = ?`)
        .bind(row.id)
        .first<{ updated_at: string }>();
      const ms = created?.updated_at ? Date.parse(created.updated_at.replace(" ", "T") + "Z") : 0;
      if (ms && Date.now() - ms > 24 * 60 * 60 * 1000) {
        await db
          .prepare(
            `UPDATE part_pickup_tickets SET miller_reminded_at = datetime('now') WHERE id = ? AND miller_reminded_at IS NULL`
          )
          .bind(row.id)
          .run();
        await notifyUsers(
          db,
          await millerIds(db),
          "part_pickup_schedule_reminder",
          "Still waiting on schedule",
          `${row.notes || "job"} - parts picked up yesterday. Pick a tech.`.slice(0, 200),
          { type: "part_pickup_schedule", id: row.id }
        );
      }
    }
  }
  return out;
}

export async function assignMillerTech(
  db: D1Database,
  actor: PublicUser,
  ticketId: number,
  techUserId: number
): Promise<void> {
  await ensurePickupScheduleColumns(db);
  if (!isMillerUser(actor)) throw new Error("Miller or admin only");
  const ticket = await db
    .prepare(`SELECT * FROM part_pickup_tickets WHERE id = ?`)
    .bind(ticketId)
    .first<TicketBits>();
  if (!ticket) throw new Error("Not found");
  if (ticket.schedule_status === "booked" || ticket.schedule_status === "skipped") {
    throw new Error("Already closed");
  }
  const tech = await db
    .prepare(`SELECT id, display_name FROM users WHERE id = ? AND active = 1`)
    .bind(techUserId)
    .first<{ id: number; display_name: string }>();
  if (!tech) throw new Error("Tech not found");
  await db
    .prepare(
      `UPDATE part_pickup_tickets
       SET miller_assigned_user_id = ?, miller_assigned_at = datetime('now'),
           miller_assigned_by = ?, schedule_status = 'assigned', updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(tech.id, actor.id, ticketId)
    .run();
  const parts = await partSummary(db, ticketId);
  const address = (ticket.notes || "").trim() || "job";
  await notifyUsers(
    db,
    [tech.id],
    "part_pickup_assigned",
    "Install assigned - parts ready",
    `${address} - ${parts}`.slice(0, 220),
    { type: "part_pickup_schedule", id: ticketId }
  );
  if (ticket.logged_by_user_id && ticket.logged_by_user_id !== tech.id) {
    await notifyUsers(
      db,
      [ticket.logged_by_user_id],
      "part_pickup_assigned_requester",
      "Install assigned - parts ready",
      `${address} - Miller assigned ${tech.display_name}`.slice(0, 220),
      { type: "part_pickup_schedule", id: ticketId }
    );
  }
}

export async function setScheduleStatus(
  db: D1Database,
  actor: PublicUser,
  ticketId: number,
  status: "booked" | "skipped"
): Promise<void> {
  await ensurePickupScheduleColumns(db);
  const office = actor.role === "admin" || actor.role === "office" || isMillerUser(actor);
  if (status === "skipped" && !isMillerUser(actor)) throw new Error("Miller or admin only");
  if (status === "booked" && !office) throw new Error("Not allowed");
  const cur = await db
    .prepare(`SELECT schedule_status FROM part_pickup_tickets WHERE id = ?`)
    .bind(ticketId)
    .first<{ schedule_status: string | null }>();
  if (!cur) throw new Error("Not found");
  if (cur.schedule_status === status) return;
  await db
    .prepare(
      `UPDATE part_pickup_tickets SET schedule_status = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .bind(status, ticketId)
    .run();
}
