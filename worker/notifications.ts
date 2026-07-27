import type { PublicUser } from "./types";

export async function notifyUsers(
  db: D1Database,
  userIds: number[],
  kind: string,
  title: string,
  body?: string | null,
  entity?: { type: string; id: string | number }
): Promise<void> {
  const uniq = [...new Set(userIds.filter((id) => id > 0))];
  for (const uid of uniq) {
    await db
      .prepare(
        `INSERT INTO notifications (user_id, kind, title, body, entity_type, entity_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        uid,
        kind,
        title,
        body || null,
        entity?.type || null,
        entity?.id != null ? String(entity.id) : null
      )
      .run();
  }
}

export async function usersByRoles(db: D1Database, roles: string[]): Promise<number[]> {
  if (!roles.length) return [];
  const wantWh = roles.includes("warehouse");
  const baseRoles = roles.filter((r) => r !== "warehouse");
  const ids = new Set<number>();
  if (baseRoles.length) {
    const ph = baseRoles.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT id FROM users WHERE active = 1 AND role IN (${ph})`)
      .bind(...baseRoles)
      .all<{ id: number }>();
    for (const r of rows.results || []) ids.add(r.id);
  }
  if (wantWh) {
    try {
      const rows = await db
        .prepare(
          `SELECT id FROM users WHERE active = 1 AND (role = 'warehouse' OR IFNULL(is_warehouse, 0) = 1)`
        )
        .all<{ id: number }>();
      for (const r of rows.results || []) ids.add(r.id);
    } catch {
      /* is_warehouse optional */
    }
  }
  return [...ids];
}

/** Drivers with weekly check overdue on their assigned unit (by assigned_driver name match). */
export async function notifyWeeklyChecksDue(db: D1Database): Promise<number> {
  const due = await db
    .prepare(
      `SELECT v.id as vehicle_id, v.unit_number, v.assigned_driver
       FROM vehicles v
       WHERE v.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM inspections i
           WHERE i.vehicle_id = v.id AND i.inspection_date >= date('now', '-7 days')
         )`
    )
    .all<{ vehicle_id: number; unit_number: string; assigned_driver: string | null }>();

  const drivers = await db
    .prepare(
      `SELECT u.id, u.display_name, u.employee_id, e.name as employee_name
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       WHERE u.active = 1 AND u.role = 'driver'`
    )
    .all<{ id: number; display_name: string; employee_id: number | null; employee_name: string | null }>();

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  let created = 0;
  for (const v of due.results || []) {
    const ad = norm(v.assigned_driver || "");
    if (!ad) continue;
    for (const d of drivers.results || []) {
      const names = [d.display_name, d.employee_name].filter(Boolean).map((n) => norm(String(n)));
      const hit = names.some((n) => n && (ad === n || ad.includes(n) || n.includes(ad)));
      if (!hit) continue;
      // Avoid spam: one unread weekly_check per vehicle per user
      const existing = await db
        .prepare(
          `SELECT id FROM notifications
           WHERE user_id = ? AND kind = 'weekly_check' AND entity_id = ? AND read_at IS NULL
           LIMIT 1`
        )
        .bind(d.id, String(v.vehicle_id))
        .first();
      if (existing) continue;
      await notifyUsers(
        db,
        [d.id],
        "weekly_check",
        `Weekly check due — unit ${v.unit_number}`,
        "Please complete your weekly vehicle check today. Open Weekly checks in the app.",
        { type: "vehicle", id: v.vehicle_id }
      );
      created++;
    }
  }
  return created;
}

/**
 * Ops action alerts (idempotent — one unread per entity):
 * - Warranties open 7+ / 14+ days → warehouse + admin
 * - Open part pickups → warehouse
 * - Equipment needing attention → warehouse + admin
 */
export async function notifyOpsActionItems(db: D1Database): Promise<number> {
  let created = 0;
  const whAdmin = await usersByRoles(db, ["warehouse", "admin"]);
  if (!whAdmin.length) return 0;

  // Aging open warranties
  try {
    const rows = await db
      .prepare(
        `SELECT id, log_number, part_name, status, dropped_off_at,
           CAST((julianday('now') - julianday(dropped_off_at)) AS INTEGER) as days_open
         FROM warranty_claims
         WHERE status IN ('dropped_off','claim_submitted','return_to_vendor','delivered')
           AND dropped_off_at <= datetime('now', '-7 days')
         ORDER BY dropped_off_at ASC
         LIMIT 40`
      )
      .all<{
        id: number;
        log_number: string;
        part_name: string;
        status: string;
        days_open: number;
      }>();
    for (const w of rows.results || []) {
      const days = Number(w.days_open) || 0;
      const urgent = days >= 14;
      const kind = urgent ? "warranty_urgent" : "warranty_aging";
      const existing = await db
        .prepare(
          `SELECT id FROM notifications
           WHERE kind = ? AND entity_id = ? AND read_at IS NULL
           LIMIT 1`
        )
        .bind(kind, String(w.id))
        .first();
      if (existing) continue;
      await notifyUsers(
        db,
        whAdmin,
        kind,
        urgent
          ? `Warranty ${w.log_number} urgent (${days}d)`
          : `Warranty ${w.log_number} aging (${days}d)`,
        `${w.part_name} · ${w.status.replace(/_/g, " ")} — still open.`,
        { type: "warranty", id: w.id }
      );
      created += whAdmin.length;
    }
  } catch {
    /* table optional */
  }

  // Open part pickups waiting
  try {
    const pickups = await db
      .prepare(
        `SELECT id, request_number, status FROM part_pickups
         WHERE status IN ('open','ready','partial')
         ORDER BY created_at ASC LIMIT 30`
      )
      .all<{ id: number; request_number: string; status: string }>();
    for (const p of pickups.results || []) {
      const existing = await db
        .prepare(
          `SELECT id FROM notifications
           WHERE kind = 'pickup_waiting' AND entity_id = ? AND read_at IS NULL
           LIMIT 1`
        )
        .bind(String(p.id))
        .first();
      if (existing) continue;
      await notifyUsers(
        db,
        whAdmin,
        "pickup_waiting",
        `Part pickup ${p.request_number}`,
        `Status: ${p.status} — needs warehouse attention.`,
        { type: "pickup", id: p.id }
      );
      created += whAdmin.length;
    }
  } catch {
    /* optional */
  }

  // Equipment / assets needing attention
  try {
    const assets = await db
      .prepare(
        `SELECT id, name, asset_tag, condition, status FROM company_assets
         WHERE active = 1 AND (
           condition IN ('damaged','poor','out_of_service')
           OR status IN ('repair','missing')
         )
         LIMIT 25`
      )
      .all<{
        id: number;
        name: string;
        asset_tag: string | null;
        condition: string;
        status: string;
      }>();
    for (const a of assets.results || []) {
      const existing = await db
        .prepare(
          `SELECT id FROM notifications
           WHERE kind = 'asset_attention' AND entity_id = ? AND read_at IS NULL
           LIMIT 1`
        )
        .bind(String(a.id))
        .first();
      if (existing) continue;
      const tag = a.asset_tag ? `${a.asset_tag} · ` : "";
      await notifyUsers(
        db,
        whAdmin,
        "asset_attention",
        `Equipment attention: ${tag}${a.name}`,
        `${a.condition.replace(/_/g, " ")} · ${a.status}`,
        { type: "asset", id: a.id }
      );
      created += whAdmin.length;
    }
  } catch {
    /* optional */
  }

  return created;
}

export async function markNotificationRead(
  db: D1Database,
  user: PublicUser,
  id: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE notifications SET read_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
    .bind(id, user.id)
    .run();
}

/**
 * After odometer updates (fuel log): if unit is at/past next oil due mileage,
 * open a scheduled oil-change shop job (once) and notify mechanics.
 */
export async function ensureOilChangeScheduled(
  db: D1Database,
  vehicleId: number,
  odometer: number
): Promise<{ scheduled: boolean; next_due: number | null }> {
  const last = await db
    .prepare(
      `SELECT * FROM service_records
       WHERE vehicle_id = ? AND service_type = 'oil_change'
       ORDER BY service_date DESC, id DESC LIMIT 1`
    )
    .bind(vehicleId)
    .first<{
      next_due_odometer: number | null;
      interval_miles: number | null;
      odometer: number | null;
    }>();

  // No history yet: seed next due from current + default interval when first fuel logged
  let nextDue = last?.next_due_odometer ?? null;
  if (nextDue == null && last?.odometer != null && last.interval_miles != null) {
    nextDue = last.odometer + last.interval_miles;
  }
  if (nextDue == null) {
    // No oil history — don't auto-open until first oil change is logged by mechanic
    return { scheduled: false, next_due: null };
  }

  if (odometer < nextDue) {
    return { scheduled: false, next_due: nextDue };
  }

  // Already have an open oil-change job?
  const existing = await db
    .prepare(
      `SELECT id FROM vehicle_issues
       WHERE vehicle_id = ? AND issue_category = 'oil_change'
         AND status IN ('open','scheduled','in_progress')
       LIMIT 1`
    )
    .bind(vehicleId)
    .first();
  if (existing) return { scheduled: false, next_due: nextDue };

  const unit = await db
    .prepare("SELECT unit_number FROM vehicles WHERE id = ?")
    .bind(vehicleId)
    .first<{ unit_number: string }>();

  // System reporter: first admin, else first mechanic
  const reporter = await db
    .prepare(
      `SELECT id FROM users WHERE active = 1 AND role IN ('admin','mechanic','office')
       ORDER BY CASE role WHEN 'mechanic' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id LIMIT 1`
    )
    .first<{ id: number }>();
  if (!reporter) return { scheduled: false, next_due: nextDue };

  const title = `Oil change due — unit ${unit?.unit_number || vehicleId}`;
  const desc = `Auto-scheduled: odometer ${odometer.toLocaleString()} mi reached next oil service at ${nextDue.toLocaleString()} mi. Mechanic can adjust interval when completing.`;

  const ins = await db
    .prepare(
      `INSERT INTO vehicle_issues
        (vehicle_id, reported_by_user_id, severity, title, description, issue_category, status, scheduled_date)
       VALUES (?, ?, 'medium', ?, ?, 'oil_change', 'scheduled', date('now'))`
    )
    .bind(vehicleId, reporter.id, title, desc)
    .run();

  const issueId = ins.meta.last_row_id as number;
  const techs = await usersByRoles(db, ["mechanic", "admin"]);
  await notifyUsers(
    db,
    techs,
    "oil_change_due",
    title,
    desc,
    { type: "vehicle_issue", id: issueId }
  );

  return { scheduled: true, next_due: nextDue };
}
