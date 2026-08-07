/**
 * Alert channels for fleet incidents.
 *
 * Priority order:
 *  1. In-app notifications (always free — already created by caller)
 *  2. Discord webhook (optional free office channel)
 *  3. Twilio SMS (optional paid — only if secrets configured)
 */

import { getSetting } from "./audit";
import { getLivePositions, type LivePosition } from "./gps";
import { logSms, normalizePhone, sendSms, smsConfigured } from "./sms";
import { notifyUsers } from "./notifications";
import type { Env } from "./types";

export type AlertPriority = "default" | "high" | "urgent";

export interface AlertPayload {
  title: string;
  body: string;
  /** short SMS-friendly body */
  sms?: string;
  priority?: AlertPriority;
  /** optional tags (unused; kept for payload shape compatibility) */
  tags?: string[];
  clickUrl?: string;
}

export interface NearbyDriver {
  user_id: number;
  display_name: string;
  phone: string | null;
  unit_number: string;
  vehicle_id: number;
  miles: number;
  lat: number;
  lng: number;
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Free Discord webhook for office / shop channel */
export async function sendDiscord(
  db: D1Database,
  payload: AlertPayload
): Promise<{ ok: boolean; detail?: string }> {
  const url = (await getSetting(db, "discord_webhook_url", "")).trim();
  if (!url || !url.startsWith("https://")) return { ok: false, detail: "discord not set" };

  const content = `**${payload.title}**\n${payload.body}`.slice(0, 1900);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, detail: `discord ${res.status}: ${t.slice(0, 100)}` };
    }
    return { ok: true, detail: "discord sent" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "discord failed" };
  }
}

/** Optional paid SMS (Twilio) to a list of phones */
export async function sendSmsToPhones(
  env: Env,
  db: D1Database,
  phones: string[],
  text: string,
  fromUserId: number | null,
  context: string
): Promise<number> {
  if (!smsConfigured(env)) return 0;
  let n = 0;
  const seen = new Set<string>();
  for (const raw of phones) {
    const phone = normalizePhone(raw);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const sent = await sendSms(env, phone, text);
    await logSms(db, {
      from_user_id: fromUserId,
      to_user_id: null,
      to_phone: phone,
      body: text,
      status: sent.ok ? "sent" : "failed",
      provider_sid: sent.ok ? sent.sid : null,
      error: sent.ok ? null : sent.error,
      context,
    });
    if (sent.ok) n++;
  }
  return n;
}

/**
 * Fan out Discord + optional SMS.
 * In-app notifyUsers should already have been called by the route.
 */
export async function fanOutAlert(
  env: Env,
  db: D1Database,
  payload: AlertPayload,
  opts?: {
    fromUserId?: number | null;
    context?: string;
    /** Also text these phones if Twilio is configured */
    smsPhones?: string[];
    /** Skip Discord (e.g. silent admin test) */
    skipDiscord?: boolean;
  }
): Promise<{ discord: boolean; sms: number; details: string[] }> {
  const details: string[] = [];

  let discordOk = false;
  let discordDetail = "discord skip";
  if (!opts?.skipDiscord) {
    const discord = await sendDiscord(db, payload);
    discordOk = discord.ok;
    discordDetail = discord.detail || (discord.ok ? "discord ok" : "discord skip");
  }
  details.push(discordDetail);

  let sms = 0;
  if (opts?.smsPhones?.length) {
    sms = await sendSmsToPhones(
      env,
      db,
      opts.smsPhones,
      payload.sms || `${payload.title}: ${payload.body}`.slice(0, 300),
      opts.fromUserId ?? null,
      opts.context || "alert"
    );
    details.push(sms ? `sms ${sms}` : "sms none");
  }

  return { discord: discordOk, sms, details };
}

/**
 * Find the 3 nearest other active drivers to a stranded vehicle (using live GPS).
 */
export async function findNearestDrivers(
  env: Env,
  db: D1Database,
  strandedVehicleId: number,
  limit = 3
): Promise<{ origin: LivePosition | null; nearby: NearbyDriver[] }> {
  let live;
  try {
    live = await getLivePositions(env, false);
  } catch {
    return { origin: null, nearby: [] };
  }

  const origin =
    live.positions.find((p) => p.vehicle_id === strandedVehicleId && Number.isFinite(p.lat)) ||
    null;
  if (!origin) return { origin: null, nearby: [] };

  // Active drivers with phones / user ids, linked via assigned unit
  const drivers = await db
    .prepare(
      `SELECT u.id as user_id, u.display_name, u.phone, u.employee_id,
              e.name as employee_name,
              v.id as vehicle_id, v.unit_number, v.assigned_driver
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN vehicles v ON v.status = 'active' AND (
         (u.employee_id IS NOT NULL AND v.assigned_driver IS NOT NULL AND (
           LOWER(TRIM(v.assigned_driver)) = LOWER(TRIM(COALESCE(e.name, '')))
           OR LOWER(v.assigned_driver) LIKE '%' || LOWER(TRIM(COALESCE(e.name, ''))) || '%'
         ))
         OR (v.assigned_driver IS NOT NULL AND (
           LOWER(TRIM(v.assigned_driver)) = LOWER(TRIM(u.display_name))
           OR LOWER(v.assigned_driver) LIKE '%' || LOWER(TRIM(u.display_name)) || '%'
         ))
       )
       WHERE u.active = 1 AND u.role = 'driver'`
    )
    .all<{
      user_id: number;
      display_name: string;
      phone: string | null;
      employee_id: number | null;
      employee_name: string | null;
      vehicle_id: number | null;
      unit_number: string | null;
      assigned_driver: string | null;
    }>();

  // Also map live positions → vehicle → any driver on that unit
  const byVehicle = new Map<number, { user_id: number; display_name: string; phone: string | null }>();
  for (const d of drivers.results || []) {
    if (d.vehicle_id && d.vehicle_id !== strandedVehicleId) {
      byVehicle.set(d.vehicle_id, {
        user_id: d.user_id,
        display_name: d.display_name,
        phone: d.phone,
      });
    }
  }

  const scored: NearbyDriver[] = [];
  const seenUsers = new Set<number>();

  for (const p of live.positions) {
    if (p.vehicle_id == null || p.vehicle_id === strandedVehicleId) continue;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const driver = byVehicle.get(p.vehicle_id);
    if (!driver || seenUsers.has(driver.user_id)) continue;
    const miles = haversineMiles(origin.lat, origin.lng, p.lat, p.lng);
    if (!Number.isFinite(miles) || miles > 80) continue; // ignore far units
    seenUsers.add(driver.user_id);
    scored.push({
      user_id: driver.user_id,
      display_name: driver.display_name,
      phone: driver.phone,
      unit_number: p.unit_number || "?",
      vehicle_id: p.vehicle_id,
      miles: Math.round(miles * 10) / 10,
      lat: p.lat,
      lng: p.lng,
    });
  }

  scored.sort((a, b) => a.miles - b.miles);
  return { origin, nearby: scored.slice(0, limit) };
}

/**
 * Phones for optional SMS on fleet incidents.
 * Prefers admin-set role lines (shop / mechanic / office), then individual user phones.
 */
export async function shopPhones(db: D1Database): Promise<string[]> {
  const phones: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const t = (raw || "").trim();
    if (!t) return;
    const n = normalizePhone(t);
    const key = n || t;
    if (seen.has(key)) return;
    seen.add(key);
    phones.push(t);
  };

  // Admin-configured defaults (Settings / Admin page)
  add(await getSetting(db, "shop_sms_phone", ""));
  add(await getSetting(db, "mechanic_sms_phone", ""));
  add(await getSetting(db, "office_sms_phone", ""));

  const rows = await db
    .prepare(
      `SELECT phone FROM users WHERE active = 1 AND role IN ('mechanic','admin','office')
       AND phone IS NOT NULL AND TRIM(phone) != ''`
    )
    .all<{ phone: string }>();
  for (const r of rows.results || []) add(r.phone);
  return phones;
}

/**
 * Full incident fan-out used when a driver reports a repair / emergency.
 * Sends Discord + optional SMS to shop; nearby drivers get in-app (+ SMS if phones on file).
 */
export async function alertFleetIncident(
  env: Env,
  db: D1Database,
  opts: {
    fromUserId: number;
    fromName: string;
    unitNumber: string;
    vehicleId: number;
    issueId: number;
    title: string;
    description?: string | null;
    isEmergency: boolean;
    appBaseUrl?: string;
    /** When true, skip Discord/SMS main shop fan-out (only nearby drivers). */
    skipMainPush?: boolean;
  }
): Promise<{
  nearby: NearbyDriver[];
  channels: { discord: boolean; sms: number };
}> {
  const shortDesc = (opts.description || "").trim().slice(0, 120);
  const title = opts.isEmergency
    ? `EMERGENCY Unit ${opts.unitNumber}: ${opts.title}`
    : `Repair Unit ${opts.unitNumber}: ${opts.title}`;
  const body = [
    `From: ${opts.fromName}`,
    shortDesc || (opts.isEmergency ? "Needs help now — open the fleet app." : "New shop request."),
    opts.isEmergency ? "Open Repairs / contact the driver ASAP." : "Open Repairs & shop board.",
  ].join("\n");

  let channels: { discord: boolean; sms: number } = {
    discord: false,
    sms: 0,
  };

  if (!opts.skipMainPush) {
    const phones = await shopPhones(db);
    channels = await fanOutAlert(
      env,
      db,
      {
        title,
        body,
        sms: `TA Fleet ${opts.isEmergency ? "EMERGENCY" : "repair"} unit ${opts.unitNumber}: ${opts.title}. ${shortDesc || "Open app."} — ${opts.fromName}`,
        priority: opts.isEmergency ? "urgent" : "high",
        tags: opts.isEmergency ? ["rotating_light", "exclamation"] : ["wrench"],
      },
      {
        fromUserId: opts.fromUserId,
        context: opts.isEmergency ? `emergency_issue:${opts.issueId}` : `repair_issue:${opts.issueId}`,
        smsPhones: phones,
      }
    );
  }

  let nearby: NearbyDriver[] = [];
  if (opts.isEmergency) {
    const near = await findNearestDrivers(env, db, opts.vehicleId, 3);
    nearby = near.nearby;

    if (nearby.length) {
      const nearIds = nearby.map((n) => n.user_id);
      const nearList = nearby
        .map((n) => `Unit ${n.unit_number} (${n.display_name}, ~${n.miles} mi)`)
        .join("; ");
      // In-app only for nearby drivers
      await notifyUsers(
        db,
        nearIds,
        "roadside_help",
        `HELP NEEDED · Unit ${opts.unitNumber} · ${opts.title}`,
        `${opts.fromName} is stopped and may need roadside help. You are one of the closest units (${nearList.split(";")[0] || "nearby"}). Call or head that way if you can. Open Live map for location.`,
        { type: "vehicle_issue", id: opts.issueId }
      );

      // Optional SMS to nearby drivers who have phones on file (Twilio only)
      const nearPhones = nearby.map((n) => n.phone).filter(Boolean) as string[];
      if (nearPhones.length && smsConfigured(env)) {
        await sendSmsToPhones(
          env,
          db,
          nearPhones,
          `TA Fleet: Unit ${opts.unitNumber} needs help (${opts.title}). You're nearby — check Live map or call office. — ${opts.fromName}`,
          opts.fromUserId,
          `nearby_help:${opts.issueId}`
        );
      }
    }
  }

  return { nearby, channels };
}
