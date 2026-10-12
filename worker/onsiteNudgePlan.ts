/**
 * Install-crew board-mismatch decisions. No D1, no fetch, no SMS.
 * Ships off. Service crews are dropped before any action.
 */
import {
  arrivedUrl,
  asciiSms,
  chicagoWall,
  chicagoLocalToUtc,
  chicagoYmd,
  inNudgeWindow,
  isAdamBosquez,
  parseAppointmentStart,
  parseUtcLoose,
  type ChicagoWall,
  type NudgeMode,
} from "./clockinNudgePlan";

export const CHRIS_PHONE = "+13617791182";
export const SHOP_LAT = 27.695997;
export const SHOP_LNG = -97.418093;
export const SHOP_RADIUS_M = 250;
export const JOB_RADIUS_M = 150;
export const CONFIRM_GAP_MS = 4 * 60 * 1000;
export const VZ_STOP_MS = 5 * 60 * 1000;
export const ESCALATE_MIN_MS = 10 * 60 * 1000;
export const ESCALATE_MIN_TICKS = 2;
export const MAX_POINT_AGE_MS = 30 * 60 * 1000;
export const MAX_BOARD_AGE_MS = 6 * 60 * 1000;
export const LEAD_DAILY_CAP = 3;
export const CHRIS_DAILY_CAP = 10;
export const ONSITE_CREW = "install";

export type OnsiteCase = "day_no_job" | "dispatched_on_site";

export type OnsiteJob = {
  apptId: string;
  jobId?: string | null;
  jobNumber?: string | null;
  street?: string | null;
  customer?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  stPhase?: string | null;
  isDone?: boolean;
  isOff?: boolean;
  ink?: string | null;
  jobLat?: number | null;
  jobLng?: number | null;
};

export type OnsiteVan = {
  vehicleId: number;
  unit: string;
  mapSource?: string | null;
  gpsTracker?: string | null;
  status?: string | null;
};

export type OnsiteCrewInput = {
  crew?: string | null;
  leadUserId: number;
  leadName: string;
  leadUsername?: string | null;
  memberUserIds?: number[];
  leadActive?: boolean;
  leadOnPto?: boolean;
  jobs: OnsiteJob[];
  van?: OnsiteVan | null;
  /** Reason only, e.g. two_vans or person_on_two_crews. */
  vanAmbiguous?: string | null;
};

export type OnsitePosition = {
  lat: number;
  lng: number;
  speedMph?: number | null;
  pointAt?: string | null;
  provider?: string | null;
  status?: string | null;
  stoppedSince?: string | null;
};

export type OnsiteExisting = {
  leadUserId: number;
  apptId: string;
  caseKind?: string | null;
  firstSeenAt?: string | null;
  seenTicks?: number | null;
  lastSeenAt?: string | null;
  leadAt?: string | null;
  leadTickCount?: number | null;
  chrisAt?: string | null;
  closedAt?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
};

export type OnsiteCloseBy = "board_ok" | "fa_punch" | "terminal";

export type OnsiteAction =
  | { kind: "skip"; reason: string; leadUserId?: number; apptId?: string; jobNumber?: string | null }
  | { kind: "close"; leadUserId: number; apptId: string; resolvedBy: OnsiteCloseBy; jobNumber?: string | null }
  | { kind: "resolve"; leadUserId: number; apptId: string; resolvedBy: "board_ok" | "terminal" | "fa_punch" }
  | { kind: "reset"; leadUserId: number; apptId: string; resolvedBy: "left_site" }
  | {
      kind: "seen";
      leadUserId: number;
      apptId: string;
      caseKind: OnsiteCase;
      distanceM?: number | null;
      jobNumber?: string | null;
      street?: string | null;
    }
  | { kind: "tick"; leadUserId: number; apptId: string; caseKind: OnsiteCase }
  | {
      kind: "lead";
      leadUserId: number;
      apptId: string;
      caseKind: OnsiteCase;
      body: string;
      jobNumber?: string | null;
      street?: string | null;
      bellUserIds: number[];
    }
  | {
      kind: "chris";
      leadUserId: number;
      apptId: string;
      caseKind: OnsiteCase;
      phone: string;
      body: string;
      jobNumber?: string | null;
      unit?: string | null;
    };

export type OnsitePlanResult = { inWindow: boolean; actions: OnsiteAction[] };

export type OnsitePlanInput = {
  now: Date;
  mode: NudgeMode;
  boardAgeMs?: number | null;
  crews: OnsiteCrewInput[];
  dayClocked?: Record<number, string> | Map<number, string> | null;
  faArriveKeys?: string[] | null;
  faDispatchKeys?: string[] | null;
  faJobOpenKeys?: string[] | null;
  positions?: Record<number, OnsitePosition> | Map<number, OnsitePosition> | null;
  existing?: OnsiteExisting[] | null;
  lateNudgedKeys?: string[] | null;
  lateOfficeAppts?: string[] | null;
  leadSmsToday?: Record<number, number> | null;
  chrisToday?: number | null;
  radiusM?: number | null;
  appBase?: string | null;
};

type BState =
  | { kind: "na" }
  | { kind: "skip"; reason: string }
  | { kind: "away" }
  | { kind: "onsite"; distanceM: number; vzConfirmed?: boolean };

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function inChrisWindow(wall: ChicagoWall): boolean {
  return wall.weekday >= 1 && wall.weekday <= 5 && wall.minutes >= 8 * 60 && wall.minutes < 17 * 60;
}

function jobToken(job: OnsiteJob): string {
  const num = asciiSms(job.jobNumber);
  if (num) return num;
  const customer = asciiSms(job.customer);
  const street = asciiSms(job.street).split(",")[0].trim();
  if (customer && street) return `${customer} - ${street}`.slice(0, 72);
  return (customer || street || "your job").slice(0, 72);
}

export function leadBodyDayNoJob(lead: string, jobNumber: string | null, street: string, url: string): string {
  const who = asciiSms(lead) || "Lead";
  const job = asciiSms(jobNumber) || "your job";
  const where = asciiSms(street) || "the job";
  return asciiSms(
    `Total Assurance: ${who}, your crew is clocked in but not on a job in ServiceTitan. Please put your crew on job #${job} (${where}): ${url}`
  );
}

export function leadBodyDispatchedOnSite(lead: string, jobNumber: string | null, street: string, url: string): string {
  const who = asciiSms(lead) || "Lead";
  const job = asciiSms(jobNumber) || "your job";
  const where = asciiSms(street) || "the job";
  return asciiSms(
    `Total Assurance: ${who}, your van is at job #${job} (${where}) but ServiceTitan still shows your crew Dispatched. Please mark your crew Arrived: ${url}`
  );
}

export function chrisBody(
  lead: string,
  jobNumber: string | null,
  street: string,
  caseKind: OnsiteCase,
  unit: string | null
): string {
  const who = asciiSms(lead) || "Lead";
  const job = asciiSms(jobNumber) || "your job";
  const where = asciiSms(street) || "the job";
  const what =
    caseKind === "dispatched_on_site"
      ? `Van at the job but ServiceTitan still says Dispatched (van ${asciiSms(unit) || "unknown"})`
      : "Crew clocked in but not on any job in ServiceTitan";
  return asciiSms(`Still not fixed 10+ min: ${who} - job #${job}, ${where}. ${what}.`);
}

function phaseOf(job: OnsiteJob): string {
  return String(job.stPhase || "").toLowerCase();
}

function isTerminal(job: OnsiteJob): boolean {
  const phase = phaseOf(job);
  return (
    !!job.isDone ||
    !!job.isOff ||
    phase === "finished" ||
    phase === "canceled" ||
    phase === "cancelled" ||
    phase === "off" ||
    phase === "hold" ||
    phase === "nonjob"
  );
}

function lookupFlag(map: Record<number, string> | Map<number, string> | null | undefined, id: number): boolean {
  if (!map) return false;
  if (map instanceof Map) return map.has(id);
  return map[id] != null || (map as Record<string, string>)[String(id)] != null;
}

function lookupPos(
  map: Record<number, OnsitePosition> | Map<number, OnsitePosition> | null | undefined,
  id: number
): OnsitePosition | null {
  if (!map) return null;
  if (map instanceof Map) return map.get(id) || null;
  return map[id] || (map as Record<string, OnsitePosition>)[String(id)] || null;
}

function hasMemberKey(keys: string[] | null | undefined, members: number[], job: OnsiteJob): boolean {
  if (!keys?.length) return false;
  const set = new Set(keys);
  for (const uid of members) {
    if (job.apptId && set.has(`${uid}|${job.apptId}`)) return true;
    if (job.jobId && set.has(`${uid}|${job.jobId}`)) return true;
  }
  return false;
}

function onestepTracker(raw: string | null | undefined): boolean {
  return /one\s*step|onestep|1step/i.test(String(raw || ""));
}

function outOfService(status: string | null | undefined): boolean {
  return String(status || "").toLowerCase().replace(/\s+/g, "_") === "out_of_service";
}

function actionRank(kind: OnsiteAction["kind"]): number {
  if (kind === "close") return 0;
  if (kind === "resolve") return 1;
  if (kind === "reset") return 2;
  if (kind === "seen") return 3;
  if (kind === "tick") return 4;
  if (kind === "lead") return 5;
  if (kind === "chris") return 6;
  return 7;
}

function rowKey(leadUserId: number, apptId: string): string {
  return `${leadUserId}|${apptId}`;
}

export function planOnsiteTick(input: OnsitePlanInput): OnsitePlanResult {
  if (input.mode === "off") return { inWindow: false, actions: [] };
  const wall = chicagoWall(input.now);
  if (!inNudgeWindow(wall)) return { inWindow: false, actions: [] };
  const boardAge = Number(input.boardAgeMs ?? 0);
  if (Number.isFinite(boardAge) && boardAge > MAX_BOARD_AGE_MS) {
    return { inWindow: true, actions: [{ kind: "skip", reason: "board_stale" }] };
  }

  const nowMs = input.now.getTime();
  const radius = Number(input.radiusM) > 0 ? Number(input.radiusM) : JOB_RADIUS_M;
  const appBase = String(input.appBase || "");
  const lateKeys = new Set(input.lateNudgedKeys || []);
  const lateOffice = new Set((input.lateOfficeAppts || []).map((id) => String(id)));
  const existing = new Map<string, OnsiteExisting>();
  for (const row of input.existing || []) {
    existing.set(rowKey(Number(row.leadUserId), String(row.apptId)), row);
  }
  const actions: OnsiteAction[] = [];

  const installCrews = (input.crews || []).filter((crew) => String(crew.crew || "") === ONSITE_CREW);

  for (const crew of installCrews) {
    const leadUserId = Number(crew.leadUserId);
    if (!(leadUserId > 0)) continue;
    if (crew.leadActive === false) continue;
    if (crew.leadOnPto) continue;
    if (isAdamBosquez(leadUserId, crew.leadName, crew.leadUsername)) continue;

    const members = (crew.memberUserIds?.length ? crew.memberUserIds : [leadUserId])
      .map((id) => Number(id))
      .filter((id) => id > 0);
    if (!members.includes(leadUserId)) members.unshift(leadUserId);

    const todayJobs = (crew.jobs || []).filter((job) => {
      const apptId = String(job.apptId || "").trim();
      if (!apptId) return false;
      if (job.ink != null && job.ink !== "" && job.ink !== "st") return false;
      const start = parseAppointmentStart(job.windowStart);
      return start != null && chicagoYmd(start) === wall.ymd;
    });

    const faArrive = (job: OnsiteJob) =>
      hasMemberKey(input.faArriveKeys, members, job) ||
      (input.faArriveKeys == null && hasMemberKey(input.faJobOpenKeys, members, job) && phaseOf(job) === "arrived");
    const faDispatch = (job: OnsiteJob) => hasMemberKey(input.faDispatchKeys, members, job);
    const dispatched = (job: OnsiteJob) => phaseOf(job) === "dispatched" || faDispatch(job);
    const arrivedWorking = (job: OnsiteJob) => phaseOf(job) === "arrived" || phaseOf(job) === "working" || faArrive(job);

    const getRow = (apptId: string) => existing.get(rowKey(leadUserId, apptId));

    let anyArrived = false;
    for (const job of todayJobs) {
      const terminal = isTerminal(job);
      const arrived = arrivedWorking(job);
      if (arrived) anyArrived = true;
      if (!arrived && !terminal) continue;
      const apptId = String(job.apptId);
      const row = getRow(apptId);
      const resolvedBy: OnsiteCloseBy = terminal ? "terminal" : faArrive(job) && phaseOf(job) !== "arrived" && phaseOf(job) !== "working"
        ? "fa_punch"
        : "board_ok";
      if (!row?.closedAt || (terminal && row.resolvedBy !== "terminal")) {
        actions.push({
          kind: "close",
          leadUserId,
          apptId,
          resolvedBy,
          jobNumber: job.jobNumber ?? null,
        });
      }
      if (row && !row.resolvedAt && (row.leadAt || row.firstSeenAt || Number(row.seenTicks) > 0)) {
        actions.push({
          kind: "resolve",
          leadUserId,
          apptId,
          resolvedBy: terminal ? "terminal" : "board_ok",
        });
      }
    }
    if (anyArrived) continue;

    const usable = todayJobs.filter((job) => !isTerminal(job));
    const candidate = (job: OnsiteJob) => {
      const row = getRow(String(job.apptId));
      if (!row) return true;
      if (row.closedAt || row.leadAt) return false;
      return true;
    };

    const caseB = (job: OnsiteJob): BState => {
      if (!dispatched(job)) return { kind: "na" };
      if (crew.vanAmbiguous) {
        const reason = String(crew.vanAmbiguous);
        const tail = reason.startsWith("ambiguous_van:") ? reason.slice("ambiguous_van:".length) : reason;
        return { kind: "skip", reason: `ambiguous_van:${tail}` };
      }
      const van = crew.van;
      if (!van || !(Number(van.vehicleId) > 0)) return { kind: "skip", reason: "no_van" };
      if (outOfService(van.status)) return { kind: "skip", reason: "van_out_of_service" };
      if (!onestepTracker(van.gpsTracker)) return { kind: "skip", reason: "van_not_onestep" };
      if (job.jobLat == null || job.jobLng == null || !Number.isFinite(Number(job.jobLat)) || !Number.isFinite(Number(job.jobLng))) {
        return { kind: "skip", reason: "no_geocode" };
      }
      const jLat = Number(job.jobLat);
      const jLng = Number(job.jobLng);
      if (haversineM(jLat, jLng, SHOP_LAT, SHOP_LNG) <= SHOP_RADIUS_M) {
        return { kind: "skip", reason: "near_shop" };
      }
      const pos = lookupPos(input.positions, Number(van.vehicleId));
      if (!pos || pos.lat == null || pos.lng == null) return { kind: "skip", reason: "no_fresh_point" };
      const pointMs = parseUtcLoose(pos.pointAt);
      const age = pointMs == null ? Number.POSITIVE_INFINITY : nowMs - pointMs;
      const speed = Number(pos.speedMph ?? 0);
      if (age > MAX_POINT_AGE_MS || (speed > 3 && age > 2 * 60 * 1000)) {
        return { kind: "skip", reason: "no_fresh_point" };
      }
      if (haversineM(pos.lat, pos.lng, SHOP_LAT, SHOP_LNG) <= SHOP_RADIUS_M) {
        return { kind: "skip", reason: "at_shop" };
      }
      const dist = haversineM(pos.lat, pos.lng, jLat, jLng);
      const moving = speed > 3;
      let confirmedStop = false;
      if (String(pos.provider || "").toLowerCase() === "verizon") {
        const stopped = String(pos.status || "").toLowerCase() === "stop" || speed <= 3;
        const since = parseUtcLoose(pos.stoppedSince || pos.pointAt);
        confirmedStop = stopped && since != null && nowMs - since >= VZ_STOP_MS;
      }
      if (dist > radius || (moving && !confirmedStop)) return { kind: "away" };
      return { kind: "onsite", distanceM: dist, vzConfirmed: confirmedStop };
    };

    const urlFor = (job: OnsiteJob) => arrivedUrl(appBase, String(job.apptId));
    const labelFor = (job: OnsiteJob) => jobToken(job);

    const emitLead = (job: OnsiteJob, caseKind: OnsiteCase) => {
      const apptId = String(job.apptId);
      const key = rowKey(leadUserId, apptId);
      if (lateKeys.has(key)) {
        actions.push({ kind: "skip", reason: "late_just_sent", leadUserId, apptId, jobNumber: job.jobNumber ?? null });
        return;
      }
      const sent = Number(input.leadSmsToday?.[leadUserId] ?? 0);
      if (sent >= LEAD_DAILY_CAP) {
        actions.push({ kind: "skip", reason: "lead_cap", leadUserId, apptId, jobNumber: job.jobNumber ?? null });
        return;
      }
      const street = asciiSms(job.street) || "the job";
      const jobNumber = job.jobNumber ?? null;
      const body =
        caseKind === "day_no_job"
          ? leadBodyDayNoJob(crew.leadName, labelFor(job), street, urlFor(job))
          : leadBodyDispatchedOnSite(crew.leadName, labelFor(job), street, urlFor(job));
      actions.push({
        kind: "lead",
        leadUserId,
        apptId,
        caseKind,
        body,
        jobNumber,
        street,
        bellUserIds: [leadUserId],
      });
    };

    const emitSeenOrLead = (job: OnsiteJob, caseKind: OnsiteCase, distanceM: number | null, vzConfirmed = false) => {
      const apptId = String(job.apptId);
      const row = getRow(apptId);
      const ticks = Number(row?.seenTicks ?? 0);
      const first = row?.firstSeenAt ? parseUtcLoose(row.firstSeenAt) : null;
      const confirmed =
        (ticks >= 1 && first != null && nowMs - first >= CONFIRM_GAP_MS) ||
        (vzConfirmed && !row?.leadAt);
      if (confirmed && !row?.leadAt && !row?.closedAt) {
        emitLead(job, caseKind);
        return;
      }
      actions.push({
        kind: "seen",
        leadUserId,
        apptId,
        caseKind,
        distanceM,
        jobNumber: job.jobNumber ?? null,
        street: job.street ?? null,
      });
    };

    const maybeChris = (job: OnsiteJob, row: OnsiteExisting, nextTicks: number, caseKind: OnsiteCase) => {
      if (row.chrisAt) return;
      const leadMs = row.leadAt ? parseUtcLoose(row.leadAt) : null;
      if (nextTicks < ESCALATE_MIN_TICKS || leadMs == null || nowMs - leadMs < ESCALATE_MIN_MS) return;
      const apptId = String(job.apptId);
      if (!inChrisWindow(wall)) {
        actions.push({ kind: "skip", reason: "chris_after_hours", leadUserId, apptId, jobNumber: job.jobNumber ?? null });
        return;
      }
      if (lateOffice.has(apptId)) {
        actions.push({ kind: "skip", reason: "late_office_done", leadUserId, apptId, jobNumber: job.jobNumber ?? null });
        return;
      }
      if (Number(input.chrisToday ?? 0) >= CHRIS_DAILY_CAP) {
        actions.push({ kind: "skip", reason: "chris_cap", leadUserId, apptId, jobNumber: job.jobNumber ?? null });
        return;
      }
      const street = asciiSms(job.street) || "the job";
      actions.push({
        kind: "chris",
        leadUserId,
        apptId,
        caseKind,
        phone: CHRIS_PHONE,
        body: chrisBody(crew.leadName, labelFor(job), street, caseKind, crew.van?.unit || null),
        jobNumber: job.jobNumber ?? null,
        unit: crew.van?.unit || null,
      });
    };

    for (const job of usable) {
      const row = getRow(String(job.apptId));
      if (!row?.leadAt || row.closedAt) continue;
      const state = caseB(job);
      const caseKind = (row.caseKind === "day_no_job" || row.caseKind === "dispatched_on_site"
        ? row.caseKind
        : "dispatched_on_site") as OnsiteCase;
      if (state.kind === "onsite") {
        const next = Number(row.leadTickCount ?? 0) + 1;
        actions.push({ kind: "tick", leadUserId, apptId: String(job.apptId), caseKind });
        maybeChris(job, row, next, caseKind);
        continue;
      }
      if (state.kind === "away" || (state.kind === "skip" && dispatched(job))) {
        continue;
      }
      const anyDisp = usable.some((j) => dispatched(j));
      const start = parseAppointmentStart(job.windowStart);
      const clocked = members.some((id) => lookupFlag(input.dayClocked, id));
      if (!anyDisp && clocked && start != null && start <= nowMs) {
        const next = Number(row.leadTickCount ?? 0) + 1;
        const kind: OnsiteCase = caseKind;
        actions.push({ kind: "tick", leadUserId, apptId: String(job.apptId), caseKind: kind });
        maybeChris(job, row, next, kind);
        continue;
      }
      if (!row.resolvedAt) {
        actions.push({ kind: "resolve", leadUserId, apptId: String(job.apptId), resolvedBy: "board_ok" });
      }
      if (!row.closedAt) {
        actions.push({
          kind: "close",
          leadUserId,
          apptId: String(job.apptId),
          resolvedBy: "board_ok",
          jobNumber: job.jobNumber ?? null,
        });
      }
    }

    const anyDispatched = usable.some((job) => dispatched(job));
    if (anyDispatched) {
      const choices = usable.filter((job) => candidate(job) && dispatched(job));
      if (!choices.length) continue;
      const containing = choices.filter((job) => {
        const start = parseAppointmentStart(job.windowStart);
        const end = parseAppointmentStart(job.windowEnd);
        if (start == null || start > nowMs) return false;
        if (end != null && nowMs >= end) return false;
        return true;
      });
      const pool = containing.length ? containing : choices;
      const chosen = [...pool].sort((a, b) => {
        const as = parseAppointmentStart(a.windowStart) ?? 0;
        const bs = parseAppointmentStart(b.windowStart) ?? 0;
        return as - bs;
      })[0];
      for (const other of choices) {
        if (other === chosen) continue;
        actions.push({
          kind: "skip",
          reason: "other_job_chosen",
          leadUserId,
          apptId: String(other.apptId),
          jobNumber: other.jobNumber ?? null,
        });
      }
      const state = caseB(chosen);
      const row = getRow(String(chosen.apptId));
      if (state.kind === "skip") {
        actions.push({
          kind: "skip",
          reason: state.reason,
          leadUserId,
          apptId: String(chosen.apptId),
          jobNumber: chosen.jobNumber ?? null,
        });
      } else if (state.kind === "away") {
        if (row && !row.leadAt && !row.closedAt && (row.firstSeenAt || Number(row.seenTicks) > 0)) {
          actions.push({ kind: "reset", leadUserId, apptId: String(chosen.apptId), resolvedBy: "left_site" });
        }
      } else if (state.kind === "onsite") {
        emitSeenOrLead(chosen, "dispatched_on_site", state.distanceM, !!state.vzConfirmed);
      }
      continue;
    }

    const clocked = members.some((id) => lookupFlag(input.dayClocked, id));
    if (!clocked) continue;
    const started = usable
      .filter((job) => candidate(job))
      .filter((job) => {
        const start = parseAppointmentStart(job.windowStart);
        return start != null && start <= nowMs;
      })
      .sort((a, b) => (parseAppointmentStart(a.windowStart) ?? 0) - (parseAppointmentStart(b.windowStart) ?? 0));
    if (!started.length) continue;
    emitSeenOrLead(started[0], "day_no_job", null);
  }

  actions.sort((a, b) => actionRank(a.kind) - actionRank(b.kind));
  return { inWindow: true, actions };
}

export type OnsiteReplayHit = { atIso: string; atMs: number; actions: OnsiteAction[] };

export function replayOnsiteDay(input: {
  dayYmd: string;
  fromMin?: number;
  toMin?: number;
  stepMin?: number;
  inclusiveEnd?: boolean;
  mode?: NudgeMode;
  appBase?: string;
  radiusM?: number;
  snapshot: (ctx: { now: Date; nowMs: number; existing: OnsiteExisting[] }) => Omit<
    OnsitePlanInput,
    "now" | "mode" | "existing"
  >;
}): { hits: OnsiteReplayHit[]; rows: OnsiteExisting[]; ticks: number } {
  const [y, m, d] = input.dayYmd.split("-").map((n) => Number(n));
  if (!(y > 0 && m > 0 && d > 0)) return { hits: [], rows: [], ticks: 0 };
  const fromMin = input.fromMin ?? 7 * 60;
  const toMin = input.toMin ?? 18 * 60;
  const step = (input.stepMin ?? 5) * 60 * 1000;
  const start = chicagoLocalToUtc(y, m, d, Math.floor(fromMin / 60), fromMin % 60);
  const end = chicagoLocalToUtc(y, m, d, Math.floor(toMin / 60), toMin % 60);
  const rows: OnsiteExisting[] = [];
  const hits: OnsiteReplayHit[] = [];
  let ticks = 0;
  const leadCounts = new Map<number, number>();
  let chrisCount = 0;
  const last = input.inclusiveEnd ? end : end - 1;

  for (let t = start; t <= last; t += step) {
    ticks += 1;
    const now = new Date(t);
    const snap = input.snapshot({ now, nowMs: t, existing: rows });
    const plan = planOnsiteTick({
      ...snap,
      now,
      mode: input.mode || "dry",
      existing: rows.map((row) => ({ ...row })),
      appBase: snap.appBase ?? input.appBase,
      radiusM: snap.radiusM ?? input.radiusM,
      leadSmsToday: snap.leadSmsToday ?? Object.fromEntries(leadCounts),
      chrisToday: snap.chrisToday ?? chrisCount,
    });
    const atIso = now.toISOString();
    for (const action of plan.actions) {
      const apptId = "apptId" in action ? String(action.apptId || "") : "";
      const leadUserId = "leadUserId" in action ? Number(action.leadUserId) : 0;
      const find = () => rows.find((row) => row.leadUserId === leadUserId && row.apptId === apptId);
      if (action.kind === "seen" || action.kind === "lead" || action.kind === "tick" || action.kind === "close") {
        let row = find();
        if (!row && apptId && leadUserId) {
          row = { leadUserId, apptId, seenTicks: 0, leadTickCount: 0 };
          rows.push(row);
        }
        if (row && action.kind === "seen") {
          if (!row.firstSeenAt) row.firstSeenAt = atIso;
          row.seenTicks = Number(row.seenTicks || 0) + 1;
          row.lastSeenAt = atIso;
          if (!row.caseKind) row.caseKind = action.caseKind;
        } else if (row && action.kind === "lead") {
          row.leadAt = atIso;
          if (!row.caseKind) row.caseKind = action.caseKind;
          leadCounts.set(leadUserId, (leadCounts.get(leadUserId) || 0) + 1);
        } else if (row && action.kind === "tick") {
          row.leadTickCount = Number(row.leadTickCount || 0) + 1;
          row.lastSeenAt = atIso;
        } else if (row && action.kind === "close") {
          if (!row.closedAt) row.closedAt = atIso;
          row.resolvedBy = action.resolvedBy;
        }
      } else if (action.kind === "chris") {
        const row = find();
        if (row) row.chrisAt = atIso;
        chrisCount += 1;
      } else if (action.kind === "reset") {
        const row = find();
        if (row && !row.leadAt) {
          row.seenTicks = 0;
          row.firstSeenAt = null;
          row.resolvedBy = "left_site";
        }
      } else if (action.kind === "resolve") {
        const row = find();
        if (row && !row.resolvedAt) {
          row.resolvedAt = atIso;
          row.resolvedBy = action.resolvedBy;
        }
      }
    }
    if (plan.actions.length) hits.push({ atIso, atMs: t, actions: plan.actions });
  }
  return { hits, rows, ticks };
}
