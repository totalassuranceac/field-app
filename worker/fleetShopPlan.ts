/**
 * Fleet Shop pure rules. No D1, no fetch, no notifications.
 * Odometer, PM, queue order, step aging, hours.
 */
import { chicagoLocalToUtc } from "./clockinNudgePlan";

export const ALLOWED_ENTRY_TYPES = ["work_order", "shop"] as const;

export function entryTypeAllowed(entryType: string): boolean {
  return (ALLOWED_ENTRY_TYPES as readonly string[]).includes(entryType);
}

export type OdoSource = "fuel" | "inspection" | "shop" | "shop_confirm" | "wo_in" | "wo_out" | string;

export type OdoReading = {
  id: number;
  source: OdoSource;
  date: string;
  odometer: number | null;
  ocr_needs_review?: number | null;
  ocr_reviewed_at?: string | null;
};

export type OdoOutlier = { id: number; source: string; date: string; odometer: number };

export type OdoResult = {
  odometer: number | null;
  as_of: string | null;
  source: string | null;
  source_id: number | null;
  confidence: "none" | "thin" | "stale" | "check" | "good";
  outliers: OdoOutlier[];
  miles_per_day: number | null;
};

export type OdoOpts = {
  maxPerDay?: number;
  slack?: number;
  todayCt?: string;
  windowDays?: number;
};

const SOURCE_RANK: Record<string, number> = {
  fuel: 0,
  inspection: 1,
  shop: 2,
  shop_confirm: 2,
  wo_in: 2,
  wo_out: 2,
};

function sourceRank(source: string): number {
  return SOURCE_RANK[source] ?? 9;
}

function ymdUtc(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((ymdUtc(b) - ymdUtc(a)) / 86400000);
}

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(ymdUtc(ymd) + days * 86400000).toISOString().slice(0, 10);
}

function keepReading(r: OdoReading): boolean {
  const odo = Number(r.odometer);
  if (!Number.isFinite(odo) || odo <= 0) return false;
  if (Number(r.ocr_needs_review) === 1 && !r.ocr_reviewed_at) return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(r.date || ""))) return false;
  return true;
}

function plausiblePair(
  a: { date: string; odometer: number },
  b: { date: string; odometer: number },
  maxPerDay: number,
  slack: number
): boolean {
  const delta = b.odometer - a.odometer;
  const days = Math.max(1, daysBetween(a.date, b.date));
  return delta >= -10 && delta <= maxPerDay * days + slack;
}

export function reliableOdometer(readings: OdoReading[], opts: OdoOpts = {}): OdoResult {
  const maxPerDay = opts.maxPerDay ?? 400;
  const slack = opts.slack ?? 300;
  const today = (opts.todayCt || "2026-10-01").slice(0, 10);
  const windowDays = opts.windowDays ?? 90;
  const empty: OdoResult = {
    odometer: null,
    as_of: null,
    source: null,
    source_id: null,
    confidence: "none",
    outliers: [],
    miles_per_day: null,
  };
  let rows = readings.filter(keepReading).map((r) => ({
    id: Number(r.id),
    source: String(r.source || "fuel"),
    date: String(r.date).slice(0, 10),
    odometer: Number(r.odometer),
  }));
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const sr = sourceRank(a.source) - sourceRank(b.source);
    if (sr) return sr;
    return a.id - b.id;
  });
  const confirms = rows.filter((r) => r.source === "shop_confirm");
  let anchorIdx = -1;
  if (confirms.length) {
    const anchor = confirms[confirms.length - 1];
    rows = rows.filter((r) => r.date >= anchor.date);
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const sr = sourceRank(a.source) - sourceRank(b.source);
      if (sr) return sr;
      return a.id - b.id;
    });
    anchorIdx = rows.findIndex((r) => r.id === anchor.id && r.source === anchor.source);
  }
  const n = rows.length;
  if (!n) return empty;

  const best = new Array<number>(n).fill(0);
  const prev = new Array<number>(n).fill(-1);
  if (anchorIdx >= 0) {
    best[anchorIdx] = 1;
  } else {
    best.fill(1);
  }
  for (let i = 0; i < n; i++) {
    for (let j = (anchorIdx >= 0 ? anchorIdx : 0); j < i; j++) {
      if (best[j] <= 0) continue;
      if (!plausiblePair(rows[j], rows[i], maxPerDay, slack)) continue;
      const len = best[j] + 1;
      if (len > best[i] || (len === best[i] && j >= prev[i])) {
        best[i] = len;
        prev[i] = j;
      }
    }
  }

  const need = Math.min(3, n);
  let chosen = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (best[i] >= need) {
      chosen = i;
      break;
    }
  }
  if (chosen < 0) {
    let maxB = -1;
    for (let i = 0; i < n; i++) {
      if (best[i] > maxB) {
        maxB = best[i];
        chosen = i;
      } else if (best[i] === maxB) {
        chosen = i;
      }
    }
  }
  if (chosen < 0 || best[chosen] <= 0) return empty;

  const on = new Set<number>();
  for (let i = chosen; i >= 0; i = prev[i]) {
    on.add(i);
    if (prev[i] < 0) break;
  }
  const picked = rows[chosen];
  const outliers: OdoOutlier[] = [];
  rows.forEach((r, i) => {
    if (!on.has(i)) outliers.push({ id: r.id, source: r.source, date: r.date, odometer: r.odometer });
  });
  const chain = rows.filter((_, i) => on.has(i));
  const recent = chain.filter((p) => daysBetween(p.date, today) <= windowDays && daysBetween(p.date, today) >= 0);
  let miles: number | null = null;
  if (recent.length >= 2) {
    const span = daysBetween(recent[0].date, recent[recent.length - 1].date);
    if (span > 0) miles = (recent[recent.length - 1].odometer - recent[0].odometer) / span;
  }
  let confidence: OdoResult["confidence"] = "good";
  if (n < 3) confidence = "thin";
  else if (daysBetween(picked.date, today) > 30) confidence = "stale";
  else {
    const last3 = rows.slice(Math.max(0, n - 3));
    const last3Out = last3.some((r) => outliers.some((o) => o.id === r.id && o.source === r.source));
    if (chosen !== n - 1 || last3Out) confidence = "check";
  }
  return {
    odometer: picked.odometer,
    as_of: picked.date,
    source: picked.source,
    source_id: picked.id,
    confidence,
    outliers,
    miles_per_day: miles,
  };
}

/** A service-record oil odometer may seed last-done only when it sits on the reliable chain. */
export function oilSeedAccepted(
  service: { date: string; odometer: number },
  chain: { date: string; odometer: number }[],
  opts: { maxPerDay?: number; slack?: number } = {}
): boolean {
  const odo = Number(service.odometer);
  if (!Number.isFinite(odo) || odo <= 0) return false;
  const maxPerDay = opts.maxPerDay ?? 400;
  const slack = opts.slack ?? 300;
  const pts = chain
    .filter((p) => Number.isFinite(p.odometer) && p.odometer > 0 && /^\d{4}-\d{2}-\d{2}/.test(p.date))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!pts.length) return false;
  const earlier = pts.filter((p) => p.date <= service.date);
  const later = pts.filter((p) => p.date >= service.date);
  const pred = earlier.length ? earlier[earlier.length - 1] : null;
  const succ = later.length ? later[0] : null;
  if (pred && pred.date === service.date && succ && succ.date === service.date) {
    return plausiblePair(pred, { date: service.date, odometer: odo }, maxPerDay, slack);
  }
  if (pred && !plausiblePair(pred, { date: service.date, odometer: odo }, maxPerDay, slack)) return false;
  if (succ && !plausiblePair({ date: service.date, odometer: odo }, succ, maxPerDay, slack)) return false;
  return Boolean(pred || succ);
}

export type PmType = {
  code: string;
  label: string;
  interval_miles: number | null;
  interval_days: number | null;
  soon_miles: number;
  soon_days: number;
  date_source: "interval" | "registration_expires" | "inspection_expires";
  active?: number;
};

export type PmState = {
  interval_miles?: number | null;
  interval_days?: number | null;
  last_done_date?: string | null;
  last_done_odometer?: number | null;
  active?: number;
} | null;

export type PmVehicle = {
  status?: string | null;
  inspection_expires?: string | null;
  registration_expires?: string | null;
};

export type PmOdo = { odometer: number | null; miles_per_day: number | null };

export type PmStatusResult = {
  status: "ok" | "due_soon" | "overdue" | "unknown" | "skipped";
  reason: string;
  due_odometer: number | null;
  due_date: string | null;
};

function fmtMi(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function pmStatus(
  type: PmType,
  vehicle: PmVehicle,
  state: PmState,
  odo: PmOdo,
  todayCt: string
): PmStatusResult {
  const today = todayCt.slice(0, 10);
  if (Number(type.active) === 0 || Number(state?.active) === 0 || vehicle.status === "retired") {
    return { status: "skipped", reason: "Inactive", due_odometer: null, due_date: null };
  }
  const intervalMiles = state?.interval_miles != null ? state.interval_miles : type.interval_miles;
  const intervalDays = state?.interval_days != null ? state.interval_days : type.interval_days;
  let dueOdo: number | null = null;
  let dueDate: string | null = null;
  if (type.date_source === "registration_expires") {
    dueDate = vehicle.registration_expires ? String(vehicle.registration_expires).slice(0, 10) : null;
  } else if (type.date_source === "inspection_expires") {
    dueDate = vehicle.inspection_expires ? String(vehicle.inspection_expires).slice(0, 10) : null;
  } else {
    if (state?.last_done_odometer != null && intervalMiles) {
      dueOdo = Number(state.last_done_odometer) + Number(intervalMiles);
    }
    if (state?.last_done_date && intervalDays) {
      dueDate = addDaysYmd(String(state.last_done_date).slice(0, 10), Number(intervalDays));
    }
    if (state?.last_done_odometer == null && !state?.last_done_date) {
      return { status: "unknown", reason: "Set last done", due_odometer: null, due_date: null };
    }
  }
  if (type.date_source !== "interval" && !dueDate) {
    return { status: "unknown", reason: "Set last done", due_odometer: null, due_date: null };
  }
  if (type.date_source === "interval" && dueOdo == null && dueDate == null) {
    return { status: "unknown", reason: "Set last done", due_odometer: null, due_date: null };
  }

  const miles = odo.odometer != null ? Number(odo.odometer) : null;
  const since =
    miles != null && state?.last_done_odometer != null ? miles - Number(state.last_done_odometer) : null;
  let overdue = false;
  if (dueOdo != null && miles != null && miles >= dueOdo) overdue = true;
  if (dueDate && today >= dueDate) overdue = true;
  if (overdue) {
    const reason =
      since != null && dueOdo != null
        ? `${type.label}: ${fmtMi(since)} mi since last (due at ${fmtMi(dueOdo)})`
        : `${type.label}: overdue`;
    return { status: "overdue", reason, due_odometer: dueOdo, due_date: dueDate };
  }
  let soon = false;
  if (dueOdo != null && miles != null && dueOdo - miles <= type.soon_miles && dueOdo - miles > 0) soon = true;
  if (dueDate && today < dueDate && daysBetween(today, dueDate) <= type.soon_days) soon = true;
  if (
    !soon &&
    dueOdo != null &&
    miles != null &&
    odo.miles_per_day != null &&
    odo.miles_per_day > 0 &&
    dueOdo > miles
  ) {
    const proj = (dueOdo - miles) / odo.miles_per_day;
    if (proj <= type.soon_days) soon = true;
  }
  const reason =
    since != null && dueOdo != null
      ? `${type.label}: ${fmtMi(since)} mi since last (due at ${fmtMi(dueOdo)})`
      : dueDate
        ? `${type.label}: due ${dueDate}`
        : type.label;
  return { status: soon ? "due_soon" : "ok", reason, due_odometer: dueOdo, due_date: dueDate };
}

export function pmToCreate<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.status === "overdue" || r.status === "due_soon");
}

export type QueueItem = {
  is_emergency?: boolean;
  severity?: string | null;
  truck_down?: boolean;
  pm_status?: "overdue" | "due_soon" | null;
  in_progress?: boolean;
  created_at: string;
};

function queueRank(item: QueueItem): number {
  if (item.is_emergency || item.severity === "critical") return 0;
  if (item.truck_down) return 1;
  if (item.pm_status === "overdue") return 2;
  if (item.severity === "high") return 3;
  if (item.in_progress) return 4;
  if (item.severity === "medium") return 5;
  if (item.pm_status === "due_soon") return 6;
  return 7;
}

export function queueSort(a: QueueItem, b: QueueItem): number {
  const d = queueRank(a) - queueRank(b);
  if (d) return d;
  if (a.created_at < b.created_at) return -1;
  if (a.created_at > b.created_at) return 1;
  return 0;
}

export type StageName =
  | "reported"
  | "scheduled"
  | "part_ordered"
  | "part_received"
  | "started"
  | "done"
  | "cancelled";

export type StageStep = {
  step: StageName;
  at: string | null;
  known: boolean;
  reached: boolean;
  na: boolean;
  source: string;
  actor_user_id: number | null;
  note: string | null;
};

export type StageOrder = {
  status: string;
  ordered_at?: string | null;
  received_at?: string | null;
};

export type StageOrderEvent = { to_status: string; created_at: string };

export type StageInput = {
  issue: {
    id: number;
    status: string;
    created_at: string;
    scheduled_date?: string | null;
    completed_at?: string | null;
  };
  stage_events?: { stage: string; at: string; actor_user_id?: number | null; source?: string }[];
  audits?: { created_at: string; user_id?: number | null; after_status?: string | null }[];
  orders?: StageOrder[];
  order_events?: StageOrderEvent[];
  segments?: { started_at: string }[];
  /** Present only so callers can prove it is ignored. */
  downtime_started_at?: string | null;
};

function firstEvent(events: StageInput["stage_events"], stage: string) {
  const rows = (events || []).filter((e) => e.stage === stage).slice().sort((a, b) => (a.at < b.at ? -1 : 1));
  return rows[0] || null;
}

export function stageTimeline(input: StageInput): StageStep[] {
  const issue = input.issue;
  const events = input.stage_events || [];
  const audits = (input.audits || []).slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const orders = (input.orders || []).filter((o) => o.status !== "cancelled");
  const steps: StageStep[] = [];

  steps.push({
    step: "reported",
    at: issue.created_at,
    known: true,
    reached: true,
    na: false,
    source: "issue",
    actor_user_id: null,
    note: null,
  });

  const schedEv = firstEvent(events, "scheduled");
  const schedAudit = audits.find((a) => a.after_status === "scheduled");
  if (schedEv) {
    steps.push({
      step: "scheduled",
      at: schedEv.at,
      known: true,
      reached: true,
      na: false,
      source: schedEv.source || "stage",
      actor_user_id: schedEv.actor_user_id ?? null,
      note: null,
    });
  } else if (schedAudit) {
    steps.push({
      step: "scheduled",
      at: schedAudit.created_at,
      known: true,
      reached: true,
      na: false,
      source: "audit",
      actor_user_id: schedAudit.user_id ?? null,
      note: null,
    });
  } else if (issue.scheduled_date) {
    steps.push({
      step: "scheduled",
      at: null,
      known: false,
      reached: true,
      na: false,
      source: "scheduled_date",
      actor_user_id: null,
      note: `booked for ${String(issue.scheduled_date).slice(0, 10)}`,
    });
  } else {
    steps.push({
      step: "scheduled",
      at: null,
      known: false,
      reached: false,
      na: false,
      source: "none",
      actor_user_id: null,
      note: null,
    });
  }

  if (!orders.length) {
    steps.push({
      step: "part_ordered",
      at: null,
      known: false,
      reached: false,
      na: true,
      source: "none",
      actor_user_id: null,
      note: null,
    });
    steps.push({
      step: "part_received",
      at: null,
      known: false,
      reached: false,
      na: true,
      source: "none",
      actor_user_id: null,
      note: null,
    });
  } else {
    const orderedTimes = orders.map((o) => o.ordered_at).filter((t): t is string => Boolean(t));
    const orderedEvents = (input.order_events || []).filter((e) => e.to_status === "ordered").map((e) => e.created_at);
    const orderedAt = orderedTimes.length
      ? orderedTimes.slice().sort()[0]
      : orderedEvents.length
        ? orderedEvents.slice().sort()[0]
        : null;
    const orderedReached =
      Boolean(orderedAt) ||
      orders.some((o) => o.status === "ordered" || o.status === "arriving" || o.status === "received");
    steps.push({
      step: "part_ordered",
      at: orderedAt,
      known: Boolean(orderedAt),
      reached: orderedReached,
      na: false,
      source: orderedTimes.length ? "order" : orderedEvents.length ? "order_event" : "status",
      actor_user_id: null,
      note: orderedReached && !orderedAt ? "time unknown" : null,
    });
    const allReceived = orders.every((o) => o.status === "received");
    const receivedTimes = orders.map((o) => o.received_at).filter((t): t is string => Boolean(t));
    const receivedEvents = (input.order_events || []).filter((e) => e.to_status === "received").map((e) => e.created_at);
    let receivedAt: string | null = null;
    if (allReceived) {
      if (receivedTimes.length) receivedAt = receivedTimes.slice().sort().slice(-1)[0];
      else if (receivedEvents.length) receivedAt = receivedEvents.slice().sort().slice(-1)[0];
    }
    steps.push({
      step: "part_received",
      at: receivedAt,
      known: Boolean(receivedAt),
      reached: allReceived,
      na: false,
      source: receivedTimes.length ? "order" : "status",
      actor_user_id: null,
      note: allReceived && !receivedAt ? "time unknown" : null,
    });
  }

  const segStart = (input.segments || []).map((s) => s.started_at).filter(Boolean).sort()[0] || null;
  const startEv = firstEvent(events, "started");
  const startAudit = audits.find((a) => a.after_status === "in_progress");
  const startedByStatus = issue.status === "in_progress" || issue.status === "completed";
  if (segStart) {
    steps.push({
      step: "started",
      at: segStart,
      known: true,
      reached: true,
      na: false,
      source: "segment",
      actor_user_id: null,
      note: null,
    });
  } else if (startEv) {
    steps.push({
      step: "started",
      at: startEv.at,
      known: true,
      reached: true,
      na: false,
      source: startEv.source || "stage",
      actor_user_id: startEv.actor_user_id ?? null,
      note: null,
    });
  } else if (startAudit) {
    steps.push({
      step: "started",
      at: startAudit.created_at,
      known: true,
      reached: true,
      na: false,
      source: "audit",
      actor_user_id: startAudit.user_id ?? null,
      note: null,
    });
  } else if (startedByStatus) {
    steps.push({
      step: "started",
      at: null,
      known: false,
      reached: true,
      na: false,
      source: "status",
      actor_user_id: null,
      note: "time unknown",
    });
  } else {
    steps.push({
      step: "started",
      at: null,
      known: false,
      reached: false,
      na: false,
      source: "none",
      actor_user_id: null,
      note: null,
    });
  }

  const doneEv = firstEvent(events, "done");
  if (issue.status === "completed" && issue.completed_at) {
    steps.push({
      step: "done",
      at: issue.completed_at,
      known: true,
      reached: true,
      na: false,
      source: "issue",
      actor_user_id: null,
      note: null,
    });
  } else if (issue.status === "completed") {
    steps.push({
      step: "done",
      at: doneEv?.at || null,
      known: Boolean(doneEv?.at),
      reached: true,
      na: false,
      source: doneEv ? "stage" : "status",
      actor_user_id: doneEv?.actor_user_id ?? null,
      note: doneEv?.at ? null : "time unknown",
    });
  } else if (doneEv) {
    steps.push({
      step: "done",
      at: doneEv.at,
      known: true,
      reached: true,
      na: false,
      source: "stage",
      actor_user_id: doneEv.actor_user_id ?? null,
      note: null,
    });
  } else {
    steps.push({
      step: "done",
      at: null,
      known: false,
      reached: false,
      na: false,
      source: "none",
      actor_user_id: null,
      note: null,
    });
  }

  if (issue.status === "cancelled") {
    const cancelEv = firstEvent(events, "cancelled");
    const cancelAudit = audits.find((a) => a.after_status === "cancelled");
    steps.push({
      step: "cancelled",
      at: cancelEv?.at || cancelAudit?.created_at || null,
      known: Boolean(cancelEv?.at || cancelAudit?.created_at),
      reached: true,
      na: false,
      source: cancelEv ? "stage" : cancelAudit ? "audit" : "status",
      actor_user_id: cancelEv?.actor_user_id ?? cancelAudit?.user_id ?? null,
      note: null,
    });
  }
  return steps;
}

export function currentStage(
  timeline: StageStep[],
  status: string,
  timer: "running" | "paused" | "none" = "none"
): { stage: string; sub: string | null } {
  if (status === "cancelled" || timeline.some((s) => s.step === "cancelled" && s.reached)) {
    return { stage: "cancelled", sub: null };
  }
  if (status === "completed" || timeline.some((s) => s.step === "done" && s.reached)) {
    return { stage: "done", sub: null };
  }
  const ordered = timeline.find((s) => s.step === "part_ordered");
  const received = timeline.find((s) => s.step === "part_received");
  if (ordered && ordered.reached && !ordered.na && received && !received.reached) {
    return { stage: "waiting_parts", sub: null };
  }
  const started = timeline.find((s) => s.step === "started");
  if (started?.reached || status === "in_progress") {
    return { stage: "in_progress", sub: timer === "running" ? "Running" : "Paused" };
  }
  const sched = timeline.find((s) => s.step === "scheduled");
  if (sched?.reached || status === "scheduled") return { stage: "scheduled", sub: null };
  return { stage: "reported", sub: null };
}

function parseMs(raw: string): number {
  const s = raw.includes("T") ? raw : raw.replace(" ", "T");
  const z = /Z|[+-]\d{2}:?\d{2}$/i.test(s) ? s : `${s}Z`;
  return Date.parse(z);
}

export function stageAge(
  timeline: StageStep[],
  current: string,
  nowMs: number
): { days: number; age_basis: string | null; open_days: number | null } {
  const reported = timeline.find((s) => s.step === "reported");
  const openDays =
    current === "done" || current === "cancelled" || !reported?.at
      ? null
      : Math.max(0, Math.floor((nowMs - parseMs(reported.at)) / 86400000));
  const key =
    current === "waiting_parts"
      ? "part_ordered"
      : current === "in_progress"
        ? "started"
        : current === "scheduled"
          ? "scheduled"
          : current === "reported"
            ? "reported"
            : current === "done"
              ? "done"
              : "reported";
  const idx = timeline.findIndex((s) => s.step === key);
  const own = idx >= 0 ? timeline[idx] : null;
  if (own?.known && own.at) {
    return {
      days: Math.max(0, Math.floor((nowMs - parseMs(own.at)) / 86400000)),
      age_basis: null,
      open_days: openDays,
    };
  }
  let fallback: StageStep | null = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (timeline[i].known && timeline[i].at) {
      fallback = timeline[i];
      break;
    }
  }
  if (!fallback?.at) return { days: 0, age_basis: null, open_days: openDays };
  return {
    days: Math.max(0, Math.floor((nowMs - parseMs(fallback.at)) / 86400000)),
    age_basis: `since ${fallback.step}`,
    open_days: openDays,
  };
}

export const DEFAULT_AGE: Record<string, [number, number]> = {
  reported: [2, 5],
  scheduled: [3, 7],
  waiting_parts: [3, 7],
  in_progress: [2, 5],
  open_total: [7, 14],
  step_report_scheduled: [2, 5],
  step_part_ordered_received: [3, 7],
  step_report_done: [7, 14],
};

export function validateAgeDays(input: unknown): { ok: true; value: Record<string, [number, number]> } | { ok: false; error: string } {
  const value: Record<string, [number, number]> = { ...DEFAULT_AGE };
  if (input == null || input === "") return { ok: true, value };
  let obj: unknown = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      return { ok: false, error: "Age thresholds must be JSON" };
    }
  }
  if (!obj || typeof obj !== "object") return { ok: false, error: "Age thresholds must be an object" };
  for (const [key, raw] of Object.entries(obj as Record<string, unknown>)) {
    if (!Array.isArray(raw) || raw.length !== 2) return { ok: false, error: `Bad threshold ${key}` };
    const amber = Number(raw[0]);
    const red = Number(raw[1]);
    if (!Number.isInteger(amber) || !Number.isInteger(red) || amber < 1 || red > 365 || amber >= red) {
      return { ok: false, error: `Bad threshold ${key}` };
    }
    value[key] = [amber, red];
  }
  for (const key of Object.keys(DEFAULT_AGE)) {
    if (!value[key]) value[key] = DEFAULT_AGE[key];
  }
  return { ok: true, value };
}

function worseTone(a: "" | "overdue" | "urgent", b: "" | "overdue" | "urgent"): "" | "overdue" | "urgent" {
  if (a === "urgent" || b === "urgent") return "urgent";
  if (a === "overdue" || b === "overdue") return "overdue";
  return "";
}

function toneOf(days: number, pair: [number, number] | undefined): "" | "overdue" | "urgent" {
  if (!pair) return "";
  if (days >= pair[1]) return "urgent";
  if (days >= pair[0]) return "overdue";
  return "";
}

export function ageTone(
  current: string,
  days: number,
  openDays: number | null,
  thresholds: Record<string, [number, number]> = DEFAULT_AGE
): "" | "overdue" | "urgent" {
  if (current === "done" || current === "cancelled") return "";
  const stage = toneOf(days, thresholds[current] || DEFAULT_AGE[current]);
  const open = openDays == null ? "" : toneOf(openDays, thresholds.open_total || DEFAULT_AGE.open_total);
  return worseTone(stage, open);
}

export type StepStat = {
  n_known: number;
  n_total: number;
  avg_days: number | null;
  max_days: number | null;
  max_issue_id: number | null;
  open: boolean;
  open_days: number | null;
  open_issue_id: number | null;
  tone: "" | "overdue" | "urgent";
};

export type StatsRow = {
  issue_id: number;
  vehicle_id: number;
  reported_at: string;
  scheduled_at?: string | null;
  scheduled_known?: boolean;
  part_ordered_at?: string | null;
  part_received_at?: string | null;
  parts_na?: boolean;
  done_at?: string | null;
  status: string;
};

function pairStat(
  rows: { issue_id: number; start: string | null; end: string | null; openDays: number | null }[],
  pair: [number, number]
): StepStat {
  const known = rows.filter((r) => r.start && r.end);
  const total = rows.filter((r) => r.start);
  const spans = known.map((r) => ({
    id: r.issue_id,
    days: Math.max(0, daysBetween(String(r.start).slice(0, 10), String(r.end).slice(0, 10))),
  }));
  const avg = spans.length ? Math.round((spans.reduce((s, r) => s + r.days, 0) / spans.length) * 10) / 10 : null;
  let maxDays: number | null = null;
  let maxId: number | null = null;
  for (const s of spans) {
    if (maxDays == null || s.days > maxDays || (s.days === maxDays && (maxId == null || s.id > maxId))) {
      maxDays = s.days;
      maxId = s.id;
    }
  }
  let openDays: number | null = null;
  let openId: number | null = null;
  for (const r of rows) {
    if (r.end || r.openDays == null || !r.start) continue;
    if (openDays == null || r.openDays > openDays) {
      openDays = r.openDays;
      openId = r.issue_id;
    }
  }
  const openWins = openDays != null && (maxDays == null || openDays > maxDays);
  const shown = openWins ? openDays : maxDays;
  const tone = shown == null ? "" : toneOf(shown, pair);
  return {
    n_known: known.length,
    n_total: total.length,
    avg_days: avg,
    max_days: maxDays,
    max_issue_id: maxId,
    open: openWins,
    open_days: openDays,
    open_issue_id: openId,
    tone,
  };
}

export function stepStats(
  rows: StatsRow[],
  windowDays: number,
  thresholds: Record<string, [number, number]> = DEFAULT_AGE,
  todayCt = "2026-10-01",
  nowMs?: number
): { overall: Record<string, StepStat>; by_vehicle: Record<string, Record<string, StepStat>> } {
  const today = todayCt.slice(0, 10);
  const now = nowMs ?? Date.parse(`${today}T18:00:00Z`);
  const inWindow = rows.filter((r) => {
    const rep = r.reported_at.slice(0, 10);
    const age = daysBetween(rep, today);
    return age >= 0 && age <= windowDays && r.status !== "cancelled";
  });
  const build = (list: StatsRow[]) => {
    const sched = list.map((r) => ({
      issue_id: r.issue_id,
      start: r.reported_at,
      end: r.scheduled_known === false ? null : r.scheduled_at || null,
      openDays: r.status === "open" || r.status === "scheduled" || r.status === "in_progress"
        ? Math.max(0, Math.floor((now - parseMs(r.reported_at)) / 86400000))
        : null,
    }));
    const parts = list
      .filter((r) => !r.parts_na)
      .map((r) => ({
        issue_id: r.issue_id,
        start: r.part_ordered_at || null,
        end: r.part_received_at || null,
        openDays:
          r.part_ordered_at && !r.part_received_at
            ? Math.max(0, Math.floor((now - parseMs(r.part_ordered_at)) / 86400000))
            : null,
      }));
    const done = list.map((r) => ({
      issue_id: r.issue_id,
      start: r.reported_at,
      end: r.done_at || null,
      openDays:
        !r.done_at && r.status !== "completed" && r.status !== "cancelled"
          ? Math.max(0, Math.floor((now - parseMs(r.reported_at)) / 86400000))
          : null,
    }));
    return {
      report_scheduled: pairStat(sched, thresholds.step_report_scheduled || DEFAULT_AGE.step_report_scheduled),
      part_ordered_received: pairStat(parts, thresholds.step_part_ordered_received || DEFAULT_AGE.step_part_ordered_received),
      report_done: pairStat(done, thresholds.step_report_done || DEFAULT_AGE.step_report_done),
    };
  };
  const by: Record<string, Record<string, StepStat>> = {};
  const vids = [...new Set(inWindow.map((r) => r.vehicle_id))];
  for (const vid of vids) by[String(vid)] = build(inWindow.filter((r) => r.vehicle_id === vid));
  return { overall: build(inWindow), by_vehicle: by };
}

function utcSql(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export function dayBoundsMs(dayCt: string): [number, number] {
  const [y, m, d] = dayCt.slice(0, 10).split("-").map(Number);
  const start = chicagoLocalToUtc(y, m, d, 0, 0);
  const next = new Date(Date.UTC(y, m - 1, d) + 86400000);
  const end = chicagoLocalToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
  return [start, end];
}

export type HourSegment = {
  entry_type: string;
  started_at: string;
  ended_at?: string | null;
};

export type ClockSession = {
  kind?: string | null;
  clock_in_at: string;
  clock_out_at?: string | null;
};

function msOf(raw: string): number {
  return parseMs(raw);
}

export function hoursForDay(
  segments: HourSegment[],
  clockSessions: ClockSession[],
  dayCt: string,
  nowMs: number
): { wrench_h: number; shop_h: number; clocked_h: number; open_timer: boolean } {
  const [start, end] = dayBoundsMs(dayCt);
  const clip = (a: number, b: number) => Math.max(0, Math.min(b, end) - Math.max(a, start));
  let wrench = 0;
  let shop = 0;
  let open = false;
  for (const seg of segments) {
    if (!entryTypeAllowed(seg.entry_type)) continue;
    const a = msOf(seg.started_at);
    const b = seg.ended_at ? msOf(seg.ended_at) : nowMs;
    if (!seg.ended_at && a < end && b > start) open = true;
    const h = clip(a, b) / 3600000;
    if (seg.entry_type === "work_order") wrench += h;
    else shop += h;
  }
  let clocked = 0;
  for (const ses of clockSessions) {
    if (ses.kind && ses.kind !== "shop") continue;
    const a = msOf(ses.clock_in_at);
    const b = ses.clock_out_at ? msOf(ses.clock_out_at) : nowMs;
    clocked += clip(a, b) / 3600000;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { wrench_h: r2(wrench), shop_h: r2(shop), clocked_h: r2(clocked), open_timer: open };
}

export function autoCloseAt(
  segment: { started_at: string; ended_at?: string | null },
  nowMs: number
): { ended_at: string; end_reason: "auto_close" } | null {
  if (segment.ended_at) return null;
  const start = msOf(segment.started_at);
  const close = start + 12 * 3600000;
  if (nowMs < close) return null;
  return { ended_at: new Date(close).toISOString(), end_reason: "auto_close" };
}

export function utcStamp(ms: number): string {
  return utcSql(ms);
}
