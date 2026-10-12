/**
 * Fleet Shop plan checks. Nothing here touches D1.
 * Run: npx esbuild scripts/test-fleet-shop-plan.ts --bundle --platform=node --format=cjs --outfile=tmp-fleet-shop-test.cjs
 *      node tmp-fleet-shop-test.cjs
 */
import { readFileSync } from "node:fs";
import {
  ALLOWED_ENTRY_TYPES,
  ageTone,
  autoCloseAt,
  currentStage,
  daysBetween,
  entryTypeAllowed,
  hoursForDay,
  oilSeedAccepted,
  pmStatus,
  pmToCreate,
  queueSort,
  reliableOdometer,
  stageAge,
  stageTimeline,
  stepStats,
  validateAgeDays,
  type OdoReading,
  type PmType,
  type QueueItem,
} from "../worker/fleetShopPlan";

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
  } else {
    console.log(`ok ${name}`);
  }
}

const fixture = JSON.parse(
  readFileSync("scripts/fixtures/fleet-odometer-2026-10-01.json", "utf8")
) as OdoReading[];

function forVehicle(id: number): OdoReading[] {
  return fixture.filter((r) => r.vehicle_id === id);
}

const expectOdo: { id: number; odo: number | null; conf: string; outliers?: number[] }[] = [
  { id: 15, odo: 127453, conf: "good", outliers: [110, 78, 101, 2, 102] },
  { id: 8, odo: 184375, conf: "good", outliers: [76, 199] },
  { id: 17, odo: 81708.7, conf: "good" },
  { id: 4, odo: 9058, conf: "good" },
  { id: 18, odo: 7152, conf: "stale" },
  { id: 1, odo: 116417, conf: "stale" },
  { id: 6, odo: null, conf: "none" },
];

for (const exp of expectOdo) {
  const got = reliableOdometer(forVehicle(exp.id), { todayCt: "2026-10-01" });
  const ids = got.outliers.map((o) => o.id).sort((a, b) => a - b);
  const want = exp.outliers ? [...exp.outliers].sort((a, b) => a - b) : null;
  check(
    `1 v${exp.id} odo`,
    got.odometer === exp.odo && got.confidence === exp.conf && (want == null || JSON.stringify(ids) === JSON.stringify(want)),
    `got ${got.odometer} ${got.confidence} outliers ${ids.join(",")}`
  );
}

const v17 = forVehicle(17);
const anchored = reliableOdometer(
  [...v17, { id: 9001, source: "shop_confirm", date: "2026-10-01", odometer: 99900 }],
  { todayCt: "2026-10-01" }
);
check("2 anchor", anchored.odometer === 99900 && anchored.outliers.every((o) => o.date < "2026-10-01"), String(anchored.odometer));

const reviewed = reliableOdometer(
  [
    { id: 1, source: "fuel", date: "2026-09-01", odometer: 1000, ocr_needs_review: 0, ocr_reviewed_at: null },
    { id: 2, source: "fuel", date: "2026-09-10", odometer: 1400, ocr_needs_review: 1, ocr_reviewed_at: null },
    { id: 3, source: "fuel", date: "2026-09-20", odometer: 1800, ocr_needs_review: 1, ocr_reviewed_at: "2026-09-21 00:00:00" },
    { id: 4, source: "fuel", date: "2026-09-28", odometer: 2100, ocr_needs_review: 0, ocr_reviewed_at: null },
  ],
  { todayCt: "2026-10-01" }
);
check("3 unreviewed ignored", reviewed.odometer === 2100 && !reviewed.outliers.some((o) => o.id === 2), JSON.stringify(reviewed));

const oil: PmType = {
  code: "oil",
  label: "Oil",
  interval_miles: 5000,
  interval_days: null,
  soon_miles: 500,
  soon_days: 14,
  date_source: "interval",
  active: 1,
};
const oilState = { last_done_date: "2025-08-27", last_done_odometer: 120000, active: 1 };
check(
  "4 oil due_soon",
  pmStatus(oil, {}, oilState, { odometer: 124999, miles_per_day: 40 }, "2026-10-01").status === "due_soon"
);
check(
  "4 oil overdue",
  pmStatus(oil, {}, oilState, { odometer: 125000, miles_per_day: 40 }, "2026-10-01").status === "overdue"
);
check(
  "4 oil no date limit",
  pmStatus(oil, {}, oilState, { odometer: 121000, miles_per_day: 40 }, "2026-10-01").status === "ok"
);

const tires: PmType = {
  code: "tires",
  label: "Tires",
  interval_miles: 7500,
  interval_days: 182,
  soon_miles: 500,
  soon_days: 14,
  date_source: "interval",
  active: 1,
};
const tireState = { last_done_date: "2026-03-01", last_done_odometer: 110000, active: 1 };
check(
  "5 tires overdue date",
  pmStatus(tires, {}, tireState, { odometer: 112000, miles_per_day: 20 }, "2026-08-31").status === "overdue"
);
check(
  "5 tires due_soon",
  pmStatus(tires, {}, tireState, { odometer: 112000, miles_per_day: 20 }, "2026-08-20").status === "due_soon"
);

const brakes: PmType = {
  code: "brakes",
  label: "Brakes",
  interval_miles: 15000,
  interval_days: 365,
  soon_miles: 1000,
  soon_days: 30,
  date_source: "interval",
  active: 1,
};
const brakeState = { last_done_date: "2026-09-01", last_done_odometer: 115000, active: 1 };
check(
  "6 brakes projected",
  pmStatus(brakes, {}, brakeState, { odometer: 128500, miles_per_day: 120 }, "2026-10-01").status === "due_soon"
);
check(
  "6 brakes no rate",
  pmStatus(brakes, {}, brakeState, { odometer: 128500, miles_per_day: null }, "2026-10-01").status === "ok"
);

const reg: PmType = {
  code: "registration",
  label: "Registration",
  interval_miles: null,
  interval_days: null,
  soon_miles: 0,
  soon_days: 30,
  date_source: "registration_expires",
  active: 1,
};
check(
  "7 reg due_soon",
  pmStatus(reg, { registration_expires: "2026-10-31" }, null, { odometer: null, miles_per_day: null }, "2026-10-01").status ===
    "due_soon"
);
const unknown = pmStatus(reg, { registration_expires: null }, null, { odometer: null, miles_per_day: null }, "2026-10-01");
check("7 reg unknown", unknown.status === "unknown");
check("7 unknown not created", pmToCreate([unknown, { status: "ok" }, { status: "due_soon" }]).length === 1);

const chain18 = forVehicle(18).map((r) => ({ date: r.date, odometer: Number(r.odometer) }));
check("8 reject 0", oilSeedAccepted({ date: "2026-07-29", odometer: 0 }, chain18) === false);
check("8 reject 11295", oilSeedAccepted({ date: "2026-07-29", odometer: 11295 }, chain18) === false);
check(
  "8 accept near chain",
  oilSeedAccepted({ date: "2026-09-20", odometer: 199995 }, [
    { date: "2026-09-01", odometer: 199200 },
    { date: "2026-09-15", odometer: 199400 },
    { date: "2026-09-28", odometer: 200100 },
  ]) === true
);

const items: QueueItem[] = [
  { severity: "low", created_at: "2026-09-01" },
  { pm_status: "due_soon", severity: "low", created_at: "2026-09-02" },
  { severity: "medium", created_at: "2026-09-03" },
  { in_progress: true, severity: "low", created_at: "2026-09-04" },
  { severity: "high", created_at: "2026-09-05" },
  { pm_status: "overdue", severity: "low", created_at: "2026-09-06" },
  { truck_down: true, severity: "low", created_at: "2026-09-07" },
  { is_emergency: true, severity: "low", created_at: "2026-09-08" },
  { severity: "critical", created_at: "2026-09-09" },
  { severity: "medium", created_at: "2026-08-01" },
  { severity: "medium", created_at: "2026-09-03" },
];
const sorted = items.slice().sort(queueSort);
check(
  "9 queue order",
  sorted[0].is_emergency === true &&
    sorted[1].severity === "critical" &&
    sorted[2].truck_down === true &&
    sorted[3].pm_status === "overdue" &&
    sorted[4].severity === "high" &&
    sorted[5].in_progress === true &&
    sorted[6].severity === "medium" &&
    sorted[6].created_at === "2026-08-01" &&
    sorted[7].severity === "medium" &&
    sorted[9].pm_status === "due_soon" &&
    sorted[sorted.length - 1].severity === "low"
);

const fresh = stageTimeline({
  issue: { id: 47, status: "in_progress", created_at: "2026-10-01 14:00:00", scheduled_date: "2026-10-02", completed_at: null },
  stage_events: [{ stage: "scheduled", at: "2026-10-01 15:00:00", actor_user_id: 7, source: "fleet_shop" }],
  orders: [
    { status: "received", ordered_at: "2026-10-01 16:00:00", received_at: "2026-10-01 18:00:00" },
  ],
  segments: [{ started_at: "2026-10-01 19:00:00" }],
});
check(
  "10 six known",
  fresh.filter((s) => s.step !== "cancelled").length === 6 &&
    fresh.every((s) => s.step === "done" || s.known) &&
    fresh.find((s) => s.step === "scheduled")?.at === "2026-10-01 15:00:00" &&
    fresh.find((s) => s.step === "started")?.at === "2026-10-01 19:00:00" &&
    fresh.find((s) => s.step === "part_received")?.at === "2026-10-01 18:00:00"
);

const old34 = stageTimeline({
  issue: { id: 34, status: "scheduled", created_at: "2026-07-28 12:00:00", scheduled_date: "2026-07-30", completed_at: null },
  audits: [{ created_at: "2026-07-30 14:32:41", user_id: 7, after_status: "scheduled" }],
  downtime_started_at: "2026-07-30 14:32:41",
});
check(
  "11 #34 audit scheduled, downtime ignored",
  old34.find((s) => s.step === "scheduled")?.at === "2026-07-30 14:32:41" &&
    old34.find((s) => s.step === "started")?.reached === false
);
const old26 = stageTimeline({
  issue: { id: 26, status: "scheduled", created_at: "2026-07-20 12:00:00", scheduled_date: "2026-07-27", completed_at: null },
});
check(
  "11 #26 booked unknown",
  old26.find((s) => s.step === "scheduled")?.reached === true &&
    old26.find((s) => s.step === "scheduled")?.known === false &&
    old26.find((s) => s.step === "scheduled")?.note === "booked for 2026-07-27"
);
const old44 = stageTimeline({
  issue: { id: 44, status: "in_progress", created_at: "2026-08-01 12:00:00", completed_at: null },
  audits: [{ created_at: "2026-08-26 18:58:38", user_id: 7, after_status: "in_progress" }],
});
check("11 #44 started audit", old44.find((s) => s.step === "started")?.at === "2026-08-26 18:58:38");
const old39 = stageTimeline({
  issue: { id: 39, status: "completed", created_at: "2026-08-01 12:00:00", completed_at: "2026-08-14 21:07:00" },
});
check("11 #39 done", old39.find((s) => s.step === "done")?.at === "2026-08-14 21:07:00");
check("11 parts na", old39.find((s) => s.step === "part_ordered")?.na === true);

const wait = stageTimeline({
  issue: { id: 50, status: "open", created_at: "2026-10-01 12:00:00", completed_at: null },
  orders: [
    { status: "received", ordered_at: "2026-10-01 13:00:00", received_at: "2026-10-01 15:00:00" },
    { status: "ordered", ordered_at: "2026-10-01 14:00:00", received_at: null },
    { status: "cancelled", ordered_at: "2026-09-01 00:00:00", received_at: null },
  ],
});
check(
  "12 waiting",
  currentStage(wait, "open").stage === "waiting_parts" && wait.find((s) => s.step === "part_received")?.reached === false
);
const both = stageTimeline({
  issue: { id: 51, status: "open", created_at: "2026-10-01 12:00:00", completed_at: null },
  orders: [
    { status: "received", ordered_at: "2026-10-01 13:00:00", received_at: "2026-10-01 15:00:00" },
    { status: "received", ordered_at: "2026-10-01 14:00:00", received_at: "2026-10-01 16:30:00" },
  ],
});
check("12 both received", both.find((s) => s.step === "part_received")?.at === "2026-10-01 16:30:00");

const ageTl = stageTimeline({
  issue: { id: 60, status: "open", created_at: "2026-10-01 12:00:00", completed_at: null },
});
const startMs = Date.parse("2026-10-01T12:00:00Z");
check("13 23h59", stageAge(ageTl, "reported", startMs + (23 * 60 + 59) * 60000).days === 0);
check("13 48h", stageAge(ageTl, "reported", startMs + 48 * 3600000).days === 2);
const unk = stageTimeline({
  issue: { id: 61, status: "scheduled", created_at: "2026-10-01 12:00:00", scheduled_date: "2026-10-03", completed_at: null },
});
check("13 basis", stageAge(unk, "scheduled", startMs + 48 * 3600000).age_basis === "since reported");

check("14 tone 1", ageTone("reported", 1, 1) === "");
check("14 tone 2", ageTone("reported", 2, 2) === "overdue");
check("14 tone 5", ageTone("reported", 5, 5) === "urgent");
check("14 open total", ageTone("in_progress", 1, 7) === "overdue");
check("14 done", ageTone("done", 9, 9) === "");

const missing = validateAgeDays({ reported: [2, 5] });
check("15 missing key default", missing.ok && missing.ok && missing.value.scheduled[0] === 3);
const badPair = validateAgeDays({ reported: [5, 2] });
check("15 reject amber>=red", badPair.ok === false);

const stats = stepStats(
  [
    { issue_id: 1, vehicle_id: 15, reported_at: "2026-09-01 12:00:00", scheduled_at: "2026-09-03 12:00:00", scheduled_known: true, done_at: "2026-09-03 12:00:00", status: "completed", parts_na: true },
    { issue_id: 2, vehicle_id: 15, reported_at: "2026-09-01 12:00:00", scheduled_at: "2026-09-05 12:00:00", scheduled_known: true, done_at: "2026-09-05 12:00:00", status: "completed", parts_na: true },
    { issue_id: 3, vehicle_id: 15, reported_at: "2026-09-01 12:00:00", scheduled_at: "2026-09-10 12:00:00", scheduled_known: true, done_at: "2026-09-10 12:00:00", status: "completed", parts_na: true },
    { issue_id: 4, vehicle_id: 15, reported_at: "2026-09-20 12:00:00", scheduled_at: null, scheduled_known: false, done_at: null, status: "open", parts_na: true },
    { issue_id: 5, vehicle_id: 18, reported_at: "2026-09-19 12:00:00", scheduled_at: null, scheduled_known: false, done_at: null, status: "open", parts_na: true },
  ],
  90,
  undefined,
  "2026-10-01",
  Date.parse("2026-10-01T12:00:00Z")
);
check(
  "16 report_done",
  stats.overall.report_done.avg_days === 5 &&
    stats.overall.report_done.max_days === 9 &&
    stats.overall.report_done.max_issue_id === 3 &&
    stats.overall.report_done.n_known === 3,
  JSON.stringify(stats.overall.report_done)
);
check(
  "16 unknown scheduled",
  stats.overall.report_scheduled.n_known === 3 && stats.overall.report_scheduled.n_total >= 4
);
check(
  "16 open longest",
  stats.overall.report_done.open === true && stats.overall.report_done.open_days === 12 && stats.overall.report_done.open_issue_id === 5,
  JSON.stringify(stats.overall.report_done)
);
check("16 per vehicle", stats.by_vehicle["15"].report_done.n_known === 3 && stats.by_vehicle["18"].report_done.n_known === 0);

const split = hoursForDay(
  [{ entry_type: "work_order", started_at: "2026-10-02T04:30:00Z", ended_at: "2026-10-02T05:30:00Z" }],
  [],
  "2026-10-01",
  Date.parse("2026-10-02T12:00:00Z")
);
const splitNext = hoursForDay(
  [{ entry_type: "work_order", started_at: "2026-10-02T04:30:00Z", ended_at: "2026-10-02T05:30:00Z" }],
  [],
  "2026-10-02",
  Date.parse("2026-10-02T12:00:00Z")
);
check("17 split day", split.wrench_h === 0.5 && splitNext.wrench_h === 0.5, `${split.wrench_h} ${splitNext.wrench_h}`);
const dst = hoursForDay(
  [{ entry_type: "shop", started_at: "2026-11-02T05:30:00Z", ended_at: "2026-11-02T06:30:00Z" }],
  [],
  "2026-11-01",
  Date.parse("2026-11-02T12:00:00Z")
);
const dstNext = hoursForDay(
  [{ entry_type: "shop", started_at: "2026-11-02T05:30:00Z", ended_at: "2026-11-02T06:30:00Z" }],
  [],
  "2026-11-02",
  Date.parse("2026-11-02T12:00:00Z")
);
check("17 dst split", dst.shop_h === 0.5 && dstNext.shop_h === 0.5, `${dst.shop_h} ${dstNext.shop_h}`);
const openClock = hoursForDay(
  [],
  [{ kind: "shop", clock_in_at: "2026-10-01T13:00:00Z", clock_out_at: null }],
  "2026-10-01",
  Date.parse("2026-10-01T15:00:00Z")
);
check("17 open session", openClock.clocked_h === 2, String(openClock.clocked_h));
check("17 warehouse rejected", entryTypeAllowed("warehouse") === false && ALLOWED_ENTRY_TYPES.length === 2);

const started = "2026-10-01T12:00:00Z";
const closed = autoCloseAt({ started_at: started }, Date.parse(started) + 13 * 3600000);
check(
  "18 auto close",
  closed?.end_reason === "auto_close" && closed.ended_at === new Date(Date.parse(started) + 12 * 3600000).toISOString()
);
check("18 still open", autoCloseAt({ started_at: started }, Date.parse(started) + 11 * 3600000) === null);

check("days helper", daysBetween("2026-03-01", "2026-08-31") === 183);

console.log(failed ? `FAILS ${failed}` : "ALL PASS");
process.exit(failed ? 1 : 0);
