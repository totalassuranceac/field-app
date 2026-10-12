/**
 * Post-payment Google review thank-you text: I/O side (ST read-only GETs, D1 log, optional Twilio).
 * Pure rules live in ./reviewTextPlan (unit-tested). Called from the every-5-minute cron.
 *
 * SAFETY:
 *  - Only GET calls to ServiceTitan (stApiGet). No POST/PATCH to ST anywhere in this file.
 *  - mode "off" (default) returns before any ST call. mode "dry" logs would_send rows only.
 *  - The ONLY Twilio call is deps.send inside guardedSend(), reached only when sendTarget() says send:
 *    live (setting live + env REVIEW_TEXT_LIVE_SEND=on, no test number) or test (allowlisted
 *    env REVIEW_TEXT_TEST_NUMBER only; every other number -> would_send). None of these env values is set in this build.
 *  - Trigger (Chris 10/3 7:23 AM): job complete AND invoice paid, later of the two + 2 h, 9 AM-7 PM CT window.
 *    Source = read-only ServiceTitan (payments, invoices, jobs, job types, tag types, appointment assignments,
 *    customers, contacts). Field App payments don't reconcile yet, so ST stays the source for now.
 */
import type { Env } from "./types";
import { getSetting, setSetting } from "./audit";
import { stApiGet, stTenantId } from "./servicetitan";
import { logSms, sendSms } from "./sms";
import {
  DEFAULT_CONFIG,
  DEFAULT_GOOGLE_REVIEW_LINK,
  REVIEW_TEXT_SETTING_HWM,
  REVIEW_TEXT_SETTING_MODE,
  REVIEW_TEXT_TEMPLATE,
  type ReviewTextConfig,
  type StAssignment,
  type StInvoice,
  type StJob,
  type PaymentTypeMap,
  type ReviewTextMode,
  type StContact,
  type StCustomerFlags,
  type StPayment,
  chicagoLocalToUtc,
  chicagoWall,
  buildTypeMap,
  buildReviewText,
  checkJob,
  customerFirstName,
  eligibleAtMs,
  invoicesState,
  parseTestNumbers,
  sendAt,
  sendTarget,
  waitExpired,
  firstLook,
  resolveTypeName,
  maskPhone,
  optKeyword,
  parseListSetting,
  parseStTime,
  pickMobile,
  pollSinceIso,
  recheck,
  refundedIds,
  renderReviewText,
  resolveMode,
  sendGate,
  shouldCallTwilio,
} from "./reviewTextPlan";

const MAX_PAGES = 5;
const DUE_LIMIT = 50;

export type ReviewTextDeps = {
  stGet: (path: string) => Promise<{ ok: boolean; status: number; json: unknown }>;
  send: (to: string, body: string) => ReturnType<typeof sendSms>;
  nowMs: () => number;
};

export type TickSummary = {
  at: string;
  mode: ReviewTextMode;
  note?: string;
  polled: number;
  queued: number;
  skipped: number;
  voided: number;
  held: number;
  would_send: number;
  sent: number;
  errors: string[];
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
/** D1 datetime('now') style, so string comparisons with created_at work. */
function sqlTs(ms: number): string {
  return iso(ms).replace("T", " ").slice(0, 19);
}

async function loadConfig(db: D1Database): Promise<ReviewTextConfig> {
  const types = await getSetting(db, "review_text_allowed_types", "").catch(() => "");
  const hol = await getSetting(db, "review_text_holidays", "").catch(() => "");
  return {
    ...DEFAULT_CONFIG,
    allowedTypes: parseListSetting(types, DEFAULT_CONFIG.allowedTypes),
    holidays: parseListSetting(hol, DEFAULT_CONFIG.holidays).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  };
}

/** id -> name list lookups (job types, tag types). confirm against real response: data[].id, data[].name. */
async function loadNameMap(stGet: ReviewTextDeps["stGet"], path: string): Promise<Map<string, string> | null> {
  const res = await stGet(path);
  if (!res.ok) return null;
  return buildTypeMap(rows<{ id?: number; name?: string }>(res.json));
}

function rows<T>(json: unknown): T[] {
  const d = (json as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? (d as T[]) : [];
}

/** Payment-type names by id, read each tick (confirm against real response: data[].id, data[].name). */
async function loadPaymentTypes(stGet: ReviewTextDeps["stGet"], t: string): Promise<PaymentTypeMap | null> {
  const res = await stGet(`/accounting/v2/tenant/${t}/payment-types?pageSize=200`);
  if (!res.ok) return null;
  return buildTypeMap(rows<{ id?: number; name?: string }>(res.json));
}

export { REVIEW_TEXT_TEMPLATE };

/** Real deps (ST GET helper, Twilio sender, clock), overridable by tests. sendSms is referenced only here. */
function makeDeps(env: Env, db: D1Database, depsIn?: Partial<ReviewTextDeps>): ReviewTextDeps {
  return {
    stGet: (path) => stApiGet(env, db, path),
    send: (to, body) => sendSms(env, to, body),
    nowMs: () => Date.now(),
    ...depsIn,
  };
}

export async function runReviewTextTick(
  env: Env,
  db: D1Database,
  depsIn?: Partial<ReviewTextDeps>
): Promise<TickSummary> {
  const deps = makeDeps(env, db, depsIn);
  const now = deps.nowMs();
  const sum: TickSummary = { at: iso(now), mode: "off", polled: 0, queued: 0, skipped: 0, voided: 0, held: 0, would_send: 0, sent: 0, errors: [] };

  let settingMode = "off";
  try {
    settingMode = await getSetting(db, REVIEW_TEXT_SETTING_MODE, "off");
  } catch {
    settingMode = "off";
  }
  const m = resolveMode(settingMode, env.REVIEW_TEXT_ENABLED, env.REVIEW_TEXT_LIVE_SEND, env.REVIEW_TEXT_TEST_NUMBER);
  sum.mode = m.mode;
  if (m.note) sum.note = m.note;
  if (m.mode === "off") return sum; // no ST call, no D1 write

  const tenant = await stTenantId(env, db).catch(() => null);
  if (!tenant && !depsIn?.stGet) {
    sum.errors.push("st_not_configured");
    await saveSummary(db, sum);
    return sum;
  }
  const t = tenant || "test";
  const cfg = await loadConfig(db);
  const types = await loadPaymentTypes(deps.stGet, t);
  if (!types || types.size === 0) {
    // Fail closed: without type names nothing can be classified, so do nothing this tick.
    sum.errors.push("payment_types_unavailable");
    await saveSummary(db, sum);
    return sum;
  }

  // ---- 1. poll new payments ----
  const hwmRaw = await getSetting(db, REVIEW_TEXT_SETTING_HWM, "").catch(() => "");
  const since = pollSinceIso(hwmRaw, now);
  let maxSeen = parseStTime(hwmRaw) ?? 0;
  const seen: StPayment[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    // confirm against real response: createdOnOrAfter / page / pageSize / sort params and the data[] / hasMore shape
    const q = new URLSearchParams({ createdOnOrAfter: since, page: String(page), pageSize: "200", sort: "+CreatedOn" });
    const res = await deps.stGet(`/accounting/v2/tenant/${t}/payments?${q.toString()}`);
    if (!res.ok) {
      sum.errors.push(`payments_${res.status}`);
      break;
    }
    const data = rows<StPayment>(res.json);
    seen.push(...data);
    const hasMore = Boolean((res.json as { hasMore?: boolean } | null)?.hasMore);
    if (!hasMore || data.length === 0) break;
  }
  sum.polled = seen.length;
  const refunded = refundedIds(seen);
  for (const p of seen) {
    const c = parseStTime(p.createdOn);
    if (c != null && c > maxSeen) maxSeen = c;
    const look = firstLook(p, now, cfg, types);
    const typeName = resolveTypeName(p, types);
    if (!look.paymentId) continue;
    const invoiceIds = (p.appliedTo || []).map((a) => a.appliedTo).filter((n) => n != null).join(",");
    const isRefunded = refunded.has(look.paymentId);
    const status = look.action === "queue" && !isRefunded ? "queued" : "skipped";
    const reason = look.action === "skip" ? look.reason : isRefunded ? "refund" : null;
    const r = await db
      .prepare(
        `INSERT OR IGNORE INTO review_text_log
           (st_payment_id, st_customer_id, customer_name, st_invoice_ids, payment_type, payment_total,
            payment_created_on, payment_created_by, status, reason, mode, recheck_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        look.paymentId,
        Number(p.customer?.id) || null,
        p.customer?.name ? String(p.customer.name).slice(0, 120) : null,
        invoiceIds || null,
        typeName ? typeName.slice(0, 60) : p.typeId != null ? `typeId:${p.typeId}` : null,
        Number.isFinite(Number(p.total)) ? Number(p.total) : null,
        p.createdOn || null,
        p.createdBy ? String(p.createdBy).slice(0, 80) : null,
        status,
        reason,
        m.mode,
        look.action === "queue" ? sqlTs(look.recheckAtMs) : null,
        status === "skipped" ? sqlTs(now) : null
      )
      .run();
    if (Number(r.meta?.changes || 0) > 0) {
      if (status === "queued") sum.queued++;
      else sum.skipped++;
    }
  }
  // a refund seen later cancels a still-pending original
  for (const pid of refunded) {
    const r = await db
      .prepare(
        `UPDATE review_text_log SET status = 'voided', reason = 'refund', decided_at = ?, updated_at = ?
         WHERE st_payment_id = ? AND status IN ('queued','held')`
      )
      .bind(sqlTs(now), sqlTs(now), pid)
      .run();
    sum.voided += Number(r.meta?.changes || 0);
  }
  const newHwm = Math.max(maxSeen, now - 15 * 60_000);
  await setSetting(db, REVIEW_TEXT_SETTING_HWM, iso(newHwm));

  // ---- 2. due rows: recheck for voids, find mobile, gate, log ----
  type Row = {
    id: number;
    st_payment_id: string;
    st_customer_id: number;
    customer_name: string | null;
    st_invoice_ids: string | null;
    payment_type: string | null;
    payment_created_on: string;
    status: string;
  };
  const due = await db
    .prepare(
      `SELECT id, st_payment_id, st_customer_id, customer_name, st_invoice_ids, payment_type, payment_created_on, status
       FROM review_text_log
       WHERE status IN ('queued','held') AND COALESCE(hold_until, recheck_at) <= ?
       ORDER BY id LIMIT ?`
    )
    .bind(sqlTs(now), DUE_LIMIT)
    .all<Row>();

  const dayStart = (() => {
    const w = chicagoWall(now);
    return sqlTs(chicagoLocalToUtc(w.y, w.m, w.d, 0, 0));
  })();
  let sentToday = Number(
    (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM review_text_log WHERE status IN ('would_send','sent') AND decided_at >= ?`)
        .bind(dayStart)
        .first<{ n: number }>()
    )?.n || 0
  );
  let sentThisTick = 0;

  type Extra = { phone?: string; body?: string; hold?: number; sid?: string; jobId?: number; eligible?: number; variant?: string; segments?: number; tech?: string | null };
  const finish = async (id: number, status: string, reason: string | null, extra: Extra = {}) => {
    await db
      .prepare(
        `UPDATE review_text_log
         SET status = ?, reason = ?, to_phone = COALESCE(?, to_phone), body = COALESCE(?, body),
             hold_until = ?, provider_sid = COALESCE(?, provider_sid), mode = ?,
             st_job_id = COALESCE(?, st_job_id), eligible_at = COALESCE(?, eligible_at),
             template_variant = COALESCE(?, template_variant), segments = COALESCE(?, segments), tech_first = COALESCE(?, tech_first),
             decided_at = CASE WHEN ? = 'held' THEN decided_at ELSE ? END, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        status,
        reason,
        extra.phone ?? null,
        extra.body ?? null,
        extra.hold != null ? sqlTs(extra.hold) : null,
        extra.sid ?? null,
        m.mode,
        extra.jobId != null ? String(extra.jobId) : null,
        extra.eligible != null ? sqlTs(extra.eligible) : null,
        extra.variant ?? null,
        extra.segments ?? null,
        extra.tech ?? null,
        status,
        sqlTs(now),
        sqlTs(now),
        id
      )
      .run();
  };

  const testNumbers = parseTestNumbers(env.REVIEW_TEXT_TEST_NUMBER);
  let jobTypes: Map<string, string> | null | undefined;
  let tagTypes: Map<string, string> | null | undefined;

  for (const row of due.results || []) {
    try {
      const createdMs = parseStTime(row.payment_created_on) ?? now;
      // 1) VOID RECHECK (every time a row comes due, including right before the send)
      // verify on PC: does GET /payments accept ids=? If not, use modifiedOnOrAfter around createdOn and match id.
      const pr = await deps.stGet(`/accounting/v2/tenant/${t}/payments?ids=${encodeURIComponent(row.st_payment_id)}`);
      if (!pr.ok) {
        sum.errors.push(`recheck_${pr.status}`);
        continue; // leave queued; next tick retries
      }
      const refreshed = rows<StPayment>(pr.json).find((p) => String(p.id) === row.st_payment_id) || null;
      const rc = recheck(refreshed, createdMs, now, cfg, types);
      if (!rc.ok) {
        await finish(row.id, rc.status, rc.reason);
        if (rc.status === "voided") sum.voided++;
        else sum.skipped++;
        continue;
      }

      // 2) INVOICE PAID? (all invoices this payment applied to; one job)  confirm against real response: id, balance, job.id
      const invIds = String(row.st_invoice_ids || "").split(",").map((x) => x.trim()).filter(Boolean);
      let invs: StInvoice[] = [];
      if (invIds.length) {
        const ir = await deps.stGet(`/accounting/v2/tenant/${t}/invoices?ids=${encodeURIComponent(invIds.join(","))}`);
        if (!ir.ok) {
          sum.errors.push(`invoices_${ir.status}`);
          continue;
        }
        invs = rows<StInvoice>(ir.json);
      }
      const inv = invoicesState(invIds, invs);
      if (!inv.ok) {
        await finish(row.id, "skipped", inv.reason);
        sum.skipped++;
        continue;
      }

      // 3) JOB COMPLETE? + skip list (job type, tags, recall)  confirm against real response: jobStatus, completedOn, recallForId, jobTypeId, tagTypeIds
      const jr = await deps.stGet(`/jpm/v2/tenant/${t}/jobs/${inv.jobId}`);
      if (!jr.ok) {
        sum.errors.push(`job_${jr.status}`);
        continue;
      }
      const job = (jr.json || {}) as StJob;
      const holdOrExpire = async (why: "waiting_complete" | "waiting_paid") => {
        if (waitExpired(createdMs, now, cfg)) {
          await finish(row.id, "skipped", why === "waiting_complete" ? "not_completed" : "not_paid", { jobId: inv.jobId });
          sum.skipped++;
        } else {
          await finish(row.id, "held", why, { jobId: inv.jobId, hold: now + cfg.waitRecheckMinutes * 60_000 });
          sum.held++;
        }
      };
      // Cheap first pass (no lookups, no customer GET): canceled / recall skip, or still waiting on complete/paid.
      const quick = checkJob({ job, jobTypeName: null, tagNames: [], paymentTypeName: null, paid: inv.paid, customerType: null, hasFirstName: true, reviewed: false }, cfg);
      if (quick.action === "skip") {
        await finish(row.id, "skipped", quick.reason, { jobId: inv.jobId });
        sum.skipped++;
        continue;
      }
      if (quick.action === "wait") {
        await holdOrExpire(quick.reason);
        continue;
      }
      if (jobTypes === undefined) jobTypes = await loadNameMap(deps.stGet, `/jpm/v2/tenant/${t}/job-types?pageSize=500`);
      if (tagTypes === undefined) tagTypes = await loadNameMap(deps.stGet, `/settings/v2/tenant/${t}/tag-types?pageSize=500`);
      if (!jobTypes || !tagTypes) {
        // Fail closed: without names the skip list can't be checked.
        sum.errors.push(!jobTypes ? "job_types_unavailable" : "tag_types_unavailable");
        continue;
      }

      const [cr, kr] = await Promise.all([
        deps.stGet(`/crm/v2/tenant/${t}/customers/${row.st_customer_id}`),
        deps.stGet(`/crm/v2/tenant/${t}/customers/${row.st_customer_id}/contacts`),
      ]);
      if (!cr.ok || !kr.ok) {
        sum.errors.push(`contacts_${cr.ok ? kr.status : cr.status}`);
        continue;
      }
      const cust = (cr.json || {}) as StCustomerFlags & { name?: string | null; type?: string | null; tagTypeIds?: number[] | null };
      const custName = cust.name ?? row.customer_name;
      const tagNames = [...(job.tagTypeIds || []), ...(cust.tagTypeIds || [])]
        .map((id) => tagTypes!.get(String(id)))
        .filter((x): x is string => Boolean(x));
      const reviewed = await db
        .prepare(`SELECT 1 AS x FROM review_text_reviewed WHERE st_customer_id = ? AND cleared_at IS NULL`)
        .bind(row.st_customer_id)
        .first<{ x: number }>();
      const jc = checkJob(
        {
          job,
          jobTypeName: job.jobTypeId != null ? jobTypes.get(String(job.jobTypeId)) ?? null : null,
          tagNames,
          paymentTypeName: row.payment_type,
          paid: inv.paid,
          customerType: cust.type ?? null,
          hasFirstName: customerFirstName(custName, null).ok,
          reviewed: Boolean(reviewed),
        },
        cfg
      );
      if (jc.action === "skip") {
        await finish(row.id, "skipped", jc.reason, { jobId: inv.jobId });
        sum.skipped++;
        continue;
      }
      if (jc.action === "wait") {
        await holdOrExpire(jc.reason);
        continue;
      }

      // 4) ONE TEXT PER JOB: another payment on this job already texted (or would have)
      const sibling = await db
        .prepare(`SELECT 1 AS x FROM review_text_log WHERE st_job_id = ? AND id != ? AND status IN ('would_send','sent')`)
        .bind(String(inv.jobId), row.id)
        .first<{ x: number }>();
      if (sibling) {
        await finish(row.id, "skipped", "same_job", { jobId: inv.jobId });
        sum.skipped++;
        continue;
      }

      // 5a) MOBILE ONLY + STOP list, decided now so landlines / opted-out never sit in "held"
      const pick = pickMobile(rows<StContact>(kr.json), cust as StCustomerFlags);
      if (!pick.ok) {
        await finish(row.id, "skipped", pick.reason, { jobId: inv.jobId });
        sum.skipped++;
        continue;
      }
      const optEarly = await db
        .prepare(`SELECT 1 AS x FROM sms_opt_outs WHERE phone = ? AND (opted_in_at IS NULL OR opted_in_at < opted_out_at)`)
        .bind(pick.phone)
        .first<{ x: number }>();
      if (optEarly) {
        await finish(row.id, "skipped", "opted_out", { phone: pick.phone, jobId: inv.jobId });
        sum.skipped++;
        continue;
      }

      // 5) TIMING: later of (complete, paid) + 2 h, then the 9 AM-7 PM CT window (no Sundays/holidays)
      // "Paid" = the LAST payment on this job / these invoices (a later payment that cleared the balance counts,
      // even if its own row hasn't been processed yet). Field App payments don't reconcile yet: ST is the source.
      const invLike = invIds.map(() => `(',' || COALESCE(st_invoice_ids, '') || ',') LIKE ?`).join(" OR ");
      const lastPaid = await db
        .prepare(
          `SELECT MAX(payment_created_on) AS t FROM review_text_log
           WHERE (st_job_id = ? OR id = ?${invLike ? ` OR ${invLike}` : ""}) AND status NOT IN ('voided') AND payment_total > 0`
        )
        .bind(String(inv.jobId), row.id, ...invIds.map((x) => `%,${x},%`))
        .first<{ t: string | null }>();
      const paidMs = Math.max(createdMs, parseStTime(lastPaid?.t) ?? 0);
      const eligible = eligibleAtMs(jc.completedMs, paidMs, cfg);
      const when = sendAt(eligible, now, cfg);
      if (when.reason !== "ready") {
        await finish(row.id, "held", when.reason, { phone: pick.phone, jobId: inv.jobId, eligible, hold: when.atMs });
        sum.held++;
        continue;
      }

      // 6) caps (+ STOP again: an opt-out can arrive while a row is held)
      const opt = await db
        .prepare(`SELECT 1 AS x FROM sms_opt_outs WHERE phone = ? AND (opted_in_at IS NULL OR opted_in_at < opted_out_at)`)
        .bind(pick.phone)
        .first<{ x: number }>();
      const lastCust = await db
        .prepare(`SELECT MAX(decided_at) AS t FROM review_text_log WHERE st_customer_id = ? AND status IN ('would_send','sent') AND id != ?`)
        .bind(row.st_customer_id, row.id)
        .first<{ t: string | null }>();
      const lastPhone = await db
        .prepare(`SELECT MAX(decided_at) AS t FROM review_text_log WHERE to_phone = ? AND status IN ('would_send','sent') AND id != ?`)
        .bind(pick.phone, row.id)
        .first<{ t: string | null }>();

      const gate = sendGate(
        {
          nowMs: now,
          paymentCreatedMs: eligible, // stale is measured from eligibility now (72 h)
          phone: pick.phone,
          optedOut: Boolean(opt),
          lastToCustomerMs: lastCust?.t ? parseStTime(lastCust.t.replace(" ", "T")) : null,
          lastToPhoneMs: lastPhone?.t ? parseStTime(lastPhone.t.replace(" ", "T")) : null,
          sentToday,
          sentThisTick,
        },
        cfg
      );
      if (gate.action === "skip") {
        await finish(row.id, "skipped", gate.reason, { phone: pick.phone, jobId: inv.jobId, eligible });
        sum.skipped++;
        continue;
      }
      if (gate.action === "hold") {
        await finish(row.id, "held", "held_for_window", { phone: pick.phone, hold: gate.untilMs, jobId: inv.jobId, eligible });
        sum.held++;
        continue;
      }

      // 7) TEXT: Chris's 7:23 AM wording, tech first name from the job's assignments (read-only)
      // confirm against real response: data[].technicianId, data[].technicianName, data[].active
      const ar = await deps.stGet(`/dispatch/v2/tenant/${t}/appointment-assignments?jobId=${inv.jobId}&pageSize=50`);
      const techs = ar.ok ? rows<StAssignment>(ar.json) : []; // lookup down -> the no-tech text, never a guessed name
      const r = buildReviewText({ customerName: custName, customerType: cust.type ?? null, techs }, cfg);
      if (!r.ok) {
        await finish(row.id, "error", r.error, { phone: pick.phone, jobId: inv.jobId, eligible });
        sum.errors.push(r.error);
        continue;
      }
      const meta = { jobId: inv.jobId, eligible, variant: r.variant, segments: r.segments, tech: r.tech };
      const out = await guardedSend(db, deps, m.mode, pick.phone, r.body, testNumbers, `review_text:${row.st_payment_id}`);
      if (!out.sent && !out.error) {
        await finish(row.id, "would_send", out.reason === "dry_run" ? m.note || "dry_run" : out.reason, { phone: pick.phone, body: r.body, ...meta });
        sum.would_send++;
      } else if (out.sent) {
        await finish(row.id, "sent", m.mode === "test" ? "test_number" : null, { phone: pick.phone, body: r.body, sid: out.sid, ...meta });
        sum.sent++;
      } else {
        await finish(row.id, "error", (out.error || "send_failed").slice(0, 200), { phone: pick.phone, body: r.body, ...meta });
        sum.errors.push("send_failed");
      }
      sentToday++;
      sentThisTick++;
    } catch (e) {
      sum.errors.push(e instanceof Error ? e.message.slice(0, 120) : "row_error");
    }
  }
  await saveSummary(db, sum);
  return sum;
}

/**
 * The ONLY place a text can leave the worker. sendTarget() decides: off/dry -> never; test -> allowlisted
 * env number only (everyone else would_send "not_test_number"); live -> send. deps.send appears once, here.
 */
async function guardedSend(
  db: D1Database,
  deps: ReviewTextDeps,
  mode: ReviewTextMode,
  phone: string,
  body: string,
  testNumbers: string[],
  context: string
): Promise<{ sent: true; sid: string } | { sent: false; reason: string; error?: string }> {
  const target = sendTarget(mode, phone, testNumbers);
  if (!target.send || !shouldCallTwilio(mode)) return { sent: false, reason: target.send ? "dry_run" : target.reason };
  const s = await deps.send(phone, body);
  await logSms(db, {
    from_user_id: null,
    to_user_id: null,
    to_phone: phone,
    body,
    status: s.ok ? "sent" : "failed",
    provider_sid: s.ok ? s.sid : null,
    error: s.ok ? null : s.error,
    context,
  });
  return s.ok ? { sent: true, sid: s.sid } : { sent: false, reason: "send_failed", error: s.error };
}

/**
 * Admin "Send a test to the test number" (Chris: test on a test number only before any real customer).
 * Works ONLY when the mode resolves to test; goes ONLY to the first env REVIEW_TEXT_TEST_NUMBER; max 5 per Chicago day.
 * Uses fake names unless the admin types first/tech (same name rules as real texts). No ST call, no review_text_log row.
 */
export async function sendTestReviewText(
  env: Env,
  db: D1Database,
  opts: { first?: string; tech?: string } = {},
  depsIn?: Partial<ReviewTextDeps>
): Promise<{ ok: boolean; error?: string; to_masked?: string; body?: string; segments?: number; variant?: string }> {
  const deps = makeDeps(env, db, { stGet: async () => ({ ok: false, status: 0, json: null }), ...depsIn }); // no ST call in a test send
  const setting = await getSetting(db, REVIEW_TEXT_SETTING_MODE, "off").catch(() => "off");
  const m = resolveMode(setting, env.REVIEW_TEXT_ENABLED, env.REVIEW_TEXT_LIVE_SEND, env.REVIEW_TEXT_TEST_NUMBER);
  if (m.mode !== "test") return { ok: false, error: `mode_${m.mode}${m.note ? `_${m.note}` : ""}` };
  const tests = parseTestNumbers(env.REVIEW_TEXT_TEST_NUMBER);
  const to = tests[0];
  const now = deps.nowMs();
  const w = chicagoWall(now);
  const dayStart = sqlTs(chicagoLocalToUtc(w.y, w.m, w.d, 0, 0));
  const n = await db
    .prepare(`SELECT COUNT(*) AS n FROM sms_log WHERE context = 'review_text:test' AND created_at >= ?`)
    .bind(dayStart)
    .first<{ n: number }>();
  if (Number(n?.n || 0) >= 5) return { ok: false, error: "test_daily_cap" };
  const r = buildReviewText({
    customerName: opts.first ?? "Sample, Sam",
    techs: [{ technicianId: 1, technicianName: opts.tech ?? "Alex Sample" }],
  });
  if (!r.ok) return { ok: false, error: r.error };
  const out = await guardedSend(db, deps, m.mode, to, r.body, tests, "review_text:test");
  if (!out.sent) return { ok: false, error: out.error || out.reason };
  return { ok: true, to_masked: maskPhone(to), body: r.body, segments: r.segments, variant: r.variant };
}

/** Office marks "customer already left a Google review" (spec: keep a reviewed flag). Field App table only. */
export async function markReviewed(db: D1Database, customerId: number, userId: number | null, reviewed: boolean): Promise<void> {
  if (!(customerId > 0)) return;
  // No DELETE: un-marking stamps cleared_at, so the history stays.
  if (reviewed) {
    await db
      .prepare(
        `INSERT INTO review_text_reviewed (st_customer_id, marked_by_user_id) VALUES (?, ?)
         ON CONFLICT(st_customer_id) DO UPDATE SET marked_at = datetime('now'), marked_by_user_id = excluded.marked_by_user_id, cleared_at = NULL`
      )
      .bind(customerId, userId)
      .run();
  } else {
    await db.prepare(`UPDATE review_text_reviewed SET cleared_at = datetime('now') WHERE st_customer_id = ?`).bind(customerId).run();
  }
}

async function saveSummary(db: D1Database, sum: TickSummary): Promise<void> {
  try {
    await setSetting(db, "review_text_last_tick", JSON.stringify({ ...sum, errors: sum.errors.slice(0, 10) }));
  } catch {
    /* summary is best-effort */
  }
}

/** Called from /api/sms/inbound AFTER signature verification. Never replies (Twilio's opt-out reply covers it). */
export async function recordInboundOptKeyword(db: D1Database, fromPhone: string | null, body: string): Promise<"stop" | "start" | null> {
  if (!fromPhone) return null;
  const k = optKeyword(body);
  if (k === "stop") {
    await db
      .prepare(
        `INSERT INTO sms_opt_outs (phone, opted_out_at, opted_in_at, source, last_body)
         VALUES (?, datetime('now'), NULL, 'inbound_stop', ?)
         ON CONFLICT(phone) DO UPDATE SET opted_out_at = datetime('now'), opted_in_at = NULL, last_body = excluded.last_body`
      )
      .bind(fromPhone, body.slice(0, 160))
      .run();
    return "stop";
  }
  if (k === "start") {
    await db
      .prepare(`UPDATE sms_opt_outs SET opted_in_at = datetime('now'), last_body = ? WHERE phone = ?`)
      .bind(body.slice(0, 160), fromPhone)
      .run();
    return "start";
  }
  return null;
}

export type ReviewTextLogRow = {
  id: number;
  st_payment_id: string;
  st_customer_id: number;
  customer_name: string | null;
  payment_type: string | null;
  payment_total: number | null;
  payment_created_on: string | null;
  payment_created_by: string | null;
  status: string;
  reason: string | null;
  mode: string;
  reviewed: number;
  st_job_id: string | null;
  eligible_at: string | null;
  template_variant: string | null;
  segments: number | null;
  tech_first: string | null;
  phone_masked: string;
  body: string | null;
  hold_until: string | null;
  decided_at: string | null;
  created_at: string;
};

/** Admin view data. Phone is masked; the full number never leaves the worker. */
export async function listReviewTextLog(db: D1Database, opts: { status?: string; limit?: number } = {}): Promise<ReviewTextLogRow[]> {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));
  const allowed = ["queued", "held", "would_send", "sent", "skipped", "voided", "error"];
  const st = opts.status && allowed.includes(opts.status) ? opts.status : null;
  const res = await db
    .prepare(
      `SELECT l.id, l.st_payment_id, l.st_customer_id, l.customer_name, l.payment_type, l.payment_total, l.payment_created_on,
              l.payment_created_by, l.status, l.reason, l.mode, l.st_job_id, l.eligible_at, l.template_variant, l.segments,
              l.tech_first, l.to_phone, l.body, l.hold_until, l.decided_at, l.created_at,
              CASE WHEN r.st_customer_id IS NOT NULL AND r.cleared_at IS NULL THEN 1 ELSE 0 END AS reviewed
       FROM review_text_log l
       LEFT JOIN review_text_reviewed r ON r.st_customer_id = l.st_customer_id
       WHERE (? IS NULL OR l.status = ?)
       ORDER BY l.id DESC LIMIT ?`
    )
    .bind(st, st, limit)
    .all<Omit<ReviewTextLogRow, "phone_masked"> & { to_phone: string | null }>();
  return (res.results || []).map(({ to_phone, ...r }) => ({ ...r, phone_masked: maskPhone(to_phone) }));
}

/** Admin preview: all 4 variants with fake names, with honest length and segment counts. */
export function reviewTextPreviews(): { variant: string; body: string; chars: number; segments: number }[] {
  const cases: { customerName: string | null; techs: StAssignment[] }[] = [
    { customerName: "Sample, Maria", techs: [{ technicianId: 1, technicianName: "Warren Sample" }] },
    { customerName: "Sample, Maria", techs: [] },
    { customerName: "SAMPLE HOLDINGS LLC", techs: [{ technicianId: 1, technicianName: "Warren Sample" }] },
    { customerName: null, techs: [] },
  ];
  const out: { variant: string; body: string; chars: number; segments: number }[] = [];
  for (const c of cases) {
    const r = buildReviewText(c);
    if (r.ok) out.push({ variant: r.variant, body: r.body, chars: r.chars, segments: r.segments });
  }
  return out;
}

export type SampleCheck = {
  id: string;
  found: boolean;
  type_id: string | null;
  type_name: string | null;
  batch: string | null;
  created_by: string | null;
  customer_id: number | null;
  invoices: string;
  total: number | null;
  decision: string;
};

/**
 * READ-ONLY sample check for the PC verification step (admin route GET /api/review-text/verify?ids=...).
 * Two GETs (payment-types, payments?ids=). No contacts, no D1 write, no send. Age is ignored.
 */
export async function verifySamplePayments(env: Env, db: D1Database, ids: string[], depsIn?: Partial<ReviewTextDeps>): Promise<{ ok: boolean; error?: string; rows: SampleCheck[] }> {
  const stGet = depsIn?.stGet || ((path: string) => stApiGet(env, db, path));
  const clean = [...new Set(ids.map((x) => String(x).trim()).filter((x) => /^\d{1,12}$/.test(x)))].slice(0, 20);
  if (!clean.length) return { ok: false, error: "no_ids", rows: [] };
  const t = (await stTenantId(env, db).catch(() => null)) || (depsIn?.stGet ? "test" : null);
  if (!t) return { ok: false, error: "st_not_configured", rows: [] };
  const types = await loadPaymentTypes(stGet, t);
  if (!types) return { ok: false, error: "payment_types_unavailable", rows: [] };
  const res = await stGet(`/accounting/v2/tenant/${t}/payments?ids=${clean.join(",")}`);
  if (!res.ok) return { ok: false, error: `payments_${res.status}`, rows: [] };
  const got = rows<StPayment>(res.json);
  const cfg = await loadConfig(db);
  return {
    ok: true,
    rows: clean.map((id) => {
      const p = got.find((x) => String(x.id) === id);
      if (!p) return { id, found: false, type_id: null, type_name: null, batch: null, created_by: null, customer_id: null, invoices: "", total: null, decision: "not_found" };
      const look = firstLook(p, Date.now(), cfg, types, { ignoreAge: true });
      return {
        id,
        found: true,
        type_id: p.typeId != null ? String(p.typeId) : null,
        type_name: resolveTypeName(p, types),
        batch: p.batch?.name || p.deposit?.name || null,
        created_by: p.createdBy || null,
        customer_id: Number(p.customer?.id) || null,
        invoices: (p.appliedTo || []).map((a) => a.appliedTo).filter((n) => n != null).join(","),
        total: Number.isFinite(Number(p.total)) ? Number(p.total) : null,
        decision: look.action === "queue" ? "would_queue" : `skip:${look.reason}`,
      };
    }),
  };
}
