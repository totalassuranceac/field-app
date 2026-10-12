/**
 * Post-payment Google review thank-you text: PURE decision logic.
 * No fetch, no D1, no Twilio. Every function here is deterministic given its inputs,
 * so scripts/test-review-text-plan.ts can cover it with fixtures.
 * The I/O side (worker/reviewText.ts) calls these and writes review_text_log.
 *
 * Modes: "off" (default) -> nothing runs. "dry" -> log who WOULD get a text. "live" -> real send,
 * reachable ONLY when the settings row says live AND env REVIEW_TEXT_LIVE_SEND is "on".
 * "test" (Chris 10/3 7:23 AM spec: test on a test number before any real customer) -> real send ONLY to a
 * number in env REVIEW_TEXT_TEST_NUMBER (comma list, never in code); every other number -> would_send.
 * test needs the setting test (or live) AND REVIEW_TEXT_LIVE_SEND=on AND a valid test number.
 *
 * Trigger (7:23 AM spec): job COMPLETE and invoice PAID, eligible at the LATER of the two + 2 h,
 * sent only inside 9 AM-7 PM CT Mon-Sat (no holidays); otherwise held to the next window start.
 * Data source stays READ-ONLY ServiceTitan for now (Field App payments don't reconcile yet).
 */
import { normalizePhone } from "./sms";

export const TZ = "America/Chicago";
export const REVIEW_TEXT_SETTING_MODE = "review_text_mode";
export const REVIEW_TEXT_SETTING_HWM = "review_text_hwm";
/** Review link from Chris's 7:23 AM spec (EBM). The website footer still uses ...EAE/review (same Google listing). */
export const DEFAULT_GOOGLE_REVIEW_LINK = "https://g.page/r/CVe1mBfXoqn_EBM/review";
/** RETIRED 10/3 7:23 AM (was option 1, locked 1:20 AM). Kept only so a test can prove it is no longer used. */
export const RETIRED_TEMPLATE_OPTION1 =
  "Thanks for choosing Total Assurance! If we earned it, a Google review means a lot to our crew: {link} Reply STOP to opt out";
/**
 * Chris's 7:23 AM wording. tech_named / notech_named are his exact text. {tech} = tech FIRST name only.
 * The two *_noname variants drop "Hi {first}, " for a missing/odd customer name (business, ALL CAPS,
 * initials...): the same words, nothing added (confirm with Chris). No UI edits these.
 */
export const REVIEW_TEXT_TEMPLATES = {
  tech_named: "Hi {first}, thanks for choosing Total Assurance. How did {tech} do? A quick Google review helps us a lot: {link} Reply STOP to opt out",
  notech_named: "Hi {first}, thanks for choosing Total Assurance A/C & Heating. A quick Google review helps us a lot: {link} Reply STOP to opt out",
  tech_noname: "Thanks for choosing Total Assurance. How did {tech} do? A quick Google review helps us a lot: {link} Reply STOP to opt out",
  notech_noname: "Thanks for choosing Total Assurance A/C & Heating. A quick Google review helps us a lot: {link} Reply STOP to opt out",
} as const;
export type TemplateVariant = keyof typeof REVIEW_TEXT_TEMPLATES;
/** Back-compat name: the main (tech-named) template. */
export const REVIEW_TEXT_TEMPLATE = REVIEW_TEXT_TEMPLATES.tech_named;

export type ReviewTextMode = "off" | "dry" | "test" | "live";

export type ReviewTextConfig = {
  /** Lowercased exact payment-type NAMES that may get a text (matched via GET /payment-types, never by id). */
  allowedTypes: string[];
  /** Lowercased exact names that are always skipped. Deny beats allow. */
  deniedTypes: string[];
  /** Substrings (lowercased) that always exclude a type name, as a backstop for renamed/new types. */
  deniedTypeParts: string[];
  /** Lowercased prefixes of batch / deposit names that mean an online processor batch. */
  deniedBatchPrefixes: string[];
  /** Ignore payments older than this at first sight (no backfill blast). */
  maxAgeMinutes: number;
  /** Re-check for voids this long after the payment was created. */
  recheckDelayMinutes: number;
  /** Re-check must happen before this; later than this we still re-check, but log it as late. */
  recheckLatestMinutes: number;
  /** Give up on a held text this long after the payment. */
  maxHoldHours: number;
  /** One review text per customer (and per phone) per this many days. */
  capDays: number;
  /** Safety caps. */
  maxPerTick: number;
  maxPerDay: number;
  /** Send window, Chicago wall time. Days: 0=Sun..6=Sat. End is exclusive. */
  windowStartHour: number;
  windowEndHour: number;
  windowDays: number[];
  /** No texts on these Chicago dates (YYYY-MM-DD). Spec: no Sundays or holidays. Settings can replace the list. */
  holidays: string[];
  /** Eligible at max(job completed, invoice paid) + this. */
  delayAfterBothMinutes: number;
  /** While the job isn't complete / the invoice isn't paid, re-check this often... */
  waitRecheckMinutes: number;
  /** ...and give up this many days after the payment (skipped not_completed / not_paid). */
  maxWaitDays: number;
  /** Never render more segments than this (falls back to a shorter variant). */
  maxSegments: number;
  /** Name up to this many techs ("Warren and Beto"); more -> the no-tech text. */
  maxTechNames: number;
  /** Spec skip list (merged with ours). Lowercased substrings. */
  deniedJobTypeParts: string[];
  deniedTagParts: string[];
  homeWarrantyParts: string[];
  /** Home-warranty jobs (payer isn't the homeowner): Chris decides. Default false = skip. */
  includeHomeWarranty: boolean;
};

/**
 * Payment types from Gauge's read of Settings > Invoicing > Payment and Invoice Types (10/3/2026).
 * createdBy is NOT a filter (ST audit shows N/A for these records); it is logged only.
 */
export const DEFAULT_CONFIG: ReviewTextConfig = {
  allowedTypes: ["cash", "check", "visa", "mastercard", "amex", "discover", "ach", "pay-by-bank"],
  deniedTypes: [
    "online payments",
    "bypassed payment",
    "financing by ftl",
    "financing by service finance",
    "imported default credit card",
    "other",
    "refund",
  ],
  deniedTypeParts: ["online", "portal", "auto-pay", "autopay", "recurring", "membership", "financ", "bypass", "imported", "refund"],
  deniedBatchPrefixes: ["autobatch_adyen"],
  maxAgeMinutes: 120,
  recheckDelayMinutes: 15,
  recheckLatestMinutes: 30,
  maxHoldHours: 72,
  capDays: 90,
  maxPerTick: 20,
  maxPerDay: 40,
  windowStartHour: 9,
  windowEndHour: 19,
  windowDays: [1, 2, 3, 4, 5, 6],
  // US holidays the shop is closed (confirm with Chris). Sundays are already out via windowDays.
  holidays: ["2026-11-26", "2026-12-25", "2027-01-01", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
  delayAfterBothMinutes: 120,
  waitRecheckMinutes: 60,
  maxWaitDays: 14,
  maxSegments: 2,
  maxTechNames: 2,
  deniedJobTypeParts: ["recall", "callback", "call back", "call-back"],
  deniedTagParts: ["complaint", "dispute", "refund", "chargeback", "charge back", "recall", "callback", "call back", "do not text", "no text"],
  homeWarrantyParts: ["home warranty", "first american", "american home shield", "choice home", "old republic", "fidelity national home", "cinch home", "select home warranty"],
  includeHomeWarranty: false,
};

/** Subset of ST Accounting v2 payment (verify field names on PC with one read-only call). */
export type StPayment = {
  id?: number | string | null;
  active?: boolean | null;
  total?: number | string | null;
  type?: string | null;
  typeId?: number | null;
  createdBy?: string | null;
  createdOn?: string | null;
  date?: string | null;
  refundedPaymentId?: number | string | null;
  batch?: { id?: number | null; number?: string | null; name?: string | null } | null;
  deposit?: { id?: number | null; name?: string | null } | null;
  customer?: { id?: number | null; name?: string | null } | null;
  appliedTo?: { appliedTo?: number | null; appliedAmount?: number | string | null }[] | null;
};

export type StContact = {
  id?: number;
  type?: string | null;
  value?: string | null;
  phoneSettings?: { phoneNumber?: string | null; doNotText?: boolean | null } | null;
};

export type StCustomerFlags = {
  doNotService?: boolean | null;
  /** Some tenants expose a customer-level text opt-out; honor it if present. */
  doNotText?: boolean | null;
};

export type SkipReason =
  | "no_id"
  | "inactive"
  | "not_positive"
  | "refund"
  | "type_excluded"
  | "type_not_allowed"
  | "type_unresolved"
  | "online_batch"
  | "no_customer"
  | "too_old"
  | "no_created_on";

export type FirstLook =
  | { action: "queue"; paymentId: string; customerId: number; recheckAtMs: number; typeName: string; total: number }
  | { action: "skip"; paymentId: string | null; reason: SkipReason; detail?: string };

function lc(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function toAmount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** ST times are UTC; tolerate a missing "Z". */
export function parseStTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = String(s).trim();
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

/** typeId -> name map built from GET /accounting/v2/tenant/{t}/payment-types. */
export type PaymentTypeMap = Map<string, string>;

export function buildTypeMap(rows: { id?: number | string | null; name?: string | null }[] | null | undefined): PaymentTypeMap {
  const m: PaymentTypeMap = new Map();
  for (const r of rows || []) {
    if (r?.id == null || !r.name) continue;
    m.set(String(r.id), String(r.name));
  }
  return m;
}

/**
 * The payment's type NAME. With a typeId, the name comes from the lookup (never a hardcoded id);
 * a typeId missing from the lookup -> null (unresolved -> skip). No typeId -> the payment's own `type` text.
 */
export function resolveTypeName(p: StPayment, types: PaymentTypeMap | null): string | null {
  if (p.typeId != null && String(p.typeId).trim() !== "") {
    if (!types) return null;
    return types.get(String(p.typeId)) ?? null;
  }
  const t = String(p.type ?? "").trim();
  return t || null;
}

export function classifyType(
  name: string | null | undefined,
  cfg: ReviewTextConfig = DEFAULT_CONFIG
): "in_person" | "excluded" | "unknown" {
  const n = lc(name);
  if (!n) return "unknown";
  if (cfg.deniedTypes.includes(n)) return "excluded";
  if (cfg.deniedTypeParts.some((p) => n.includes(p))) return "excluded";
  if (cfg.allowedTypes.includes(n)) return "in_person";
  return "unknown";
}

export function isOnlineBatch(p: StPayment, cfg: ReviewTextConfig = DEFAULT_CONFIG): boolean {
  const names = [p.batch?.name, p.deposit?.name].map((x) => lc(x)).filter(Boolean);
  return names.some((n) => cfg.deniedBatchPrefixes.some((pre) => n.startsWith(pre)));
}

function isRefundLink(v: unknown): boolean {
  return v != null && String(v).trim() !== "" && String(v) !== "0";
}

/** First time the poller sees a payment. Pure. `ignoreAge` is for the read-only sample check only. */
export function firstLook(
  p: StPayment,
  nowMs: number,
  cfg: ReviewTextConfig = DEFAULT_CONFIG,
  types: PaymentTypeMap | null = null,
  opts: { ignoreAge?: boolean } = {}
): FirstLook {
  const pid = p.id == null || String(p.id).trim() === "" ? null : String(p.id).trim();
  if (!pid) return { action: "skip", paymentId: null, reason: "no_id" };
  if (p.active === false) return { action: "skip", paymentId: pid, reason: "inactive" };
  const total = toAmount(p.total);
  if (!(total > 0)) return { action: "skip", paymentId: pid, reason: "not_positive", detail: String(p.total) };
  if (isRefundLink(p.refundedPaymentId)) return { action: "skip", paymentId: pid, reason: "refund" };
  const typeName = resolveTypeName(p, types);
  if (!typeName) return { action: "skip", paymentId: pid, reason: "type_unresolved", detail: String(p.typeId ?? "") };
  const t = classifyType(typeName, cfg);
  if (t === "excluded") return { action: "skip", paymentId: pid, reason: "type_excluded", detail: typeName };
  if (t === "unknown") return { action: "skip", paymentId: pid, reason: "type_not_allowed", detail: typeName };
  if (isOnlineBatch(p, cfg)) return { action: "skip", paymentId: pid, reason: "online_batch", detail: String(p.batch?.name || p.deposit?.name || "") };
  const customerId = Number(p.customer?.id);
  if (!(customerId > 0)) return { action: "skip", paymentId: pid, reason: "no_customer" };
  const created = parseStTime(p.createdOn);
  if (created == null) return { action: "skip", paymentId: pid, reason: "no_created_on" };
  if (!opts.ignoreAge && nowMs - created > cfg.maxAgeMinutes * 60_000) {
    return { action: "skip", paymentId: pid, reason: "too_old", detail: String(p.createdOn) };
  }
  return {
    action: "queue",
    paymentId: pid,
    customerId,
    recheckAtMs: created + cfg.recheckDelayMinutes * 60_000,
    typeName,
    total,
  };
}

export type RecheckResult =
  | { ok: true; late: boolean }
  | { ok: false; status: "voided" | "skipped"; reason: string };

/**
 * 15-30 min later: re-read the payment by id. null = not found (deleted / voided).
 * Any change that would have failed firstLook (except age) cancels the text.
 */
export function recheck(
  refreshed: StPayment | null,
  createdMs: number,
  nowMs: number,
  cfg: ReviewTextConfig = DEFAULT_CONFIG,
  types: PaymentTypeMap | null = null
): RecheckResult {
  if (!refreshed) return { ok: false, status: "voided", reason: "payment_gone" };
  if (refreshed.active === false) return { ok: false, status: "voided", reason: "inactive" };
  if (!(toAmount(refreshed.total) > 0)) return { ok: false, status: "voided", reason: "not_positive" };
  if (refreshed.refundedPaymentId != null && String(refreshed.refundedPaymentId).trim() !== "" && String(refreshed.refundedPaymentId) !== "0") {
    return { ok: false, status: "voided", reason: "refund" };
  }
  if (classifyType(resolveTypeName(refreshed, types), cfg) !== "in_person") {
    return { ok: false, status: "skipped", reason: "type_changed" };
  }
  if (isOnlineBatch(refreshed, cfg)) return { ok: false, status: "skipped", reason: "online_batch" };
  return { ok: true, late: nowMs - createdMs > cfg.recheckLatestMinutes * 60_000 };
}

/** True when this payment (by id) was later refunded by another payment in the same poll. */
export function refundedIds(payments: StPayment[]): Set<string> {
  const out = new Set<string>();
  for (const p of payments) {
    if (p.refundedPaymentId != null && String(p.refundedPaymentId).trim() !== "" && String(p.refundedPaymentId) !== "0") {
      out.add(String(p.refundedPaymentId).trim());
    }
  }
  return out;
}

export type PhonePick =
  | { ok: true; phone: string }
  | { ok: false; reason: "no_mobile" | "no_text_flag" | "do_not_service" | "bad_number" };

/** MOBILE ONLY. Never fall back to a landline (unlike stJobSiteEnrich.phoneFromContacts). */
export function pickMobile(contacts: StContact[] | null | undefined, customer?: StCustomerFlags | null): PhonePick {
  if (customer?.doNotService === true) return { ok: false, reason: "do_not_service" };
  if (customer?.doNotText === true) return { ok: false, reason: "no_text_flag" };
  const mobiles = (contacts || []).filter((c) => {
    const t = lc(c.type).replace(/\s/g, "");
    return t === "mobilephone" || t === "mobile" || t === "cell" || t === "cellphone";
  });
  if (!mobiles.length) return { ok: false, reason: "no_mobile" };
  let flagged = false;
  let bad = false;
  for (const m of mobiles) {
    if (m.phoneSettings?.doNotText === true) {
      flagged = true;
      continue;
    }
    const raw = m.phoneSettings?.phoneNumber || m.value || "";
    const e164 = normalizePhone(raw);
    if (!e164 || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) {
      bad = true;
      continue;
    }
    return { ok: true, phone: e164 };
  }
  return { ok: false, reason: flagged ? "no_text_flag" : bad ? "bad_number" : "no_mobile" };
}

export type ChicagoWall = { y: number; m: number; d: number; hh: number; mi: number; dow: number; ymd: string };

export function chicagoWall(ms: number): ChicagoWall {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  return {
    y,
    m,
    d,
    hh: Number(parts.hour),
    mi: Number(parts.minute),
    dow: dows[parts.weekday] ?? -1,
    ymd: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  };
}

/** Chicago wall clock -> UTC ms (DST-safe, two-pass). */
export function chicagoLocalToUtc(y: number, m: number, d: number, hh: number, mi: number): number {
  const target = Date.UTC(y, m - 1, d, hh, mi);
  let guess = target + 6 * 3600_000;
  for (let i = 0; i < 3; i++) {
    const w = chicagoWall(guess);
    const seen = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mi);
    guess += target - seen;
  }
  return guess;
}

export function isSendDay(w: ChicagoWall, cfg: ReviewTextConfig = DEFAULT_CONFIG): boolean {
  return cfg.windowDays.includes(w.dow) && !(cfg.holidays || []).includes(w.ymd);
}

export function inSendWindow(nowMs: number, cfg: ReviewTextConfig = DEFAULT_CONFIG): boolean {
  const w = chicagoWall(nowMs);
  return isSendDay(w, cfg) && w.hh >= cfg.windowStartHour && w.hh < cfg.windowEndHour;
}

/** Start of the next allowed window (or nowMs if inside one). */
export function nextWindowStart(nowMs: number, cfg: ReviewTextConfig = DEFAULT_CONFIG): number {
  if (inSendWindow(nowMs, cfg)) return nowMs;
  for (let i = 0; i <= 14; i++) {
    const w = chicagoWall(nowMs + i * 86_400_000);
    const start = chicagoLocalToUtc(w.y, w.m, w.d, cfg.windowStartHour, 0);
    if (isSendDay(chicagoWall(start), cfg) && start > nowMs) return start;
  }
  return nowMs + 86_400_000; // unreachable with a sane config
}

export type SendGateInput = {
  nowMs: number;
  paymentCreatedMs: number;
  phone: string;
  optedOut: boolean;
  /** Latest sent OR would_send for this customer / phone (dry run counts, so the log is honest). */
  lastToCustomerMs: number | null;
  lastToPhoneMs: number | null;
  sentToday: number;
  sentThisTick: number;
};

export type SendGate =
  | { action: "send" }
  | { action: "hold"; untilMs: number }
  | { action: "skip"; reason: "opted_out" | "customer_cap" | "phone_cap" | "stale" | "day_cap" | "tick_cap" };

export function sendGate(i: SendGateInput, cfg: ReviewTextConfig = DEFAULT_CONFIG): SendGate {
  if (i.optedOut) return { action: "skip", reason: "opted_out" };
  const capMs = cfg.capDays * 86_400_000;
  if (i.lastToCustomerMs != null && i.nowMs - i.lastToCustomerMs < capMs) return { action: "skip", reason: "customer_cap" };
  if (i.lastToPhoneMs != null && i.nowMs - i.lastToPhoneMs < capMs) return { action: "skip", reason: "phone_cap" };
  if (i.nowMs - i.paymentCreatedMs > cfg.maxHoldHours * 3600_000) return { action: "skip", reason: "stale" };
  if (!inSendWindow(i.nowMs, cfg)) return { action: "hold", untilMs: nextWindowStart(i.nowMs, cfg) };
  // Caps HOLD to the next tick / day rather than drop: they are throughput limits, not customer rules.
  if (i.sentToday >= cfg.maxPerDay) return { action: "hold", untilMs: nextWindowStart(chicagoLocalToUtc(...ymdPlus(i.nowMs, 1), 0, 0), cfg) };
  if (i.sentThisTick >= cfg.maxPerTick) return { action: "hold", untilMs: i.nowMs + 5 * 60_000 };
  return { action: "send" };
}

function ymdPlus(ms: number, days: number): [number, number, number] {
  const w = chicagoWall(ms);
  const noon = chicagoLocalToUtc(w.y, w.m, w.d, 12, 0) + days * 86_400_000;
  const n = chicagoWall(noon);
  return [n.y, n.m, n.d];
}

/** settings.review_text_mode + env kill switch + env live flag. Default off. */
export function resolveMode(
  settingRaw: string | null | undefined,
  envEnabledRaw: string | null | undefined,
  envLiveRaw: string | null | undefined,
  envTestNumbersRaw?: string | null
): { mode: ReviewTextMode; note?: string } {
  const s = lc(settingRaw);
  const kill = lc(envEnabledRaw);
  if (kill === "off" || kill === "0" || kill === "false" || kill === "no") return { mode: "off", note: "env_kill_switch" };
  if (s === "dry") return { mode: "dry" };
  const tests = parseTestNumbers(envTestNumbersRaw);
  if (s === "test") {
    if (lc(envLiveRaw) !== "on") return { mode: "dry", note: "live_flag_off" };
    if (!tests.length) return { mode: "dry", note: "test_number_missing" };
    return { mode: "test" };
  }
  if (s === "live") {
    if (lc(envLiveRaw) !== "on") return { mode: "dry", note: "live_flag_off" };
    // A test number present means we are still testing: the allowlist wins over live.
    if (tests.length) return { mode: "test", note: "test_number_set" };
    return { mode: "live" };
  }
  return { mode: "off" };
}

export function shouldCallTwilio(mode: ReviewTextMode): boolean {
  return mode === "live" || mode === "test";
}

/** env REVIEW_TEXT_TEST_NUMBER -> E.164 list. US mobiles only; junk ignored. No number ever lives in code. */
export function parseTestNumbers(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(raw ?? "").split(/[,;\n]+/)) { // not on spaces: "(361) 555-0199" is one number
    const d = part.replace(/\D/g, "");
    const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
    if (/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) out.push(`+1${ten}`);
  }
  return [...new Set(out)];
}

/** The ONE decision that allows a real send. off/dry -> never; test -> allowlisted number only; live -> yes. */
export function sendTarget(
  mode: ReviewTextMode,
  phone: string,
  testNumbers: string[]
): { send: true } | { send: false; reason: "dry_run" | "off" | "not_test_number" } {
  if (mode === "off") return { send: false, reason: "off" };
  if (mode === "dry") return { send: false, reason: "dry_run" };
  if (mode === "test") return testNumbers.includes(phone) ? { send: true } : { send: false, reason: "not_test_number" };
  return { send: true };
}

/** Inbound keyword (Twilio Advanced Opt-Out defaults). Lenient for STOP, strict for START. */
export function optKeyword(body: string | null | undefined): "stop" | "start" | "help" | null {
  const raw = String(body ?? "").trim().toUpperCase();
  const word = raw.replace(/[^A-Z]/g, "");
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"].includes(word) && raw.split(/\s+/).length <= 2) {
    return "stop";
  }
  if (raw === "START" || raw === "UNSTOP") return "start";
  if (raw === "HELP" || raw === "INFO") return "help";
  return null;
}

const GSM7 =
  "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\u000a\u00d8\u00f8\u000d\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0";

const GSM7_EXT = "^{}\\[~]|\u20ac";

export function isGsm7(s: string): boolean {
  for (const ch of s) if (!GSM7.includes(ch) && !GSM7_EXT.includes(ch)) return false;
  return true;
}

export function smsSegments(s: string): number {
  const gsm = isGsm7(s);
  let units = 0;
  for (const ch of s) units += gsm && GSM7_EXT.includes(ch) ? 2 : 1;
  if (gsm) return units <= 160 ? 1 : Math.ceil(units / 153);
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

export type Rendered = { ok: true; body: string; chars: number; segments: number; gsm7: boolean } | { ok: false; error: string };

/** Fills {link} (+ optional {first}/{tech}). Refuses no link, no STOP line, a bad link or any unfilled placeholder. */
export function renderReviewText(template: string, link: string, vars: { first?: string | null; tech?: string | null } = {}): Rendered {
  const t = String(template || "").trim();
  if (!t.includes("{link}")) return { ok: false, error: "template_missing_link" };
  if (!/reply stop to opt out$/i.test(t)) return { ok: false, error: "template_missing_stop" };
  const l = String(link || "").trim();
  if (!/^https:\/\/(g\.page\/r\/[A-Za-z0-9_-]+\/review|search\.google\.com\/local\/writereview\?placeid=[A-Za-z0-9_-]+)$/.test(l)) {
    return { ok: false, error: "bad_review_link" };
  }
  let body = t.split("{link}").join(l);
  if (vars.first != null && vars.first !== "") body = body.split("{first}").join(vars.first);
  if (vars.tech != null && vars.tech !== "") body = body.split("{tech}").join(vars.tech);
  if (/\{[a-z_]+\}/i.test(body)) return { ok: false, error: "unfilled_placeholder" };
  return { ok: true, body, chars: [...body].length, segments: smsSegments(body), gsm7: isGsm7(body) };
}

// ---------- names ----------
export type NamePick = { ok: true; name: string } | { ok: false; reason: "missing" | "business" | "couple" | "initials" | "all_caps" | "all_lower" | "odd_chars" | "too_long" | "placeholder" | "commercial" };

const BUSINESS_WORDS = [
  "llc", "l.l.c", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "lp", "llp", "pllc", "church", "ministries",
  "school", "isd", "academy", "university", "college", "hospital", "clinic", "dental", "medical", "apartments", "apts", "properties",
  "property", "management", "mgmt", "realty", "homes", "builders", "construction", "contractors", "hoa", "association", "assn",
  "services", "group", "holdings", "partners", "enterprises", "trust", "estate", "bank", "city", "county", "state", "dept",
  "department", "restaurant", "cafe", "grill", "hotel", "motel", "inn", "storage", "store", "shop", "market", "center", "centre",
  "office", "salon", "foundation", "investments", "rentals", "rental", "ranch", "farms", "family", "the", "plumbing", "electric",
];
const PLACEHOLDER_NAMES = ["customer", "tenant", "occupant", "resident", "owner", "homeowner", "unknown", "test", "na", "n/a", "none", "cash", "office", "builder", "current"];
const HONORIFICS = ["mr", "mrs", "ms", "miss", "dr", "mx"];

/**
 * Customer FIRST name from the ST customer name ("Garza, Maria" or "Maria Garza"). Anything odd -> not ok, and the
 * text uses the no-name variant. Odd = missing, business words, couples, initials, ALL CAPS, all lower, accents or
 * digits (would break GSM-7), > 14 letters, placeholder words, or an ST customer type of Commercial.
 */
export function customerFirstName(raw: string | null | undefined, customerType?: string | null): NamePick {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return { ok: false, reason: "missing" };
  if (lc(customerType) === "commercial") return { ok: false, reason: "commercial" };
  const words = s.toLowerCase().split(/[\s,]+/).map((w) => w.replace(/[^a-z.\/]/g, "")).filter(Boolean);
  if (words.some((w) => BUSINESS_WORDS.includes(w.replace(/\.$/, "")) || BUSINESS_WORDS.includes(w))) return { ok: false, reason: "business" };
  if (/[0-9@#]/.test(s)) return { ok: false, reason: "odd_chars" };
  if (/&|\+|\band\b|\//i.test(s)) return { ok: false, reason: "couple" };
  const firstPart = s.includes(",") ? s.slice(s.indexOf(",") + 1).trim() : s;
  let tokens = firstPart.split(" ").filter(Boolean);
  while (tokens.length && HONORIFICS.includes(tokens[0].toLowerCase().replace(/\.$/, ""))) tokens = tokens.slice(1);
  if (!tokens.length) return { ok: false, reason: "missing" };
  const tok = tokens[0];
  if (PLACEHOLDER_NAMES.includes(tok.toLowerCase())) return { ok: false, reason: "placeholder" };
  const bare = tok.replace(/\./g, "");
  if (bare.length <= 1 || tok.includes(".") || (bare.length <= 3 && bare === bare.toUpperCase() && /[A-Z]/.test(bare))) {
    return { ok: false, reason: "initials" };
  }
  if (tok === tok.toUpperCase() && /[A-Z]/.test(tok)) return { ok: false, reason: "all_caps" };
  if (tok === tok.toLowerCase()) return { ok: false, reason: "all_lower" };
  if (!/^[A-Z][A-Za-z]*(?:['-][A-Za-z]+)*$/.test(tok)) return { ok: false, reason: "odd_chars" };
  if (tok.length > 14) return { ok: false, reason: "too_long" };
  return { ok: true, name: tok };
}

/** Tech FIRST name only (Chris 7:23 AM). Our own staff names, so ALL CAPS is title-cased; anything else odd -> null. */
export function techFirstName(raw: string | null | undefined): string | null {
  const tok = String(raw ?? "").trim().split(/[\s,]+/)[0] || "";
  const t = tok === tok.toUpperCase() || tok === tok.toLowerCase() ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : tok;
  if (!/^[A-Z][A-Za-z]*(?:['-][A-Za-z]+)*$/.test(t) || t.length < 2 || t.length > 14) return null;
  return t;
}

export type StAssignment = { technicianId?: number | null; technicianName?: string | null; active?: boolean | null };

/** Distinct active techs on the job -> "Warren" or "Warren and Beto". None, an odd name, or > maxTechNames -> null. */
export function techDisplay(assignments: StAssignment[] | null | undefined, cfg: ReviewTextConfig = DEFAULT_CONFIG): string | null {
  const seen = new Map<string, string>();
  for (const a of assignments || []) {
    if (a?.active === false) continue;
    const key = a.technicianId != null ? `id:${a.technicianId}` : `n:${lc(a.technicianName)}`;
    if (seen.has(key) || !a.technicianName) continue;
    const f = techFirstName(a.technicianName);
    if (!f) return null; // an odd name on the crew -> don't guess
    seen.set(key, f);
  }
  const names = [...new Set(seen.values())];
  if (!names.length || names.length > cfg.maxTechNames) return null;
  return names.join(" and ");
}

export type BuiltText =
  | { ok: true; body: string; chars: number; segments: number; gsm7: true; variant: TemplateVariant; first: string | null; tech: string | null; nameNote: string | null }
  | { ok: false; error: string };

/** Picks the variant, renders it, and falls back (drop name, then tech) if a fill ever breaks GSM-7 or maxSegments. */
export function buildReviewText(
  i: { customerName: string | null | undefined; customerType?: string | null; techs: StAssignment[] | null | undefined; link?: string },
  cfg: ReviewTextConfig = DEFAULT_CONFIG
): BuiltText {
  const link = i.link || DEFAULT_GOOGLE_REVIEW_LINK;
  const np = customerFirstName(i.customerName, i.customerType);
  let first = np.ok ? np.name : null;
  let tech = techDisplay(i.techs, cfg);
  const nameNote = np.ok ? null : np.reason;
  for (let attempt = 0; attempt < 3; attempt++) {
    const variant: TemplateVariant = tech ? (first ? "tech_named" : "tech_noname") : first ? "notech_named" : "notech_noname";
    const r = renderReviewText(REVIEW_TEXT_TEMPLATES[variant], link, { first, tech });
    if (!r.ok) return r;
    if (r.gsm7 && r.segments <= cfg.maxSegments) {
      return { ok: true, body: r.body, chars: r.chars, segments: r.segments, gsm7: true, variant, first, tech, nameNote };
    }
    if (first) first = null;
    else if (tech) tech = null;
    else break;
  }
  return { ok: false, error: "text_too_long_or_not_gsm7" };
}

// ---------- job complete + invoice paid (read-only ST) ----------
/** Subset of ST invoice / job (confirm against real response). */
export type StInvoice = { id?: number | string | null; balance?: number | string | null; total?: number | string | null; job?: { id?: number | null; number?: string | null; type?: string | null } | null };
export type StJob = {
  id?: number | null;
  jobStatus?: string | null;
  completedOn?: string | null;
  recallForId?: number | null;
  jobTypeId?: number | null;
  tagTypeIds?: number[] | null;
  customerId?: number | null;
};

/** All of this payment's invoices exist, belong to one job, and have no balance left. */
export function invoicesState(
  invoiceIds: string[],
  invoices: StInvoice[] | null | undefined
): { ok: true; paid: boolean; jobId: number } | { ok: false; reason: "no_invoice" | "invoice_missing" | "no_job" | "multi_job" } {
  const ids = invoiceIds.map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return { ok: false, reason: "no_invoice" };
  const got = (invoices || []).filter((v) => ids.includes(String(v.id)));
  if (got.length !== ids.length) return { ok: false, reason: "invoice_missing" };
  const jobs = [...new Set(got.map((v) => Number(v.job?.id)).filter((n) => n > 0))];
  if (!jobs.length) return { ok: false, reason: "no_job" };
  if (jobs.length > 1) return { ok: false, reason: "multi_job" };
  const paid = got.every((v) => {
    const b = toAmount(v.balance);
    return Number.isFinite(b) && b <= 0.005;
  });
  return { ok: true, paid, jobId: jobs[0] };
}

export type JobSkipReason =
  | "job_canceled"
  | "recall"
  | "callback_job_type"
  | "flagged_tag"
  | "home_warranty"
  | "commercial_no_contact"
  | "already_reviewed";
export type JobCheck =
  | { action: "ok"; completedMs: number }
  | { action: "wait"; reason: "waiting_complete" | "waiting_paid" }
  | { action: "skip"; reason: JobSkipReason; detail?: string };

/** Spec skip list merged with ours, then complete + paid. Pure. Names come from read-only lookups. */
export function checkJob(
  i: {
    job: StJob;
    jobTypeName: string | null;
    tagNames: string[];
    paymentTypeName: string | null;
    paid: boolean;
    customerType: string | null;
    hasFirstName: boolean;
    reviewed: boolean;
  },
  cfg: ReviewTextConfig = DEFAULT_CONFIG
): JobCheck {
  const status = lc(i.job.jobStatus);
  if (status === "canceled" || status === "cancelled") return { action: "skip", reason: "job_canceled" };
  if (i.job.recallForId != null && Number(i.job.recallForId) > 0) return { action: "skip", reason: "recall" };
  const jt = lc(i.jobTypeName);
  if (jt && cfg.deniedJobTypeParts.some((p) => jt.includes(p))) return { action: "skip", reason: "callback_job_type", detail: i.jobTypeName || "" };
  const tag = i.tagNames.map(lc).find((t) => cfg.deniedTagParts.some((p) => t.includes(p)));
  if (tag) return { action: "skip", reason: "flagged_tag", detail: tag };
  if (!cfg.includeHomeWarranty) {
    const hay = [jt, lc(i.paymentTypeName), ...i.tagNames.map(lc)];
    const hw = hay.find((h) => h && cfg.homeWarrantyParts.some((p) => h.includes(p)));
    if (hw) return { action: "skip", reason: "home_warranty", detail: hw };
  }
  if (lc(i.customerType) === "commercial" && !i.hasFirstName) return { action: "skip", reason: "commercial_no_contact" };
  if (i.reviewed) return { action: "skip", reason: "already_reviewed" };
  const completedMs = parseStTime(i.job.completedOn);
  if (status !== "completed" || completedMs == null) return { action: "wait", reason: "waiting_complete" };
  if (!i.paid) return { action: "wait", reason: "waiting_paid" };
  return { action: "ok", completedMs };
}

/** Later of (job completed, invoice paid) + 2 h. */
export function eligibleAtMs(completedMs: number, paidMs: number, cfg: ReviewTextConfig = DEFAULT_CONFIG): number {
  return Math.max(completedMs, paidMs) + cfg.delayAfterBothMinutes * 60_000;
}

/** When it may go out: eligible time if inside the window, else the next window start. Reason for the log. */
export function sendAt(eligibleMs: number, nowMs: number, cfg: ReviewTextConfig = DEFAULT_CONFIG): { atMs: number; reason: "ready" | "waiting_2h" | "held_for_window" } {
  const at = nextWindowStart(Math.max(eligibleMs, nowMs), cfg);
  if (at <= nowMs) return { atMs: nowMs, reason: "ready" };
  return { atMs: at, reason: at > Math.max(eligibleMs, nowMs) ? "held_for_window" : "waiting_2h" };
}

export function waitExpired(paymentCreatedMs: number, nowMs: number, cfg: ReviewTextConfig = DEFAULT_CONFIG): boolean {
  return nowMs - paymentCreatedMs > cfg.maxWaitDays * 86_400_000;
}

/** Admin view: "(361) ***-1234". Full number stays in D1 for the later live send. */
export function maskPhone(e164: string | null | undefined): string {
  const d = String(e164 || "").replace(/\D/g, "").slice(-10);
  if (d.length !== 10) return "";
  return `(${d.slice(0, 3)}) ***-${d.slice(6)}`;
}

/** Poll window start: high-water mark minus 10 min overlap; first run = now - 30 min (no backfill). */
export function pollSinceIso(hwmIso: string | null | undefined, nowMs: number): string {
  const hwm = parseStTime(hwmIso || "");
  const base = hwm == null ? nowMs - 30 * 60_000 : Math.min(hwm, nowMs) - 10 * 60_000;
  return new Date(base).toISOString();
}

/** Parse a comma list setting into lowercased entries; empty/blank -> fallback. */
export function parseListSetting(raw: string | null | undefined, fallback: string[]): string[] {
  const list = String(raw ?? "")
    .split(",")
    .map((s) => lc(s))
    .filter(Boolean);
  return list.length ? list : fallback;
}
