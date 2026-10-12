/**
 * Dry-run simulation: worker/reviewText.ts against an in-memory SQLite "D1" and a FAKE ServiceTitan.
 * No network. The fake sender throws unless the test explicitly enables live/test mode.
 * Fixtures only: fake names, 555 numbers. The test number is a 555 fixture passed via env (never in code).
 * Needs Node >= 22.13 (node:sqlite). Run from the tree root:
 * Run: npx esbuild scripts/sim-review-text-dryrun.ts --bundle --platform=node --format=esm --outfile=tmp-sim.mjs && node tmp-sim.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { recordInboundOptKeyword, runReviewTextTick, listReviewTextLog, verifySamplePayments, sendTestReviewText, markReviewed, reviewTextPreviews } from "../worker/reviewText";
import { chicagoLocalToUtc } from "../worker/reviewTextPlan";
import type { Env } from "../worker/types";

// ---- tiny D1 shim over node:sqlite ----
function d1(sqlite: DatabaseSync): D1Database {
  const mk = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => mk(sql, a),
    first: async () => (sqlite.prepare(sql).get(...(args as any[])) as any) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as any[])) }),
    run: async () => {
      const r = sqlite.prepare(sql).run(...(args as any[]));
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql: string) => mk(sql), batch: async (s: any[]) => Promise.all(s.map((x) => x.run())), exec: async (sql: string) => sqlite.exec(sql) } as any;
}

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) => {
  const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.error(`FAIL ${n}\n  got:  ${a}\n  want: ${b}`); }
};

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);`);
sqlite.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
sqlite.exec(readFileSync("migrations/011_sms.sql", "utf8"));
const mig = readFileSync("migrations/117_review_text_dryrun.sql", "utf8");
sqlite.exec(mig);
sqlite.exec(mig); // idempotent
const db = d1(sqlite);
eq("migration twice: 1 mode row", (sqlite.prepare(`SELECT COUNT(*) n FROM settings WHERE key='review_text_mode'`).get() as any).n, 1);
eq("default mode off", (sqlite.prepare(`SELECT value FROM settings WHERE key='review_text_mode'`).get() as any).value, "off");
eq("migration: new columns", ["st_job_id", "eligible_at", "template_variant", "segments", "tech_first"].every((c) => (sqlite.prepare(`SELECT COUNT(*) n FROM pragma_table_info('review_text_log') WHERE name=?`).get(c) as any).n === 1), true);
eq("migration: reviewed table", (sqlite.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name='review_text_reviewed'`).get() as any).n, 1);

const ct = (y: number, m: number, d: number, hh: number, mi = 0) => chicagoLocalToUtc(y, m, d, hh, mi);
const isoAt = (ms: number) => new Date(ms).toISOString();
const sqlTs = (ms: number) => isoAt(ms).replace("T", " ").slice(0, 19);

// ---- fake ST (read-only GETs) ----
type P = Record<string, unknown>;
let payments: P[] = [];
const contacts: Record<number, unknown[]> = {};
const customers: Record<number, P> = {};
const invoices: Record<number, P> = {};
const jobs: Record<number, P> = {};
const assigns: Record<number, unknown[]> = {};
let stCalls: string[] = [];
// FAKE ids; the code matches by name via /payment-types.
const TYPE_NAMES = ["ACH", "AMEX", "Bypassed payment", "Cash", "Check", "Discover", "Financing by FTL", "Financing by Service Finance", "Imported Default Credit Card", "MasterCard", "Online Payments", "Other", "Pay-By-Bank", "Refund", "Visa"];
const JOB_TYPES = [{ id: 1, name: "Service Call" }, { id: 2, name: "Callback - No Charge" }, { id: 3, name: "Home Warranty Diagnostic" }, { id: 4, name: "Maintenance" }];
const TAG_TYPES = [{ id: 11, name: "Customer Complaint" }, { id: 12, name: "VIP" }, { id: 13, name: "Do Not Text" }];
let typesUp = true, jobTypesUp = true, assignUp = true;
const stGet = async (path: string) => {
  stCalls.push(path);
  if (/\/payment-types/.test(path)) {
    return typesUp ? { ok: true, status: 200, json: { data: TYPE_NAMES.map((name, i) => ({ id: 7000 + i, name })) } } : { ok: false, status: 500, json: null };
  }
  if (/\/job-types/.test(path)) return jobTypesUp ? { ok: true, status: 200, json: { data: JOB_TYPES } } : { ok: false, status: 503, json: null };
  if (/\/tag-types/.test(path)) return { ok: true, status: 200, json: { data: TAG_TYPES } };
  if (/\/invoices\?ids=/.test(path)) {
    const want = decodeURIComponent(path.split("ids=")[1]).split(",");
    return { ok: true, status: 200, json: { data: want.map((id) => invoices[Number(id)]).filter(Boolean) } };
  }
  const jm = path.match(/\/jpm\/v2\/tenant\/[^/]+\/jobs\/(\d+)$/);
  if (jm) return jobs[Number(jm[1])] ? { ok: true, status: 200, json: jobs[Number(jm[1])] } : { ok: false, status: 404, json: null };
  if (/appointment-assignments\?jobId=/.test(path)) {
    if (!assignUp) return { ok: false, status: 500, json: null };
    const id = Number(new URLSearchParams(path.split("?")[1]).get("jobId"));
    return { ok: true, status: 200, json: { data: assigns[id] || [] } };
  }
  if (/\/payments\?ids=/.test(path)) {
    const want = decodeURIComponent(path.split("ids=")[1]).split(",");
    return { ok: true, status: 200, json: { data: payments.filter((p) => want.includes(String(p.id)) && p.active !== false) } };
  }
  if (/\/payments\?/.test(path)) {
    const since = Date.parse(new URLSearchParams(path.split("?")[1]).get("createdOnOrAfter")!);
    return { ok: true, status: 200, json: { data: payments.filter((p) => Date.parse(String(p.createdOn)) >= since), hasMore: false } };
  }
  const m = path.match(/customers\/(\d+)(\/contacts)?$/);
  if (m) {
    const id = Number(m[1]);
    return m[2] ? { ok: true, status: 200, json: { data: contacts[id] || [] } } : { ok: true, status: 200, json: customers[id] || { id } };
  }
  return { ok: false, status: 404, json: null };
};
let sends: string[] = [];
let allowSend = false;
const send = async (to: string, body: string) => {
  if (!allowSend) throw new Error("SEND CALLED IN DRY RUN");
  sends.push(`${to}|${body}`);
  return { ok: true as const, sid: "SMfake", sender_mode: "messaging_service" as const };
};
const env = {} as Env;
const TEST_NUMBER_ENV = "(361) 555-0199"; // 555 fixture, as an env value would be set
const tick = (nowMs: number, e: Partial<Env> = {}) => runReviewTextTick({ ...env, ...e } as Env, db, { stGet, send, nowMs: () => nowMs });
const mob = (n: string, extra: P = {}) => ({ type: "MobilePhone", value: n, ...extra });
const statusOf = (pid: string) => sqlite.prepare(`SELECT status, reason FROM review_text_log WHERE st_payment_id=?`).get(pid) as any;
const rowOf = (pid: string) => sqlite.prepare(`SELECT * FROM review_text_log WHERE st_payment_id=?`).get(pid) as any;
const WARREN = { technicianId: 501, technicianName: "Warren Sample", active: true };
const BETO = { technicianId: 502, technicianName: "Beto Sample", active: true };

// Each payment -> its own invoice (100000+id) on its own job (8000+id), completed 1 h before T0, paid in full, Warren on it.
// Scenarios override these.
const T0 = ct(2026, 10, 3, 10, 0); // Sat 10/3 10:00 CT
function wire(id: number, custId: number, o: { jobId?: number; invoiceId?: number; balance?: number; completedMs?: number | null; job?: P; techs?: unknown[] } = {}) {
  const jobId = o.jobId ?? 8000 + id;
  const invId = o.invoiceId ?? 100000 + id;
  invoices[invId] = { id: invId, balance: o.balance ?? 0, total: 100, job: { id: jobId } };
  if (!jobs[jobId] || o.job || o.completedMs !== undefined) {
    jobs[jobId] = {
      id: jobId, jobStatus: o.completedMs === null ? "InProgress" : "Completed",
      completedOn: o.completedMs === null ? null : isoAt(o.completedMs ?? T0 - 60 * 60_000),
      recallForId: null, jobTypeId: 1, tagTypeIds: [], customerId: custId, ...(o.job || {}),
    };
  }
  if (!assigns[jobId]) assigns[jobId] = o.techs ?? [WARREN];
  return [{ appliedTo: invId }];
}
const pay = (id: number, typeId: number, createdMs: number, custId: number, extra: P = {}, w: Parameters<typeof wire>[2] = {}): P => ({
  id, active: true, total: 100, typeId, createdBy: "Bianca R", createdOn: isoAt(createdMs), customer: { id: custId, name: String((customers[custId] as any)?.name ?? "") },
  appliedTo: wire(id, custId, w), ...extra,
});
const cust = (id: number, name: string, type = "Residential") => { customers[id] = { id, name, type }; };

const at = (minAgo: number) => T0 - minAgo * 60_000;
cust(1, "Garza, Maria"); cust(2, "Sample, Bob"); cust(3, "Sample, Cara"); cust(4, "Sample, Dana"); cust(5, "Sample, Eli");
cust(6, "Sample, Fran"); cust(7, "Sample, Gus"); cust(8, "Sample, Hal");
payments = [
  pay(9001, 7003, at(5), 1, { total: 289.5 }),
  pay(9002, 7004, at(4), 1, { total: 89 }), // same customer, same visit, a second job (maintenance)
  pay(9003, 7014, at(5), 2, { total: 400, createdBy: "Marcus Torres" }),
  pay(9010, 7010, at(5), 3, { total: 169.99, createdBy: "Customer Portal" }),
  pay(9040, 7003, at(5), 4, { total: 120 }),
  pay(9041, 7003, at(5), 5, { total: 75 }),
  pay(9042, 7004, at(5), 6, { total: 60 }),
  pay(9044, 7003, at(6), 7, { total: 50 }),
  pay(9045, 7003, at(2), 7, { total: -50, refundedPaymentId: 9044 }),
  pay(9050, 7006, at(5), 8, { total: 500 }),
];
contacts[1] = [mob("361-555-0101")];
contacts[2] = [mob("361-555-0102", { phoneSettings: { doNotText: true } })];
contacts[4] = [{ type: "Phone", value: "361-555-0104" }];
contacts[5] = [mob("361-555-0105")];
contacts[6] = [mob("361-555-0106")];

// mode off: zero ST calls, zero rows
let s = await tick(T0);
eq("off: mode", s.mode, "off");
eq("off: no ST calls", stCalls.length, 0);
eq("off: no rows", (sqlite.prepare(`SELECT COUNT(*) n FROM review_text_log`).get() as any).n, 0);

// STOP from customer F's phone arrives via inbound webhook
eq("inbound STOP", await recordInboundOptKeyword(db, "+13615550106", "Stop"), "stop");
eq("inbound chit-chat ignored", await recordInboundOptKeyword(db, "+13615550101", "thanks!"), null);

sqlite.exec(`UPDATE settings SET value='dry' WHERE key='review_text_mode'`);
s = await tick(T0);
eq("dry t0: mode", s.mode, "dry");
eq("dry t0: polled", s.polled, 10);
eq("dry t0: queued", s.queued, 6);
eq("dry t0: skipped at first look", s.skipped, 4);
eq("dry t0: nothing due yet", s.would_send, 0);
eq("online skipped", statusOf("9010"), { status: "skipped", reason: "type_excluded" });
eq("financing skipped", statusOf("9050"), { status: "skipped", reason: "type_excluded" });
eq("refund row skipped", statusOf("9045").status, "skipped");
eq("refunded original skipped", statusOf("9044"), { status: "skipped", reason: "refund" });

// re-poll same page: de-dupe by payment id
s = await tick(T0 + 5 * 60_000);
eq("re-poll adds no rows", s.queued + s.skipped, 0);
eq("row count stable", (sqlite.prepare(`SELECT COUNT(*) n FROM review_text_log`).get() as any).n, 10);

// 9041 voided in ST before the recheck
payments = payments.map((p) => (p.id === 9041 ? { ...p, active: false } : p));
s = await tick(T0 + 20 * 60_000);
// NEW trigger: complete + paid + 2 h. At t+20 the 2 h haven't passed, so nothing goes yet.
eq("t+20 would_send", s.would_send, 0);
eq("9001 held waiting_2h", statusOf("9001"), { status: "held", reason: "waiting_2h" });
eq("9001 eligible = paid (later than complete) + 2h", rowOf("9001").eligible_at, sqlTs(at(5) + 120 * 60_000));
eq("9003 no-text flag", statusOf("9003"), { status: "skipped", reason: "no_text_flag" });
eq("9040 landline only", statusOf("9040"), { status: "skipped", reason: "no_mobile" });
eq("9041 voided", statusOf("9041"), { status: "voided", reason: "payment_gone" });
eq("9042 STOP honored", statusOf("9042"), { status: "skipped", reason: "opted_out" });
eq("job id logged", rowOf("9001").st_job_id, "17001");

s = await tick(T0 + 121 * 60_000); // 12:01 PM: 2 h after the last of (complete, paid)
eq("t+2h01 would_send", s.would_send, 1);
eq("9001 would_send", statusOf("9001"), { status: "would_send", reason: "dry_run" });
eq("9002 same customer same visit -> cap", statusOf("9002"), { status: "skipped", reason: "customer_cap" });
const body = (sqlite.prepare(`SELECT body, to_phone, template_variant v, segments, tech_first FROM review_text_log WHERE st_payment_id='9001'`).get() as any);
eq("draft body logged", body.body.includes("https://g.page/r/CVe1mBfXoqn_EBM/review") && body.body.endsWith("Reply STOP to opt out"), true);
eq("draft body exact (7:23 AM wording, tech first name)", body.body, "Hi Maria, thanks for choosing Total Assurance. How did Warren do? A quick Google review helps us a lot: https://g.page/r/CVe1mBfXoqn_EBM/review Reply STOP to opt out");
eq("variant/segments/tech logged", [body.v, body.segments, body.tech_first], ["tech_named", 2, "Warren"]);
eq("phone logged", body.to_phone, "+13615550101");
eq("no sends in dry", sends.length, 0);
eq("no ST writes (all GET paths)", stCalls.every((p) => ["/accounting/v2/", "/crm/v2/", "/jpm/v2/", "/settings/v2/", "/dispatch/v2/"].some((x) => p.startsWith(x))), true);

// late Saturday payment -> held to Monday 9 AM
const T1 = ct(2026, 10, 3, 18, 50);
cust(9, "Sample, Ivy");
payments.push(pay(9060, 7003, T1, 9, { total: 210 }));
contacts[9] = [mob("361-555-0109")];
await tick(T1 + 2 * 60_000);
s = await tick(T1 + 20 * 60_000); // 7:10 PM
eq("7:10 PM held", statusOf("9060"), { status: "held", reason: "held_for_window" });
eq("hold_until Mon 9 AM", (sqlite.prepare(`SELECT hold_until h FROM review_text_log WHERE st_payment_id='9060'`).get() as any).h, sqlTs(ct(2026, 10, 5, 9)));
s = await tick(ct(2026, 10, 4, 12)); // Sunday noon: still held, not due
eq("Sunday nothing", s.would_send, 0);
s = await tick(ct(2026, 10, 5, 9, 0));
eq("Mon 9 AM would_send", statusOf("9060").status, "would_send");

// live setting WITHOUT the env flag stays dry
sqlite.exec(`UPDATE settings SET value='live' WHERE key='review_text_mode'`);
cust(10, "Sample, Jo");
payments.push(pay(9070, 7003, ct(2026, 10, 5, 10), 10, { total: 99 }));
contacts[10] = [mob("361-555-0110")];
await tick(ct(2026, 10, 5, 10, 2));
await tick(ct(2026, 10, 5, 10, 20));
s = await tick(ct(2026, 10, 5, 12, 1));
eq("live w/o env flag -> dry", s.mode, "dry");
eq("9070 would_send note", statusOf("9070"), { status: "would_send", reason: "live_flag_off" });
eq("still no sends", sends.length, 0);

// kill switch
s = await tick(ct(2026, 10, 5, 12, 5), { REVIEW_TEXT_ENABLED: "off" });
eq("kill switch off", s.mode, "off");

// both flags on, no test number (sim only): exactly one real send through the injected sender
allowSend = true;
cust(11, "Sample, Kim");
payments.push(pay(9080, 7003, ct(2026, 10, 5, 12, 10), 11, { total: 99 }));
contacts[11] = [mob("361-555-0111")];
await tick(ct(2026, 10, 5, 12, 12), { REVIEW_TEXT_LIVE_SEND: "on" });
await tick(ct(2026, 10, 5, 12, 30), { REVIEW_TEXT_LIVE_SEND: "on" });
s = await tick(ct(2026, 10, 5, 14, 11), { REVIEW_TEXT_LIVE_SEND: "on" });
eq("both flags: live", s.mode, "live");
eq("both flags: one send", sends.length, 1);
eq("sms_log row", (sqlite.prepare(`SELECT COUNT(*) n FROM sms_log WHERE context LIKE 'review_text:%'`).get() as any).n, 1);
allowSend = false;

const view = await listReviewTextLog(db, { status: "would_send" });
eq("admin view masks phone", view.map((r) => r.phone_masked), ["(361) ***-0110", "(361) ***-0109", "(361) ***-0101"]);
eq("admin view has no raw phone", view.some((r) => "to_phone" in r), false);

// payment-types lookup down -> fail closed, nothing queued
sqlite.exec(`UPDATE settings SET value='dry' WHERE key='review_text_mode'`);
typesUp = false;
const before = (sqlite.prepare(`SELECT COUNT(*) n FROM review_text_log`).get() as any).n;
cust(12, "Sample, Lou");
payments.push(pay(9090, 7003, ct(2026, 10, 5, 15), 12, { total: 99, createdBy: "N/A" }));
s = await tick(ct(2026, 10, 5, 15, 2));
eq("types down: error", s.errors.includes("payment_types_unavailable"), true);
eq("types down: no new rows", (sqlite.prepare(`SELECT COUNT(*) n FROM review_text_log`).get() as any).n, before);
typesUp = true;
s = await tick(ct(2026, 10, 5, 15, 3));
eq("types back: queued", statusOf("9090").status, "queued");
eq("payment_type stored as looked-up name", (sqlite.prepare(`SELECT payment_type t FROM review_text_log WHERE st_payment_id='9090'`).get() as any).t, "Cash");

// ================= NEW (7:23 AM spec) =================
const TUE = (hh: number, mi = 0) => ct(2026, 10, 6, hh, mi);
const WED = (hh: number, mi = 0) => ct(2026, 10, 7, hh, mi);

// A) Office takes payment in person BEFORE the job is completed -> waits, then complete + 2 h
cust(30, "Sample, Nina"); contacts[30] = [mob("361-555-0130")];
payments.push(pay(9100, 7003, TUE(11), 30, {}, { completedMs: null }));
await tick(TUE(11, 2));
s = await tick(TUE(11, 20));
eq("A: not complete -> held waiting_complete", statusOf("9100"), { status: "held", reason: "waiting_complete" });
eq("A: rechecks hourly", rowOf("9100").hold_until, sqlTs(TUE(12, 20)));
s = await tick(TUE(12, 21));
eq("A: still in progress -> still waiting", statusOf("9100").reason, "waiting_complete");
jobs[8000 + 9100] = { ...jobs[8000 + 9100], jobStatus: "Completed", completedOn: isoAt(TUE(13)) };
s = await tick(TUE(13, 22));
eq("A: completed 1 PM -> held waiting_2h", statusOf("9100"), { status: "held", reason: "waiting_2h" });
eq("A: eligible = complete (later) + 2h = 3 PM", rowOf("9100").eligible_at, sqlTs(TUE(15)));
s = await tick(TUE(14, 59));
eq("A: 2:59 PM not yet", statusOf("9100").status, "held");
s = await tick(TUE(15, 0));
eq("A: 3 PM would_send", statusOf("9100"), { status: "would_send", reason: "dry_run" });

// B) Partial payment (balance left) -> waiting_paid; the payment that clears it sets the clock; one text per job
cust(31, "Sample, Omar"); contacts[31] = [mob("361-555-0131")];
payments.push(pay(9110, 7014, TUE(13), 31, { total: 50 }, { balance: 50 }));
await tick(TUE(13, 2));
s = await tick(TUE(13, 16));
eq("B: balance left -> held waiting_paid", statusOf("9110"), { status: "held", reason: "waiting_paid" });
invoices[100000 + 9110] = { ...invoices[100000 + 9110], balance: 0 };
payments.push({ ...pay(9111, 7003, TUE(14), 31, { total: 50 }, { jobId: 8000 + 9110, invoiceId: 100000 + 9110 }) });
await tick(TUE(14, 2));
s = await tick(TUE(14, 17));
eq("B: paid in full at 2 PM -> eligible 4 PM (not 3 PM)", rowOf("9110").eligible_at, sqlTs(TUE(16)));
eq("B: both held waiting_2h", [statusOf("9110").reason, statusOf("9111").reason], ["waiting_2h", "waiting_2h"]);
s = await tick(TUE(16, 1));
eq("B: first payment row texts", statusOf("9110"), { status: "would_send", reason: "dry_run" });
eq("B: second payment same job -> same_job", statusOf("9111"), { status: "skipped", reason: "same_job" });

// C) Weekday evening -> held_for_window to 9 AM next day
cust(32, "Sample, Pia"); contacts[32] = [mob("361-555-0132")];
payments.push(pay(9120, 7003, TUE(17, 30), 32, {}, { completedMs: TUE(16) }));
await tick(TUE(17, 32));
s = await tick(TUE(17, 46));
eq("C: 5:30 PM paid -> 7:30 PM -> held_for_window", statusOf("9120"), { status: "held", reason: "held_for_window" });
eq("C: hold until Wed 9 AM", rowOf("9120").hold_until, sqlTs(WED(9)));
s = await tick(WED(9, 0));
eq("C: Wed 9 AM would_send", statusOf("9120").status, "would_send");

// D) Skip list (spec merged with ours)
cust(33, "Sample, Quin"); contacts[33] = [mob("361-555-0133")];
cust(34, "Sample, Rae"); contacts[34] = [mob("361-555-0134")];
cust(35, "Sample, Sid"); contacts[35] = [mob("361-555-0135")];
cust(36, "Sample, Tia"); contacts[36] = [mob("361-555-0136")];
cust(37, "Sample, Uma"); contacts[37] = [mob("361-555-0137")];
cust(38, "Sample Holdings LLC", "Commercial"); contacts[38] = [mob("361-555-0138")];
cust(39, "Sample, Val"); contacts[39] = [mob("361-555-0139")];
payments.push(
  pay(9130, 7003, WED(10), 33, {}, { job: { tagTypeIds: [11] } }),
  pay(9131, 7003, WED(10), 34, {}, { job: { recallForId: 7777 } }),
  pay(9132, 7003, WED(10), 35, {}, { job: { jobTypeId: 2 } }),
  pay(9133, 7003, WED(10), 36, {}, { job: { jobTypeId: 3 } }),
  pay(9134, 7003, WED(10), 37, {}, { job: { jobStatus: "Canceled" } }),
  pay(9135, 7003, WED(10), 38),
  pay(9136, 7003, WED(10), 39),
);
await markReviewed(db, 39, 1, true);
await tick(WED(10, 2));
s = await tick(WED(10, 16));
eq("D: complaint tag", statusOf("9130"), { status: "skipped", reason: "flagged_tag" });
eq("D: recall", statusOf("9131"), { status: "skipped", reason: "recall" });
eq("D: callback job type", statusOf("9132"), { status: "skipped", reason: "callback_job_type" });
eq("D: home warranty (default out)", statusOf("9133"), { status: "skipped", reason: "home_warranty" });
eq("D: canceled job", statusOf("9134"), { status: "skipped", reason: "job_canceled" });
eq("D: commercial, no named contact", statusOf("9135"), { status: "skipped", reason: "commercial_no_contact" });
eq("D: already reviewed flag", statusOf("9136"), { status: "skipped", reason: "already_reviewed" });
await markReviewed(db, 39, 1, false);
eq("D: un-mark keeps the row (no DELETE)", (sqlite.prepare(`SELECT COUNT(*) n, MAX(cleared_at IS NOT NULL) c FROM review_text_reviewed WHERE st_customer_id=39`).get() as any), { n: 1, c: 1 });

// E) Odd customer name -> no "Hi {first}," ; no techs -> no-tech text ; assignments down -> no-tech, never a guess
cust(40, "SAMPLE, SAMANTHA"); contacts[40] = [mob("361-555-0140")];
cust(41, "Sample, Wes"); contacts[41] = [mob("361-555-0141")];
cust(42, "Sample, Xena"); contacts[42] = [mob("361-555-0142")];
cust(43, "Sample, Yuri"); contacts[43] = [mob("361-555-0143")];
payments.push(
  pay(9140, 7003, WED(11), 40),
  pay(9141, 7003, WED(11), 41, {}, { techs: [] }),
  pay(9142, 7003, WED(11), 42, {}, { techs: [WARREN, BETO] }),
);
await tick(WED(11, 2));
await tick(WED(11, 16));
s = await tick(WED(13, 1));
eq("E: ALL CAPS name -> tech_noname", [rowOf("9140").template_variant, rowOf("9140").body], ["tech_noname", "Thanks for choosing Total Assurance. How did Warren do? A quick Google review helps us a lot: https://g.page/r/CVe1mBfXoqn_EBM/review Reply STOP to opt out"]);
eq("E: no tech -> spec fallback text", rowOf("9141").body, "Hi Wes, thanks for choosing Total Assurance A/C & Heating. A quick Google review helps us a lot: https://g.page/r/CVe1mBfXoqn_EBM/review Reply STOP to opt out");
eq("E: two techs", [rowOf("9142").tech_first, rowOf("9142").segments], ["Warren and Beto", 2]);
assignUp = false;
payments.push(pay(9143, 7003, WED(13, 10), 43));
await tick(WED(13, 12));
await tick(WED(13, 26));
s = await tick(WED(15, 11));
eq("E: assignments down -> notech_named", [statusOf("9143").status, rowOf("9143").template_variant], ["would_send", "notech_named"]);
assignUp = true;

// F) job-types lookup down -> fail closed, row stays queued
jobTypesUp = false;
cust(44, "Sample, Zed"); contacts[44] = [mob("361-555-0144")];
payments.push(pay(9144, 7003, WED(15, 20), 44));
await tick(WED(15, 22));
s = await tick(WED(15, 36));
eq("F: job types down -> error", s.errors.includes("job_types_unavailable"), true);
eq("F: row stays queued", statusOf("9144").status, "queued");
jobTypesUp = true;
s = await tick(WED(15, 37));
eq("F: back -> held waiting_2h", statusOf("9144"), { status: "held", reason: "waiting_2h" });

// G) Never completed -> gives up after 14 days (skipped not_completed)
cust(45, "Sample, Abe"); contacts[45] = [mob("361-555-0145")];
payments.push(pay(9145, 7003, WED(16), 45, {}, { completedMs: null }));
await tick(WED(16, 2));
await tick(WED(16, 16));
eq("G: waiting_complete", statusOf("9145").reason, "waiting_complete");
s = await tick(ct(2026, 10, 22, 10));
eq("G: 15 days later -> skipped not_completed", statusOf("9145"), { status: "skipped", reason: "not_completed" });

// H) TEST-NUMBER MODE: real sends only to the env allowlist; every other number -> would_send not_test_number
sqlite.exec(`UPDATE settings SET value='test' WHERE key='review_text_mode'`);
const TH = (hh: number, mi = 0) => ct(2026, 10, 23, hh, mi); // Fri 10/23
s = await tick(TH(9), { REVIEW_TEXT_LIVE_SEND: "on" });
eq("H: test w/o number -> dry", [s.mode], ["dry"]);
s = await tick(TH(9, 1), { REVIEW_TEXT_TEST_NUMBER: TEST_NUMBER_ENV });
eq("H: test w/o live flag -> dry", s.mode, "dry");
allowSend = true;
const sendsBefore = sends.length;
cust(50, "Sample, Tess"); contacts[50] = [mob("361-555-0199")]; // the test phone (fixture customer)
cust(51, "Sample, Real"); contacts[51] = [mob("361-555-0151")];
payments.push(pay(9150, 7003, TH(10), 50), pay(9151, 7003, TH(10), 51));
const TE = { REVIEW_TEXT_LIVE_SEND: "on", REVIEW_TEXT_TEST_NUMBER: TEST_NUMBER_ENV };
await tick(TH(10, 2), TE);
await tick(TH(10, 16), TE);
s = await tick(TH(12, 1), TE);
eq("H: mode test", s.mode, "test");
eq("H: allowlisted 555 number gets the real send", statusOf("9150"), { status: "sent", reason: "test_number" });
eq("H: any other number -> would_send not_test_number", statusOf("9151"), { status: "would_send", reason: "not_test_number" });
eq("H: exactly one send, to the test number", sends.slice(sendsBefore).map((x) => x.split("|")[0]), ["+13615550199"]);
s = await tick(TH(12, 2), { REVIEW_TEXT_LIVE_SEND: "on", REVIEW_TEXT_TEST_NUMBER: TEST_NUMBER_ENV });
sqlite.exec(`UPDATE settings SET value='live' WHERE key='review_text_mode'`);
s = await tick(TH(12, 3), TE);
eq("H: live + test number still set -> test", s.mode, "test");

// I) Admin "send a test" button: test mode only, test number only, fake names, 5/day
sqlite.exec(`UPDATE settings SET value='test' WHERE key='review_text_mode'`);
const realNow = () => Date.now(); // sms_log.created_at uses the real clock
const stBeforeTest = stCalls.length;
const t1 = await sendTestReviewText({ ...env, ...TE } as Env, db, {}, { send, nowMs: realNow });
eq("I: test send ok to masked test number", [t1.ok, t1.to_masked], [true, "(361) ***-0199"]);
eq("I: test body uses fake names", t1.body, "Hi Sam, thanks for choosing Total Assurance. How did Alex do? A quick Google review helps us a lot: https://g.page/r/CVe1mBfXoqn_EBM/review Reply STOP to opt out");
eq("I: test send never calls ST", stCalls.length, stBeforeTest);
for (let i = 0; i < 4; i++) await sendTestReviewText({ ...env, ...TE } as Env, db, {}, { send, nowMs: realNow });
const t6 = await sendTestReviewText({ ...env, ...TE } as Env, db, {}, { send, nowMs: realNow });
eq("I: 6th test send blocked (5/day)", t6, { ok: false, error: "test_daily_cap" });
sqlite.exec(`UPDATE settings SET value='dry' WHERE key='review_text_mode'`);
const t7 = await sendTestReviewText({ ...env, ...TE } as Env, db, {}, { send, nowMs: realNow });
eq("I: dry mode refuses test send", t7, { ok: false, error: "mode_dry" });
eq("I: all real sends went to the 555 test number", sends.slice(sendsBefore).every((x) => x.startsWith("+13615550199|")), true);
allowSend = false;

// J) Admin page data: 4 previews with honest segments; reviewed column joins the flag table
const pv = reviewTextPreviews();
eq("J: previews = 4 variants", pv.map((x) => x.variant), ["tech_named", "notech_named", "tech_noname", "notech_noname"]);
eq("J: preview segments honest", pv.map((x) => x.segments), [2, 1, 1, 1]);
await markReviewed(db, 1, 1, true);
const lv = await listReviewTextLog(db, { status: "would_send" });
eq("J: reviewed shown for customer 1 only", lv.filter((r) => r.reviewed === 1).map((r) => r.st_payment_id), ["9001"]);
eq("J: log rows carry job/variant/segments", (() => { const r = lv.find((x) => x.st_payment_id === "9001")!; return [r.st_job_id, r.template_variant, r.segments, r.tech_first]; })(), ["17001", "tech_named", 2, "Warren"]);

// Read-only sample check (PC verification step), Gauge's 5 ids
payments.push(
  { id: 397158161, active: true, total: 10250, typeId: 7004, createdBy: "N/A", createdOn: "2026-10-02T16:00:00Z", customer: { id: 21 }, appliedTo: [{ appliedTo: 104714 }] },
  { id: 397105159, active: true, total: 1284.22, typeId: 7004, createdBy: "N/A", createdOn: "2026-10-01T16:00:00Z", customer: { id: 22 }, appliedTo: [{ appliedTo: 104182 }, { appliedTo: 104254 }] },
  { id: 397164560, active: true, total: 170, typeId: 7014, createdBy: "N/A", createdOn: "2026-10-02T18:00:00Z", customer: { id: 23 }, appliedTo: [{ appliedTo: 104504 }] },
  { id: 397143295, active: true, total: 5221.82, typeId: 7001, createdBy: "N/A", createdOn: "2026-10-01T20:00:00Z", customer: { id: 24 }, appliedTo: [{ appliedTo: 104353 }] },
  { id: 397074687, active: true, total: 188.78, typeId: 7010, createdBy: "N/A", createdOn: "2026-09-30T20:00:00Z", customer: { id: 25 }, batch: { name: "AutoBatch_Adyen Deposit 2026-10-01 (BJL6)_10/1/2026" }, appliedTo: [{ appliedTo: 103897 }] },
);
const rowsBefore = (sqlite.prepare(`SELECT COUNT(*) n FROM review_text_log`).get() as any).n;
stCalls = [];
const v = await verifySamplePayments({} as Env, db, ["397158161", "397105159", "397164560", "397143295", "397074687", "abc"], { stGet });
eq("verify ok", v.ok, true);
eq("verify decisions", v.rows.map((r) => `${r.id}:${r.decision}`), ["397158161:would_queue", "397105159:would_queue", "397164560:would_queue", "397143295:would_queue", "397074687:skip:type_excluded"]);
eq("verify 2 invoices on one payment", v.rows[1].invoices, "104182,104254");
eq("verify type names", v.rows.map((r) => r.type_name), ["Check", "Check", "Visa", "AMEX", "Online Payments"]);
eq("verify online batch shown", v.rows[4].batch, "AutoBatch_Adyen Deposit 2026-10-01 (BJL6)_10/1/2026");
eq("verify only 2 GETs, no contacts", stCalls.length === 2 && stCalls.every((p) => !p.includes("/crm/")), true);
eq("verify writes no rows", (sqlite.prepare(`SELECT COUNT(*) n FROM review_text_log`).get() as any).n, rowsBefore);

console.log(`review-text dry-run sim: ${pass} passed, ${fail} failed`);
console.log("final log:");
for (const r of sqlite.prepare(`SELECT st_payment_id, payment_type, status, reason, template_variant, segments FROM review_text_log ORDER BY id`).all() as any[]) {
  console.log(`  ${r.st_payment_id}  ${String(r.payment_type).padEnd(18)} ${r.status.padEnd(10)} ${String(r.reason ?? "").padEnd(22)} ${r.template_variant ?? ""} ${r.segments ?? ""}`);
}
if (fail) process.exit(1);
