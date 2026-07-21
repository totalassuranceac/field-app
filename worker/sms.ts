import type { Env } from "./types";

export function smsConfigured(env: Env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
}

/** Normalize to E.164-ish for US numbers (default +1). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) {
    const digits = d.slice(1).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const digits = d.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

export async function sendSms(
  env: Env,
  toRaw: string,
  body: string
): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  if (!smsConfigured(env)) {
    return {
      ok: false,
      error:
        "SMS is not set up yet. Add Twilio secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.",
    };
  }
  const to = normalizePhone(toRaw);
  if (!to) return { ok: false, error: "Invalid phone number" };
  const text = body.trim().slice(0, 1500);
  if (!text) return { ok: false, error: "Message is empty" };

  const sid = env.TWILIO_ACCOUNT_SID!;
  const token = env.TWILIO_AUTH_TOKEN!;
  const from = env.TWILIO_FROM_NUMBER!;
  const auth = btoa(`${sid}:${token}`);
  const params = new URLSearchParams({ To: to, From: from, Body: text });

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );
    const data = (await res.json()) as { sid?: string; message?: string; error_message?: string };
    if (!res.ok) {
      return {
        ok: false,
        error: data.message || data.error_message || `SMS failed (${res.status})`,
      };
    }
    return { ok: true, sid: data.sid || "sent" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "SMS network error" };
  }
}

export async function logSms(
  db: D1Database,
  row: {
    from_user_id: number | null;
    to_user_id: number | null;
    to_phone: string;
    body: string;
    status: string;
    provider_sid?: string | null;
    error?: string | null;
    context?: string | null;
  }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO sms_log (from_user_id, to_user_id, to_phone, body, status, provider_sid, error, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.from_user_id,
        row.to_user_id,
        row.to_phone,
        row.body.slice(0, 1500),
        row.status,
        row.provider_sid || null,
        row.error || null,
        row.context || null
      )
      .run();
  } catch {
    // table may not exist until migration
  }
}
