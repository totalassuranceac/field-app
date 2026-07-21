/**
 * Free-first alert channels for fleet incidents.
 *
 * Priority order (cost):
 *  1. In-app notifications (always free — already created by caller)
 *  2. ntfy.sh push (free phone app — https://ntfy.sh)
 *  3. Discord webhook (free office channel)
 *  4. Twilio SMS (optional paid — only if secrets configured)
 */

import { getSetting, setSetting } from "./audit";
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
  /** tags for ntfy (emoji names) */
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

/** Easy default topic name — same word everyone remembers and types in the ntfy app. */
export const DEFAULT_NTFY_TOPIC = "totalassurance";

/**
 * Admin-only ntfy channel for Settings “Send test”.
 * Real emergencies stay on DEFAULT_NTFY_TOPIC so the mechanic is not buzzed by tests.
 * Admin must subscribe to this word in ntfy (in addition to the fleet channel).
 */
export const NTFY_ADMIN_TEST_TOPIC = "totalassurance-admin";

function asciiHeader(s: string, max = 120): string {
  return (s || "Fleet alert")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || "Fleet alert";
}

async function rememberNtfyStatus(db: D1Database, detail: string): Promise<void> {
  try {
    await setSetting(db, "last_ntfy_status", `${new Date().toISOString()} | ${detail.slice(0, 300)}`);
  } catch {
    /* ignore */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientNtfyFailure(status: number, body: string): boolean {
  // 522 = Cloudflare origin timeout (very common when Workers call ntfy.sh)
  if ([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(status)) {
    return true;
  }
  return /error code:\s*52[0-4]|timeout|temporar|rate.?limit|overloaded/i.test(body);
}

type NtfyAttempt = { ok: boolean; detail: string; retryable: boolean };

function fetchTimeoutSignal(ms: number): AbortSignal | undefined {
  try {
    // Workers support AbortSignal.timeout; fall back if missing
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

async function tryNtfyOnce(
  server: string,
  topic: string,
  token: string,
  title: string,
  message: string,
  priority: number,
  tags: string[],
  opts?: { timeoutMs?: number; classicOnly?: boolean }
): Promise<NtfyAttempt> {
  const errors: string[] = [];
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const signal = fetchTimeoutSignal(timeoutMs);

  // Classic publish to /topic (simplest, works when ntfy is healthy)
  try {
    const h: Record<string, string> = {
      Title: asciiHeader(title),
      Priority: String(priority),
      Tags: tags.join(","),
      "User-Agent": "TotalAssuranceFleet/1.0",
    };
    if (token) h.Authorization = `Bearer ${token}`;
    // Skip Click — some ntfy/CF edges are flaky with extra headers on free tier
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: h,
      body: message,
      signal,
    });
    const text = await res.text().catch(() => "");
    if (res.ok) return { ok: true, detail: `ntfy ok → ${topic}`, retryable: false };
    errors.push(`classic ${res.status}: ${text.slice(0, 80)}`);
    if (isTransientNtfyFailure(res.status, text)) {
      return { ok: false, detail: errors.join(" | "), retryable: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`classic err: ${msg}`);
    // Timeout / network — retryable
    if (opts?.classicOnly) {
      return { ok: false, detail: errors.join(" | "), retryable: true };
    }
  }

  if (opts?.classicOnly) {
    return { ok: false, detail: errors.join(" | ") || "classic only failed", retryable: true };
  }

  // JSON publish fallback
  try {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "TotalAssuranceFleet/1.0",
    };
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(`${server}/`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        topic,
        title: asciiHeader(title, 200),
        message,
        priority,
        tags,
      }),
      signal: fetchTimeoutSignal(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) return { ok: true, detail: `ntfy ok json → ${topic}`, retryable: false };
    errors.push(`json ${res.status}: ${text.slice(0, 80)}`);
    return {
      ok: false,
      detail: errors.join(" | "),
      retryable: isTransientNtfyFailure(res.status, text),
    };
  } catch (e) {
    errors.push(`json err: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, detail: errors.join(" | "), retryable: true };
  }
}

/** ntfy.sh — free push. Retries on Cloudflare 522/timeouts (common Worker→ntfy.sh issue). */
export async function sendNtfy(
  env: Env,
  db: D1Database,
  payload: AlertPayload,
  opts?: {
    maxAttempts?: number;
    /** Per-attempt fetch timeout (ms). Default 8000. */
    timeoutMs?: number;
    /** Only classic /topic publish (faster for in-request first try). */
    classicOnly?: boolean;
    /** Override settings topic (e.g. admin test topic). */
    topic?: string;
  }
): Promise<{ ok: boolean; detail?: string }> {
  const topic =
    (opts?.topic || (await getSetting(db, "ntfy_topic", DEFAULT_NTFY_TOPIC))).trim() ||
    DEFAULT_NTFY_TOPIC;
  if (!topic) {
    await rememberNtfyStatus(db, "fail: ntfy_topic not set");
    return { ok: false, detail: "ntfy_topic not set" };
  }

  let server = ((await getSetting(db, "ntfy_server", "https://ntfy.sh")) || "https://ntfy.sh")
    .trim()
    .replace(/\/$/, "");
  if (!/^https?:\/\//i.test(server)) server = `https://${server}`;
  const token = (await getSetting(db, "ntfy_token", "")).trim();

  const priority =
    payload.priority === "urgent" ? 5 : payload.priority === "high" ? 4 : 3;
  const message = (payload.body || "Open the fleet app.").slice(0, 3900);
  const title = (payload.title || "Fleet alert").slice(0, 200);
  const tags = payload.tags?.length ? payload.tags : ["warning"];
  const maxAttempts = opts?.maxAttempts ?? 4;
  const timeoutMs = opts?.timeoutMs ?? 8000;

  let lastDetail = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await tryNtfyOnce(server, topic, token, title, message, priority, tags, {
      timeoutMs,
      classicOnly: opts?.classicOnly,
    });
    if (result.ok) {
      const detail =
        attempt > 1 ? `${result.detail} (attempt ${attempt})` : result.detail;
      await rememberNtfyStatus(db, detail);
      return { ok: true, detail };
    }
    lastDetail = result.detail;
    if (!result.retryable || attempt === maxAttempts) break;
    // Back off: 400ms, 900ms, 1800ms — beat intermittent 522s
    await sleep(400 * attempt * attempt);
  }

  const detail = `ntfy failed (${server}/${topic}): ${lastDetail}`;
  await rememberNtfyStatus(db, detail);
  return { ok: false, detail };
}

/**
 * Keep trying ntfy in the background after a failed/slow first wave.
 * Use with executionCtx.waitUntil so the driver UI is not blocked.
 */
export async function sendNtfyWithBackgroundRetries(
  env: Env,
  db: D1Database,
  payload: AlertPayload
): Promise<{ ok: boolean; detail?: string }> {
  // First wave: up to ~3s of retries
  const first = await sendNtfy(env, db, payload, { maxAttempts: 3 });
  if (first.ok) return first;

  // Second wave: more spaced attempts (522 often clears in a few seconds)
  for (let i = 0; i < 3; i++) {
    await sleep(2000 + i * 2500);
    const r = await sendNtfy(env, db, payload, { maxAttempts: 2 });
    if (r.ok) {
      await rememberNtfyStatus(db, `${r.detail} (background retry ${i + 1})`);
      return r;
    }
  }
  return first;
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
 * Fan out free (+ optional paid) alerts.
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
    /** ntfy attempts in this call (default 4 — handles 522 timeouts) */
    ntfyAttempts?: number;
    /** Override ntfy topic (rare; tests use fleet topic by default) */
    ntfyTopic?: string;
    /** Skip Discord (e.g. silent admin test) */
    skipDiscord?: boolean;
  }
): Promise<{ ntfy: boolean; discord: boolean; sms: number; details: string[] }> {
  const details: string[] = [];
  const ntfy = await sendNtfy(env, db, payload, {
    maxAttempts: opts?.ntfyAttempts ?? 4,
    topic: opts?.ntfyTopic,
  });
  details.push(ntfy.detail || (ntfy.ok ? "ntfy ok" : "ntfy skip"));

  let discord = { ok: false, detail: "discord skip" as string | undefined };
  if (!opts?.skipDiscord) {
    discord = await sendDiscord(db, payload);
  }
  details.push(discord.detail || (discord.ok ? "discord ok" : "discord skip"));

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

  return { ntfy: ntfy.ok, discord: discord.ok, sms, details };
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
 * Main phone push is usually already sent by the /issues route — pass skipMainPush
 * to only handle nearby-driver alerts (avoids double ntfy + false "failed" races).
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
    /** When true, do not send the main shop ntfy again (route already did / client will). */
    skipMainPush?: boolean;
    /** When true, never publish extra ntfy (same topic = duplicate phone buzzes). */
    skipNtfy?: boolean;
  }
): Promise<{
  nearby: NearbyDriver[];
  channels: { ntfy: boolean; discord: boolean; sms: number };
}> {
  const base =
    opts.appBaseUrl ||
    env.APP_BASE_URL ||
    "";
  const click = base ? `${base.replace(/\/$/, "")}/issues` : undefined;
  const noNtfy = Boolean(opts.skipNtfy);

  const shortDesc = (opts.description || "").trim().slice(0, 120);
  const title = opts.isEmergency
    ? `EMERGENCY Unit ${opts.unitNumber}: ${opts.title}`
    : `Repair Unit ${opts.unitNumber}: ${opts.title}`;
  const body = [
    `From: ${opts.fromName}`,
    shortDesc || (opts.isEmergency ? "Needs help now — open the fleet app." : "New shop request."),
    opts.isEmergency ? "Open Repairs / contact the driver ASAP." : "Open Repairs & shop board.",
  ].join("\n");

  let channels: { ntfy: boolean; discord: boolean; sms: number } = {
    ntfy: false,
    discord: false,
    sms: 0,
  };

  if (!opts.skipMainPush && !noNtfy) {
    const phones = await shopPhones(db);
    channels = await fanOutAlert(
      env,
      db,
      {
        title,
        body,
        sms: `TA Fleet ${opts.isEmergency ? "EMERGENCY" : "repair"} unit ${opts.unitNumber}: ${opts.title}. ${shortDesc || "Open app."} — ${opts.fromName}`,
        priority: opts.isEmergency ? "urgent" : "high",
        // Keep tags minimal — some ntfy edges reject unknown tag combos
        tags: opts.isEmergency ? ["rotating_light", "exclamation"] : ["wrench"],
        clickUrl: click,
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
      // In-app only for nearby drivers — do NOT ntfy the shared shop topic again
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
    // No second phone push when GPS has no match — main emergency ntfy already covers shop
  }

  return { nearby, channels };
}
