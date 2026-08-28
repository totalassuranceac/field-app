import type { Env } from "./types";

export function smsConfigured(env: Env): boolean {
  const hasAuth = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  const hasSender = Boolean(
    env.TWILIO_MESSAGING_SERVICE_SID?.trim() || env.TWILIO_FROM_NUMBER?.trim()
  );
  return hasAuth && hasSender;
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

export type SendSmsResult =
  | {
      ok: true;
      sid: string;
      /** How the Twilio request was addressed — never both at once */
      sender_mode: "messaging_service" | "from";
      messaging_service_sid?: string;
    }
  | { ok: false; error: string };

export async function sendSms(
  env: Env,
  toRaw: string,
  body: string
): Promise<SendSmsResult> {
  if (!smsConfigured(env)) {
    return {
      ok: false,
      error:
        "SMS is not set up yet. Add Twilio secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM_NUMBER).",
    };
  }
  const to = normalizePhone(toRaw);
  if (!to) return { ok: false, error: "Invalid phone number" };
  const text = body.trim().slice(0, 1500);
  if (!text) return { ok: false, error: "Message is empty" };

  const sid = env.TWILIO_ACCOUNT_SID!;
  const token = env.TWILIO_AUTH_TOKEN!;
  const messagingService = (env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  let from = (env.TWILIO_FROM_NUMBER || "").trim();
  const auth = btoa(`${sid}:${token}`);

  // Retired number — never send as From (even if still in an old secret / pool misconfig).
  const fromDigits = from.replace(/\D/g, "");
  if (fromDigits.endsWith("4453688") || fromDigits.endsWith("3614453688")) {
    from = "";
  }

  // Exclusive sender: Messaging Service OR From — never both.
  // If TWILIO_MESSAGING_SERVICE_SID is set, send MessagingServiceSid only (no From).
  const params = new URLSearchParams({ To: to, Body: text });
  let senderMode: "messaging_service" | "from";
  if (messagingService) {
    params.set("MessagingServiceSid", messagingService);
    senderMode = "messaging_service";
  } else if (from) {
    params.set("From", from);
    senderMode = "from";
  } else {
    return {
      ok: false,
      error:
        "No SMS sender configured. Set TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_FROM_NUMBER (+13614466925).",
    };
  }

  // Hard rule: never put From on the wire when MessagingServiceSid is present
  params.delete("From");
  if (senderMode === "from" && from) {
    params.set("From", from);
  }
  if (params.has("MessagingServiceSid")) {
    params.delete("From");
  }

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
    const data = (await res.json()) as {
      sid?: string;
      message?: string;
      error_message?: string;
      code?: number;
    };
    if (!res.ok) {
      const detail = data.message || data.error_message || `SMS failed (${res.status})`;
      const code = data.code != null ? `Twilio ${data.code}: ` : "";
      return { ok: false, error: `${code}${detail}` };
    }
    return {
      ok: true,
      sid: data.sid || "sent",
      sender_mode: senderMode,
      messaging_service_sid:
        senderMode === "messaging_service" ? messagingService : undefined,
    };
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

export type TwilioMessageStatus = {
  sid: string;
  status: string;
  error_code: number | null;
  error_message: string | null;
  from: string | null;
  to: string | null;
  date_updated: string | null;
};

/** Look up final delivery status from Twilio (queued/sent ≠ delivered). */
export async function fetchTwilioMessageStatus(
  env: Env,
  messageSid: string
): Promise<
  | { ok: true; message: TwilioMessageStatus }
  | { ok: false; error: string }
> {
  if (!smsConfigured(env)) {
    return { ok: false, error: "Twilio secrets not configured" };
  }
  const sid = env.TWILIO_ACCOUNT_SID!;
  const token = env.TWILIO_AUTH_TOKEN!;
  const msgSid = String(messageSid || "").trim();
  if (!/^SM[a-f0-9]{32}$/i.test(msgSid)) {
    return { ok: false, error: "Invalid Twilio message SID" };
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${msgSid}.json`,
      {
        headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}` },
      }
    );
    const data = (await res.json()) as {
      sid?: string;
      status?: string;
      error_code?: number | null;
      error_message?: string | null;
      from?: string;
      to?: string;
      date_updated?: string;
      message?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.message || `Twilio lookup failed (${res.status})`,
      };
    }
    return {
      ok: true,
      message: {
        sid: data.sid || msgSid,
        status: String(data.status || "unknown"),
        error_code: data.error_code ?? null,
        error_message: data.error_message ?? null,
        from: data.from || null,
        to: data.to || null,
        date_updated: data.date_updated || null,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Twilio lookup network error",
    };
  }
}

/** Map Twilio status into our sms_log status + error fields. */
export function applyTwilioStatusToLog(msg: TwilioMessageStatus): {
  status: string;
  error: string | null;
} {
  const st = msg.status.toLowerCase();
  if (st === "delivered") return { status: "delivered", error: null };
  if (st === "undelivered" || st === "failed") {
    const code = msg.error_code != null ? `Twilio ${msg.error_code}` : "Twilio";
    const detail = msg.error_message || st;
    return { status: st, error: `${code}: ${detail}` };
  }
  // queued / sending / sent / receiving / received / accepted — keep as sent (API accepted)
  if (st === "sent" || st === "queued" || st === "sending" || st === "accepted") {
    return { status: "sent", error: `Twilio status: ${st} (not delivered yet)` };
  }
  return { status: st, error: msg.error_message || null };
}
