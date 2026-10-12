/**
 * POST /api/sms/agent-send
 * A secret key may text Chris Marroquin only. It grants nothing else.
 */
import type { Context } from "hono";
import type { Env, Variables } from "./types";
import { logSms, normalizePhone, sendSms, smsConfigured } from "./sms";
import { secretsMatch } from "./secretCompare";

/** Chris Marroquin 361-779-1182. Code-only on purpose. No settings override, no env override. */
export const AGENT_SMS_ALLOWLIST = ["+13617791182"] as const;

const UNAUTH_ACTIONS = [
  "agent_sms_missing_key",
  "agent_sms_bad_key",
  "agent_sms_key_disabled",
] as const;

type AgentCtx = Context<{ Bindings: Env; Variables: Variables }>;

function fail(c: AgentCtx, status: number, reason: string, error?: string) {
  return c.json({ ok: false, error: error || reason, reason }, status as 400);
}

async function keysMatch(provided: string, secret: string): Promise<boolean> {
  return secretsMatch(provided, secret);
}

function extractAgentKey(c: AgentCtx): { key: string | null; conflict: boolean } {
  const auth = c.req.header("Authorization") || "";
  const bearerMatch = auth.match(/^Bearer\s+(\S.*)$/i);
  const bearer = bearerMatch ? bearerMatch[1].trim() : "";
  const xRaw = c.req.header("X-Agent-Key");
  const xKey = xRaw != null ? xRaw.trim() : "";
  if (bearer && xKey && bearer !== xKey) return { key: null, conflict: true };
  const key = bearer || xKey;
  return { key: key || null, conflict: false };
}

function sanitizeAgent(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9 _-]{1,32}$/.test(s)) return null;
  return s;
}

function sanitizeContext(raw: unknown): string {
  const s = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9 _:.\-]/g, "")
    .slice(0, 60);
  return s || "none";
}

async function unauthAuditAllowed(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_logs
         WHERE action IN ('agent_sms_missing_key','agent_sms_bad_key','agent_sms_key_disabled')
           AND created_at >= datetime('now','-60 minutes')`
      )
      .first<{ n: number }>();
    return Number(row?.n || 0) < 50;
  } catch {
    return false;
  }
}

async function auditAgentSms(
  db: D1Database,
  agentLabel: string,
  outcome: string,
  summary: string,
  after: unknown,
  entityId?: number | null,
  throttleUnauth?: boolean
): Promise<void> {
  try {
    const action = `agent_sms_${outcome}`;
    if (throttleUnauth && UNAUTH_ACTIONS.includes(action as (typeof UNAUTH_ACTIONS)[number])) {
      if (!(await unauthAuditAllowed(db))) return;
    }
    const name = agentLabel.trim() || "unknown";
    await db
      .prepare(
        `INSERT INTO audit_logs (user_id, user_display, action, entity_type, entity_id, summary, after_json)
         VALUES (NULL, ?, ?, 'sms', ?, ?, ?)`
      )
      .bind(
        `agent:${name}`.slice(0, 80),
        action,
        entityId != null ? String(entityId) : null,
        summary.slice(0, 180),
        after != null ? JSON.stringify(after) : null
      )
      .run();
  } catch {
    /* logging must not change the response */
  }
}

function clientMeta(c: AgentCtx): { ip: string; ua: string } {
  return {
    ip: (c.req.header("CF-Connecting-IP") || "").slice(0, 64),
    ua: (c.req.header("User-Agent") || "").slice(0, 80),
  };
}

export async function handleAgentSmsSend(c: AgentCtx): Promise<Response> {
  const db = c.env.DB;
  const secret = String(c.env.AGENT_SMS_KEY || "");
  if (!secret || secret.length < 32) {
    await auditAgentSms(db, "unknown", "key_disabled", "key disabled", clientMeta(c), null, true);
    return fail(c, 401, "unauthorized", "Unauthorized");
  }

  const extracted = extractAgentKey(c);
  if (!extracted.key || extracted.conflict) {
    const outcome = extracted.key || extracted.conflict ? "bad_key" : "missing_key";
    await auditAgentSms(db, "unknown", outcome, outcome === "missing_key" ? "missing key" : "bad key", clientMeta(c), null, true);
    return fail(c, 401, "unauthorized", "Unauthorized");
  }
  const providedOk = await keysMatch(extracted.key, secret);
  if (!providedOk) {
    await auditAgentSms(db, "unknown", "bad_key", "bad key", clientMeta(c), null, true);
    return fail(c, 401, "unauthorized", "Unauthorized");
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      await auditAgentSms(db, "unknown", "bad_request", "bad request", null);
      return fail(c, 400, "bad_request");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    await auditAgentSms(db, "unknown", "bad_request", "bad request", null);
    return fail(c, 400, "bad_request");
  }

  const agent = sanitizeAgent(body.agent);
  if (!agent) {
    await auditAgentSms(db, "unknown", "bad_request", "bad agent", null);
    return fail(c, 400, "bad_request");
  }
  const message = String(body.message ?? "");
  const trimmed = message.trim();
  if (!trimmed) {
    await auditAgentSms(db, agent, "bad_request", "empty message", null);
    return fail(c, 400, "bad_request");
  }
  if (trimmed.length > 1500) {
    await auditAgentSms(db, agent, "bad_request", "message too long", { chars: trimmed.length });
    return fail(c, 400, "message_too_long");
  }
  const context = sanitizeContext(body.context);

  if ("to_user_id" in body) {
    await auditAgentSms(db, agent, "to_user_id_not_allowed", "to_user_id not allowed", null);
    return fail(c, 403, "to_user_id_not_allowed");
  }

  const rawPhone = String(body.to_phone ?? "").slice(0, 20);
  const toPhone = normalizePhone(typeof body.to_phone === "string" ? body.to_phone : rawPhone);
  if (!toPhone || !AGENT_SMS_ALLOWLIST.includes(toPhone as (typeof AGENT_SMS_ALLOWLIST)[number])) {
    await auditAgentSms(db, agent, "recipient_not_allowlisted", "recipient not allowlisted", {
      to_phone: (toPhone || rawPhone).slice(0, 20),
    });
    return fail(c, 403, "recipient_not_allowlisted");
  }

  try {
    const dup = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM sms_log
         WHERE to_phone = ? AND body = ? AND status != 'failed'
           AND created_at >= datetime('now','-30 minutes')`
      )
      .bind(toPhone, trimmed)
      .first<{ n: number }>();
    if (Number(dup?.n || 0) > 0) {
      await auditAgentSms(db, agent, "duplicate_30m", "duplicate", { to_phone: toPhone });
      return fail(c, 429, "duplicate_30m");
    }
  } catch {
    await auditAgentSms(db, agent, "bad_request", "sms log unavailable", null);
    return fail(c, 503, "sms_not_configured");
  }

  try {
    const cap = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM sms_log
         WHERE context LIKE 'agent:%' AND created_at >= datetime('now','-60 minutes')`
      )
      .first<{ n: number }>();
    if (Number(cap?.n || 0) >= 20) {
      await auditAgentSms(db, agent, "rate_limit_hour", "hourly cap", { to_phone: toPhone });
      return fail(c, 429, "rate_limit_hour");
    }
  } catch {
    await auditAgentSms(db, agent, "bad_request", "sms log unavailable", null);
    return fail(c, 503, "sms_not_configured");
  }

  if (!smsConfigured(c.env)) {
    await auditAgentSms(db, agent, "sms_not_configured", "sms not configured", null);
    return fail(c, 503, "sms_not_configured");
  }

  const sent = await sendSms(c.env, toPhone, trimmed);
  const smsId = await logSms(db, {
    from_user_id: null,
    to_user_id: null,
    to_phone: toPhone,
    body: trimmed,
    status: sent.ok ? "sent" : "failed",
    provider_sid: sent.ok ? sent.sid : null,
    error: sent.ok ? null : sent.error,
    context: `agent:${agent}:${context}`,
  });
  if (!sent.ok) {
    await auditAgentSms(
      db,
      agent,
      "send_failed",
      "send failed",
      { agent, context, to_phone: toPhone, chars: trimmed.length },
      smsId
    );
    return fail(c, 502, "send_failed", sent.error);
  }
  await auditAgentSms(
    db,
    agent,
    "sent",
    "sent",
    { agent, context, to_phone: toPhone, sid: sent.sid, chars: trimmed.length },
    smsId
  );
  return c.json({
    ok: true,
    sid: sent.sid,
    status: "sent",
    twilio_status: sent.status,
  });
}
