/**
 * Offline checks for the install-crew board-mismatch nudge. Nothing sends.
 */
import assert from "node:assert/strict";
import { chicagoLocalToUtc, planClockinTick } from "../worker/clockinNudgePlan";
import {
  CHRIS_PHONE,
  JOB_RADIUS_M,
  SHOP_LAT,
  SHOP_LNG,
  leadBodyDayNoJob,
  leadBodyDispatchedOnSite,
  planOnsiteTick,
  replayOnsiteDay,
  type OnsiteAction,
  type OnsiteCrewInput,
  type OnsiteExisting,
  type OnsiteJob,
  type OnsitePlanInput,
  type OnsitePosition,
  type OnsiteVan,
} from "../worker/onsiteNudgePlan";
import { runOnsiteNudges } from "../worker/onsiteNudge";

const DAY = "2026-09-30";
const SAT = "2026-10-03";
const APPT = "396989582";
const JOBN = "104682";
const STREET = "5806 Crest Pebble Dr";
const JOB_LAT = 27.7;
const JOB_LNG = -97.4;
const APPT2 = "397000001";
const JOBN2 = "104700";
const STREET2 = "1810 Clapper Rail";
const JOB2_LAT = 27.71;
const JOB2_LNG = -97.39;

let failed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        console.log("PASS  " + name);
      })
      .catch((err: unknown) => {
        failed += 1;
        console.log("FAIL  " + name);
        console.log(err instanceof Error ? err.stack || err.message : String(err));
      })
  );
}

function at(ymd: string, hh: number, mi: number): Date {
  const [y, m, d] = ymd.split("-").map((n) => Number(n));
  return new Date(chicagoLocalToUtc(y, m, d, hh, mi));
}

function northOf(lat: number, lng: number, meters: number): { lat: number; lng: number } {
  const d = meters / 6371000;
  const p1 = (lat * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d));
  return { lat: (p2 * 180) / Math.PI, lng };
}

function fresh(lat: number, lng: number, now: Date, ageMin = 1, speed = 0): OnsitePosition {
  return {
    lat,
    lng,
    speedMph: speed,
    pointAt: new Date(now.getTime() - ageMin * 60 * 1000).toISOString(),
    provider: "onestep",
    status: "stop",
  };
}

function job(partial: Partial<OnsiteJob> = {}): OnsiteJob {
  return {
    apptId: APPT,
    jobId: "job-104682",
    jobNumber: JOBN,
    street: STREET,
    windowStart: `${DAY}T08:00:00`,
    stPhase: "scheduled",
    ink: "st",
    jobLat: JOB_LAT,
    jobLng: JOB_LNG,
    ...partial,
  };
}

function van(partial: Partial<OnsiteVan> = {}): OnsiteVan {
  return {
    vehicleId: 7,
    unit: "007",
    mapSource: "partner",
    gpsTracker: "One Step",
    status: "active",
    ...partial,
  };
}

function install(partial: Partial<OnsiteCrewInput> & { jobs?: OnsiteJob[] } = {}): OnsiteCrewInput {
  const { jobs, ...rest } = partial;
  return {
    crew: "install",
    leadUserId: 17,
    leadName: "Arin R",
    leadUsername: "arin",
    memberUserIds: [17, 16],
    leadActive: true,
    leadOnPto: false,
    jobs: jobs || [job()],
    van: van(),
    ...rest,
  };
}

function plan(now: Date, crews: OnsiteCrewInput[], extra: Partial<OnsitePlanInput> = {}) {
  return planOnsiteTick({
    now,
    mode: "dry",
    boardAgeMs: 60 * 1000,
    crews,
    appBase: "https://total-assurance-fleet.totalassurance.workers.dev",
    radiusM: JOB_RADIUS_M,
    ...extra,
  });
}

function kinds(actions: OnsiteAction[], kind: OnsiteAction["kind"]) {
  return actions.filter((a) => a.kind === kind);
}

function fold(rows: OnsiteExisting[], actions: OnsiteAction[], atIso: string) {
  for (const action of actions) {
    if (!("apptId" in action) || !action.apptId || !("leadUserId" in action) || !action.leadUserId) continue;
    let row = rows.find((r) => r.leadUserId === action.leadUserId && r.apptId === action.apptId);
    if (!row && (action.kind === "seen" || action.kind === "lead" || action.kind === "close" || action.kind === "tick")) {
      row = { leadUserId: action.leadUserId, apptId: action.apptId, seenTicks: 0, leadTickCount: 0 };
      rows.push(row);
    }
    if (!row) continue;
    if (action.kind === "seen") {
      if (!row.firstSeenAt) row.firstSeenAt = atIso;
      row.seenTicks = Number(row.seenTicks || 0) + 1;
      if (!row.caseKind) row.caseKind = action.caseKind;
    } else if (action.kind === "lead") {
      row.leadAt = atIso;
      if (!row.caseKind) row.caseKind = action.caseKind;
    } else if (action.kind === "tick") {
      row.leadTickCount = Number(row.leadTickCount || 0) + 1;
    } else if (action.kind === "chris") {
      row.chrisAt = atIso;
    } else if (action.kind === "reset") {
      if (!row.leadAt) {
        row.seenTicks = 0;
        row.firstSeenAt = null;
        row.resolvedBy = "left_site";
      }
    } else if (action.kind === "close") {
      if (!row.closedAt) row.closedAt = atIso;
      row.resolvedBy = action.resolvedBy;
    } else if (action.kind === "resolve") {
      if (!row.resolvedAt) {
        row.resolvedAt = atIso;
        row.resolvedBy = action.resolvedBy;
      }
    }
  }
}

function parked(now: Date, meters: number, speed = 0) {
  const p = northOf(JOB_LAT, JOB_LNG, meters);
  return { 7: fresh(p.lat, p.lng, now, 1, speed) };
}

check("1 off", () => {
  const out = plan(at(DAY, 10, 0), [install({ jobs: [job({ stPhase: "dispatched" })] })], { mode: "off" });
  assert.equal(out.actions.length, 0);
  assert.equal(out.inWindow, false);
});

check("2 window", () => {
  assert.equal(plan(at(SAT, 10, 0), [install()]).inWindow, false);
  assert.equal(plan(at(SAT, 10, 0), [install()]).actions.length, 0);
  assert.equal(plan(at(DAY, 6, 55), [install()]).inWindow, false);
  assert.equal(plan(at(DAY, 7, 0), [install()]).inWindow, true);
  assert.equal(plan(at(DAY, 17, 59), [install()]).inWindow, true);
  assert.equal(plan(at(DAY, 18, 0), [install()]).inWindow, false);
});

check("3 board looks right", () => {
  const open: OnsiteExisting = {
    leadUserId: 17,
    apptId: APPT,
    seenTicks: 2,
    firstSeenAt: at(DAY, 9, 0).toISOString(),
    leadAt: at(DAY, 9, 5).toISOString(),
    caseKind: "dispatched_on_site",
  };
  const now = at(DAY, 10, 0);
  const arrived = plan(now, [install({ jobs: [job({ stPhase: "arrived" })] })], {
    positions: parked(now, 100),
    existing: [open],
  });
  assert.equal(kinds(arrived.actions, "lead").length, 0);
  assert.equal(kinds(arrived.actions, "chris").length, 0);
  assert.ok(arrived.actions.some((a) => a.kind === "resolve" && a.resolvedBy === "board_ok"));

  const working = plan(now, [install({ jobs: [job({ stPhase: "working" })] })], { existing: [open] });
  assert.equal(kinds(working.actions, "lead").length + kinds(working.actions, "chris").length, 0);
  assert.ok(working.actions.some((a) => a.kind === "resolve" && a.resolvedBy === "board_ok"));

  const driving = plan(now, [install({ jobs: [job({ stPhase: "dispatched" })] })], {
    positions: parked(now, 2000, 25),
    existing: [{ ...open, leadAt: null }],
  });
  assert.equal(kinds(driving.actions, "lead").length + kinds(driving.actions, "chris").length, 0);
  assert.ok(driving.actions.some((a) => a.kind === "reset"));

  const idle = plan(now, [install({ jobs: [job({ stPhase: "scheduled" })] })]);
  assert.equal(kinds(idle.actions, "lead").length + kinds(idle.actions, "seen").length + kinds(idle.actions, "chris").length, 0);

  const done = plan(now, [install({ jobs: [job({ stPhase: "finished" })] })], { existing: [open] });
  assert.equal(kinds(done.actions, "lead").length + kinds(done.actions, "chris").length, 0);
  assert.ok(done.actions.some((a) => a.kind === "resolve" && a.resolvedBy === "terminal"));
});

check("4 case a", () => {
  const crew = install();
  const first = plan(at(DAY, 8, 5), [crew], { dayClocked: { 17: "fa_shop_session" } });
  assert.deepEqual(kinds(first.actions, "seen").map((a) => a.kind), ["seen"]);
  assert.equal(kinds(first.actions, "lead").length, 0);
  const rows: OnsiteExisting[] = [];
  fold(rows, first.actions, at(DAY, 8, 5).toISOString());
  const second = plan(at(DAY, 8, 10), [crew], { dayClocked: { 17: "fa_shop_session" }, existing: rows });
  const lead = kinds(second.actions, "lead");
  assert.equal(lead.length, 1);
  assert.equal(lead[0].kind === "lead" && lead[0].body.includes("job #" + JOBN), true);
  assert.equal(lead[0].kind === "lead" && lead[0].body.includes("/clock?appt=" + APPT), true);
  const later = plan(at(DAY, 8, 30), [install({ jobs: [job({ windowStart: `${DAY}T09:00:00` })] })], {
    dayClocked: { 17: "fa_shop_session" },
  });
  assert.equal(kinds(later.actions, "lead").length + kinds(later.actions, "seen").length, 0);
  const partner = plan(at(DAY, 8, 5), [crew], { dayClocked: { 16: "fa_shop_session" } });
  const rows2: OnsiteExisting[] = [];
  fold(rows2, partner.actions, at(DAY, 8, 5).toISOString());
  const partnerLead = plan(at(DAY, 8, 10), [crew], { dayClocked: { 16: "fa_shop_session" }, existing: rows2 });
  const sent = kinds(partnerLead.actions, "lead");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind === "lead" && sent[0].leadUserId, 17);
  assert.equal(sent[0].kind === "lead" && sent[0].bellUserIds.join(","), "17");
});

check("5 case b", () => {
  const crew = install({ jobs: [job({ stPhase: "dispatched" })] });
  const t0 = at(DAY, 10, 0);
  const seen = plan(t0, [crew], { positions: parked(t0, 100) });
  assert.equal(kinds(seen.actions, "seen").length, 1);
  assert.equal(kinds(seen.actions, "lead").length, 0);
  const rows: OnsiteExisting[] = [];
  fold(rows, seen.actions, t0.toISOString());
  const t1 = at(DAY, 10, 5);
  const lead = plan(t1, [crew], { positions: parked(t1, 100), existing: rows });
  const body = kinds(lead.actions, "lead")[0];
  assert.equal(body?.kind, "lead");
  if (body?.kind === "lead") {
    assert.equal(body.body.includes("Dispatched"), true);
    assert.equal(body.body.includes("/clock?appt=" + APPT), true);
  }
  const far = plan(t0, [crew], { positions: parked(t0, 151) });
  assert.equal(kinds(far.actions, "seen").length + kinds(far.actions, "lead").length, 0);
  const near = plan(t0, [crew], { positions: parked(t0, 149) });
  assert.equal(kinds(near.actions, "seen").length, 1);
  const moving = plan(t0, [crew], { positions: parked(t0, 100, 25) });
  assert.equal(kinds(moving.actions, "seen").length + kinds(moving.actions, "lead").length, 0);
  const vz = plan(t0, [install({ jobs: [job({ stPhase: "dispatched" })], van: van({ gpsTracker: "Verizon", vehicleId: 4, unit: "004" }) })], {
    positions: { 4: fresh(JOB_LAT, JOB_LNG, t0) },
  });
  assert.ok(vz.actions.some((a) => a.kind === "skip" && a.reason === "van_not_onestep"));
});

check("6 lead only", () => {
  const crew = install({ jobs: [job({ stPhase: "dispatched" })] });
  const rows: OnsiteExisting[] = [];
  const t0 = at(DAY, 10, 0);
  fold(rows, plan(t0, [crew], { positions: parked(t0, 100) }).actions, t0.toISOString());
  const lead = plan(at(DAY, 10, 5), [crew], { positions: parked(at(DAY, 10, 5), 100), existing: rows });
  for (const action of lead.actions) {
    if ("leadUserId" in action && action.leadUserId) assert.notEqual(action.leadUserId, 16);
    if (action.kind === "lead") assert.deepEqual(action.bellUserIds, [17]);
  }
});

check("7 chris only", () => {
  const crew = install({ jobs: [job({ stPhase: "dispatched" })] });
  const rows: OnsiteExisting[] = [];
  const times = [at(DAY, 10, 0), at(DAY, 10, 5), at(DAY, 10, 10), at(DAY, 10, 15), at(DAY, 10, 20)];
  const dumped: OnsiteAction[][] = [];
  for (const t of times) {
    const out = plan(t, [crew], { positions: parked(t, 100), existing: rows });
    dumped.push(out.actions);
    fold(rows, out.actions, t.toISOString());
  }
  const chris = dumped.flat().filter((a) => a.kind === "chris");
  assert.equal(chris.length, 1);
  assert.equal(chris[0].kind === "chris" && chris[0].phone, CHRIS_PHONE);
  if (chris[0].kind === "chris") {
    assert.equal(chris[0].body.includes("Arin R"), true);
    assert.equal(chris[0].body.includes("job #104682"), true);
    assert.equal(chris[0].body.includes(STREET), true);
    assert.equal(chris[0].body.includes("Dispatched (van 007)"), true);
  }
  const banned = ["+13614467438", "+13614627939"];
  for (const action of dumped.flat()) {
    if (action.kind === "chris") assert.equal(banned.includes(action.phone), false);
  }
  assert.equal(dumped[4].filter((a) => a.kind === "chris").length, 0);
});

check("8 escalate minimum", () => {
  const crew = install({ jobs: [job({ stPhase: "dispatched" })] });
  const leadAt = at(DAY, 10, 5).toISOString();
  const row: OnsiteExisting = {
    leadUserId: 17,
    apptId: APPT,
    caseKind: "dispatched_on_site",
    leadAt,
    leadTickCount: 1,
    seenTicks: 2,
    firstSeenAt: at(DAY, 10, 0).toISOString(),
  };
  const jitter = plan(at(DAY, 10, 13), [crew], { positions: parked(at(DAY, 10, 13), 100), existing: [row] });
  assert.equal(kinds(jitter.actions, "chris").length, 0);
  assert.equal(kinds(jitter.actions, "tick").length, 1);
  const later = plan(at(DAY, 10, 15), [crew], {
    positions: parked(at(DAY, 10, 15), 100),
    existing: [{ ...row, leadTickCount: 2 }],
  });
  assert.equal(kinds(later.actions, "chris").length, 1);
  const fixed = plan(at(DAY, 10, 10), [install({ jobs: [job({ stPhase: "arrived" })] })], { existing: [row] });
  assert.equal(kinds(fixed.actions, "chris").length, 0);
  assert.ok(fixed.actions.some((a) => a.kind === "resolve" && a.resolvedBy === "board_ok"));
});

check("9 chris hours", () => {
  const crew = install({ jobs: [job({ stPhase: "dispatched" })] });
  const due = plan(at(DAY, 17, 5), [crew], {
    positions: parked(at(DAY, 17, 5), 80),
    existing: [{
      leadUserId: 17,
      apptId: APPT,
      caseKind: "dispatched_on_site",
      leadAt: at(DAY, 16, 55).toISOString(),
      leadTickCount: 1,
      seenTicks: 2,
      firstSeenAt: at(DAY, 16, 50).toISOString(),
    }],
  });
  assert.equal(kinds(due.actions, "chris").length, 0);
  assert.ok(due.actions.some((a) => a.kind === "skip" && a.reason === "chris_after_hours"));
  const rows: OnsiteExisting[] = [];
  const seen = plan(at(DAY, 17, 0), [install()], { dayClocked: { 17: "fa_shop_session" } });
  fold(rows, seen.actions, at(DAY, 17, 0).toISOString());
  const lead = plan(at(DAY, 17, 5), [install()], { dayClocked: { 17: "fa_shop_session" }, existing: rows });
  assert.equal(kinds(lead.actions, "lead").length, 1);
});

check("10 shop", () => {
  const nearShop = northOf(SHOP_LAT, SHOP_LNG, 60);
  const now = at(DAY, 10, 0);
  const jobNear = plan(now, [install({
    jobs: [job({ stPhase: "dispatched", jobLat: nearShop.lat, jobLng: nearShop.lng })],
  })], { positions: { 7: fresh(nearShop.lat, nearShop.lng, now) } });
  assert.ok(jobNear.actions.some((a) => a.kind === "skip" && a.reason === "near_shop"));
  const vanAtShop = northOf(SHOP_LAT, SHOP_LNG, 85);
  const atShop = plan(now, [install({ jobs: [job({ stPhase: "dispatched" })] })], {
    positions: { 7: fresh(vanAtShop.lat, vanAtShop.lng, now) },
  });
  assert.ok(atShop.actions.some((a) => a.kind === "skip" && a.reason === "at_shop"));
});

check("11 stale point", () => {
  const now = at(DAY, 10, 0);
  const p = northOf(JOB_LAT, JOB_LNG, 40);
  const young = plan(now, [install({ jobs: [job({ stPhase: "dispatched" })] })], {
    positions: { 7: fresh(p.lat, p.lng, now, 29, 0) },
  });
  assert.equal(kinds(young.actions, "seen").length, 1);
  const old = plan(now, [install({ jobs: [job({ stPhase: "dispatched" })] })], {
    positions: { 7: fresh(p.lat, p.lng, now, 31, 0) },
  });
  assert.ok(old.actions.some((a) => a.kind === "skip" && a.reason === "no_fresh_point"));
});

check("12 mapping", () => {
  const now = at(DAY, 10, 0);
  const kirk = plan(now, [install({
    leadName: "Kirk C",
    leadUserId: 30,
    memberUserIds: [30],
    vanAmbiguous: "two_vans",
    van: null,
    jobs: [job({ stPhase: "dispatched" })],
  })]);
  assert.ok(kirk.actions.some((a) => a.kind === "skip" && a.reason === "ambiguous_van:two_vans"));

  const justinA = install({
    leadName: "David T",
    leadUserId: 40,
    memberUserIds: [40, 41],
    vanAmbiguous: "person_on_two_crews",
    van: null,
    jobs: [job({ apptId: "a", stPhase: "dispatched" })],
  });
  const justinB = install({
    leadName: "Nate T",
    leadUserId: 42,
    memberUserIds: [42, 41],
    vanAmbiguous: "person_on_two_crews",
    van: null,
    jobs: [job({ apptId: "b", jobNumber: "1", stPhase: "dispatched" })],
  });
  const both = plan(now, [justinA, justinB]);
  const amb = both.actions.filter((a) => a.kind === "skip" && String(a.reason).startsWith("ambiguous_van:person_on_two_crews"));
  assert.equal(amb.length, 2);

  const stillA = plan(now, [install({
    leadUserId: 40,
    leadName: "David T",
    memberUserIds: [40, 41],
    vanAmbiguous: "person_on_two_crews",
    van: null,
    jobs: [job({ stPhase: "scheduled" })],
  })], { dayClocked: { 40: "fa_shop_session" } });
  assert.equal(kinds(stillA.actions, "seen").length, 1);
  assert.equal(stillA.actions.some((a) => a.kind === "skip"), false);

  const kai = plan(now, [install({
    leadUserId: 50,
    leadName: "Kai W",
    memberUserIds: [50, 51],
    jobs: [job({ stPhase: "dispatched" })],
    van: van({ vehicleId: 11, unit: "011", mapSource: "name" }),
  })], { positions: { 11: fresh(northOf(JOB_LAT, JOB_LNG, 40).lat, northOf(JOB_LAT, JOB_LNG, 40).lng, now) } });
  assert.equal(kinds(kai.actions, "seen").length, 1);

  const oos = plan(now, [install({
    jobs: [job({ stPhase: "dispatched" })],
    van: van({ vehicleId: 15, unit: "015", status: "out_of_service" }),
  })]);
  assert.ok(oos.actions.some((a) => a.kind === "skip" && a.reason === "van_out_of_service"));
});

check("13 caps", () => {
  const crew = install({ jobs: [job({ stPhase: "dispatched" })] });
  const now = at(DAY, 10, 5);
  const seenRow: OnsiteExisting = {
    leadUserId: 17,
    apptId: APPT,
    seenTicks: 1,
    firstSeenAt: at(DAY, 10, 0).toISOString(),
    caseKind: "dispatched_on_site",
  };
  const cap = plan(now, [crew], { positions: parked(now, 40), existing: [seenRow], leadSmsToday: { 17: 3 } });
  assert.ok(cap.actions.some((a) => a.kind === "skip" && a.reason === "lead_cap"));
  const late = plan(now, [crew], {
    positions: parked(now, 40),
    existing: [seenRow],
    lateNudgedKeys: [`17|${APPT}`],
  });
  assert.ok(late.actions.some((a) => a.kind === "skip" && a.reason === "late_just_sent"));
  const office = plan(at(DAY, 10, 15), [crew], {
    positions: parked(at(DAY, 10, 15), 40),
    lateOfficeAppts: [APPT],
    existing: [{ ...seenRow, leadAt: at(DAY, 10, 5).toISOString(), leadTickCount: 1, seenTicks: 2 }],
  });
  assert.equal(kinds(office.actions, "chris").length, 0);
  assert.ok(office.actions.some((a) => a.kind === "skip" && a.reason === "late_office_done"));
  const chrisCap = plan(at(DAY, 10, 15), [crew], {
    positions: parked(at(DAY, 10, 15), 40),
    chrisToday: 10,
    existing: [{ ...seenRow, leadAt: at(DAY, 10, 5).toISOString(), leadTickCount: 1, seenTicks: 2 }],
  });
  assert.ok(chrisCap.actions.some((a) => a.kind === "skip" && a.reason === "chris_cap"));
  const second = plan(at(DAY, 10, 20), [crew], {
    positions: parked(at(DAY, 10, 20), 40),
    existing: [{ ...seenRow, leadAt: at(DAY, 10, 5).toISOString(), leadTickCount: 3, chrisAt: at(DAY, 10, 15).toISOString() }],
  });
  assert.equal(kinds(second.actions, "lead").length, 0);
});

check("14 board stale", () => {
  const out = plan(at(DAY, 10, 0), [install({ jobs: [job({ stPhase: "dispatched" })] })], {
    boardAgeMs: 7 * 60 * 1000,
    positions: parked(at(DAY, 10, 0), 20),
    dayClocked: { 17: "fa_shop_session" },
  });
  assert.deepEqual(out.actions.map((a) => (a.kind === "skip" ? a.reason : a.kind)), ["board_stale"]);
});

check("15 exclusions", () => {
  const now = at(DAY, 10, 0);
  const adam = plan(now, [install({ leadUserId: 11, leadName: "Adam Bosquez", jobs: [job({ stPhase: "dispatched" })] })], {
    positions: parked(now, 20),
    dayClocked: { 11: "fa_shop_session" },
  });
  assert.equal(adam.actions.length, 0);
  const pto = plan(now, [install({ leadOnPto: true, jobs: [job({ stPhase: "dispatched" })] })], { positions: parked(now, 20) });
  assert.equal(pto.actions.length, 0);
  const inactive = plan(now, [install({ leadActive: false, jobs: [job({ stPhase: "dispatched" })] })], { positions: parked(now, 20) });
  assert.equal(inactive.actions.length, 0);
  const ink = plan(now, [install({ jobs: [job({ ink: "board", stPhase: "dispatched" })] })], {
    positions: parked(now, 20),
    dayClocked: { 17: "fa_shop_session" },
  });
  assert.equal(ink.actions.length, 0);
});

check("16 geocoder off", () => {
  const now = at(DAY, 10, 0);
  const missing = plan(now, [install({ jobs: [job({ stPhase: "dispatched", jobLat: null, jobLng: null })] })], {
    positions: parked(now, 20),
  });
  assert.ok(missing.actions.some((a) => a.kind === "skip" && a.reason === "no_geocode"));
  const still = plan(now, [install({ jobs: [job({ jobLat: null, jobLng: null })] })], { dayClocked: { 17: "fa_shop_session" } });
  assert.equal(kinds(still.actions, "seen").length, 1);
});

check("17 bodies", () => {
  const street = "123456789012345678901234567890";
  const url = "https://total-assurance-fleet.totalassurance.workers.dev/clock?appt=396989582";
  const dayBody = leadBodyDayNoJob("Arin R", JOBN, street, url);
  const vanBody = leadBodyDispatchedOnSite("Arin R", JOBN, street, url);
  for (const body of [dayBody, vanBody]) {
    assert.equal(body, body.replace(/[^\x00-\x7F]/g, ""));
    assert.equal(body.includes("job #104682"), true);
    assert.equal(body.includes("/clock?appt=396989582"), true);
    assert.equal(body.includes(street), true);
  }
  console.log("  lead body lengths day/van", dayBody.length, vanBody.length);
});

check("18 late watch skip", () => {
  const jobs = [{
    userId: 17,
    name: "Arin R",
    apptId: APPT,
    windowStart: `${DAY}T08:00:00`,
    stPhase: "scheduled",
    active: true,
    address: STREET,
    customer: "Ada",
  }];
  const clock = { shopUserIds: [], jobUserIds: [], apptKeys: [], jobKeys: [] };
  const base = {
    now: at(DAY, 9, 0),
    mode: "dry" as const,
    jobs,
    clock,
    existing: [],
    morningSent: true,
    appBase: "https://x",
  };
  const skipped = planClockinTick({ ...base, onsiteKeys: [`17|${APPT}`] });
  assert.equal(skipped.actions.filter((a) => a.kind === "tech").length, 0);
  const plain = planClockinTick(base);
  assert.equal(plain.actions.filter((a) => a.kind === "tech").length, 1);
});

check("19 service excluded", () => {
  const replay = replayOnsiteDay({
    dayYmd: DAY,
    fromMin: 10 * 60,
    toMin: 12 * 60,
    inclusiveEnd: false,
    snapshot: () => ({
      crews: [{
        crew: "service",
        leadUserId: 20,
        leadName: "Kyle D",
        memberUserIds: [20],
        jobs: [
          job({ stPhase: "dispatched", jobLat: JOB_LAT, jobLng: JOB_LNG }),
          job({ apptId: APPT2, jobNumber: JOBN2, street: STREET2, windowStart: `${DAY}T11:00:00`, stPhase: "scheduled" }),
        ],
        van: van({ vehicleId: 4, unit: "004", gpsTracker: "Verizon", mapSource: "name" }),
      }],
      dayClocked: { 20: "fa_shop_session" },
      positions: { 4: { lat: JOB_LAT, lng: JOB_LNG, speedMph: 0, pointAt: at(DAY, 10, 0).toISOString(), provider: "verizon" } },
      boardAgeMs: 1000,
    }),
  });
  assert.equal(replay.hits.length, 0);
  const missing = plan(at(DAY, 10, 0), [{
    leadUserId: 20,
    leadName: "Kyle D",
    memberUserIds: [20],
    jobs: [job({ stPhase: "dispatched" })],
    van: van({ vehicleId: 4, unit: "004", gpsTracker: "Verizon" }),
  }], { positions: parked(at(DAY, 10, 0), 50), dayClocked: { 20: "fa_shop_session" } });
  assert.equal(missing.actions.length, 0);
});

check("20 working all day", () => {
  const replay = replayOnsiteDay({
    dayYmd: DAY,
    fromMin: 8 * 60,
    toMin: 14 * 60,
    inclusiveEnd: true,
    snapshot: ({ nowMs }) => {
      const hour = new Date(nowMs).getTime();
      const lunchStart = at(DAY, 12, 0).getTime();
      const lunchEnd = at(DAY, 12, 40).getTime();
      const away = hour >= lunchStart && hour < lunchEnd;
      const p = northOf(JOB_LAT, JOB_LNG, away ? 1500 : 40);
      return {
        crews: [install({
          jobs: [
            job({ stPhase: "working" }),
            job({
              apptId: APPT2,
              jobNumber: JOBN2,
              street: STREET2,
              windowStart: `${DAY}T13:00:00`,
              stPhase: "scheduled",
              jobLat: JOB2_LAT,
              jobLng: JOB2_LNG,
            }),
          ],
        })],
        dayClocked: { 17: "fa_shop_session" },
        positions: { 7: fresh(p.lat, p.lng, new Date(nowMs), 1, away ? 25 : 0) },
        boardAgeMs: 1000,
      };
    },
  });
  const all = replay.hits.flatMap((h) => h.actions);
  assert.equal(replay.ticks, 73);
  assert.equal(kinds(all, "lead").length, 0);
  assert.equal(kinds(all, "chris").length, 0);
  assert.equal(kinds(all, "seen").length, 0);
  assert.equal(kinds(all, "tick").length, 0);
  const closes = all.filter((a) => a.kind === "close" && a.apptId === APPT);
  assert.equal(closes.length, 1);
  assert.equal(all.some((a) => "apptId" in a && a.apptId === APPT2), false);
});

check("21 second job", () => {
  const replay = replayOnsiteDay({
    dayYmd: DAY,
    fromMin: 8 * 60,
    toMin: 14 * 60,
    inclusiveEnd: true,
    snapshot: ({ nowMs }) => {
      const working = nowMs < at(DAY, 12, 0).getTime();
      const finished = nowMs >= at(DAY, 12, 30).getTime();
      const dispatched = nowMs >= at(DAY, 12, 40).getTime();
      const atSecond = nowMs >= at(DAY, 13, 0).getTime();
      const p = northOf(JOB2_LAT, JOB2_LNG, 60);
      return {
        crews: [install({
          jobs: [
            job({ stPhase: finished ? "finished" : working ? "working" : "scheduled" }),
            job({
              apptId: APPT2,
              jobNumber: JOBN2,
              street: STREET2,
              windowStart: `${DAY}T13:00:00`,
              stPhase: dispatched ? "dispatched" : "scheduled",
              jobLat: JOB2_LAT,
              jobLng: JOB2_LNG,
            }),
          ],
        })],
        positions: atSecond ? { 7: fresh(p.lat, p.lng, new Date(nowMs)) } : {},
        boardAgeMs: 1000,
      };
    },
  });
  const all = replay.hits.flatMap((h) => h.actions);
  const leads = all.filter((a) => a.kind === "lead");
  const chris = all.filter((a) => a.kind === "chris");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].kind === "lead" && leads[0].body.includes("job #104700"), true);
  assert.equal(leads[0].kind === "lead" && leads[0].body.includes("/clock?appt=" + APPT2), true);
  assert.equal(chris.length, 1);
  assert.equal(all.filter((a) => a.kind === "lead" && a.apptId === APPT).length, 0);
});

check("22 one check across cases", () => {
  const rows: OnsiteExisting[] = [];
  const crewA = install();
  const t1 = at(DAY, 8, 5);
  fold(rows, plan(t1, [crewA], { dayClocked: { 17: "fa_shop_session" } }).actions, t1.toISOString());
  const t2 = at(DAY, 8, 10);
  const lead = plan(t2, [crewA], { dayClocked: { 17: "fa_shop_session" }, existing: rows });
  assert.equal(kinds(lead.actions, "lead").length, 1);
  fold(rows, lead.actions, t2.toISOString());
  assert.equal(rows[0].caseKind, "day_no_job");
  const t3 = at(DAY, 8, 15);
  const tick = plan(t3, [install({ jobs: [job({ stPhase: "dispatched" })] })], {
    positions: parked(t3, 40),
    existing: rows,
  });
  assert.equal(kinds(tick.actions, "lead").length, 0);
  fold(rows, tick.actions, t3.toISOString());
  const t4 = at(DAY, 8, 20);
  const chris = plan(t4, [install({ jobs: [job({ stPhase: "dispatched" })] })], {
    positions: parked(t4, 40),
    existing: rows,
  });
  assert.equal(kinds(chris.actions, "lead").length, 0);
  assert.equal(kinds(chris.actions, "chris").length, 1);
  assert.equal(rows[0].caseKind, "day_no_job");
});

check("23 closed stays closed", () => {
  const rows: OnsiteExisting[] = [];
  const t0 = at(DAY, 9, 0);
  const closed = plan(t0, [install({ jobs: [job({ stPhase: "arrived" })] })]);
  assert.ok(closed.actions.some((a) => a.kind === "close"));
  fold(rows, closed.actions, t0.toISOString());
  const t1 = at(DAY, 11, 0);
  const again = plan(t1, [install({ jobs: [job({ stPhase: "dispatched" })] })], {
    positions: parked(t1, 30),
    existing: rows,
  });
  assert.equal(kinds(again.actions, "seen").length, 0);
  assert.equal(kinds(again.actions, "lead").length, 0);
});

check("24 drive-by", () => {
  const rows: OnsiteExisting[] = [];
  const crew = install({ jobs: [job({ stPhase: "dispatched" })] });
  const t0 = at(DAY, 9, 0);
  const seen = plan(t0, [crew], { positions: parked(t0, 40) });
  assert.equal(kinds(seen.actions, "seen").length, 1);
  fold(rows, seen.actions, t0.toISOString());
  const t1 = at(DAY, 9, 5);
  const left = plan(t1, [crew], { positions: parked(t1, 2000, 25), existing: rows });
  assert.ok(left.actions.some((a) => a.kind === "reset"));
  fold(rows, left.actions, t1.toISOString());
  const t2 = at(DAY, 10, 0);
  const back = plan(t2, [crew], { positions: parked(t2, 40), existing: rows });
  assert.equal(kinds(back.actions, "seen").length, 1);
  fold(rows, back.actions, t2.toISOString());
  const t3 = at(DAY, 10, 5);
  const lead = plan(t3, [crew], { positions: parked(t3, 40), existing: rows });
  assert.equal(kinds(lead.actions, "lead").length, 1);
});

check("25 morning and second", () => {
  const rows: OnsiteExisting[] = [];
  const onSite = (t: Date) => parked(t, 40);
  const t0 = at(DAY, 8, 5);
  fold(rows, plan(t0, [install({ jobs: [job({ stPhase: "dispatched" })] })], { positions: onSite(t0) }).actions, t0.toISOString());
  const t1 = at(DAY, 8, 10);
  const lead1 = plan(t1, [install({ jobs: [job({ stPhase: "dispatched" })] })], { positions: onSite(t1), existing: rows });
  assert.equal(kinds(lead1.actions, "lead").length, 1);
  fold(rows, lead1.actions, t1.toISOString());
  const t2 = at(DAY, 8, 12);
  const fixed = plan(t2, [install({ jobs: [job({ stPhase: "arrived" })] })], { existing: rows });
  assert.equal(kinds(fixed.actions, "chris").length, 0);
  assert.ok(fixed.actions.some((a) => a.kind === "resolve" && a.resolvedBy === "board_ok"));
  assert.ok(fixed.actions.some((a) => a.kind === "close"));
  fold(rows, fixed.actions, t2.toISOString());
  const secondVan = (t: Date) => {
    const p = northOf(JOB2_LAT, JOB2_LNG, 40);
    return { 7: fresh(p.lat, p.lng, t) };
  };
  const jobs2 = [
    job({ stPhase: "finished" }),
    job({ apptId: APPT2, jobNumber: JOBN2, street: STREET2, windowStart: `${DAY}T12:30:00`, stPhase: "dispatched", jobLat: JOB2_LAT, jobLng: JOB2_LNG }),
  ];
  const s0 = at(DAY, 12, 40);
  fold(rows, plan(s0, [install({ jobs: jobs2 })], { positions: secondVan(s0), existing: rows }).actions, s0.toISOString());
  const s1 = at(DAY, 12, 45);
  const lead2 = plan(s1, [install({ jobs: jobs2 })], { positions: secondVan(s1), existing: rows });
  const leads = kinds(lead2.actions, "lead");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].kind === "lead" && leads[0].apptId, APPT2);
  assert.equal(kinds(lead2.actions, "chris").length, 0);
});

function stubDb(settings: Record<string, string | null>) {
  const sqls: string[] = [];
  let prepares = 0;
  const db = {
    sqls,
    prepares: () => prepares,
    prepare(sql: string) {
      prepares += 1;
      sqls.push(sql);
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first() {
          if (sql.includes("settings") && settings[String(bound[0])] !== undefined) {
            const value = settings[String(bound[0])];
            return value == null ? null : { value };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM vehicles")) {
            return {
              results: [{
                id: 7,
                unit_number: "007",
                status: "active",
                assigned_driver: "Arin Ramirez",
                assigned_employee_id: 170,
                helper_employee_id: null,
                gps_tracker: "One Step",
              }],
            };
          }
          if (sql.includes("FROM users")) {
            return { results: [{ id: 17, display_name: "Arin R", employee_id: 170, employee_name: "Arin Ramirez", phone: "+13615550000", active: 1 }] };
          }
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

function boardOf(crewName: "install" | "service" | "missing", phase = "dispatched") {
  return {
    date: DAY,
    timezone: "America/Chicago",
    view: "office" as const,
    st_write_enabled: false as const,
    rows: [{
      user_id: crewName === "service" ? 20 : 17,
      display_name: crewName === "service" ? "Kyle D" : "Arin R",
      st_technician_id: 1,
      is_self: false,
      crew: crewName === "missing" ? undefined : crewName,
      jobs: [{
        st_appointment_id: APPT,
        st_job_id: "job-104682",
        job_number: JOBN,
        address: STREET,
        address_full: null,
        customer_name: "Ada",
        customer_phone: null,
        job_type: "Install",
        window_start: `${DAY}T08:00:00`,
        window_end: null,
        status: phase,
        is_done: false,
        is_off: false,
        st_phase: phase,
        ink: "st" as const,
        note: null,
        helpers: [],
      }],
      pto: [],
    }],
  };
}

check("1b run off is one settings read", async () => {
  const db = stubDb({ onsite_nudge_mode: null });
  let fetches = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("fetch");
  }) as typeof fetch;
  try {
    await runOnsiteNudges({} as never, db as never, null, 0, new Map(), at(DAY, 10, 0));
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(db.prepares(), 1);
  assert.equal(fetches, 0);
});

check("16b no census fetch", async () => {
  const db = stubDb({ onsite_nudge_mode: "dry", onsite_geocoder: "off", onsite_nudge_radius_m: "150" });
  let fetches = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response("no");
  }) as typeof fetch;
  try {
    const users = new Map([[17, { id: 17, display_name: "Arin R", employee_id: 170, phone: "+13615550000", active: 1 }]]);
    await runOnsiteNudges({} as never, db as never, boardOf("install") as never, 1000, users as never, at(DAY, 10, 0));
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(fetches, 0);
  assert.equal(db.sqls.some((sql) => sql.includes("INSERT INTO fa_onsite_nudge_log")), true);
  assert.equal(db.sqls.some((sql) => sql.includes("geocoding.geo.census.gov")), false);
});

check("19b service board writes nothing", async () => {
  const db = stubDb({ onsite_nudge_mode: "dry", onsite_geocoder: "off", onsite_nudge_radius_m: "150" });
  let fetches = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response("no");
  }) as typeof fetch;
  try {
    await runOnsiteNudges({} as never, db as never, boardOf("service") as never, 1000, new Map(), at(DAY, 10, 0));
    await runOnsiteNudges({} as never, db as never, boardOf("missing") as never, 1000, new Map(), at(DAY, 10, 0));
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(fetches, 0);
  assert.equal(db.sqls.some((sql) => /^\s*INSERT/i.test(sql)), false);
});

async function main() {
  await Promise.all(pending);
  if (failed) {
    console.log("FAILED " + failed);
    process.exit(1);
  }
  console.log("ALL PASS");
}

void main();
