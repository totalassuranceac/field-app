import type { Env, PublicUser } from "./types";
import { logSms, sendSms, smsConfigured } from "./sms";
import { getOpenShopSession } from "./shopClock";

const CLOCK_AUDIT_CHRIS_PHONE = "3617791182";
const TZ = "America/Chicago";
const MAX_OPEN_HOURS = 12;

type AuditRule =
  | "open_overnight"
  | "double_open"
  | "shop_with_jobs"
  | "st_write_failed"
  | "session_gt_12h"
  | "negative_duration";

let tablesReady = false;

async function ensureClockAuditTables(db: D1Database): Promise<void> {
  if (tablesReady) return;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS fa_clock_audit_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          day TEXT NOT NULL,
          rule_key TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(user_id, day, rule_key)
        )`
      )
      .run();
  } catch {
    /* exists */
  }
  tablesReady = true;
}

function techLabel(user: PublicUser): string {
  const name = String(user.display_name || user.username || `user ${user.id}`).trim();
  return name.slice(0, 40);
}

function buildSmsBody(rule: AuditRule, user: PublicUser, detail?: string | null): string {
  const who = techLabel(user);
  const bits: Record<AuditRule, string> = {
    open_overnight: `Clock open overnight: ${who}`,
    double_open: `Double clock-in: ${who}`,
    shop_with_jobs: `Shop clock with jobs today: ${who}`,
    st_write_failed: `Clock ST write failed: ${who}`,
    session_gt_12h: `Clock open >12h: ${who}`,
    negative_duration: `Clock-out before in: ${who}`,
  };
  let body = bits[rule];
  if (detail) body = `${body} — ${detail}`.slice(0, 220);
  if (body.length <= 120) body = `${body} -Atlas`;
  return body.slice(0, 280);
}

async function alreadyAlerted(db: D1Database, userId: number, day: string, rule: string): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT id FROM fa_clock_audit_alerts
           WHERE user_id = ? AND day = ? AND rule_key = ? LIMIT 1`
      )
      .bind(userId, day, rule)
      .first<{ id: number }>();
    return Boolean(row?.id);
  } catch {
    return false;
  }
}

async function markAlerted(
  db: D1Database,
  userId: number,
  day: string,
  rule: string,
  message: string
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO fa_clock_audit_alerts (user_id, day, rule_key, message)
         VALUES (?, ?, ?, ?)`
      )
      .bind(userId, day, rule, message.slice(0, 500))
      .run();
    return true;
  } catch {
    return false;
  }
}

async function fireAlert(
  env: Env,
  db: D1Database,
  user: PublicUser,
  day: string,
  rule: AuditRule,
  detail?: string | null
) {
  if (await alreadyAlerted(db, user.id, day, rule)) {
    return { rule, sent: false, skipped: true, reason: "deduped" };
  }
  const body = buildSmsBody(rule, user, detail);
  const claimed = await markAlerted(db, user.id, day, rule, body);
  if (!claimed) return { rule, sent: false, skipped: true, reason: "deduped" };
  if (!smsConfigured(env)) {
    return { rule, sent: false, skipped: true, reason: "sms_not_configured" };
  }
  const sent = await sendSms(env, CLOCK_AUDIT_CHRIS_PHONE, body);
  await logSms(db, {
    from_user_id: user.id,
    to_user_id: null,
    to_phone: CLOCK_AUDIT_CHRIS_PHONE,
    body,
    status: sent.ok ? "sent" : "failed",
    provider_sid: sent.ok ? sent.sid : null,
    error: sent.ok ? null : sent.error,
    context: `clock_audit:${rule}`,
  });
  return {
    rule,
    sent: sent.ok,
    skipped: !sent.ok,
    reason: sent.ok ? "sent" : sent.error || "sms_failed",
  };
}

function sessionAgeHours(clockInAt: string, now = Date.now()): number | null {
  const t = Date.parse(clockInAt);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 36e5;
}

function chicagoDateOf(iso: string): string | null {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) {
      const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    }
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return null;
  }
}

function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function countOpenShopSessions(db: D1Database, userId: number): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM fa_time_sessions
           WHERE user_id = ? AND clock_out_at IS NULL`
      )
      .bind(userId)
      .first<{ n: number }>();
    return Number(row?.n || 0);
  } catch {
    return 0;
  }
}

export async function runClockAuditAfterPunch(
  env: Env,
  db: D1Database,
  user: PublicUser,
  ctx: {
    action: "job_clock" | "shop_in" | "shop_out";
    step?: string;
    kind?: string;
    hasScheduledJobsToday?: boolean;
    sessionId?: number;
    clockInAt?: string | null;
    clockOutAt?: string | null;
    stWriteFailed?: boolean;
    stWriteError?: string | null;
  }
) {
  const alerts = [];
  try {
    await ensureClockAuditTables(db);
    const today = chicagoToday();
    if (ctx.action === "shop_out" && ctx.clockInAt && ctx.clockOutAt) {
      const a = Date.parse(ctx.clockInAt);
      const b = Date.parse(ctx.clockOutAt);
      if (Number.isFinite(a) && Number.isFinite(b) && b < a) {
        alerts.push(await fireAlert(env, db, user, today, "negative_duration", "out before in"));
      }
    }
    if (ctx.action === "shop_in" && ctx.hasScheduledJobsToday) {
      alerts.push(
        await fireAlert(
          env,
          db,
          user,
          today,
          "shop_with_jobs",
          `${ctx.kind || "shop"} while ST jobs on schedule`
        )
      );
    }
    if (ctx.stWriteFailed) {
      alerts.push(
        await fireAlert(env, db, user, today, "st_write_failed", (ctx.stWriteError || ctx.step || "sync").slice(0, 140))
      );
    }
    let open = null;
    try {
      open = await getOpenShopSession(db, user.id);
    } catch {
      open = null;
    }
    if (open) {
      const inDay = chicagoDateOf(open.clock_in_at);
      if (inDay && inDay < today) {
        alerts.push(
          await fireAlert(env, db, user, today, "open_overnight", `since ${inDay} (${open.kind})`)
        );
      }
      const age = sessionAgeHours(open.clock_in_at);
      if (age != null && age >= MAX_OPEN_HOURS) {
        alerts.push(
          await fireAlert(env, db, user, today, "session_gt_12h", `${Math.floor(age)}h ${open.kind}`)
        );
      }
    }
    const openCount = await countOpenShopSessions(db, user.id);
    if (openCount > 1) {
      alerts.push(
        await fireAlert(env, db, user, today, "double_open", `${openCount} open Shop/Office sessions`)
      );
    }
    if (ctx.action === "job_clock" && ctx.step === "dispatch" && open) {
      alerts.push(
        await fireAlert(env, db, user, today, "double_open", `job dispatch while ${open.kind} still open`)
      );
    }
  } catch (e) {
    console.log("[clock-audit] error", e instanceof Error ? e.message : String(e));
  }
  return { alerts };
}
