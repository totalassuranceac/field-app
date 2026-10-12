/**
 * Helper last clock-out → notify LEAD to fill invoice / close.
 * Uses Chris HARD LOCK pairs from installCrewPairs.ts (lead first, helper second).
 * Soft: FA push + optional SMS to lead work phone. NO money writes.
 * Do NOT leave invoice responsibility on the helper.
 */

import type { Env, PublicUser } from "./types";
import {
  HARD_LOCK_INSTALL_PAIRS,
  namesMatchHint,
  type NamedPerson,
} from "./installCrewPairs";
import { notifyAndSms } from "./notifications";

export type HelperLastClockResult = {
  is_helper: boolean;
  is_last: boolean;
  notified: boolean;
  sms: number;
  lead_user_id: number | null;
  lead_name: string | null;
  reason?: string;
};

async function loadActivePeople(db: D1Database): Promise<NamedPerson[]> {
  const rows = await db
    .prepare(
      `SELECT id, display_name FROM users
       WHERE active = 1 AND display_name IS NOT NULL AND TRIM(display_name) != ''`
    )
    .all<{ id: number; display_name: string }>();
  return (rows.results || []).map((r) => ({
    id: Number(r.id),
    display_name: String(r.display_name),
  }));
}

function resolvePairForUser(
  people: NamedPerson[],
  userId: number
): { lead: NamedPerson; helper: NamedPerson; role: "lead" | "helper" } | null {
  const unused = new Set(people.map((p) => p.id));
  const pick = (hint: string): NamedPerson | null => {
    const hits = people.filter(
      (p) => unused.has(p.id) && namesMatchHint(p.display_name, hint)
    );
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const exact = hits.filter(
        (p) =>
          p.display_name.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ===
          hint.toLowerCase().replace(/[^a-z0-9]/g, "")
      );
      if (exact.length === 1) return exact[0];
      return hits[0];
    }
    return null;
  };

  for (const pair of HARD_LOCK_INSTALL_PAIRS) {
    const lead = pick(pair.lead);
    if (!lead) continue;
    unused.delete(lead.id);
    const helper = pick(pair.helper);
    if (!helper) {
      unused.add(lead.id);
      continue;
    }
    unused.delete(helper.id);
    if (lead.id === userId) return { lead, helper, role: "lead" };
    if (helper.id === userId) return { lead, helper, role: "helper" };
  }
  return null;
}

async function userHasCompleteOnJob(
  db: D1Database,
  userId: number,
  stJobId: string,
  stAppointmentId: string | null
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM job_clock_events
       WHERE user_id = ? AND st_job_id = ? AND step = 'complete'
         AND (? IS NULL OR st_appointment_id IS NULL OR st_appointment_id = ?)
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, stJobId, stAppointmentId, stAppointmentId)
    .first();
  return Boolean(row);
}

async function userHasArriveWithoutComplete(
  db: D1Database,
  userId: number,
  stJobId: string,
  stAppointmentId: string | null
): Promise<boolean> {
  const arrive = await db
    .prepare(
      `SELECT id FROM job_clock_events
       WHERE user_id = ? AND st_job_id = ? AND step = 'arrive'
         AND (? IS NULL OR st_appointment_id IS NULL OR st_appointment_id = ?)
       LIMIT 1`
    )
    .bind(userId, stJobId, stAppointmentId, stAppointmentId)
    .first();
  if (!arrive) return false;
  const done = await userHasCompleteOnJob(db, userId, stJobId, stAppointmentId);
  return !done;
}

/**
 * After a successful Complete tap: if the actor is a HARD LOCK helper and is
 * the last of the pair still out, notify the LEAD (not the helper) to invoice/close.
 */
export async function maybeNotifyLeadOnHelperLastClockOut(
  env: Env,
  db: D1Database,
  user: PublicUser,
  opts: {
    st_job_id: string;
    st_appointment_id?: string | null;
    job_number?: string | null;
    customer_name?: string | null;
    address?: string | null;
  }
): Promise<HelperLastClockResult> {
  const people = await loadActivePeople(db);
  const pair = resolvePairForUser(people, user.id);
  if (!pair || pair.role !== "helper") {
    return {
      is_helper: false,
      is_last: false,
      notified: false,
      sms: 0,
      lead_user_id: null,
      lead_name: null,
      reason: "actor_not_hard_lock_helper",
    };
  }

  const stJobId = String(opts.st_job_id || "").trim();
  const appt =
    opts.st_appointment_id != null && String(opts.st_appointment_id).trim()
      ? String(opts.st_appointment_id).trim()
      : null;

  // Helper is "last" when the lead is not still working (arrived without complete).
  const leadStillWorking = await userHasArriveWithoutComplete(
    db,
    pair.lead.id,
    stJobId,
    appt
  );
  if (leadStillWorking) {
    return {
      is_helper: true,
      is_last: false,
      notified: false,
      sms: 0,
      lead_user_id: pair.lead.id,
      lead_name: pair.lead.display_name,
      reason: "lead_still_on_job",
    };
  }

  const jobLabel =
    (opts.job_number ? `#${opts.job_number}` : null) ||
    (stJobId ? `Job ${stJobId}` : "Install job");
  const where =
    [opts.customer_name, opts.address].filter(Boolean).join(" · ") || "job";

  const title = "Invoice / close needed";
  const body = `${pair.helper.display_name} clocked out last on ${jobLabel} (${where}). Please fill the invoice and close — do not leave it on the helper.`;
  const sms = `FA: ${pair.helper.display_name} last out on ${jobLabel}. Lead: fill invoice/close.`;

  const result = await notifyAndSms(env, db, [pair.lead.id], {
    kind: "helper_last_clock_out_invoice",
    title,
    body,
    entity: { type: "st_job", id: stJobId },
    sms,
    smsContext: `helper_last_clock_out:${stJobId}:${pair.lead.id}`,
    excludeUserId: user.id,
    fromUserId: user.id,
  });

  return {
    is_helper: true,
    is_last: true,
    notified: result.notified > 0,
    sms: result.sms,
    lead_user_id: pair.lead.id,
    lead_name: pair.lead.display_name,
    reason: "notified_lead",
  };
}
