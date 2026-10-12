/**
 * Clock-in nudge decisions. No D1, no Twilio, no ServiceTitan.
 * The scheduled pass and the dry-day replay both call this.
 *
 * Clocked for an appointment when that person already has a Field App
 * En route / Arrived punch or a Shop/Office session today, or ServiceTitan
 * shows Dispatched / Working / Done on that appointment.
 * There is no shift table; the 8:15 list is people with a Today job only.
 */

export type NudgeMode = "off" | "dry" | "live";

export type PlanJob = {
  userId: number;
  name: string;
  username?: string | null;
  apptId: string;
  jobId?: string | null;
  customer?: string | null;
  address?: string | null;
  windowStart?: string | null;
  stPhase?: string | null;
  isDone?: boolean;
  isOff?: boolean;
  onPto?: boolean;
  /** false = inactive user. Omitted = treat as active. */
  active?: boolean;
};

export type ClockSnapshot = {
  /** User ids with a Shop/Office session today. */
  shopUserIds: number[];
  /** User ids with En route (dispatch) or Arrived today. */
  jobUserIds: number[];
  /** `${userId}|${apptId}` for a dispatch/arrive on that appointment. */
  apptKeys: string[];
  /** `${userId}|${jobId}` for a dispatch/arrive on that job. */
  jobKeys: string[];
};

export type ExistingNudge = {
  userId: number;
  apptId: string;
  nudgeAt?: string | null;
  officeAt?: string | null;
  resolvedAt?: string | null;
};

export type TechAction = {
  kind: "tech";
  userId: number;
  name: string;
  apptId: string;
  body: string;
  jobLabel: string;
  /** UTC instant for the appointment start. */
  windowStart: string;
};

export type OfficeAction = {
  kind: "office";
  userId: number;
  /** Every person on this appointment included in the one office text. */
  userIds: number[];
  name: string;
  apptId: string;
  body: string;
};

export type MorningAction = {
  kind: "morning";
  userIds: number[];
  body: string;
};

export type ResolveAction = {
  kind: "resolve";
  userId: number;
  apptId: string;
};

export type PlanAction = TechAction | OfficeAction | MorningAction | ResolveAction;

export type PlanResult = {
  inWindow: boolean;
  actions: PlanAction[];
};

export type ReplayClock = {
  userId: number;
  atMs: number;
  kind: "shop" | "job";
  apptId?: string | null;
  jobId?: string | null;
};

export type ReplayHit = {
  atIso: string;
  atLabel: string;
  action: TechAction | OfficeAction | MorningAction;
};

const TZ = "America/Chicago";
const WEEK: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export const TECH_LATE_MS = 15 * 60 * 1000;
export const OFFICE_LATE_MS = 30 * 60 * 1000;
/** Office text waits until the tech text is already logged, about 15 min earlier. */
export const OFFICE_GAP_MS = 14 * 60 * 1000;
export const DEFAULT_APP_BASE = "https://total-assurance-fleet.totalassurance.workers.dev";

export type ChicagoWall = {
  ymd: string;
  minutes: number;
  weekday: number;
};

export function asciiSms(input: string | null | undefined): string {
  return String(input || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u2022/g, "*")
    .replace(/\u00b7/g, " - ")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function resolveClockinMode(
  envRaw: string | null | undefined,
  settingRaw: string | null | undefined
): NudgeMode {
  const env = String(envRaw || "").trim().toLowerCase();
  const setting = String(settingRaw || "").trim().toLowerCase();
  if (env === "0" || env === "off" || env === "false" || env === "no") return "off";
  if (setting === "dry" || setting === "live") return setting;
  if (setting === "on" || setting === "true" || setting === "1") return "live";
  if (env === "dry") return "dry";
  if (env === "live" || env === "on" || env === "true" || env === "1") return "live";
  return "off";
}

export function shouldCallTwilio(mode: NudgeMode): boolean {
  return mode === "live";
}

export function chicagoWall(now: Date): ChicagoWall {
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
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const minute = Number(parts.minute) || 0;
  const weekday = WEEK[String(parts.weekday || "")] ?? 0;
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + minute,
    weekday,
  };
}

export function chicagoYmd(ms: number): string {
  return chicagoWall(new Date(ms)).ymd;
}

export function inNudgeWindow(wall: ChicagoWall): boolean {
  return wall.weekday >= 1 && wall.weekday <= 5 && wall.minutes >= 7 * 60 && wall.minutes < 18 * 60;
}

export function inMorningWindow(wall: ChicagoWall): boolean {
  return wall.weekday >= 1 && wall.weekday <= 5 && wall.minutes >= 8 * 60 + 15 && wall.minutes < 8 * 60 + 30;
}

function tzOffsetMs(date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

export function chicagoLocalToUtc(y: number, m: number, d: number, hh: number, mi: number): number {
  let utc = Date.UTC(y, m - 1, d, hh, mi, 0);
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(new Date(utc));
    utc = Date.UTC(y, m - 1, d, hh, mi, 0) - off;
  }
  return utc;
}

/** Appointment start. Zoned strings are real instants. Naive strings are Chicago wall time. */
export function parseAppointmentStart(raw: string | null | undefined): number | null {
  const s = String(raw || "").trim();
  if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (!hasZone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    return chicagoLocalToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** D1 datetime('now') and ISO timestamps. Naive values are UTC. */
export function parseUtcLoose(raw: string | null | undefined): number | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const norm = hasZone ? s : s.includes("T") ? `${s}Z` : `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(norm);
  return Number.isFinite(ms) ? ms : null;
}

export function formatChicagoTime(ms: number): string {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
  return asciiSms(s);
}

export function isAdamBosquez(
  userId: number | null | undefined,
  display: string | null | undefined,
  username?: string | null
): boolean {
  if (Number(userId) === 11) return true;
  const n = String(display || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const u = String(username || "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "");
  if (u === "adambosquez") return true;
  if (n === "adam bosquez" || n.startsWith("adam bosquez ")) return true;
  if (n === "adam m bosquez" || n.startsWith("adam m bosquez ")) return true;
  return false;
}

export function arrivedUrl(appBase: string, apptId: string): string {
  const base = (appBase || DEFAULT_APP_BASE).trim().replace(/\/$/, "") || DEFAULT_APP_BASE;
  return `${base}/clock?appt=${encodeURIComponent(apptId)}`;
}

function placeLabel(job: PlanJob): string {
  const customer = asciiSms(job.customer);
  const street = asciiSms(job.address).split(",")[0].trim();
  if (customer && street) return `${customer} - ${street}`.slice(0, 72);
  return (customer || street || "your job").slice(0, 72);
}

function customerLabel(job: PlanJob): string {
  const customer = asciiSms(job.customer);
  if (customer) return customer.slice(0, 48);
  const street = asciiSms(job.address).split(",")[0].trim();
  return (street || "a job").slice(0, 48);
}

function personName(job: PlanJob): string {
  const name = asciiSms(job.name).split("/")[0].trim();
  return (name || "A tech").slice(0, 48);
}

function terminalJob(job: PlanJob): boolean {
  const phase = String(job.stPhase || "").toLowerCase();
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

function stWorking(job: PlanJob): boolean {
  const phase = String(job.stPhase || "").toLowerCase();
  return phase === "dispatched" || phase === "arrived" || phase === "working";
}

function stClocked(job: PlanJob): boolean {
  return stWorking(job) || !!job.isDone || String(job.stPhase || "").toLowerCase() === "finished";
}

export function techNudgeBody(place: string, timeLabel: string, url: string): string {
  return asciiSms(
    `Total Assurance: you're scheduled at ${place} since ${timeLabel}. Tap Arrived: ${url}`
  );
}

export function officeNudgeBody(name: string, customer: string, timeLabel: string): string {
  return asciiSms(`Not clocked in: ${name} - ${customer} ${timeLabel} (nudged 15 min ago).`);
}

export function morningNudgeBody(people: Array<{ name: string; timeLabel: string | null }>): string {
  const bits = people.map((p) => (p.timeLabel ? `${asciiSms(p.name)} (${p.timeLabel})` : asciiSms(p.name)));
  let body = `Not clocked in by 8:15: ${bits.join("; ")}.`;
  if (body.length > 1400) body = `${body.slice(0, 1397)}...`;
  return asciiSms(body);
}

function actionRank(kind: PlanAction["kind"]): number {
  if (kind === "resolve") return 0;
  if (kind === "tech") return 1;
  if (kind === "office") return 2;
  return 3;
}

export function planClockinTick(input: {
  now: Date;
  mode: NudgeMode;
  jobs: PlanJob[];
  clock: ClockSnapshot;
  existing: ExistingNudge[];
  morningSent: boolean;
  appBase: string;
  /** Install-crew arrivals already texted. Skip a second late text for the same lead and appointment. */
  onsiteKeys?: string[];
}): PlanResult {
  if (input.mode === "off") return { inWindow: false, actions: [] };
  const wall = chicagoWall(input.now);
  if (!inNudgeWindow(wall)) return { inWindow: false, actions: [] };

  const nowMs = input.now.getTime();
  const onsiteKeys = new Set(input.onsiteKeys || []);
  const faClocked = new Set<number>([
    ...(input.clock.shopUserIds || []),
    ...(input.clock.jobUserIds || []),
  ]);
  const apptKeys = new Set(input.clock.apptKeys || []);
  const jobKeys = new Set(input.clock.jobKeys || []);
  const existing = new Map<string, ExistingNudge>();
  for (const row of input.existing || []) {
    existing.set(`${row.userId}|${row.apptId}`, row);
  }

  const actions: PlanAction[] = [];
  const seen = new Set<string>();
  const byUser = new Map<number, PlanJob[]>();
  const officeAlready = new Set<string>();
  for (const row of input.existing || []) {
    if (row.officeAt) officeAlready.add(String(row.apptId));
  }
  const officePending = new Map<
    string,
    { apptId: string; names: string[]; userIds: number[]; customer: string; timeLabel: string }
  >();

  for (const job of input.jobs || []) {
    const userId = Number(job.userId);
    const apptId = String(job.apptId || "").trim();
    if (!(userId > 0) || !apptId) continue;
    const key = `${userId}|${apptId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byUser.get(userId) || [];
    list.push(job);
    byUser.set(userId, list);

    if (job.active === false) continue;
    if (isAdamBosquez(userId, job.name, job.username)) continue;
    if (job.onPto) continue;

    const row = existing.get(key);
    const startMs = parseAppointmentStart(job.windowStart);
    const onThisDay = startMs != null && chicagoYmd(startMs) === wall.ymd;
    const personClocked = faClocked.has(userId);
    const thisApptClocked =
      personClocked ||
      apptKeys.has(`${userId}|${apptId}`) ||
      (!!job.jobId && jobKeys.has(`${userId}|${job.jobId}`)) ||
      stClocked(job);

    if (row && !row.resolvedAt && (thisApptClocked || terminalJob(job))) {
      actions.push({ kind: "resolve", userId, apptId });
    }
    if (thisApptClocked || terminalJob(job) || !onThisDay || startMs == null) continue;
    if (row?.resolvedAt) continue;

    const name = personName(job);
    const timeLabel = formatChicagoTime(startMs);
    const techDue = nowMs >= startMs + TECH_LATE_MS;
    const nudgeAtMs = row?.nudgeAt ? parseUtcLoose(row.nudgeAt) : null;
    if (techDue && !row?.nudgeAt) {
      if (onsiteKeys.has(key)) continue;
      actions.push({
        kind: "tech",
        userId,
        name,
        apptId,
        jobLabel: placeLabel(job),
        windowStart: new Date(startMs).toISOString(),
        body: techNudgeBody(placeLabel(job), timeLabel, arrivedUrl(input.appBase, apptId)),
      });
      continue;
    }
    const officeDue =
      !!row?.nudgeAt &&
      !row.officeAt &&
      !officeAlready.has(apptId) &&
      nudgeAtMs != null &&
      nowMs >= startMs + OFFICE_LATE_MS &&
      nowMs >= nudgeAtMs + OFFICE_GAP_MS;
    if (officeDue) {
      const pending = officePending.get(apptId) || {
        apptId,
        names: [],
        userIds: [],
        customer: customerLabel(job),
        timeLabel,
      };
      if (!pending.userIds.includes(userId)) {
        pending.userIds.push(userId);
        pending.names.push(name);
      }
      officePending.set(apptId, pending);
    }
  }

  for (const pending of officePending.values()) {
    const names = [...pending.names].sort((a, b) => a.localeCompare(b)).join(", ");
    actions.push({
      kind: "office",
      userId: pending.userIds[0],
      userIds: pending.userIds,
      name: names,
      apptId: pending.apptId,
      body: officeNudgeBody(names, pending.customer, pending.timeLabel),
    });
  }

  if (!input.morningSent && inMorningWindow(wall)) {
    const people: Array<{ name: string; timeLabel: string | null; userId: number; sort: string }> = [];
    for (const [userId, jobs] of byUser) {
      const sample = jobs[0];
      if (!sample || sample.active === false) continue;
      if (isAdamBosquez(userId, sample.name, sample.username)) continue;
      if (jobs.some((j) => j.onPto)) continue;
      if (faClocked.has(userId)) continue;
      const countable = jobs.filter((j) => {
        const phase = String(j.stPhase || "").toLowerCase();
        if (phase === "canceled" || phase === "cancelled" || phase === "off" || j.isOff) return false;
        if (phase === "hold" || phase === "nonjob") return false;
        return true;
      });
      if (!countable.length) continue;
      if (countable.some((j) => stWorking(j) || j.isDone || String(j.stPhase || "") === "finished")) continue;
      const open = countable.find((j) => !terminalJob(j));
      if (!open) continue;
      let firstMs: number | null = null;
      for (const j of countable) {
        const ms = parseAppointmentStart(j.windowStart);
        if (ms == null) continue;
        if (chicagoYmd(ms) !== wall.ymd) continue;
        if (firstMs == null || ms < firstMs) firstMs = ms;
      }
      people.push({
        userId,
        name: personName(open),
        timeLabel: firstMs != null ? formatChicagoTime(firstMs) : null,
        sort: personName(open).toLowerCase(),
      });
    }
    people.sort((a, b) => a.sort.localeCompare(b.sort));
    if (people.length) {
      actions.push({
        kind: "morning",
        userIds: people.map((p) => p.userId),
        body: morningNudgeBody(people),
      });
    }
  }

  actions.sort((a, b) => actionRank(a.kind) - actionRank(b.kind));
  return { inWindow: true, actions };
}

/** Step a Chicago weekday 7:00-18:00 every 5 min. Sends only; punches are not edited. */
export function replayClockinDay(input: {
  dayYmd: string;
  jobs: PlanJob[];
  clocks?: ReplayClock[];
  appBase?: string;
}): ReplayHit[] {
  const [y, m, d] = input.dayYmd.split("-").map((n) => Number(n));
  if (!(y > 0 && m > 0 && d > 0)) return [];
  const start = chicagoLocalToUtc(y, m, d, 7, 0);
  const end = chicagoLocalToUtc(y, m, d, 18, 0);
  const existing: ExistingNudge[] = [];
  let morningSent = false;
  const hits: ReplayHit[] = [];
  const clocks = input.clocks || [];
  const appBase = input.appBase || DEFAULT_APP_BASE;

  for (let t = start; t < end; t += 5 * 60 * 1000) {
    const shopUserIds: number[] = [];
    const jobUserIds: number[] = [];
    const apptKeys: string[] = [];
    const jobKeys: string[] = [];
    for (const c of clocks) {
      if (!(c.atMs <= t)) continue;
      if (c.kind === "shop") shopUserIds.push(c.userId);
      else {
        jobUserIds.push(c.userId);
        if (c.apptId) apptKeys.push(`${c.userId}|${c.apptId}`);
        if (c.jobId) jobKeys.push(`${c.userId}|${c.jobId}`);
      }
    }
    const plan = planClockinTick({
      now: new Date(t),
      mode: "dry",
      jobs: input.jobs,
      clock: { shopUserIds, jobUserIds, apptKeys, jobKeys },
      existing,
      morningSent,
      appBase,
    });
    const atIso = new Date(t).toISOString();
    const atLabel = `${input.dayYmd} ${formatChicagoTime(t)}`;
    for (const action of plan.actions) {
      if (action.kind === "resolve") {
        const row = existing.find((e) => e.userId === action.userId && e.apptId === action.apptId);
        if (row) row.resolvedAt = atIso;
        else existing.push({ userId: action.userId, apptId: action.apptId, resolvedAt: atIso });
        continue;
      }
      if (action.kind === "tech") {
        const row = existing.find((e) => e.userId === action.userId && e.apptId === action.apptId);
        if (row) row.nudgeAt = atIso;
        else existing.push({ userId: action.userId, apptId: action.apptId, nudgeAt: atIso });
      } else if (action.kind === "office") {
        const ids = action.userIds.length ? action.userIds : [action.userId];
        for (const uid of ids) {
          const row = existing.find((e) => e.userId === uid && e.apptId === action.apptId);
          if (row) row.officeAt = atIso;
        }
      } else if (action.kind === "morning") {
        morningSent = true;
      }
      hits.push({ atIso, atLabel, action });
    }
  }
  return hits;
}

/** Office text for a job left open after day clock-out. Not the 14-minute late-clock gap. */
export const LEFT_OFFICE_GAP_MS = 15 * 60 * 1000;

export type JobClockPunch = {
  id?: number;
  userId: number;
  apptId?: string | null;
  jobId?: string | null;
  step: string;
};

export type FoldedJobSession = {
  userId: number;
  apptId: string;
  jobId: string;
  /** En route or Arrived, and no Finished punch on this appointment. */
  open: boolean;
  finished: boolean;
  /** Highest job_clock_events id applied to this appointment. */
  lastId: number;
};

/**
 * One cycle per appointment. A Finished punch closes it.
 * Later punches do not reopen it and do not change the stored times.
 */
export function foldOpenJobSessions(punches: JobClockPunch[]): FoldedJobSession[] {
  const ordered = [...punches].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  const map = new Map<string, FoldedJobSession>();
  for (const punch of ordered) {
    const userId = Number(punch.userId);
    const appt = String(punch.apptId || "").trim();
    const job = String(punch.jobId || "").trim();
    const keyId = appt || job;
    if (!(userId > 0) || !keyId) continue;
    const step = String(punch.step || "").toLowerCase();
    if (step !== "dispatch" && step !== "arrive" && step !== "complete") continue;
    const key = `${userId}|${keyId}`;
    let row = map.get(key);
    if (!row) {
      row = { userId, apptId: appt || job, jobId: job, open: false, finished: false, lastId: 0 };
      map.set(key, row);
    }
    if (appt) row.apptId = appt;
    if (job) row.jobId = job;
    if (Number(punch.id) > row.lastId) row.lastId = Number(punch.id);
    if (step === "complete") {
      row.open = false;
      row.finished = true;
    } else if (!row.finished) {
      row.open = true;
    }
  }
  return [...map.values()];
}

export function stillClockedInMessage(jobLabel: string | null | undefined): string {
  const job = asciiSms(jobLabel) || "that job";
  return `You're still clocked into ${job}. Tap Done or Pause on that job first.`;
}

export function closeJobUrl(appBase: string, apptId: string): string {
  const base = (appBase || DEFAULT_APP_BASE).trim().replace(/\/$/, "") || DEFAULT_APP_BASE;
  return `${base}/clock?appt=${encodeURIComponent(apptId)}&step=complete`;
}

export function leftOnJobTechBody(job: string, url: string): string {
  return asciiSms(
    `Total Assurance: you're clocked out for the day but still on ${job}. Tap to close it: ${url}`
  );
}

export function leftOnJobOfficeBody(name: string, timeLabel: string, job: string): string {
  return asciiSms(`${name} clocked out at ${timeLabel} but still on ${job}.`);
}

export type DayClosed = {
  userId: number;
  /** When they clocked out for the day. ISO or D1 datetime. */
  clockOutAt: string;
};

export type LeftOpenSession = {
  userId: number;
  name: string;
  username?: string | null;
  apptId: string;
  jobId?: string | null;
  jobLabel: string;
  active?: boolean;
};

export type LeftTechAction = {
  kind: "left_tech";
  userId: number;
  name: string;
  apptId: string;
  body: string;
  jobLabel: string;
  clockOutAt: string;
};

export type LeftOfficeAction = {
  kind: "left_office";
  userId: number;
  userIds: number[];
  name: string;
  apptId: string;
  body: string;
  clockOutAt: string;
};

export type LeftResolveAction = {
  kind: "left_resolve";
  userId: number;
  apptId: string;
};

export type LeftPlanAction = LeftTechAction | LeftOfficeAction | LeftResolveAction;

function latestClockOut(rows: DayClosed[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of rows) {
    const userId = Number(row.userId);
    const at = String(row.clockOutAt || "").trim();
    if (!(userId > 0) || !at || parseUtcLoose(at) == null) continue;
    const prev = out.get(userId);
    if (!prev || (parseUtcLoose(at) || 0) >= (parseUtcLoose(prev) || 0)) out.set(userId, at);
  }
  return out;
}

function leftSessionKey(userId: number, apptId: string): string {
  return `${userId}|${apptId}`;
}

/**
 * Anyone whose day is already clocked out and who still has an open job
 * or a ServiceTitan Working/Dispatched row passed in as an open session.
 * Any hour, any day. Does not edit punches.
 * Adam gets the tech text only.
 */
export function planLeftOnJobTick(input: {
  now: Date;
  mode: NudgeMode;
  closed: DayClosed[];
  openSessions: LeftOpenSession[];
  /** Appointments confirmed Finished. Absence is not proof they closed it. */
  finishedKeys?: string[];
  existing: ExistingNudge[];
  appBase: string;
  allowResolve?: boolean;
}): { actions: LeftPlanAction[] } {
  if (input.mode === "off") return { actions: [] };
  const nowMs = input.now.getTime();
  const closed = latestClockOut(input.closed || []);
  const finished = new Set(input.finishedKeys || []);
  const openKeys = new Set<string>();
  const actions: LeftPlanAction[] = [];
  const seen = new Set<string>();

  const existingByKey = new Map<string, ExistingNudge[]>();
  for (const row of input.existing || []) {
    const key = leftSessionKey(Number(row.userId), String(row.apptId || ""));
    const list = existingByKey.get(key) || [];
    list.push(row);
    existingByKey.set(key, list);
  }
  const openExisting = (key: string): ExistingNudge | null => {
    const list = existingByKey.get(key) || [];
    return list.find((row) => !row.resolvedAt) || null;
  };

  for (const session of input.openSessions || []) {
    const userId = Number(session.userId);
    const apptId = String(session.apptId || "").trim();
    if (!(userId > 0) || !apptId) continue;
    const key = leftSessionKey(userId, apptId);
    if (seen.has(key)) continue;
    seen.add(key);
    openKeys.add(key);
    if (session.jobId) openKeys.add(leftSessionKey(userId, String(session.jobId)));
    const clockOutAt = closed.get(userId);
    if (!clockOutAt) continue;
    if (session.active === false) continue;
    const row = openExisting(key);
    if (row?.resolvedAt) continue;
    const name = (asciiSms(session.name).split("/")[0].trim() || "A tech").slice(0, 48);
    const jobLabel = (asciiSms(session.jobLabel) || "a job").slice(0, 80);
    const nudgeAtMs = row?.nudgeAt ? parseUtcLoose(row.nudgeAt) : null;
    if (!row?.nudgeAt) {
      actions.push({
        kind: "left_tech",
        userId,
        name,
        apptId,
        jobLabel,
        clockOutAt,
        body: leftOnJobTechBody(jobLabel, closeJobUrl(input.appBase, apptId)),
      });
      continue;
    }
    const officeDue =
      !isAdamBosquez(userId, session.name, session.username) &&
      !row.officeAt &&
      nudgeAtMs != null &&
      nowMs >= nudgeAtMs + LEFT_OFFICE_GAP_MS;
    if (officeDue) {
      const outMs = parseUtcLoose(clockOutAt);
      const timeLabel = outMs != null ? formatChicagoTime(outMs) : "";
      if (!timeLabel) continue;
      actions.push({
        kind: "left_office",
        userId,
        userIds: [userId],
        name,
        apptId,
        clockOutAt,
        body: leftOnJobOfficeBody(name, timeLabel, jobLabel),
      });
    }
  }

  if (input.allowResolve) {
    const resolvedSeen = new Set<string>();
    for (const row of input.existing || []) {
      if (row.resolvedAt) continue;
      const key = leftSessionKey(Number(row.userId), String(row.apptId || ""));
      if (resolvedSeen.has(key) || openKeys.has(key) || !finished.has(key)) continue;
      resolvedSeen.add(key);
      actions.push({ kind: "left_resolve", userId: Number(row.userId), apptId: String(row.apptId) });
    }
  }

  const rank = (kind: LeftPlanAction["kind"]): number =>
    kind === "left_resolve" ? 0 : kind === "left_tech" ? 1 : 2;
  actions.sort((a, b) => rank(a.kind) - rank(b.kind));
  return { actions };
}
