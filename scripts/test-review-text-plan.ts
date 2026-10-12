/**
 * Review-text plan checks. Pure logic only: nothing here sends a text, calls ServiceTitan, or touches D1.
 * Run: npx esbuild scripts/test-review-text-plan.ts --bundle --platform=node --outfile=tmp-review-text-test.mjs
 *      node tmp-review-text-test.mjs ; then delete tmp-review-text-test.mjs
 */
import {
  DEFAULT_CONFIG,
  DEFAULT_GOOGLE_REVIEW_LINK,
  REVIEW_TEXT_TEMPLATE,
  REVIEW_TEXT_TEMPLATES,
  RETIRED_TEMPLATE_OPTION1,
  type StPayment,
  type StJob,
  buildReviewText,
  checkJob,
  customerFirstName,
  eligibleAtMs,
  invoicesState,
  isGsm7,
  isSendDay,
  parseTestNumbers,
  sendAt,
  sendTarget,
  techDisplay,
  techFirstName,
  waitExpired,
  chicagoLocalToUtc,
  chicagoWall,
  buildTypeMap,
  classifyType,
  firstLook,
  inSendWindow,
  isOnlineBatch,
  resolveTypeName,
  maskPhone,
  nextWindowStart,
  optKeyword,
  parseListSetting,
  pickMobile,
  pollSinceIso,
  recheck,
  refundedIds,
  renderReviewText,
  resolveMode,
  sendGate,
  shouldCallTwilio,
  smsSegments,
} from "../worker/reviewTextPlan";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}
function ok(name: string, cond: boolean): void {
  eq(name, cond, true);
}

// Sat 10/3/2026 10:00 AM CDT = 15:00Z
const NOW = Date.parse("2026-10-03T15:00:00Z");
const tenMinAgo = "2026-10-03T14:50:00Z";

// Gauge's 10/3 list of ST payment types. Ids here are FAKE test ids: the code only ever matches by name.
const TYPE_NAMES = [
  "ACH", "AMEX", "Bypassed payment", "Cash", "Check", "Discover", "Financing by FTL", "Financing by Service Finance",
  "Imported Default Credit Card", "MasterCard", "Online Payments", "Other", "Pay-By-Bank", "Refund", "Visa",
];
const TYPES = buildTypeMap(TYPE_NAMES.map((name, i) => ({ id: 7000 + i, name })));
const tid = (name: string): number => 7000 + TYPE_NAMES.indexOf(name);

function pay(over: Partial<StPayment> & { typeName?: string }): StPayment {
  const { typeName, ...rest } = over;
  return {
    id: 9001,
    active: true,
    total: 289.5,
    typeId: tid(typeName || "Cash"),
    createdBy: null,
    createdOn: tenMinAgo,
    customer: { id: 5550001, name: "Garza, Maria" },
    batch: null,
    appliedTo: [{ appliedTo: 104900, appliedAmount: 289.5 }],
    ...rest,
  };
}

// ---------- fixtures: first look ----------
type Fx = { name: string; p: StPayment; want: string };
const FIXTURES: Fx[] = [
  { name: "Cash", p: pay({}), want: "queue" },
  { name: "Check", p: pay({ id: 9002, typeName: "Check" }), want: "queue" },
  { name: "Visa", p: pay({ id: 9003, typeName: "Visa" }), want: "queue" },
  { name: "AMEX string total", p: pay({ id: 9004, typeName: "AMEX", total: "1,250.00" }), want: "queue" },
  { name: "Discover", p: pay({ id: 9005, typeName: "Discover" }), want: "queue" },
  { name: "MasterCard", p: pay({ id: 9006, typeName: "MasterCard" }), want: "queue" },
  { name: "ACH", p: pay({ id: 9007, typeName: "ACH" }), want: "queue" },
  { name: "Pay-By-Bank", p: pay({ id: 9008, typeName: "Pay-By-Bank" }), want: "queue" },
  { name: "Online Payments", p: pay({ id: 9010, typeName: "Online Payments" }), want: "skip:type_excluded" },
  { name: "Bypassed payment", p: pay({ id: 9015, typeName: "Bypassed payment" }), want: "skip:type_excluded" },
  { name: "Financing by FTL", p: pay({ id: 9013, typeName: "Financing by FTL" }), want: "skip:type_excluded" },
  { name: "Financing by Service Finance", p: pay({ id: 9014, typeName: "Financing by Service Finance" }), want: "skip:type_excluded" },
  { name: "Imported Default Credit Card", p: pay({ id: 9016, typeName: "Imported Default Credit Card" }), want: "skip:type_excluded" },
  { name: "Other", p: pay({ id: 9019, typeName: "Other" }), want: "skip:type_excluded" },
  { name: "Refund", p: pay({ id: 9017, typeName: "Refund" }), want: "skip:type_excluded" },
  { name: "typeId not in lookup (new/unknown type)", p: pay({ id: 9022, typeId: 123456 }), want: "skip:type_unresolved" },
  { name: "no lookup row, no typeId, unknown text", p: pay({ id: 9023, typeId: null, type: "Gift Card" }), want: "skip:type_not_allowed" },
  { name: "no typeId, blank type", p: pay({ id: 9024, typeId: null, type: "" }), want: "skip:type_unresolved" },
  { name: "no typeId falls back to type text", p: pay({ id: 9025, typeId: null, type: "Check" }), want: "queue" },
  { name: "lookup name wins over payment.type text", p: pay({ id: 9026, typeName: "Online Payments", type: "Visa" }), want: "skip:type_excluded" },
  { name: "Visa in AutoBatch_Adyen batch", p: pay({ id: 9027, typeName: "Visa", batch: { name: "AutoBatch_Adyen Deposit 2026-10-01 (BJL6)_10/1/2026" } }), want: "skip:online_batch" },
  { name: "Adyen deposit name, lower case", p: pay({ id: 9028, typeName: "Visa", deposit: { name: "autobatch_adyen deposit x" } }), want: "skip:online_batch" },
  { name: "ordinary batch name ok", p: pay({ id: 9029, typeName: "Check", batch: { name: "Office deposit 10/2" } }), want: "queue" },
  { name: "createdBy N/A is NOT a filter", p: pay({ id: 9030, createdBy: "N/A" }), want: "queue" },
  { name: "createdBy System is NOT a filter", p: pay({ id: 9031, createdBy: "System" }), want: "queue" },
  { name: "refund via refundedPaymentId", p: pay({ id: 9018, refundedPaymentId: 9001, total: 50 }), want: "skip:refund" },
  { name: "negative total", p: pay({ id: 9032, total: -289.5 }), want: "skip:not_positive" },
  { name: "zero total", p: pay({ id: 9020, total: 0 }), want: "skip:not_positive" },
  { name: "inactive (voided)", p: pay({ id: 9021, active: false }), want: "skip:inactive" },
  { name: "no customer", p: pay({ id: 9033, customer: null }), want: "skip:no_customer" },
  { name: "3h old (no backfill)", p: pay({ id: 9034, createdOn: "2026-10-03T12:00:00Z" }), want: "skip:too_old" },
  { name: "no createdOn", p: pay({ id: 9035, createdOn: null }), want: "skip:no_created_on" },
  { name: "no id", p: pay({ id: null }), want: "skip:no_id" },
  { name: "createdOn without Z treated as UTC", p: pay({ id: 9036, createdOn: "2026-10-03T14:50:00" }), want: "queue" },
];
for (const f of FIXTURES) {
  const r = firstLook(f.p, NOW, DEFAULT_CONFIG, TYPES);
  eq(`firstLook: ${f.name}`, r.action === "queue" ? "queue" : `skip:${r.reason}`, f.want);
}
eq("typeId with NO lookup at all -> unresolved", firstLook(pay({}), NOW, DEFAULT_CONFIG, null).action === "skip" ? "skip" : "queue", "skip");
const q = firstLook(pay({}), NOW, DEFAULT_CONFIG, TYPES);
eq("queue recheckAt = created + 15m", q.action === "queue" ? q.recheckAtMs : null, Date.parse(tenMinAgo) + 15 * 60_000);
eq("queue keeps payment id as string", q.action === "queue" ? q.paymentId : null, "9001");
eq("queue carries looked-up type name", q.action === "queue" ? q.typeName : null, "Cash");
eq("resolveTypeName by lookup", resolveTypeName(pay({ typeName: "Pay-By-Bank" }), TYPES), "Pay-By-Bank");
eq("isOnlineBatch blank", isOnlineBatch(pay({})), false);

// ---------- Gauge's real sample payments (10/3 read-only UI pass), as fixtures ----------
// Shapes are illustrative (confirm against real response). Types/batches/invoices are from PAY-SETTINGS-INACCOUNT.md.
const SAMPLES: { p: StPayment; want: string }[] = [
  { p: pay({ id: 397158161, typeName: "Check", total: 10250, createdBy: "N/A", appliedTo: [{ appliedTo: 104714 }] }), want: "queue" },
  { p: pay({ id: 397105159, typeName: "Check", total: 1284.22, createdBy: "N/A", appliedTo: [{ appliedTo: 104182 }, { appliedTo: 104254 }] }), want: "queue" },
  { p: pay({ id: 397164560, typeName: "Visa", total: 170, createdBy: "N/A", appliedTo: [{ appliedTo: 104504 }] }), want: "queue" },
  { p: pay({ id: 397143295, typeName: "AMEX", total: 5221.82, createdBy: "N/A", appliedTo: [{ appliedTo: 104353 }] }), want: "queue" },
  { p: pay({ id: 397074687, typeName: "Online Payments", total: 188.78, createdBy: "N/A", batch: { name: "AutoBatch_Adyen Deposit 2026-10-01 (BJL6)_10/1/2026" }, appliedTo: [{ appliedTo: 103897 }] }), want: "skip:type_excluded" },
  { p: pay({ id: 397061119, typeName: "Bypassed payment", total: 29061.25, createdBy: "N/A" }), want: "skip:type_excluded" },
];
for (const sm of SAMPLES) {
  const r = firstLook({ ...sm.p, createdOn: "2026-10-01T15:00:00Z" }, NOW, DEFAULT_CONFIG, TYPES, { ignoreAge: true });
  eq(`sample ${sm.p.id}`, r.action === "queue" ? "queue" : `skip:${r.reason}`, sm.want);
}
eq("sample 397105159 (2 invoices) is ONE row", SAMPLES.filter((x) => x.p.id === 397105159).length, 1);
eq("samples without ignoreAge are too_old", firstLook({ ...SAMPLES[0].p, createdOn: "2026-10-01T15:00:00Z" }, NOW, DEFAULT_CONFIG, TYPES).action, "skip");

// allow-list override from settings
const cfgNoAch = { ...DEFAULT_CONFIG, allowedTypes: parseListSetting("cash, check", DEFAULT_CONFIG.allowedTypes) };
eq("settings override drops ACH", firstLook(pay({ typeName: "ACH" }), NOW, cfgNoAch, TYPES).action, "skip");
eq("settings override cannot allow Online Payments", firstLook(pay({ typeName: "Online Payments" }), NOW, { ...DEFAULT_CONFIG, allowedTypes: ["online payments"] }, TYPES).action, "skip");
eq("blank list setting -> default", parseListSetting("  , ", ["cash"]), ["cash"]);
eq("deny beats allow (Other)", classifyType("Other", { ...DEFAULT_CONFIG, allowedTypes: ["other"] }), "excluded");
eq("case/space-insensitive", classifyType("  pay-by-bank "), "in_person");

// refunds seen in the same poll
eq("refundedIds", [...refundedIds([pay({}), pay({ id: 2, refundedPaymentId: 9001 }), pay({ id: 3, refundedPaymentId: 0 })])], ["9001"]);

// ---------- recheck ----------
const created = Date.parse(tenMinAgo);
eq("recheck: gone", recheck(null, created, NOW, DEFAULT_CONFIG, TYPES), { ok: false, status: "voided", reason: "payment_gone" });
eq("recheck: inactive", recheck(pay({ active: false }), created, NOW, DEFAULT_CONFIG, TYPES), { ok: false, status: "voided", reason: "inactive" });
eq("recheck: zeroed", recheck(pay({ total: 0 }), created, NOW, DEFAULT_CONFIG, TYPES), { ok: false, status: "voided", reason: "not_positive" });
eq("recheck: refunded", recheck(pay({ refundedPaymentId: 1 }), created, NOW, DEFAULT_CONFIG, TYPES), { ok: false, status: "voided", reason: "refund" });
eq("recheck: retyped to financing", recheck(pay({ typeName: "Financing by FTL" }), created, NOW, DEFAULT_CONFIG, TYPES), { ok: false, status: "skipped", reason: "type_changed" });
eq("recheck: fine at +20m", recheck(pay({}), created, created + 20 * 60_000, DEFAULT_CONFIG, TYPES), { ok: true, late: false });
eq("recheck: moved into Adyen batch", recheck(pay({ batch: { name: "AutoBatch_Adyen Deposit" } }), created, NOW, DEFAULT_CONFIG, TYPES), { ok: false, status: "skipped", reason: "online_batch" });
eq("recheck: lookup missing -> type_changed (fail closed)", recheck(pay({}), created, NOW, DEFAULT_CONFIG, null), { ok: false, status: "skipped", reason: "type_changed" });
eq("recheck: late at +45m", recheck(pay({}), created, created + 45 * 60_000, DEFAULT_CONFIG, TYPES), { ok: true, late: true });

// ---------- phone pick ----------
eq("mobile picked", pickMobile([{ type: "Phone", value: "361-555-0000" }, { type: "MobilePhone", value: "(361) 555-1234" }]), { ok: true, phone: "+13615551234" });
eq("landline only -> no_mobile", pickMobile([{ type: "Phone", value: "361-555-0000" }, { type: "Email", value: "a@b.com" }]), { ok: false, reason: "no_mobile" });
eq("mobile doNotText", pickMobile([{ type: "MobilePhone", value: "3615551234", phoneSettings: { doNotText: true } }]), { ok: false, reason: "no_text_flag" });
eq("2nd mobile ok when 1st flagged", pickMobile([{ type: "MobilePhone", value: "3615551234", phoneSettings: { doNotText: true } }, { type: "MobilePhone", value: "3615559999" }]), { ok: true, phone: "+13615559999" });
eq("customer doNotService", pickMobile([{ type: "MobilePhone", value: "3615551234" }], { doNotService: true }), { ok: false, reason: "do_not_service" });
eq("customer doNotText", pickMobile([{ type: "MobilePhone", value: "3615551234" }], { doNotText: true }), { ok: false, reason: "no_text_flag" });
eq("bad mobile", pickMobile([{ type: "MobilePhone", value: "555-1234" }]), { ok: false, reason: "bad_number" });
eq("intl mobile rejected", pickMobile([{ type: "MobilePhone", value: "+44 7700 900123" }]), { ok: false, reason: "bad_number" });
eq("no contacts", pickMobile(null), { ok: false, reason: "no_mobile" });
eq("phoneSettings.phoneNumber preferred", pickMobile([{ type: "MobilePhone", value: "x", phoneSettings: { phoneNumber: "3615551111" } }]), { ok: true, phone: "+13615551111" });

// ---------- send window (Chicago) ----------
const ct = (y: number, m: number, d: number, hh: number, mi = 0) => chicagoLocalToUtc(y, m, d, hh, mi);
eq("CT conversion CDT", new Date(ct(2026, 10, 3, 10)).toISOString(), "2026-10-03T15:00:00.000Z");
eq("CT conversion CST", new Date(ct(2026, 12, 1, 9)).toISOString(), "2026-12-01T15:00:00.000Z");
eq("wall dow Sat", chicagoWall(NOW).dow, 6);
ok("Sat 10:00 in window", inSendWindow(ct(2026, 10, 3, 10)));
ok("Sat 9:00 in window", inSendWindow(ct(2026, 10, 3, 9, 0)));
ok("Sat 8:59 out", !inSendWindow(ct(2026, 10, 3, 8, 59)));
ok("Sat 18:59 in", inSendWindow(ct(2026, 10, 3, 18, 59)));
ok("Sat 19:00 out", !inSendWindow(ct(2026, 10, 3, 19, 0)));
ok("Sun noon out", !inSendWindow(ct(2026, 10, 4, 12)));
ok("Mon noon in", inSendWindow(ct(2026, 10, 5, 12)));
eq("Sat 7:30 PM -> Mon 9 AM", nextWindowStart(ct(2026, 10, 3, 19, 30)), ct(2026, 10, 5, 9));
eq("Sun -> Mon 9 AM", nextWindowStart(ct(2026, 10, 4, 15)), ct(2026, 10, 5, 9));
eq("Tue 6:10 AM -> Tue 9 AM", nextWindowStart(ct(2026, 10, 6, 6, 10)), ct(2026, 10, 6, 9));
eq("Wed 11 PM -> Thu 9 AM", nextWindowStart(ct(2026, 10, 7, 23)), ct(2026, 10, 8, 9));
eq("inside window -> now", nextWindowStart(ct(2026, 10, 6, 13)), ct(2026, 10, 6, 13));
eq("DST end Sat 10/31 8 PM -> Mon 11/2 9 AM CST", new Date(nextWindowStart(ct(2026, 10, 31, 20))).toISOString(), "2026-11-02T15:00:00.000Z");
eq("DST start Sat 3/13/2027 8 PM -> Mon 3/15 9 AM CDT", new Date(nextWindowStart(ct(2027, 3, 13, 20))).toISOString(), "2027-03-15T14:00:00.000Z");
eq("pre-DST Sat 3/6/2027 8 PM -> Mon 3/8 9 AM CST", new Date(nextWindowStart(ct(2027, 3, 6, 20))).toISOString(), "2027-03-08T15:00:00.000Z");

// ---------- send gate ----------
const base = { nowMs: NOW, paymentCreatedMs: created, phone: "+13615551234", optedOut: false, lastToCustomerMs: null, lastToPhoneMs: null, sentToday: 0, sentThisTick: 0 };
eq("gate: send", sendGate(base), { action: "send" });
eq("gate: STOP list", sendGate({ ...base, optedOut: true }), { action: "skip", reason: "opted_out" });
eq("gate: customer texted 30d ago", sendGate({ ...base, lastToCustomerMs: NOW - 30 * 86_400_000 }), { action: "skip", reason: "customer_cap" });
eq("gate: customer texted 91d ago", sendGate({ ...base, lastToCustomerMs: NOW - 91 * 86_400_000 }), { action: "send" });
eq("gate: same phone other customer 10d", sendGate({ ...base, lastToPhoneMs: NOW - 10 * 86_400_000 }), { action: "skip", reason: "phone_cap" });
eq("gate: Sunday holds to Mon 9", sendGate({ ...base, nowMs: ct(2026, 10, 4, 10), paymentCreatedMs: ct(2026, 10, 4, 9, 40) }), { action: "hold", untilMs: ct(2026, 10, 5, 9) });
eq("gate: stale after 72h", sendGate({ ...base, nowMs: NOW + 73 * 3600_000 }), { action: "skip", reason: "stale" });
eq("gate: tick cap holds 5m", sendGate({ ...base, sentThisTick: 20 }), { action: "hold", untilMs: NOW + 5 * 60_000 });
eq("gate: day cap holds to Mon 9", sendGate({ ...base, sentToday: 40 }), { action: "hold", untilMs: ct(2026, 10, 5, 9) });
eq("gate: STOP beats window", sendGate({ ...base, optedOut: true, nowMs: ct(2026, 10, 4, 10) }), { action: "skip", reason: "opted_out" });

// ---------- mode: no real send without the separate flag ----------
eq("mode default off", resolveMode(undefined, undefined, undefined), { mode: "off" });
eq("mode dry", resolveMode("dry", undefined, undefined), { mode: "dry" });
eq("mode live w/o env flag -> dry", resolveMode("live", undefined, undefined), { mode: "dry", note: "live_flag_off" });
eq("mode live w/ env flag yes (not 'on') -> dry", resolveMode("live", undefined, "yes"), { mode: "dry", note: "live_flag_off" });
eq("mode live + env on", resolveMode("live", undefined, "on"), { mode: "live" });
eq("env kill switch beats live", resolveMode("live", "off", "on"), { mode: "off", note: "env_kill_switch" });
eq("junk setting -> off", resolveMode("yes please", undefined, "on"), { mode: "off" });
ok("dry never calls Twilio", !shouldCallTwilio("dry") && !shouldCallTwilio("off") && shouldCallTwilio("live"));

// ---------- STOP keywords ----------
eq("STOP", optKeyword("STOP"), "stop");
eq("stop. lower", optKeyword(" stop. "), "stop");
eq("Unsubscribe", optKeyword("Unsubscribe"), "stop");
eq("STOP ALL", optKeyword("stop all"), "stop");
eq("sentence not a stop", optKeyword("please don't stop by today, come tomorrow"), null);
eq("START", optKeyword("start"), "start");
eq("YES is not our opt-in", optKeyword("yes"), null);
eq("HELP", optKeyword("Help"), "help");

// ---------- rendering (Chris 10/3 7:23 AM wording; option 1 retired) ----------
const LOCKED = "Hi Maria, thanks for choosing Total Assurance. How did Warren do? A quick Google review helps us a lot: https://g.page/r/CVe1mBfXoqn_EBM/review Reply STOP to opt out";
const NOTECH = "Hi Maria, thanks for choosing Total Assurance A/C & Heating. A quick Google review helps us a lot: https://g.page/r/CVe1mBfXoqn_EBM/review Reply STOP to opt out";
const SAMPLE = { first: "Maria", tech: "Warren" };
eq("template is Chris's locked text", REVIEW_TEXT_TEMPLATE.split("{link}").join(DEFAULT_GOOGLE_REVIEW_LINK).split("{first}").join("Maria").split("{tech}").join("Warren"), LOCKED);
eq("template words exact (7:23 AM)", REVIEW_TEXT_TEMPLATES.tech_named, "Hi {first}, thanks for choosing Total Assurance. How did {tech} do? A quick Google review helps us a lot: {link} Reply STOP to opt out");
eq("no-tech template words exact (7:23 AM)", REVIEW_TEXT_TEMPLATES.notech_named, "Hi {first}, thanks for choosing Total Assurance A/C & Heating. A quick Google review helps us a lot: {link} Reply STOP to opt out");
eq("no-name variants = same words minus 'Hi {first}, '", [REVIEW_TEXT_TEMPLATES.tech_noname, REVIEW_TEXT_TEMPLATES.notech_noname], [
  "Thanks for choosing Total Assurance. How did {tech} do? A quick Google review helps us a lot: {link} Reply STOP to opt out",
  "Thanks for choosing Total Assurance A/C & Heating. A quick Google review helps us a lot: {link} Reply STOP to opt out",
]);
ok("retired option 1 not used by any variant", !Object.values(REVIEW_TEXT_TEMPLATES).some((t) => t === RETIRED_TEMPLATE_OPTION1 || t.includes("If we earned it")));
ok("link is EBM (7:23 AM spec)", DEFAULT_GOOGLE_REVIEW_LINK === "https://g.page/r/CVe1mBfXoqn_EBM/review");
ok("every variant ends with the STOP line", Object.values(REVIEW_TEXT_TEMPLATES).every((t) => t.endsWith("Reply STOP to opt out")));
const DRAFTS = [REVIEW_TEXT_TEMPLATE];
const T1 = REVIEW_TEXT_TEMPLATES.notech_noname; // fillable without vars: used for link validation
for (const [i, t] of DRAFTS.entries()) {
  const r = renderReviewText(t, DEFAULT_GOOGLE_REVIEW_LINK, SAMPLE);
  ok(`draft ${i + 1} renders`, r.ok);
  if (r.ok) {
    ok(`draft ${i + 1} contains link`, r.body.includes("https://g.page/r/CVe1mBfXoqn_EBM/review"));
    ok(`draft ${i + 1} GSM-7`, r.gsm7);
    // Honest: Chris's new text is over 160 GSM-7 chars -> 2 segments (was 1 segment with option 1).
    eq(`draft ${i + 1} 2 segments (Maria/Warren)`, r.segments, 2);
    ok(`draft ${i + 1} >160 and <=306 (${r.chars})`, r.chars > 160 && r.chars <= 306);
    eq("rendered body exact", r.body, LOCKED);
    console.log(`new text (Maria/Warren): ${r.chars} chars, ${r.segments} segments (GSM-7)`);
  }
}
eq("render needs vars: unfilled {first}/{tech} rejected", renderReviewText(REVIEW_TEXT_TEMPLATE, DEFAULT_GOOGLE_REVIEW_LINK), { ok: false, error: "unfilled_placeholder" });
eq("render tech only -> {first} unfilled rejected", renderReviewText(REVIEW_TEXT_TEMPLATE, DEFAULT_GOOGLE_REVIEW_LINK, { tech: "Warren" }), { ok: false, error: "unfilled_placeholder" });
eq("render placeid link ok", renderReviewText(T1, "https://search.google.com/local/writereview?placeid=ChIJp7cUkz31aIYRV7WYF9eiqf8").ok, true);
eq("render missing link", renderReviewText("Thanks! Reply STOP to opt out", DEFAULT_GOOGLE_REVIEW_LINK), { ok: false, error: "template_missing_link" });
eq("render missing STOP", renderReviewText("Thanks! {link}", DEFAULT_GOOGLE_REVIEW_LINK), { ok: false, error: "template_missing_stop" });
eq("render STOP not at end rejected", renderReviewText("Reply STOP to opt out {link} thanks", DEFAULT_GOOGLE_REVIEW_LINK), { ok: false, error: "template_missing_stop" });
eq("render placeholder link rejected", renderReviewText(T1, "{GOOGLE_REVIEW_LINK}"), { ok: false, error: "bad_review_link" });
eq("render other domain rejected", renderReviewText(T1, "https://evil.example/review"), { ok: false, error: "bad_review_link" });
eq("segments: 161 GSM = 2", smsSegments("a".repeat(161)), 2);
eq("segments: 160 GSM = 1", smsSegments("a".repeat(160)), 1);
eq("segments: 306 GSM = 2, 307 = 3", [smsSegments("a".repeat(306)), smsSegments("a".repeat(307))], [2, 3]);
eq("segments: emoji forces UCS-2", smsSegments("Thanks \u{1F600}" + "a".repeat(70)), 2);
eq("segments: curly quote forces UCS-2", smsSegments("We\u2019re"), 1);
ok("'A/C & Heating' is GSM-7 (& and / are basic charset)", isGsm7(NOTECH));

// ---------- honest segment table (printed for the report) ----------
const segRows: [string, string | null, string | null][] = [
  ["Maria", "Warren", "tech_named"], ["Christopher", "Humberto", "tech_named"], ["Maria", null, "notech_named"],
  ["Christopher", null, "notech_named"], [null, "Warren", "tech_noname"], [null, null, "notech_noname"],
];
for (const [f, t, v] of segRows) {
  const r = renderReviewText(REVIEW_TEXT_TEMPLATES[v as keyof typeof REVIEW_TEXT_TEMPLATES], DEFAULT_GOOGLE_REVIEW_LINK, { first: f, tech: t });
  if (r.ok) console.log(`  seg ${v} first=${f ?? "-"} tech=${t ?? "-"}: ${r.chars} chars, ${r.segments} seg, gsm7=${r.gsm7}`);
}
const segOf = (f: string | null, t: string | null, v: keyof typeof REVIEW_TEXT_TEMPLATES) => {
  const r = renderReviewText(REVIEW_TEXT_TEMPLATES[v], DEFAULT_GOOGLE_REVIEW_LINK, { first: f, tech: t });
  return r.ok ? [r.chars, r.segments] : r.error;
};
eq("seg: tech_named Maria/Warren = 165 chars, 2 seg", segOf("Maria", "Warren", "tech_named"), [165, 2]);
eq("seg: notech_named Maria = 160 chars, 1 seg", segOf("Maria", null, "notech_named"), [160, 1]);
eq("seg: notech_named Christopher = 2 seg", segOf("Christopher", null, "notech_named"), [166, 2]);
eq("seg: tech_noname Warren = 155, 1 seg", segOf(null, "Warren", "tech_noname"), [155, 1]);
eq("seg: notech_noname = 150, 1 seg", segOf(null, null, "notech_noname"), [150, 1]);
eq("seg: worst case 14-letter first + 2 techs still <= 2", (segOf("Maximilianusss", "Christopherrrr and Bartholomewww", "tech_named") as number[])[1], 2);

// ---------- customer first name (odd -> no-name variant) ----------
const nm = (raw: string | null, type?: string) => { const r = customerFirstName(raw, type); return r.ok ? r.name : `x:${r.reason}`; };
eq("name: Last, First", nm("Garza, Maria"), "Maria");
eq("name: First Last", nm("Maria Garza"), "Maria");
eq("name: Mrs. honorific dropped", nm("Mrs. Maria Garza"), "Maria");
eq("name: Last, Dr. First", nm("Garza, Dr. Elena"), "Elena");
eq("name: hyphen ok", nm("Mary-Jo Pena"), "Mary-Jo");
eq("name: apostrophe ok", nm("D'Andre Wilson"), "D'Andre");
eq("name: missing", nm(""), "x:missing");
eq("name: null", nm(null), "x:missing");
eq("name: business LLC", nm("Sample Holdings LLC"), "x:business");
eq("name: business Properties", nm("Coastal Bend Properties"), "x:business");
eq("name: church", nm("First Baptist Church"), "x:business");
eq("name: commercial type", nm("Maria Garza", "Commercial"), "x:commercial");
eq("name: couple &", nm("Sam & Alex Sample"), "x:couple");
eq("name: couple and", nm("Sample, Sam and Alex"), "x:couple");
eq("name: initials J.", nm("J. Sample"), "x:initials");
eq("name: initials JR", nm("JR Sample"), "x:initials");
eq("name: single letter", nm("Sample, J"), "x:initials");
eq("name: ALL CAPS", nm("MARIA GARZA"), "x:all_caps");
eq("name: ALL CAPS Last, First", nm("GARZA, MARIA"), "x:all_caps");
eq("name: all lower", nm("maria garza"), "x:all_lower");
eq("name: accent breaks GSM-7 -> odd", nm("Zo\u00eb Sample"), "x:odd_chars");
eq("name: digits", nm("Unit 4 Sample"), "x:odd_chars");
eq("name: too long", nm("Bartholomewsonius Sample"), "x:too_long");
eq("name: placeholder Tenant", nm("Tenant"), "x:placeholder");
eq("name: placeholder Current Resident", nm("Current Resident"), "x:placeholder");

// ---------- tech first name ----------
eq("tech: first only", techFirstName("Warren Sample"), "Warren");
eq("tech: ALL CAPS staff name title-cased", techFirstName("BETO SAMPLE"), "Beto");
eq("tech: lower title-cased", techFirstName("alex sample"), "Alex");
eq("tech: junk -> null", techFirstName("#12"), null);
eq("techs: one", techDisplay([{ technicianId: 1, technicianName: "Warren Sample" }]), "Warren");
eq("techs: two -> 'and'", techDisplay([{ technicianId: 1, technicianName: "Warren Sample" }, { technicianId: 2, technicianName: "Beto Sample" }]), "Warren and Beto");
eq("techs: same tech twice", techDisplay([{ technicianId: 1, technicianName: "Warren Sample" }, { technicianId: 1, technicianName: "Warren Sample" }]), "Warren");
eq("techs: three -> null (no-tech text)", techDisplay([{ technicianId: 1, technicianName: "Warren A" }, { technicianId: 2, technicianName: "Beto B" }, { technicianId: 3, technicianName: "Alex C" }]), null);
eq("techs: inactive ignored", techDisplay([{ technicianId: 1, technicianName: "Warren Sample" }, { technicianId: 2, technicianName: "Beto Sample", active: false }]), "Warren");
eq("techs: none", techDisplay([]), null);
eq("techs: lookup failed (null)", techDisplay(null), null);
eq("techs: odd name on crew -> null", techDisplay([{ technicianId: 1, technicianName: "Warren Sample" }, { technicianId: 9, technicianName: "?? temp" }]), null);

// ---------- buildReviewText: variant pick + fallbacks ----------
const W = [{ technicianId: 1, technicianName: "Warren Sample" }];
const bt = (customerName: string | null, techs: { technicianId: number; technicianName: string }[] | null, customerType?: string) => buildReviewText({ customerName, customerType, techs });
const b1 = bt("Garza, Maria", W);
eq("build: tech_named exact", b1.ok && [b1.variant, b1.body, b1.segments], ["tech_named", LOCKED, 2]);
const b2 = bt("Garza, Maria", []);
eq("build: no tech -> notech_named exact (spec fallback)", b2.ok && [b2.variant, b2.body, b2.segments], ["notech_named", NOTECH, 1]);
const b3 = bt("Sample Holdings LLC", W);
eq("build: business -> tech_noname", b3.ok && [b3.variant, b3.nameNote, b3.body.startsWith("Thanks for choosing Total Assurance. How did Warren do?")], ["tech_noname", "business", true]);
const b4 = bt("SAMPLE, SAMANTHA", []);
eq("build: ALL CAPS + no tech -> notech_noname", b4.ok && [b4.variant, b4.nameNote, b4.segments], ["notech_noname", "all_caps", 1]);
const b5 = bt("J. Sample", W);
eq("build: 3-letter caps SAM reads as initials", (() => { const r = bt("SAMPLE, SAM", []); return r.ok && r.nameNote; })(), "initials");
eq("build: initials -> no 'Hi'", b5.ok && [b5.variant, b5.body.includes("Hi ")], ["tech_noname", false]);
const b6 = bt("Garza, Maria", [{ technicianId: 1, technicianName: "Warren Sample" }, { technicianId: 2, technicianName: "Beto Sample" }]);
eq("build: two techs", b6.ok && [b6.tech, b6.segments, b6.body.includes("How did Warren and Beto do?")], ["Warren and Beto", 2, true]);
const tight = { ...DEFAULT_CONFIG, maxSegments: 1 };
const b7 = buildReviewText({ customerName: "Garza, Maria", techs: W }, tight);
eq("build: segment guard falls back (drop name first)", b7.ok && [b7.variant, b7.segments], ["tech_noname", 1]);
const b8 = buildReviewText({ customerName: "Garza, Maria", techs: W, link: "https://evil.example/review" });
eq("build: bad link refused", b8, { ok: false, error: "bad_review_link" });
ok("build: every result GSM-7 and <= 2 segments", [b1, b2, b3, b4, b5, b6].every((b) => b.ok && b.gsm7 && b.segments <= 2));
ok("build: never an unfilled placeholder", [b1, b2, b3, b4, b5, b6].every((b) => b.ok && !/\{[a-z]+\}/.test(b.body)));
ok("build: every body ends with STOP line", [b1, b2, b3, b4, b5, b6].every((b) => b.ok && b.body.endsWith("Reply STOP to opt out")));

// ---------- invoices: paid + one job ----------
eq("inv: paid one job", invoicesState(["501"], [{ id: 501, balance: 0, job: { id: 8001 } }]), { ok: true, paid: true, jobId: 8001 });
eq("inv: balance left -> not paid", invoicesState(["501"], [{ id: 501, balance: "125.00", job: { id: 8001 } }]), { ok: true, paid: false, jobId: 8001 });
eq("inv: rounding cent ok", invoicesState(["501"], [{ id: 501, balance: 0.004, job: { id: 8001 } }]), { ok: true, paid: true, jobId: 8001 });
eq("inv: two invoices same job, one open -> not paid", invoicesState(["501", "502"], [{ id: 501, balance: 0, job: { id: 8001 } }, { id: 502, balance: 40, job: { id: 8001 } }]), { ok: true, paid: false, jobId: 8001 });
eq("inv: no invoice on payment", invoicesState([], []), { ok: false, reason: "no_invoice" });
eq("inv: invoice not returned", invoicesState(["501"], []), { ok: false, reason: "invoice_missing" });
eq("inv: invoice without job", invoicesState(["501"], [{ id: 501, balance: 0, job: null }]), { ok: false, reason: "no_job" });
eq("inv: two jobs", invoicesState(["501", "502"], [{ id: 501, balance: 0, job: { id: 8001 } }, { id: 502, balance: 0, job: { id: 8002 } }]), { ok: false, reason: "multi_job" });

// ---------- job check: spec skip list merged with ours, then complete + paid ----------
const J: StJob = { id: 8001, jobStatus: "Completed", completedOn: "2026-10-03T14:00:00Z", recallForId: null, jobTypeId: 1, tagTypeIds: [], customerId: 4001 };
const jc = { job: J, jobTypeName: "Service Call", tagNames: [] as string[], paymentTypeName: "Visa", paid: true, customerType: "Residential", hasFirstName: true, reviewed: false };
const jr = (o: Partial<typeof jc>) => { const r = checkJob({ ...jc, ...o }); return r.action === "ok" ? "ok" : `${r.action}:${r.reason}`; };
eq("job: complete + paid ok", checkJob(jc), { action: "ok", completedMs: Date.parse("2026-10-03T14:00:00Z") });
eq("job: not complete -> wait", jr({ job: { ...J, jobStatus: "InProgress", completedOn: null } }), "wait:waiting_complete");
eq("job: Completed w/o completedOn -> wait", jr({ job: { ...J, completedOn: null } }), "wait:waiting_complete");
eq("job: unpaid -> wait", jr({ paid: false }), "wait:waiting_paid");
eq("job: canceled", jr({ job: { ...J, jobStatus: "Canceled" } }), "skip:job_canceled");
eq("job: recall (recallForId)", jr({ job: { ...J, recallForId: 7777 } }), "skip:recall");
eq("job: callback job type", jr({ jobTypeName: "Callback - No Charge" }), "skip:callback_job_type");
eq("job: recall job type", jr({ jobTypeName: "Warranty Recall" }), "skip:callback_job_type");
eq("job: complaint tag", jr({ tagNames: ["Customer Complaint"] }), "skip:flagged_tag");
eq("job: do not text tag", jr({ tagNames: ["Do Not Text"] }), "skip:flagged_tag");
eq("job: chargeback tag", jr({ tagNames: ["Chargeback"] }), "skip:flagged_tag");
eq("job: home warranty job type", jr({ jobTypeName: "Home Warranty Diagnostic" }), "skip:home_warranty");
eq("job: home warranty tag (AHS)", jr({ tagNames: ["American Home Shield"] }), "skip:home_warranty");
eq("job: home warranty allowed when Chris says so", checkJob({ ...jc, jobTypeName: "Home Warranty Diagnostic" }, { ...DEFAULT_CONFIG, includeHomeWarranty: true }).action, "ok");
eq("job: commercial w/o named contact", jr({ customerType: "Commercial", hasFirstName: false }), "skip:commercial_no_contact");
eq("job: already reviewed flag", jr({ reviewed: true }), "skip:already_reviewed");
eq("job: skip beats wait (canceled + unpaid)", jr({ job: { ...J, jobStatus: "Canceled" }, paid: false }), "skip:job_canceled");
eq("job: residential odd name still ok (no-name text)", jr({ hasFirstName: false }), "ok");
eq("job: no 'unhappy' gating tag in deny list", DEFAULT_CONFIG.deniedTagParts.some((t) => t.includes("unhappy")), false);

// ---------- trigger timing: later of complete/paid + 2 h, 9 AM-7 PM CT Mon-Sat, no holidays ----------
eq("elig: paid after complete -> paid + 2h", eligibleAtMs(ct(2026, 10, 3, 10), ct(2026, 10, 3, 11)), ct(2026, 10, 3, 13));
eq("elig: office paid before complete -> complete + 2h", eligibleAtMs(ct(2026, 10, 3, 12), ct(2026, 10, 3, 9)), ct(2026, 10, 3, 14));
eq("sendAt: ready", sendAt(ct(2026, 10, 3, 13), ct(2026, 10, 3, 13, 5)), { atMs: ct(2026, 10, 3, 13, 5), reason: "ready" });
eq("sendAt: waiting 2h", sendAt(ct(2026, 10, 3, 13), ct(2026, 10, 3, 11, 30)), { atMs: ct(2026, 10, 3, 13), reason: "waiting_2h" });
eq("sendAt: paid 5:30 PM Fri -> 7:30 PM -> Sat 9 AM", sendAt(eligibleAtMs(ct(2026, 10, 2, 17), ct(2026, 10, 2, 17, 30)), ct(2026, 10, 2, 17, 45)), { atMs: ct(2026, 10, 3, 9), reason: "held_for_window" });
eq("sendAt: Sat 6 PM paid -> Mon 9 AM (no Sunday)", sendAt(eligibleAtMs(ct(2026, 10, 3, 17), ct(2026, 10, 3, 18)), ct(2026, 10, 3, 18, 10)), { atMs: ct(2026, 10, 5, 9), reason: "held_for_window" });
eq("sendAt: 6:59 PM eligible still in window", sendAt(ct(2026, 10, 6, 18, 59), ct(2026, 10, 6, 18, 59)), { atMs: ct(2026, 10, 6, 18, 59), reason: "ready" });
eq("sendAt: 7:00 PM eligible -> next day 9 AM", sendAt(ct(2026, 10, 6, 19), ct(2026, 10, 6, 19)), { atMs: ct(2026, 10, 7, 9), reason: "held_for_window" });
eq("sendAt: early morning 7 AM -> 9 AM same day", sendAt(ct(2026, 10, 6, 7), ct(2026, 10, 6, 7)), { atMs: ct(2026, 10, 6, 9), reason: "held_for_window" });
eq("sendAt: Wed before Thanksgiving 6 PM -> Fri 9 AM", sendAt(ct(2026, 11, 25, 19, 30), ct(2026, 11, 25, 18)), { atMs: ct(2026, 11, 27, 9), reason: "held_for_window" });
eq("sendAt: Christmas Eve 8 PM -> Sat 12/26 9 AM", sendAt(ct(2026, 12, 24, 20), ct(2026, 12, 24, 20)), { atMs: ct(2026, 12, 26, 9), reason: "held_for_window" });
ok("holiday: Thanksgiving not a send day", !isSendDay(chicagoWall(ct(2026, 11, 26, 12))));
ok("holiday: settings can clear the list", isSendDay(chicagoWall(ct(2026, 11, 26, 12)), { ...DEFAULT_CONFIG, holidays: [] }));
ok("window: Thanksgiving noon closed", !inSendWindow(ct(2026, 11, 26, 12)));
ok("wait: 13 days not expired, 15 days expired", !waitExpired(NOW - 13 * 86_400_000, NOW) && waitExpired(NOW - 15 * 86_400_000, NOW));

// ---------- test-number mode: real sends ONLY to the env allowlist (555 fixture; no number in code) ----------
const TESTNUM = "+13615550199";
eq("test#: parse one", parseTestNumbers("(361) 555-0199"), [TESTNUM]);
eq("test#: parse list + dedupe", parseTestNumbers("+1 361 555 0199, 3615550199; 361-555-0142"), [TESTNUM, "+13615550142"]);
eq("test#: junk ignored", parseTestNumbers("call me, 12, +44 20 7946 0000"), []);
eq("test#: empty", parseTestNumbers(undefined), []);
eq("test#: newline list", parseTestNumbers("361 555 0199\n361.555.0142"), [TESTNUM, "+13615550142"]);
eq("test#: '3 short' 555 numbers in one string not glued", parseTestNumbers("361 555 0199 361 555 0142"), []);
eq("mode test w/o live flag -> dry", resolveMode("test", undefined, undefined, TESTNUM), { mode: "dry", note: "live_flag_off" });
eq("mode test w/o number -> dry", resolveMode("test", undefined, "on", ""), { mode: "dry", note: "test_number_missing" });
eq("mode test ok", resolveMode("test", undefined, "on", TESTNUM), { mode: "test" });
eq("mode live + test number set -> test (allowlist wins)", resolveMode("live", undefined, "on", TESTNUM), { mode: "test", note: "test_number_set" });
eq("mode kill switch beats test", resolveMode("test", "off", "on", TESTNUM), { mode: "off", note: "env_kill_switch" });
eq("mode dry ignores test number", resolveMode("dry", undefined, "on", TESTNUM), { mode: "dry" });
ok("test mode calls Twilio (allowlisted only)", shouldCallTwilio("test"));
eq("target: test + allowlisted -> send", sendTarget("test", TESTNUM, [TESTNUM]), { send: true });
eq("target: test + real customer -> would_send", sendTarget("test", "+13615551234", [TESTNUM]), { send: false, reason: "not_test_number" });
eq("target: test + empty list -> nobody", sendTarget("test", TESTNUM, []), { send: false, reason: "not_test_number" });
eq("target: dry never", sendTarget("dry", TESTNUM, [TESTNUM]), { send: false, reason: "dry_run" });
eq("target: off never", sendTarget("off", TESTNUM, [TESTNUM]), { send: false, reason: "off" });
eq("target: live sends", sendTarget("live", "+13615551234", []), { send: true });

// ---------- misc ----------
eq("mask", maskPhone("+13615551234"), "(361) ***-1234");
eq("mask junk", maskPhone("12"), "");
eq("poll since first run = now-30m", pollSinceIso(null, NOW), new Date(NOW - 30 * 60_000).toISOString());
eq("poll since hwm-10m", pollSinceIso("2026-10-03T14:55:00Z", NOW), "2026-10-03T14:45:00.000Z");
eq("poll since future hwm clamps", pollSinceIso("2026-10-04T00:00:00Z", NOW), new Date(NOW - 10 * 60_000).toISOString());

// ---------- end-to-end over a poll page (pure pipeline) ----------
const page: StPayment[] = FIXTURES.map((f) => f.p);
const refunded = refundedIds(page);
const queued = page
  .map((p) => firstLook(p, NOW, DEFAULT_CONFIG, TYPES))
  .filter((r) => r.action === "queue" && !refunded.has(r.paymentId));
eq("pipeline: in-person queue count (9001 refunded in same page)", queued.map((r) => r.paymentId), ["9002", "9003", "9004", "9005", "9006", "9007", "9008", "9025", "9029", "9030", "9031", "9036"]);
// same customer paid 2 invoices in one visit: only first gets a would_send, second hits customer_cap
let last: number | null = null;
const decisions = queued.slice(0, 2).map(() => {
  const g = sendGate({ ...base, lastToCustomerMs: last });
  if (g.action === "send") last = NOW;
  return g.action === "skip" ? g.reason : g.action;
});
eq("pipeline: one text per customer per visit", decisions, ["send", "customer_cap"]);

console.log(`review-text plan: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
