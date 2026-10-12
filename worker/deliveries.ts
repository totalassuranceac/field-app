/** Deliveries I/O. Tables come from migration 109 only. This file does not create them. */

import { getSetting, setSetting, writeAudit } from "./audit";
import {
  ageDaysCt,
  cleanDeliveryPhotoKey,
  cleanSpotLabel,
  deliveryTarget,
  escapeLike,
  isOverdue,
  nextStatus,
  officeNoticeText,
  parseDeliveryLines,
  parseScheduledFor,
  receiveError,
  settingOn,
  smsCapReached,
  SPOT_HINT,
  warrantyLinks,
  type WarrantyClaimMatch,
} from "./deliveriesPlan";
import { notifyUsers, smsUsers } from "./notifications";
import { partsReceiveSmsAllowed } from "./partsReceivePlan";
import { smsConfigured } from "./sms";
import type { Env, PublicUser } from "./types";
import { toAsciiUiText } from "./utf8Mojibake";

export {
  settingOn,
  SPOT_HINT,
  officeNoticeText,
  deliveryTarget,
};

export const OFFICE_BELL_SQL =
  "SELECT id FROM users WHERE active = 1 AND (role = 'admin' OR (role = 'office' AND IFNULL(is_warehouse, 0) = 0))";

export const OFFICE_SMS_SQL =
  "SELECT id FROM users WHERE active = 1 AND role = 'office' AND IFNULL(is_warehouse, 0) = 0";

const MIGRATION_ERROR = "Run migration 109_part_deliveries.sql (after Chris says Y).";

export { MIGRATION_ERROR };

type SqlBind = string | number | null;

export async function deliveriesReady(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT 1 FROM part_deliveries LIMIT 1").first();
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return false;
    throw e;
  }
}

export async function officeBellIds(db: D1Database): Promise<number[]> {
  const rows = await db.prepare(OFFICE_BELL_SQL).all<{ id: number }>();
  return (rows.results || []).map((r) => Number(r.id)).filter((id) => id > 0);
}

export async function officeSmsIds(db: D1Database): Promise<number[]> {
  const rows = await db.prepare(OFFICE_SMS_SQL).all<{ id: number }>();
  return (rows.results || []).map((r) => Number(r.id)).filter((id) => id > 0);
}

export async function logDeliveryEvent(
  db: D1Database,
  row: {
    deliveryId: number;
    actorId: number;
    eventType: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    note?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO part_delivery_events (
         delivery_id, actor_user_id, event_type, from_status, to_status, note, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(
      row.deliveryId,
      row.actorId,
      row.eventType,
      row.fromStatus ?? null,
      row.toStatus ?? null,
      row.note ?? null
    )
    .run();
}

type DeliveryCore = {
  id: number;
  status: string;
  scheduled_at: string | null;
  spot_label: string;
  job_kind: string;
  job_number: string | null;
  customer_name: string | null;
  job_address: string | null;
  po_number: string | null;
};

async function loadCore(db: D1Database, id: number): Promise<DeliveryCore | null> {
  return db
    .prepare(
      `SELECT id, status, scheduled_at, spot_label, job_kind, job_number, customer_name, job_address, po_number
       FROM part_deliveries WHERE id = ?`
    )
    .bind(id)
    .first<DeliveryCore>();
}

function clipText(raw: unknown, max: number): string {
  return toAsciiUiText(String(raw ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function resolveSpot(
  db: D1Database,
  user: PublicUser,
  spotIdRaw: unknown,
  newLabelRaw: unknown
): Promise<{ id: number; label: string; reactivated: boolean }> {
  const spotId = Number(spotIdRaw);
  if (spotId > 0) {
    const spot = await db
      .prepare(`SELECT id, label, active FROM delivery_spots WHERE id = ?`)
      .bind(spotId)
      .first<{ id: number; label: string; active: number }>();
    if (!spot || Number(spot.active) !== 1) throw new Error("Pick where it is staged.");
    return { id: spot.id, label: spot.label, reactivated: false };
  }
  const cleaned = cleanSpotLabel(newLabelRaw);
  if ("error" in cleaned) throw new Error(cleaned.error);
  await db
    .prepare(
      `INSERT OR IGNORE INTO delivery_spots (label, label_key, hint, created_by_user_id)
       VALUES (?, ?, ?, ?)`
    )
    .bind(cleaned.label, cleaned.key, SPOT_HINT, user.id)
    .run();
  const spot = await db
    .prepare(`SELECT id, label, active FROM delivery_spots WHERE label_key = ?`)
    .bind(cleaned.key)
    .first<{ id: number; label: string; active: number }>();
  if (!spot) throw new Error("Pick where it is staged.");
  let reactivated = false;
  if (Number(spot.active) !== 1) {
    await db
      .prepare(`UPDATE delivery_spots SET active = 1, updated_at = datetime('now') WHERE id = ?`)
      .bind(spot.id)
      .run();
    reactivated = true;
  }
  return { id: spot.id, label: spot.label || cleaned.label, reactivated };
}

export async function listDeliveries(
  _env: Env,
  db: D1Database,
  opts: { view?: string; q?: string; id?: number; limit?: number }
): Promise<{ deliveries: Record<string, unknown>[] }> {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200));
  const where: string[] = [];
  const binds: SqlBind[] = [];
  const focusId = Number(opts.id);
  if (focusId > 0) {
    where.push("d.id = ?");
    binds.push(focusId);
  } else {
    const view = opts.view === "picked" || opts.view === "all" ? opts.view : "open";
    if (view === "open") where.push("d.status IN ('received','scheduled')");
    else if (view === "picked") where.push("d.status = 'picked_up'");
  }
  const q = String(opts.q || "").trim();
  if (q.length >= 2) {
    const like = `%${escapeLike(q)}%`;
    where.push(
      `(IFNULL(d.job_number,'') LIKE ? OR IFNULL(d.customer_name,'') LIKE ? OR IFNULL(d.job_address,'') LIKE ?
        OR IFNULL(d.po_number,'') LIKE ? OR IFNULL(d.vendor_name,'') LIKE ? OR IFNULL(d.spot_label,'') LIKE ?
        OR IFNULL(d.note,'') LIKE ?
        OR EXISTS (SELECT 1 FROM part_delivery_lines l WHERE l.delivery_id = d.id AND l.description LIKE ?))`
    );
    for (let i = 0; i < 8; i++) binds.push(like);
  }
  const openOrder = !(focusId > 0) && (opts.view || "open") !== "picked" && (opts.view || "open") !== "all";
  const order = openOrder ? "d.received_at ASC" : "d.received_at DESC";
  binds.push(limit);
  const rows = await db
    .prepare(
      `SELECT d.*,
              ru.display_name AS received_by_name,
              su.display_name AS scheduled_by_name,
              pu.display_name AS picked_up_by_name,
              lu.display_name AS picked_up_logged_by_name
       FROM part_deliveries d
       LEFT JOIN users ru ON ru.id = d.received_by_user_id
       LEFT JOIN users su ON su.id = d.scheduled_by_user_id
       LEFT JOIN users pu ON pu.id = d.picked_up_by_user_id
       LEFT JOIN users lu ON lu.id = d.picked_up_logged_by_user_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${order}
       LIMIT ?`
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  const list = rows.results || [];
  const ids = list.map((r) => Number(r.id)).filter((id) => id > 0);
  const linesById = new Map<number, Record<string, unknown>[]>();
  const eventsById = new Map<number, Record<string, unknown>[]>();
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const lineRows = await db
      .prepare(
        `SELECT id, delivery_id, line_no, description, part_code, qty
         FROM part_delivery_lines WHERE delivery_id IN (${ph})
         ORDER BY line_no, id`
      )
      .bind(...ids)
      .all<Record<string, unknown>>();
    for (const line of lineRows.results || []) {
      const id = Number(line.delivery_id);
      const bucket = linesById.get(id) || [];
      bucket.push(line);
      linesById.set(id, bucket);
    }
    const ev = await db
      .prepare(
        `SELECT e.id, e.delivery_id, e.actor_user_id, e.event_type, e.from_status, e.to_status,
                e.note, e.created_at, u.display_name AS actor_name
         FROM part_delivery_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.delivery_id IN (${ph})
         ORDER BY e.id DESC`
      )
      .bind(...ids)
      .all<Record<string, unknown>>();
    for (const e of ev.results || []) {
      const id = Number(e.delivery_id);
      const bucket = eventsById.get(id) || [];
      if (bucket.length < 12) bucket.push(e);
      eventsById.set(id, bucket);
    }
  }
  let claims: WarrantyClaimMatch[] = [];
  try {
    const claimSql = `SELECT id, log_number, status, service_address, customer_name, rma_number
         FROM warranty_claims
         WHERE status IN ('dropped_off','claim_submitted','return_to_vendor','delivered')`;
    try {
      const claimRows = await db
        .prepare(claimSql + ` AND IFNULL(voided, 0) = 0`)
        .all<WarrantyClaimMatch>();
      claims = claimRows.results || [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no such column.*voided/i.test(msg)) throw e;
      const claimRows = await db.prepare(claimSql).all<WarrantyClaimMatch>();
      claims = claimRows.results || [];
    }
  } catch {
    claims = [];
  }
  const now = Date.now();
  return {
    deliveries: list.map((r) => {
      const status = String(r.status || "");
      const age = ageDaysCt(String(r.received_at || ""), now);
      const photoKey = String(r.photo_key || "").trim();
      const target = deliveryTarget({
        job_kind: String(r.job_kind || ""),
        job_number: r.job_number == null ? "" : String(r.job_number),
        customer_name: r.customer_name == null ? "" : String(r.customer_name),
        job_address: r.job_address == null ? "" : String(r.job_address),
      });
      return {
        ...r,
        lines: linesById.get(Number(r.id)) || [],
        events: eventsById.get(Number(r.id)) || [],
        age_days: age,
        overdue: isOverdue(status, age),
        target,
        photo_url: photoKey ? `/api/uploads/${photoKey}` : null,
        warranty_links: warrantyLinks(
          {
            job_kind: String(r.job_kind || ""),
            job_number: r.job_number == null ? "" : String(r.job_number),
            customer_name: r.customer_name == null ? "" : String(r.customer_name),
            job_address: r.job_address == null ? "" : String(r.job_address),
            po_number: r.po_number == null ? "" : String(r.po_number),
          },
          claims
        ),
      };
    }),
  };
}

export async function receiveDelivery(
  _env: Env,
  db: D1Database,
  user: PublicUser,
  body: Record<string, unknown>
): Promise<{ ok: true; id: number; already: boolean }> {
  const token = String(body.client_token || "").trim();
  if (token) {
    const existing = await db
      .prepare(`SELECT id FROM part_deliveries WHERE client_token = ?`)
      .bind(token)
      .first<{ id: number }>();
    if (existing) return { ok: true, id: Number(existing.id), already: true };
  }
  const photo = cleanDeliveryPhotoKey(body.photo_key);
  if (photo.error) throw new Error(photo.error);
  const formError = receiveError({
    photo_key: photo.key,
    po_number: body.po_number == null ? "" : String(body.po_number),
    job_kind: body.job_kind == null ? "" : String(body.job_kind),
    job_number: body.job_number == null ? "" : String(body.job_number),
    st_job_id: body.st_job_id == null ? "" : String(body.st_job_id),
    customer_name: body.customer_name == null ? "" : String(body.customer_name),
    spot_id: Number(body.spot_id) || null,
    new_spot_label: body.new_spot_label == null ? "" : String(body.new_spot_label),
  });
  if (formError) throw new Error(formError);
  const parsed = parseDeliveryLines(body.lines);
  if ("error" in parsed) throw new Error(parsed.error);
  const spot = await resolveSpot(db, user, body.spot_id, body.new_spot_label);
  const jobKind = String(body.job_kind || "") === "stock" ? "stock" : "job";
  const vendor = clipText(body.vendor_name, 60) || null;
  const po = clipText(body.po_number, 40) || null;
  const jobNumber = jobKind === "stock" ? null : clipText(String(body.job_number || "").replace(/^#+/, ""), 120) || null;
  const customer = jobKind === "stock" ? null : clipText(body.customer_name, 120) || null;
  const address = jobKind === "stock" ? null : clipText(body.job_address, 120) || null;
  const stJob = jobKind === "stock" ? null : clipText(body.st_job_id, 120) || null;
  const note = clipText(body.note, 300) || null;
  const locId = Number(body.st_location_id) > 0 ? Number(body.st_location_id) : null;
  let id = 0;
  try {
    const ins = await db
      .prepare(
        `INSERT INTO part_deliveries (
           received_by_user_id, vendor_name, po_number, photo_key, job_kind, st_job_id, job_number,
           customer_name, job_address, st_location_id, spot_id, spot_label, note, status, client_token
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
      )
      .bind(
        user.id,
        vendor,
        po,
        photo.key,
        jobKind,
        stJob,
        jobNumber,
        customer,
        address,
        locId,
        spot.id,
        spot.label,
        note,
        token || null
      )
      .run();
    id = Number(ins.meta.last_row_id || 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (token && /unique/i.test(msg)) {
      const existing = await db
        .prepare(`SELECT id FROM part_deliveries WHERE client_token = ?`)
        .bind(token)
        .first<{ id: number }>();
      if (existing) return { ok: true, id: Number(existing.id), already: true };
    }
    throw e;
  }
  if (!id) throw new Error("Could not save the delivery.");
  for (let i = 0; i < parsed.lines.length; i++) {
    const line = parsed.lines[i];
    await db
      .prepare(
        `INSERT INTO part_delivery_lines (delivery_id, line_no, description, part_code, qty)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(id, i + 1, line.description, line.part_code, line.qty)
      .run();
  }
  await logDeliveryEvent(db, {
    deliveryId: id,
    actorId: user.id,
    eventType: "received",
    fromStatus: null,
    toStatus: "received",
  });
  const target = deliveryTarget({ job_kind: jobKind, job_number: jobNumber, customer_name: customer, job_address: address });
  const audit = `${target} @ ${spot.label}${spot.reactivated ? " spot re-activated" : ""}`;
  await writeAudit(db, user, "create", "part_delivery", id, audit);
  return { ok: true, id, already: false };
}

export async function notifyDeliveryReceived(
  env: Env,
  db: D1Database,
  deliveryId: number,
  actor: PublicUser
): Promise<{ bell: number; sms: number; sms_skipped_reason?: string }> {
  try {
    const row = await db
      .prepare(
        `SELECT id, job_kind, job_number, customer_name, job_address, spot_label
         FROM part_deliveries WHERE id = ?`
      )
      .bind(deliveryId)
      .first<{
        id: number;
        job_kind: string;
        job_number: string | null;
        customer_name: string | null;
        job_address: string | null;
        spot_label: string;
      }>();
    if (!row) return { bell: 0, sms: 0, sms_skipped_reason: "missing" };
    const target = deliveryTarget(row);
    const text = officeNoticeText(row, row.spot_label || "");
    const title = `Parts in - ${target.slice(0, 60)}`;
    const bellIds = (await officeBellIds(db)).filter((id) => id !== actor.id);
    if (bellIds.length) {
      await notifyUsers(db, bellIds, "part_delivery", title, text, { type: "part_delivery", id: deliveryId });
    }
    const job = String(row.job_kind || "") === "job";
    const flagOn = settingOn(await getSetting(db, "deliveries_sms_enabled", "false"));
    const configured = smsConfigured(env);
    const allowed = partsReceiveSmsAllowed(env.TWILIO_MESSAGING_SERVICE_SID, env.TWILIO_FROM_NUMBER);
    let sms = 0;
    let reason: string | undefined;
    if (job && flagOn && configured && allowed) {
      const smsIds = (await officeSmsIds(db)).filter((id) => id !== actor.id);
      const keep: number[] = [];
      for (const id of smsIds) {
        try {
          const countRow = await db
            .prepare(
              `SELECT COUNT(*) AS c FROM sms_log
               WHERE to_user_id = ? AND status = 'sent' AND context LIKE 'part_delivery:%'
                 AND created_at > datetime('now','-24 hours')`
            )
            .bind(id)
            .first<{ c: number }>();
          if (smsCapReached(Number(countRow?.c || 0))) continue;
          keep.push(id);
        } catch {
          /* skip this person if the count cannot be read */
        }
      }
      if (keep.length) {
        sms = await smsUsers(env, db, keep, text, `part_delivery:${deliveryId}`, {
          excludeUserId: actor.id,
          fromUserId: actor.id,
        });
      }
    } else if (!job) reason = "stock";
    else if (!flagOn) reason = "off";
    else if (!configured) reason = "sms_not_configured";
    else reason = "sender_not_allowed";
    return { bell: bellIds.length, sms, ...(reason ? { sms_skipped_reason: reason } : {}) };
  } catch {
    return { bell: 0, sms: 0, sms_skipped_reason: "error" };
  }
}

export async function scheduleDelivery(
  db: D1Database,
  user: PublicUser,
  id: number,
  scheduledForRaw: unknown
): Promise<{ ok: true }> {
  const row = await loadCore(db, id);
  if (!row) throw new Error("Not found");
  const nxt = nextStatus(row.status, "schedule", Boolean(row.scheduled_at));
  if ("error" in nxt) throw new Error(nxt.error);
  const when = parseScheduledFor(scheduledForRaw);
  if ("error" in when) throw new Error(when.error);
  await db
    .prepare(
      `UPDATE part_deliveries
       SET status = 'scheduled', scheduled_for = ?, scheduled_at = datetime('now'),
           scheduled_by_user_id = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(when.ymd, user.id, id)
    .run();
  await logDeliveryEvent(db, {
    deliveryId: id,
    actorId: user.id,
    eventType: "scheduled",
    fromStatus: row.status,
    toStatus: "scheduled",
    note: when.ymd || "no date",
  });
  await writeAudit(db, user, "update", "part_delivery", id, `scheduled ${when.ymd || "no date"}`);
  return { ok: true };
}

export async function unscheduleDelivery(db: D1Database, user: PublicUser, id: number): Promise<{ ok: true }> {
  const row = await loadCore(db, id);
  if (!row) throw new Error("Not found");
  const nxt = nextStatus(row.status, "unschedule", Boolean(row.scheduled_at));
  if ("error" in nxt) throw new Error(nxt.error);
  await db
    .prepare(
      `UPDATE part_deliveries
       SET status = 'received', scheduled_for = NULL, scheduled_at = NULL, scheduled_by_user_id = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(id)
    .run();
  await logDeliveryEvent(db, {
    deliveryId: id,
    actorId: user.id,
    eventType: "unscheduled",
    fromStatus: row.status,
    toStatus: "received",
    note: "no date",
  });
  await writeAudit(db, user, "update", "part_delivery", id, "unscheduled");
  return { ok: true };
}

export async function pickupDelivery(
  db: D1Database,
  user: PublicUser,
  id: number,
  pickedByRaw: unknown
): Promise<{ ok: true; already?: boolean }> {
  const row = await loadCore(db, id);
  if (!row) throw new Error("Not found");
  const pickerId = Number(pickedByRaw) > 0 ? Number(pickedByRaw) : user.id;
  const person = await db
    .prepare(`SELECT id, display_name, active FROM users WHERE id = ?`)
    .bind(pickerId)
    .first<{ id: number; display_name: string; active: number }>();
  if (!person || Number(person.active) !== 1) throw new Error("Pick who took it.");
  const nxt = nextStatus(row.status, "pickup", Boolean(row.scheduled_at));
  if ("error" in nxt) {
    if (String(row.status) === "picked_up") return { ok: true, already: true };
    throw new Error(nxt.error);
  }
  const updated = await db
    .prepare(
      `UPDATE part_deliveries
       SET status = 'picked_up', picked_up_at = datetime('now'),
           picked_up_by_user_id = ?, picked_up_logged_by_user_id = ?, updated_at = datetime('now')
       WHERE id = ? AND status IN ('received','scheduled')`
    )
    .bind(pickerId, user.id, id)
    .run();
  if (Number(updated.meta.changes || 0) === 0) {
    const again = await loadCore(db, id);
    if (again && String(again.status) === "picked_up") return { ok: true, already: true };
    throw new Error("Already picked up");
  }
  const note = pickerId !== user.id ? `for ${person.display_name}` : null;
  await logDeliveryEvent(db, {
    deliveryId: id,
    actorId: user.id,
    eventType: "picked_up",
    fromStatus: row.status,
    toStatus: "picked_up",
    note,
  });
  await writeAudit(db, user, "update", "part_delivery", id, note ? `picked up ${note}` : "picked up");
  return { ok: true };
}

export async function undoPickup(db: D1Database, user: PublicUser, id: number): Promise<{ ok: true }> {
  const row = await loadCore(db, id);
  if (!row) throw new Error("Not found");
  const nxt = nextStatus(row.status, "undo_pickup", Boolean(row.scheduled_at));
  if ("error" in nxt) throw new Error(nxt.error);
  await db
    .prepare(
      `UPDATE part_deliveries
       SET status = ?, picked_up_at = NULL, picked_up_by_user_id = NULL, picked_up_logged_by_user_id = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'picked_up'`
    )
    .bind(nxt.to, id)
    .run();
  await logDeliveryEvent(db, {
    deliveryId: id,
    actorId: user.id,
    eventType: "undo_pickup",
    fromStatus: "picked_up",
    toStatus: nxt.to,
  });
  await writeAudit(db, user, "update", "part_delivery", id, `undo pickup -> ${nxt.to}`);
  return { ok: true };
}

export async function voidDelivery(
  db: D1Database,
  user: PublicUser,
  id: number,
  reasonRaw: unknown
): Promise<{ ok: true }> {
  const reason = clipText(reasonRaw, 300);
  if (reason.length < 3) throw new Error("Say why (3+ letters).");
  const row = await loadCore(db, id);
  if (!row) throw new Error("Not found");
  const nxt = nextStatus(row.status, "void", Boolean(row.scheduled_at));
  if ("error" in nxt) throw new Error(nxt.error);
  await db
    .prepare(
      `UPDATE part_deliveries
       SET status = 'voided', voided_at = datetime('now'), voided_by_user_id = ?, void_reason = ?,
           updated_at = datetime('now')
       WHERE id = ? AND status IN ('received','scheduled')`
    )
    .bind(user.id, reason, id)
    .run();
  await logDeliveryEvent(db, {
    deliveryId: id,
    actorId: user.id,
    eventType: "voided",
    fromStatus: row.status,
    toStatus: "voided",
    note: reason,
  });
  await writeAudit(db, user, "update", "part_delivery", id, `voided: ${reason}`);
  return { ok: true };
}

export async function moveDeliverySpot(
  db: D1Database,
  user: PublicUser,
  id: number,
  body: { spot_id?: unknown; new_spot_label?: unknown }
): Promise<{ ok: true }> {
  const row = await loadCore(db, id);
  if (!row) throw new Error("Not found");
  const nxt = nextStatus(row.status, "move_spot", Boolean(row.scheduled_at));
  if ("error" in nxt) throw new Error(nxt.error);
  const spot = await resolveSpot(db, user, body.spot_id, body.new_spot_label);
  await db
    .prepare(
      `UPDATE part_deliveries
       SET spot_id = ?, spot_label = ?, updated_at = datetime('now')
       WHERE id = ? AND status IN ('received','scheduled')`
    )
    .bind(spot.id, spot.label, id)
    .run();
  const note = `${row.spot_label} -> ${spot.label}${spot.reactivated ? " spot re-activated" : ""}`;
  await logDeliveryEvent(db, {
    deliveryId: id,
    actorId: user.id,
    eventType: "spot_moved",
    fromStatus: row.status,
    toStatus: nxt.to,
    note,
  });
  await writeAudit(db, user, "update", "part_delivery", id, note);
  return { ok: true };
}

export async function listSpots(
  db: D1Database,
  includeInactive = false
): Promise<{ spots: { id: number; label: string; hint: string | null; active: number; sort_order: number }[]; hint: string }> {
  const sql = includeInactive
    ? `SELECT id, label, hint, active, sort_order FROM delivery_spots ORDER BY sort_order, label`
    : `SELECT id, label, hint, active, sort_order FROM delivery_spots WHERE active = 1 ORDER BY sort_order, label`;
  const rows = await db.prepare(sql).all<{
    id: number;
    label: string;
    hint: string | null;
    active: number;
    sort_order: number;
  }>();
  return { spots: rows.results || [], hint: SPOT_HINT };
}

export async function addSpot(
  db: D1Database,
  user: PublicUser,
  labelRaw: unknown
): Promise<{ ok: true; id: number; label: string }> {
  const spot = await resolveSpot(db, user, null, labelRaw);
  if (spot.reactivated) {
    await writeAudit(db, user, "update", "delivery_spot", spot.id, "spot re-activated");
  } else {
    await writeAudit(db, user, "create", "delivery_spot", spot.id, spot.label);
  }
  return { ok: true, id: spot.id, label: spot.label };
}

export async function retireSpot(db: D1Database, user: PublicUser, id: number): Promise<{ ok: true }> {
  const spot = await db
    .prepare(`SELECT id, label, active FROM delivery_spots WHERE id = ?`)
    .bind(id)
    .first<{ id: number; label: string; active: number }>();
  if (!spot) throw new Error("Not found");
  await db
    .prepare(`UPDATE delivery_spots SET active = 0, updated_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
  await writeAudit(db, user, "update", "delivery_spot", id, `retired ${spot.label}`);
  return { ok: true };
}

export async function searchPeople(
  db: D1Database,
  qRaw: string
): Promise<{ users: { id: number; display_name: string }[] }> {
  const q = String(qRaw || "").trim();
  if (q.length < 2) return { users: [] };
  const like = `%${escapeLike(q)}%`;
  const rows = await db
    .prepare(
      `SELECT id, display_name FROM users
       WHERE active = 1 AND display_name LIKE ?
       ORDER BY display_name
       LIMIT 10`
    )
    .bind(like)
    .all<{ id: number; display_name: string }>();
  return { users: rows.results || [] };
}

export async function deliveriesSmsOn(db: D1Database): Promise<boolean> {
  return settingOn(await getSetting(db, "deliveries_sms_enabled", "false"));
}

export async function setDeliveriesSms(db: D1Database, user: PublicUser, on: boolean): Promise<{ ok: true; sms_enabled: boolean }> {
  await setSetting(db, "deliveries_sms_enabled", on ? "true" : "false");
  await writeAudit(db, user, "update", "setting", "deliveries_sms_enabled", on ? "deliveries texts on" : "deliveries texts off");
  return { ok: true, sms_enabled: on };
}
