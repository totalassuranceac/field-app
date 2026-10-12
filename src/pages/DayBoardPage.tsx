import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { dayBoardUsualLine, normalizeJobTypeName } from "../jobDurations";
import { JobBriefCard } from "../components/JobBriefCard";
import "../day-board.css";

type DayBoardStPhase =
  | "scheduled"
  | "confirmed"
  | "dispatched"
  | "arrived"
  | "finished"
  | "canceled"
  | "hold"
  | "nonjob"
  | "off"
  | "other";

type DayBoardJob = {
  st_appointment_id: string;
  st_job_id: string | null;
  job_number: string | null;
  address: string | null;
  /** Which ST field won — hover debug only */
  address_source?: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  job_type: string | null;
  window_start: string | null;
  window_end: string | null;
  arrival_window_start?: string | null;
  arrival_window_end?: string | null;
  status: string | null;
  is_done: boolean;
  is_off?: boolean;
  st_phase?: DayBoardStPhase;
  ink?: "st" | "board";
  note: string | null;
  job_notes?: { code: string; level: string; text: string }[];
  helpers?: string[];
  /** Service pending (No Cool) D1 id */
  pending_id?: number | null;
  board_status?: string | null;
};

function statusLooksDone(status: string | null | undefined): boolean {
  const s = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  if (!s) return false;
  return (
    s === "done" ||
    s === "completed" ||
    s === "complete" ||
    s === "finished" ||
    /\bdone\b/.test(s) ||
    s.includes("finish")
  );
}

function stPhaseClass(j: DayBoardJob): string {
  if (j.is_off) return "st-off";
  if (j.pending_id && j.board_status === "failed") return "st-pending-failed";
  if (j.pending_id && (j.board_status === "linking" || j.board_status === "approved")) {
    return "st-pending-linking";
  }
  if (j.pending_id) return "st-pending";
  const p = j.st_phase;
  // HARD LOCK: done/finished always gray — never leave working green
  if (p === "finished" || p === "done" || j.is_done || statusLooksDone(j.status)) {
    return "st-finished";
  }
  if (p === "canceled") return "st-canceled";
  if (p === "hold") return "st-hold";
  if (p === "nonjob") return "st-nonjob";
  if (p === "dispatched") return "st-dispatched";
  if (p === "arrived" || p === "working") return "st-arrived";
  if (p === "confirmed") return "st-confirmed";
  if (p === "off") return "st-off";
  return "st-scheduled";
}


type DayBoardPto = {
  request_id: number;
  label: string;
  start_date: string;
  end_date: string;
};

type DayBoardTechRow = {
  user_id: number | null;
  display_name: string;
  st_technician_id: number | null;
  is_self: boolean;
  crew?: "service" | "install";
  jobs: DayBoardJob[];
  pto: DayBoardPto[];
};

type DayBoardResponse = {
  date: string;
  timezone: string;
  view: "office" | "self";
  st_write_enabled: boolean;
  rows: DayBoardTechRow[];
  /** Server PTO query ok — when true, empty pto must not be re-stuck from cache. */
  pto_ok?: boolean;
  message?: string;
  error?: string;
};
function todayIso(): string {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return utc.toISOString().slice(0, 10);
}

function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Chicago",
    });
  } catch {
    return "";
  }
}

/** Primary face times = appointment start–end. */
function formatWindow(start: string | null, end: string | null): string {
  const a = formatClock(start);
  const b = formatClock(end);
  if (a && b) return `${a}–${b}`;
  return a || b || "";
}

function sameClock(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const ca = formatClock(a);
  const cb = formatClock(b);
  return Boolean(ca && cb && ca === cb);
}

/** Arrival window subtitle only when it differs from appointment times. */
function formatArrivalSubtitle(j: DayBoardJob): string | null {
  const arrStart = j.arrival_window_start;
  const arrEnd = j.arrival_window_end;
  if (!arrStart && !arrEnd) return null;
  if (
    sameClock(arrStart, j.window_start) &&
    sameClock(arrEnd, j.window_end)
  ) {
    return null;
  }
  // Also skip if arrival equals start for both ends missing one side
  if (sameClock(arrStart, j.window_start) && !arrEnd && !j.window_end) {
    return null;
  }
  const label = formatWindow(arrStart || null, arrEnd || null);
  return label ? `Arrive ${label}` : null;
}

function parseLooseDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // M/D/YYYY or M-D-YYYY
  const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(t);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const mo = String(Number(m[1])).padStart(2, "0");
    const d = String(Number(m[2])).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  const lower = t.toLowerCase();
  if (lower === "today") return todayIso();
  if (lower === "tomorrow") return shiftIso(todayIso(), 1);
  if (lower === "yesterday") return shiftIso(todayIso(), -1);
  return null;
}


const DAY_BOARD_SLOTS = 7;
/** Install timeline: shop day Chicago 7am-7pm (12h). */
const INSTALL_DAY_START_MIN = 7 * 60;
const INSTALL_DAY_END_MIN = 19 * 60;
const INSTALL_DAY_LEN_MIN = INSTALL_DAY_END_MIN - INSTALL_DAY_START_MIN;
const INSTALL_DEFAULT_DUR_MIN = 4 * 60;
const INSTALL_MIN_BAR_MIN = 40;

/** Canceled ST jobs never appear on the board (sheet mirror). */
function activeBoardJobs(jobs: DayBoardJob[]): DayBoardJob[] {
  return (jobs || []).filter((j) => {
    if (j.st_phase === "canceled") return false;
    const s = String(j.status || "").toLowerCase();
    if (s.includes("cancel")) return false;
    return true;
  });
}

function jobsToSlots(jobs: DayBoardJob[]): (DayBoardJob | null)[] {
  const sorted = [...jobs].sort((a, b) =>
    String(a.window_start || "").localeCompare(String(b.window_start || ""))
  );
  const slots: (DayBoardJob | null)[] = Array.from(
    { length: DAY_BOARD_SLOTS },
    () => null
  );
  for (let i = 0; i < Math.min(sorted.length, DAY_BOARD_SLOTS); i++) {
    slots[i] = sorted[i];
  }
  return slots;
}

function chicagoMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(d);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

type InstallBar = {
  job: DayBoardJob;
  leftPct: number;
  widthPct: number;
  lane: number;
  durationLabel: string;
};


function normBoardStreet(addr: string | null | undefined): string {
  return String(addr || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop Chris Miller / Marroquin / Brady / bare Chris (belt + suspenders). */
function isHiddenChrisRow(display: string): boolean {
  const n = String(display || "")
    .toLowerCase()
    .replace(/[^a-z0-9 /]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return false;
  // Pair labels: hide if any segment is a banned Chris
  if (n.includes("/")) {
    return n.split("/").some((p) => isHiddenChrisRow(p.trim()));
  }
  if (n === "chris") return true;
  // Shortened First L forms (Chris M / Chris B) + full names
  if (
    n === "chris m" ||
    n === "chris b" ||
    n === "chris miller" ||
    n === "christopher miller" ||
    n === "chris marroquin" ||
    n === "chris brady" ||
    n === "christopher brady" ||
    n === "chrisbrady"
  ) {
    return true;
  }
  if (
    n.startsWith("chris miller") ||
    n.startsWith("christopher miller") ||
    n.startsWith("chris marroquin") ||
    n.startsWith("chris brady") ||
    n.startsWith("christopher brady")
  ) {
    return true;
  }
  if (/\bmiller\b/.test(n) && /\bchris(?:topher)?\b/.test(n)) return true;
  if (/\bmarroquin\b/.test(n) && /\bchris\b/.test(n)) return true;
  if (/\bbrady\b/.test(n) && /\bchris(?:topher)?\b/.test(n)) return true;
  return false;
}

/**
 * Same street — one Install row with joined names (Williams/Ortiz Montes).
 * PTO rows stay solo. Solo address stays solo.
 */
function mergeInstallSameAddress(rows: DayBoardTechRow[]): DayBoardTechRow[] {
  const ptoRows: DayBoardTechRow[] = [];
  const active: DayBoardTechRow[] = [];
  for (const r of rows) {
    if ((r.pto || []).length > 0) ptoRows.push(r);
    else active.push(r);
  }
  const parent = active.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }
  const addrIndex: Map<string, number> = new Map();
  active.forEach((row, i) => {
    const seen = new Set<string>();
    for (const j of row.jobs || []) {
      const a = normBoardStreet(j.address);
      if (!a || seen.has(a)) continue;
      seen.add(a);
      const prev = addrIndex.get(a);
      if (prev != null) union(prev, i);
      else addrIndex.set(a, i);
    }
  });
  const groups = new Map<number, number[]>();
  active.forEach((_, i) => {
    const r = find(i);
    const list = groups.get(r) || [];
    list.push(i);
    groups.set(r, list);
  });
  const merged: DayBoardTechRow[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length === 1) {
      merged.push(active[idxs[0]]);
      continue;
    }
    const members = idxs.map((i) => active[i]);
    const names: string[] = [];
    const seenN = new Set<string>();
    for (const m of members) {
      for (const part of String(m.display_name || "").split("/")) {
        const t = part.trim();
        if (!t) continue;
        const key = t.toLowerCase();
        if (seenN.has(key)) continue;
        seenN.add(key);
        names.push(t);
      }
    }
    const jobMap = new Map<string, DayBoardJob>();
    for (const m of members) {
      for (const j of m.jobs || []) {
        const k =
          j.st_appointment_id ||
          `${j.st_job_id}-${j.window_start}-${j.address}`;
        if (!jobMap.has(k)) jobMap.set(k, j);
      }
    }
    const base = members[0];
    merged.push({
      ...base,
      display_name: names.join("/"),
      is_self: members.some((m) => m.is_self),
      jobs: [...jobMap.values()].sort((a, b) =>
        String(a.window_start || "").localeCompare(String(b.window_start || ""))
      ),
      pto: [],
    });
  }
  return [...merged, ...ptoRows];
}

function buildInstallBars(jobs: DayBoardJob[]): InstallBar[] {
  const sorted = [...jobs].sort((a, b) =>
    String(a.window_start || "").localeCompare(String(b.window_start || ""))
  );
  const raw: Array<{
    job: DayBoardJob;
    start: number;
    end: number;
    durationLabel: string;
  }> = [];
  for (const job of sorted) {
    let start = chicagoMinutes(job.window_start);
    let end = chicagoMinutes(job.window_end);
    if (start == null && end == null) {
      start = INSTALL_DAY_START_MIN;
      end = start + INSTALL_DEFAULT_DUR_MIN;
    } else if (start == null && end != null) {
      start = Math.max(INSTALL_DAY_START_MIN, end - INSTALL_DEFAULT_DUR_MIN);
    } else if (start != null && end == null) {
      end = start + INSTALL_DEFAULT_DUR_MIN;
    }
    if (start == null || end == null) continue;
    if (end <= start) end = start + INSTALL_DEFAULT_DUR_MIN;
    const dur = Math.max(INSTALL_MIN_BAR_MIN, end - start);
    end = start + dur;
    const cs = Math.min(
      Math.max(start, INSTALL_DAY_START_MIN),
      INSTALL_DAY_END_MIN - INSTALL_MIN_BAR_MIN
    );
    const ce = Math.min(Math.max(end, cs + INSTALL_MIN_BAR_MIN), INSTALL_DAY_END_MIN);
    const mins = ce - cs;
    const hrs = mins / 60;
    const durationLabel =
      hrs >= 1 ? `${hrs % 1 === 0 ? hrs : hrs.toFixed(1)}h` : `${mins}m`;
    raw.push({ job, start: cs, end: ce, durationLabel });
  }
  const laneEnds: number[] = [];
  const out: InstallBar[] = [];
  for (const r of raw) {
    let lane = 0;
    while (lane < laneEnds.length && laneEnds[lane] > r.start) lane += 1;
    if (lane === laneEnds.length) laneEnds.push(r.end);
    else laneEnds[lane] = r.end;
    const leftPct =
      ((r.start - INSTALL_DAY_START_MIN) / INSTALL_DAY_LEN_MIN) * 100;
    const widthPct = ((r.end - r.start) / INSTALL_DAY_LEN_MIN) * 100;
    out.push({
      job: r.job,
      leftPct,
      widthPct: Math.max(widthPct, 4),
      lane,
      durationLabel: r.durationLabel,
    });
  }
  return out;
}

/**
 * Install bar: STREET — work · time · phone
 * Street is primary and kept intact; truncate work/notes first. Job # never primary.
 * Never paint literal "no address" when street/customer exists.
 */
function installBarParts(j: DayBoardJob): {
  street: string;
  work: string;
  when: string;
  arrive: string | null;
  phone: string;
  title: string;
} {
  const street = (j.address || "").replace(/\s+/g, " ").trim();
  const cust = (j.customer_name || "").replace(/\s+/g, " ").trim();
  const type = (j.job_type || "").replace(/\s+/g, " ").trim();
  const note = (j.note || "").replace(/\s+/g, " ").trim();
  const phone = (j.customer_phone || "").replace(/\s+/g, " ").trim();
  const when = formatWindow(j.window_start, j.window_end);
  const arrive = formatArrivalSubtitle(j);
  let work = note || type || "";
  // Prefer full street; shorten work before cutting street
  const MAX_WORK = 56;
  if (work.length > MAX_WORK) {
    work = `${work.slice(0, MAX_WORK - 1).trimEnd()}…`;
  }
  // Street wins; customer only when no street; "no address" only when truly empty
  const place = street || cust || "no address";
  const title = [
    street || (cust ? `${cust} (no street on file)` : "no address"),
    friendlyAddressSource(j.address_source),
    j.customer_name,
    j.job_type,
    j.note,
    when,
    arrive,
    j.customer_phone,
    j.job_number ? `Job #${j.job_number}` : j.st_job_id ? `Job ${j.st_job_id}` : null,
    j.status,
  ]
    .filter(Boolean)
    .join(" · ");
  return { street: place, work, when, arrive, phone, title };
}

function truncateNote(raw: string | null | undefined, max = 140): string | null {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Always "First L" (Abel H, Jaden D). Pairs: "Abel H/Geo M" on one line.
 * Never bare "Chris".
 */
function firstNameOnlyBoard(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const parts = t.split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  if (first.toLowerCase() === "chris" && parts.length === 1) return "";
  return first;
}

function firstPlusLastInitialBoard(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const parts = t.split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  if (first.toLowerCase() === "chris" && parts.length === 1) return "";
  if (parts.length === 1) return first;
  return `${first} ${parts[parts.length - 1].charAt(0).toUpperCase()}`;
}

/** First name only; First + last initial only when first names collide in the list. */
function shortLabelsForBoardList(fullNames: string[]): string[] {
  const firsts = fullNames.map(firstNameOnlyBoard);
  const counts = new Map<string, number>();
  for (const f of firsts) {
    const k = f.toLowerCase();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return fullNames.map((full, i) => {
    const first = firsts[i];
    if (!first) return "";
    if ((counts.get(first.toLowerCase()) || 0) > 1) {
      return firstPlusLastInitialBoard(full);
    }
    return first;
  });
}

function shortBoardLabel(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.includes("/")) {
    const segs = t.split("/").map((p) => p.trim()).filter(Boolean);
    return shortLabelsForBoardList(segs).filter(Boolean).join("/");
  }
  return firstNameOnlyBoard(t);
}

/** Single horizontal label string for titles/tooltips. Never bare Chris. */
function boardNameLabel(display: string): string {
  const s = shortBoardLabel(display);
  // Do not fall back to raw display — that reintroduces bare "Chris"
  return s;
}

/** First L parts for stacked name UI — never slash-crammed on one line. */
function boardNameParts(display: string): string[] {
  const t = String(display || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const segments = t.includes("/")
    ? t.split("/").map((p) => p.trim()).filter(Boolean)
    : [t];
  const out: string[] = [];
  for (const seg of segments) {
    const short = shortBoardLabel(seg);
    if (!short) continue;
    if (isHiddenChrisRow(short) || isHiddenChrisRow(seg)) continue;
    out.push(short);
  }
  return out;
}

function isChicagoWeekendIso(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
  }).formatToParts(new Date(`${iso}T12:00:00Z`));
  const wd = parts.find((p) => p.type === "weekday")?.value || "";
  return wd === "Sat" || wd === "Sun";
}

/**
 * Soft-refresh PTO stick — ONLY when the server PTO query failed (pto_ok===false).
 * After a clean load (pto_ok===true), empty pto[] is authoritative: never invent
 * or carry PTO from a prior paint for that user/date. Same-date only; weekends empty.
 * Force reload (prev=null) always trusts the server.
 */
function stickDayBoardPto(
  prev: DayBoardResponse | null,
  next: DayBoardResponse
): DayBoardResponse {
  if (!prev || prev.date !== next.date) return next;
  if (isChicagoWeekendIso(next.date)) return next;
  // Clean server load: never re-stick PTO the server omitted for this board day
  if (next.pto_ok !== false) return next;
  const prevByUser = new Map<number, { pto: DayBoardPto[]; row: DayBoardTechRow }>();
  for (const r of prev.rows || []) {
    if (r.user_id != null && (r.pto || []).length) {
      prevByUser.set(Number(r.user_id), { pto: r.pto || [], row: r });
    }
  }
  if (!prevByUser.size) return next;

  const present = new Set<number>();
  const rows = (next.rows || []).map((r) => {
    const uid = r.user_id != null ? Number(r.user_id) : null;
    if (uid != null) present.add(uid);
    const incoming = r.pto || [];
    if (incoming.length) return r;
    if (uid != null && prevByUser.has(uid)) {
      return { ...r, pto: prevByUser.get(uid)!.pto };
    }
    return r;
  });
  for (const [uid, kept] of prevByUser) {
    if (present.has(uid)) continue;
    rows.push({
      user_id: uid,
      display_name: kept.row.display_name || `User ${uid}`,
      st_technician_id: kept.row.st_technician_id ?? null,
      is_self: false,
      crew: kept.row.crew || "service",
      jobs: [],
      pto: kept.pto,
    });
  }
  return { ...next, rows };
}

/** Service primary: street, or customer — never Job #-first when place/person exists. */
/** Street-first primary label — readable at a glance. */
function servicePrimaryLabel(j: DayBoardJob): string {
  const street = (j.address || "").replace(/\s+/g, " ").trim();
  const cust = (j.customer_name || "").replace(/\s+/g, " ").trim();
  if (street) return street;
  if (cust) return cust;
  return `Job ${j.job_number || j.st_job_id || ""}`;
}

/** Human label for address provenance — never raw path keys. */
function friendlyAddressSource(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low.includes("invoice") && low.includes("location")) return "from invoice";
  if (low.includes("invoice")) return "from invoice";
  if (low.includes("location")) return "from location";
  if (low.includes("customer")) return "from customer";
  if (low.includes("appointment") || low.includes("job")) return "from job";
  // Strip dotted path leftovers
  if (s.includes(".")) return "from ServiceTitan";
  return s;
}

export function DayBoardPage() {
  const { user } = useAuth();
  const allowed = can(user, "viewDayBoard");
  const canLengths = can(user, "viewJobLengths");
  const [usualByType, setUsualByType] = useState<Record<string, number>>({});
  const [date, setDate] = useState(todayIso);
  const [data, setData] = useState<DayBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailJob, setDetailJob] = useState<DayBoardJob | null>(null);
  const [assistOn, setAssistOn] = useState(true);
  const [aiOn, setAiOn] = useState(false);
  const [materialFlags, setMaterialFlags] = useState<
    Record<string, { open: number; staged: number }>
  >({});
  const [materialAddresses, setMaterialAddresses] = useState<Record<string, { open: number }>>(
    {}
  );
  const [pendingBusy, setPendingBusy] = useState(false);
  const [addFor, setAddFor] = useState<{
    tech_user_id: number | null;
    st_technician_id: number | null;
    display_name: string;
  } | null>(null);
  const [addForm, setAddForm] = useState({
    customer_name: "",
    customer_phone: "",
    address: "",
    issue: "No Cool",
    window_start: "08:00",
    window_end: "12:00",
  });
  const cacheRef = useRef<Map<string, DayBoardResponse>>(new Map());
  const prefetchGen = useRef(0);
  const loadGen = useRef(0);
  const dateRef = useRef(date);
  dateRef.current = date;

  const fetchDay = useCallback(
    async (day: string, opts?: { fresh?: boolean }): Promise<DayBoardResponse> => {
      const fresh = opts?.fresh ? "&fresh=1" : "";
      const res = await api<DayBoardResponse>(
        `/day-board?date=${encodeURIComponent(day)}${fresh}`,
        { timeoutMs: 60_000 }
      );
      return res;
    },
    []
  );

  const commitDay = useCallback((day: string, res: DayBoardResponse, prev: DayBoardResponse | null) => {
    const sticky = stickDayBoardPto(prev, res);
    cacheRef.current.set(day, sticky);
    if (sticky.date && sticky.date !== day) cacheRef.current.set(sticky.date, sticky);
    return sticky;
  }, []);

  const load = useCallback(async (day: string, opts?: { force?: boolean }) => {
    if (!allowed) return;
    const gen = ++loadGen.current;
    const cached = !opts?.force ? cacheRef.current.get(day) : undefined;
    if (cached) {
      setData(cached);
      setError(cached.error && !(cached.rows || []).length ? cached.error : "");
      setLoading(false);
      // soft refresh in background — never blank board; guard stale responses
      void fetchDay(day, { fresh: !!opts?.force })
        .then((res) => {
          if (gen !== loadGen.current) return;
          if (dateRef.current !== day) return;
          setData((prev) => {
            const sticky = commitDay(
              day,
              res,
              prev?.date === day ? prev : cached
            );
            if (res.error && !(sticky.rows || []).length) setError(res.error);
            else setError("");
            return sticky;
          });
        })
        .catch(() => { /* keep cache */ });
      return;
    }
    // No cache: keep prior board painted; quiet loading only (no wipe)
    setLoading(true);
    setError("");
    try {
      const res = await fetchDay(day, { fresh: !!opts?.force });
      if (gen !== loadGen.current) return;
      if (dateRef.current !== day) return;
      const sticky = commitDay(day, res, null);
      setData(sticky);
      if (sticky.date && sticky.date !== day) setDate(sticky.date);
      if (res.error && !(sticky.rows || []).length) setError(res.error);
    } catch (e) {
      if (gen !== loadGen.current) return;
      // Only clear board on hard miss when we have nothing for this day
      if (!cacheRef.current.get(day)) {
        setError(e instanceof Error ? e.message : "Could not load day board");
      }
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [allowed, fetchDay, commitDay]);

  /** Prefetch only ±1 day — never block visible day; never blank board. */
  const prefetchNeighbors = useCallback(
    async (center: string) => {
      if (!allowed) return;
      const gen = ++prefetchGen.current;
      const days = [-1, 1].map((n) => shiftIso(center, n));
      for (const d of days) {
        if (gen !== prefetchGen.current) return;
        if (cacheRef.current.has(d)) continue;
        try {
          const res = await fetchDay(d);
          commitDay(d, res, cacheRef.current.get(d) || null);
        } catch {
          /* ignore prefetch miss */
        }
      }
    },
    [allowed, fetchDay, commitDay]
  );

  useEffect(() => {
    if (!allowed || !canLengths) return;
    let cancelled = false;
    void api<{ rows?: { job_type_name?: string | null; median_minutes?: number | null }[] }>(
      "/job-lengths?days=90",
      { timeoutMs: 60_000 }
    )
      .then((res) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const row of res.rows || []) {
          if (row.median_minutes == null || !row.job_type_name) continue;
          next[normalizeJobTypeName(row.job_type_name)] = row.median_minutes;
        }
        setUsualByType(next);
      })
      .catch(() => {
        /* hint stays off when lengths are unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, canLengths]);

  function usualLine(job: DayBoardJob): string | null {
    if (!canLengths) return null;
    const key = normalizeJobTypeName(job.job_type);
    const booked = key ? usualByType[key] : undefined;
    return dayBoardUsualLine(job.job_type, booked ?? null, job.window_start, job.window_end);
  }

  useEffect(() => {
    if (!allowed) return;
    api<{ tech_assist?: boolean; ai_enabled?: boolean }>("/tech/config")
      .then((d) => {
        setAssistOn(d.tech_assist !== false);
        setAiOn(Boolean(d.ai_enabled));
      })
      .catch(() => setAssistOn(true));
  }, [allowed]);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  useEffect(() => {
    let cancelled = false;
    void api<{
      jobs?: Record<string, { open: number; staged: number }>;
      addresses?: Record<string, { open: number }>;
    }>(`/materials/flags?date=${encodeURIComponent(date)}`)
      .then((res) => {
        if (cancelled) return;
        setMaterialFlags(res.jobs || {});
        setMaterialAddresses(res.addresses || {});
      })
      .catch(() => {
        if (!cancelled) {
          setMaterialFlags({});
          setMaterialAddresses({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [date, data]);

  // After visible day finishes, defer neighbor prefetch (±1 only)
  useEffect(() => {
    if (!allowed || loading) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      void prefetchNeighbors(date);
    };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const ric = (
      globalThis as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (id: number) => void;
      }
    ).requestIdleCallback;
    const cic = (
      globalThis as unknown as { cancelIdleCallback?: (id: number) => void }
    ).cancelIdleCallback;
    if (typeof ric === "function") {
      idleId = ric(run, { timeout: 2500 });
    } else {
      timeoutId = setTimeout(run, 2000);
    }
    return () => {
      cancelled = true;
      if (idleId != null && typeof cic === "function") cic(idleId);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, [allowed, loading, date, prefetchNeighbors]);

  const canWritePending =
    user?.role === "admin" ||
    user?.role === "office" ||
    user?.role === "supervisor";

  async function submitPendingAdd(e: FormEvent) {
    e.preventDefault();
    if (!addFor || !canWritePending) return;
    setPendingBusy(true);
    setError("");
    try {
      await api("/day-board/pending", {
        method: "POST",
        body: JSON.stringify({
          date,
          tech_user_id: addFor.tech_user_id,
          st_technician_id: addFor.st_technician_id,
          display_name: addFor.display_name,
          customer_name: addForm.customer_name.trim(),
          customer_phone: addForm.customer_phone.trim() || null,
          address: addForm.address.trim(),
          issue: addForm.issue.trim() || "No Cool",
          window_start: addForm.window_start || null,
          window_end: addForm.window_end || null,
        }),
      });
      setAddFor(null);
      setAddForm({
        customer_name: "",
        customer_phone: "",
        address: "",
        issue: "No Cool",
        window_start: "08:00",
        window_end: "12:00",
      });
      await load(date, { force: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add pending");
    } finally {
      setPendingBusy(false);
    }
  }

  async function actPending(
    pendingId: number,
    action: "approve" | "retry" | "discard"
  ) {
    setPendingBusy(true);
    setError("");
    try {
      await api(`/day-board/pending/${pendingId}/${action}`, {
        method: "POST",
        body: "{}",
      });
      setDetailJob(null);
      await load(date, { force: true });
      if (action === "approve" || action === "retry") {
        // Soft poll once after linker may finish
        window.setTimeout(() => {
          void load(date, { force: true });
        }, 4000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pending action failed");
    } finally {
      setPendingBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Today's jobs</h1>
        </header>
        <div className="empty-state">
          <p>Office and field techs only.</p>
          <Link to="/" className="btn secondary">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  const isOffice = data?.view === "office" || can(user, "viewOpsPerformance");

  const dateLabel = (() => {
    try {
      const d = new Date(`${date}T12:00:00`);
      if (!Number.isFinite(d.getTime())) return date;
      return d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "America/Chicago",
      });
    } catch {
      return date;
    }
  })();

  return (
    <div className="page day-board-page">
      {new URLSearchParams(window.location.search).get("joined") === "1" ? (
        <div className="card" style={{ marginBottom: "0.75rem" }}>
          <p>
            You are in. <Link to="/clock">Open Clock</Link> for today's jobs.
          </p>
          {new URLSearchParams(window.location.search).get("st") === "0" ? (
            <p className="muted">
              Your ServiceTitan name is not linked yet. Ask the office to connect it before clock
              times land on the job.
            </p>
          ) : null}
        </div>
      ) : null}
      <header className="page-header day-board-page-header">
        <div>
          <h1>Today's jobs</h1>
          <p className="muted">
            {isOffice ? "All techs · live ServiceTitan" : "Your day · live ServiceTitan"}
            {" · "}
            sheet backup only when the app is down
          </p>
        </div>
        <div className="day-board-header-actions">
          {loading ? (
            <span className="day-board-status-bar" aria-live="polite">
              {data ? "Updating…" : "Loading…"}
            </span>
          ) : null}
          <button
            type="button"
            className="btn secondary day-board-reload"
            disabled={loading}
            onClick={() => void load(date, { force: true })}
          >
            Reload
          </button>
        </div>
      </header>

      <div className="day-board-controls">
        <div className="day-board-date-nav" role="group" aria-label="Change day">
          <button
            type="button"
            className="btn secondary day-board-date-step"
            onClick={() => setDate((d) => shiftIso(d, -1))}
            aria-label="Previous day"
          >
            ‹
          </button>
          <div className="day-board-date-face">
            <span className="day-board-date-label">{dateLabel}</span>
            <label className="day-board-date-wrap">
              <span className="sr-only">Pick day</span>
              <input
                type="date"
                className="day-board-date"
                value={date}
                onChange={(e) => setDate(e.target.value || todayIso())}
                aria-label="Pick day"
              />
            </label>
          </div>
          <button
            type="button"
            className="btn secondary day-board-date-step"
            onClick={() => setDate((d) => shiftIso(d, 1))}
            aria-label="Next day"
          >
            ›
          </button>
        </div>
      </div>

      {error && (
        <div className="error" style={{ marginBottom: "0.75rem" }}>
          {error}
        </div>
      )}

      {data?.message && !error ? (
        <p className="muted day-board-msg">{data.message}</p>
      ) : null}

      {(() => {
        const all = (data?.rows || []).filter((r) => {
          if (isHiddenChrisRow(r.display_name)) return false;
          // Drop rows that would render with no usable name (bare Chris — "")
          const label = boardNameLabel(r.display_name);
          return Boolean(label);
        });
        const service = all.filter((r) => (r.crew || "service") !== "install");
        const install = mergeInstallSameAddress(
          all.filter((r) => r.crew === "install")
        );
        // Disambiguate John Williams vs John Alvarado (and any other shared firsts)
        const renderRows = (list: DayBoardTechRow[], label: string) => {
        const expanded = list.map((row) => {
          const raw = String(row.display_name || "").replace(/\s+/g, " ").trim();
          const segs = raw.includes("/")
            ? raw.split("/").map((p) => p.trim()).filter(Boolean)
            : raw
              ? [raw]
              : [];
          return segs;
        });
        const flat = expanded.flat();
        const flatLabels = shortLabelsForBoardList(flat);
        let cursor = 0;
        const labelsByRow = expanded.map((segs) => {
          const slice = flatLabels.slice(cursor, cursor + segs.length);
          cursor += segs.length;
          return slice.filter((n) => n && !isHiddenChrisRow(n));
        });
        return (
          <section
            className={`day-board-section crew-${label.toLowerCase()}`}
            aria-label={label}
          >
            <div className="day-board-section-label">{label}</div>
            <div className="day-board-sheet" role="table">
              <div className="day-board-sheet-scroll">
                {list.map((row) => {
                  const onPto = (row.pto || []).length > 0;
                  // Full-row light-red OFF whenever approved PTO/personal covers this day
                  const blocked = onPto;
                  const ptoLabel =
                    (row.pto || []).map((p) => p.label).join(" · ") || "OFF";
                  const rowIdx = list.indexOf(row);
                  const nameParts =
                    (rowIdx >= 0 ? labelsByRow[rowIdx] : null) ||
                    boardNameParts(row.display_name);
                  const nameTitle =
                    nameParts.join("/") ||
                    boardNameLabel(row.display_name) ||
                    row.display_name;
                  return (
                    <div
                      key={
                        row.user_id != null
                          ? `u-${row.user_id}`
                          : `st-${row.st_technician_id || row.display_name}`
                      }
                      className={`day-board-row${
                        row.is_self ? " is-self" : ""
                      }${blocked ? " is-pto-blocked" : ""}${
                        nameParts.length > 1 ? " is-crew-stack" : ""
                      }`}
                      role="row"
                    >
                      <div
                        className="day-board-tech"
                        role="rowheader"
                        title={nameTitle}
                      >
                        <div className="day-board-tech-stack" title={nameTitle}>
                          {nameParts.map((n) => (
                            <button
                              key={n}
                              type="button"
                              className="day-board-tech-stack-name"
                              title={n}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                        {canWritePending &&
                        label === "Service" &&
                        !blocked &&
                        row.st_technician_id ? (
                          <button
                            type="button"
                            className="btn ghost btn-sm day-board-add-pending"
                            title="Add pending No Cool / after-hours"
                            aria-label={`Add pending job for ${nameTitle}`}
                            onClick={() =>
                              setAddFor({
                                tech_user_id: row.user_id,
                                st_technician_id: row.st_technician_id,
                                display_name: row.display_name,
                              })
                            }
                          >
                            +
                          </button>
                        ) : null}
                      </div>
                      <div
                        className={`day-board-jobs${
                          blocked
                            ? " is-pto-span"
                            : label === "Install"
                              ? " is-install-stack"
                              : ""
                        }`}
                        role="cell"
                        style={
                          label === "Install" || blocked
                            ? undefined
                            : {
                                ["--day-board-slots" as string]:
                                  DAY_BOARD_SLOTS,
                              }
                        }
                      >
                        {blocked ? (
                          <div className="day-board-cell is-off is-install-off is-pto-full">
                            <span className="day-board-cell-main">{ptoLabel}</span>
                          </div>
                        ) : label === "Install" ? (
                          !activeBoardJobs(row.jobs).length ? (
                            <div className="day-board-install-empty muted">
                              No install jobs
                            </div>
                          ) : (
                            <div className="day-board-install-stack">
                              {[...activeBoardJobs(row.jobs)]
                                .sort((a, b) =>
                                  String(a.window_start || "").localeCompare(
                                    String(b.window_start || "")
                                  )
                                )
                                .map((j) => {
                                  const ink =
                                    j.ink === "board" ? "ink-board" : "ink-st";
                                  const parts = installBarParts(j);
                                  // Face: street · note · start–end (job # hover-only)
                                  const mid = [parts.work, parts.when]
                                    .filter(Boolean)
                                    .join(" · ");
                                  return (
                                    <button
                                      type="button"
                                      key={j.st_appointment_id}
                                      className={`day-board-bar is-miller is-fullspan ${ink} ${stPhaseClass(j)}${
                                        j.is_done ? " is-done" : ""
                                      }${j.is_off ? " is-off" : ""}`}
                                      title={parts.title}
                                      onClick={() => setDetailJob(j)}
                                    >
                                      <span className="day-board-miller-line">
                                        <span className="day-board-miller-street">
                                          {parts.street}
                                          {(j.st_job_id && (materialFlags[j.st_job_id]?.open || 0) > 0) ||
                                          (j.address &&
                                            (materialAddresses[j.address.trim().toLowerCase()]?.open || 0) > 0)
                                            ? " - Parts"
                                            : ""}
                                        </span>
                                        {mid ? (
                                          <span className="day-board-miller-detail">
                                            {`— ${mid}`}
                                          </span>
                                        ) : null}
                                      </span>
                                      {parts.arrive ? (
                                        <span className="day-board-arrive-sub">
                                          {parts.arrive}
                                        </span>
                                      ) : null}
                                      {usualLine(j) ? (
                                        <span className="day-board-usual">{usualLine(j)}</span>
                                      ) : null}
                                    </button>
                                  );
                                })}
                            </div>
                          )
                        ) : (
                          jobsToSlots(activeBoardJobs(row.jobs)).map((j, i) => {
                            if (!j) {
                              return (
                                <div
                                  key={`empty-${i}`}
                                  className="day-board-cell is-empty"
                                  aria-hidden="true"
                                />
                              );
                            }
                            const ink =
                              j.ink === "board" ? "ink-board" : "ink-st";
                            const primary = servicePrimaryLabel(j);
                            const when =
                              formatWindow(j.window_start, j.window_end) || "—";
                            const arrive = formatArrivalSubtitle(j);
                            const noteFace = (j.note || j.job_type || "")
                              .replace(/\s+/g, " ")
                              .trim();
                            return (
                              <button
                                type="button"
                                key={j.st_appointment_id}
                                className={`day-board-cell ${ink} ${stPhaseClass(j)}${
                                  j.is_done ? " is-done" : ""
                                }${j.is_off ? " is-off" : ""}${
                                  j.pending_id ? " is-pending-chip" : ""
                                }`}
                                title={[
                                  j.address ||
                                    (j.customer_name
                                      ? `${j.customer_name} (no street on file)`
                                      : "no address"),
                                  friendlyAddressSource(j.address_source),
                                  j.customer_name,
                                  j.status,
                                  j.customer_phone,
                                  j.note,
                                  when,
                                  arrive,
                                  j.job_number
                                    ? `Job #${j.job_number}`
                                    : j.st_job_id
                                      ? `Job ${j.st_job_id}`
                                      : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                                onClick={() => setDetailJob(j)}
                              >
                                <span className="day-board-cell-main">
                                  {primary}
                                  {(j.job_notes || []).some((n) => n.code === "SOLDER") ? (
                                    <span className="job-note-chip" title="Bring 15% silver solder">S</span>
                                  ) : null}
                                  {(j.st_job_id && (materialFlags[j.st_job_id]?.open || 0) > 0) ||
                                  (j.address &&
                                    (materialAddresses[j.address.trim().toLowerCase()]?.open || 0) > 0) ? (
                                    <span className="badge badge-sm danger" style={{ marginLeft: 4 }}>
                                      Parts
                                    </span>
                                  ) : null}
                                </span>
                                {noteFace ? (
                                  <span className="day-board-cell-work">{noteFace}</span>
                                ) : null}
                                <span className="day-board-cell-meta">{when}</span>
                                {arrive ? (
                                  <span className="day-board-arrive-sub">{arrive}</span>
                                ) : null}
                                {usualLine(j) ? (
                                  <span className="day-board-usual">{usualLine(j)}</span>
                                ) : null}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        );
        };

        return (
          <>
            {service.length ? renderRows(service, "Service") : null}
            {install.length ? renderRows(install, "Install") : null}
          </>
        );
      })()}

      {!loading && data && !(data.rows || []).length ? (
        <div className="empty-state">
          <p>No techs or jobs for this day.</p>
        </div>
      ) : null}

      {detailJob ? (
        <div
          className="day-board-detail-backdrop"
          role="presentation"
          onClick={() => setDetailJob(null)}
        >
          <div
            className="day-board-detail card"
            role="dialog"
            aria-label="Job detail"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="day-board-detail-head">
              <h2>
                {detailJob.address ||
                  detailJob.customer_name ||
                  `Job ${detailJob.job_number || detailJob.st_job_id || ""}`}
              </h2>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setDetailJob(null)}
              >
                Close
              </button>
            </div>
            <dl className="day-board-detail-grid">
              {detailJob.customer_name ? (
                <>
                  <dt>Customer</dt>
                  <dd>{detailJob.customer_name}</dd>
                </>
              ) : null}
              <dt>Address</dt>
              <dd>
                {detailJob.address ||
                  detailJob.customer_name ||
                  "no address"}
                {friendlyAddressSource(detailJob.address_source) ? (
                  <span className="muted" style={{ display: "block", fontSize: "0.85em" }}>
                    Address {friendlyAddressSource(detailJob.address_source)}
                  </span>
                ) : null}
              </dd>
              <dt>Phone</dt>
              <dd>
                {detailJob.customer_phone ? (
                  <a href={`tel:${detailJob.customer_phone.replace(/[^\d+]/g, "")}`}>
                    {detailJob.customer_phone}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
              <dt>Job #</dt>
              <dd>{detailJob.job_number || detailJob.st_job_id || "—"}</dd>
              <dt>Type</dt>
              <dd>{detailJob.job_type || "—"}</dd>
              <dt>Window</dt>
              <dd>
                {formatWindow(detailJob.window_start, detailJob.window_end) || "—"}
              </dd>
              <dt>Notes</dt>
              <dd>
                {truncateNote(detailJob.note, 400) || "—"}
                {(detailJob.job_notes || []).map((n) => (
                  <div key={n.code} className={`job-note job-note-${n.level}`} role="note">
                    <strong>{n.level === "bring" ? "Bring:" : n.level === "heads_up" ? "Heads up:" : "Talk:"}</strong> {n.text}
                  </div>
                ))}
              </dd>
              <dt>Status</dt>
              <dd>{detailJob.status || "—"}</dd>
            </dl>
            <div className="toolbar" style={{ marginTop: "0.75rem" }}>
              {detailJob.st_appointment_id ? (
                <Link className="btn secondary btn-sm" to={`/clock?appt=${encodeURIComponent(detailJob.st_appointment_id)}`}>
                  Clock
                </Link>
              ) : null}
              <Link
                className="btn secondary btn-sm"
                to={`/parts-runs?address=${encodeURIComponent(detailJob.address || "")}`}
              >
                Need a part
              </Link>
              <Link
                className="btn secondary btn-sm"
                to={`/warranties?address=${encodeURIComponent(detailJob.address || "")}`}
              >
                Warranty drop-off
              </Link>
            </div>
            {assistOn && detailJob.st_job_id ? (
              <JobBriefCard stJobId={detailJob.st_job_id} aiEnabled={aiOn} />
            ) : null}
            {detailJob.st_job_id ? (
              <JobMaterialsBlock
                jobId={detailJob.st_job_id}
                jobNumber={detailJob.job_number}
                customerName={detailJob.customer_name}
                address={detailJob.address}
                appointmentDate={date}
                canEdit={
                  user?.role === "admin" ||
                  user?.role === "office" ||
                  user?.role === "supervisor" ||
                  user?.role === "warehouse" ||
                  Boolean(user?.is_warehouse)
                }
                onChange={() => {
                  void api<{ jobs?: Record<string, { open: number; staged: number }> }>(
                    `/materials/flags?date=${encodeURIComponent(date)}`
                  ).then((res) => setMaterialFlags(res.jobs || {}));
                }}
              />
            ) : null}
            {canWritePending && detailJob.pending_id ? (
              <div className="toolbar day-board-pending-actions" style={{ marginTop: "0.75rem" }}>
                {detailJob.board_status === "failed" ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={pendingBusy}
                    onClick={() => void actPending(Number(detailJob.pending_id), "retry")}
                  >
                    {pendingBusy ? "Working…" : "Retry ST link"}
                  </button>
                ) : detailJob.board_status === "linking" ||
                  detailJob.board_status === "approved" ? (
                  <span className="muted">Linking to ServiceTitan…</span>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={pendingBusy}
                    onClick={() => void actPending(Number(detailJob.pending_id), "approve")}
                  >
                    {pendingBusy ? "Working…" : "Approve"}
                  </button>
                )}
                {detailJob.board_status !== "linking" &&
                detailJob.board_status !== "approved" ? (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={pendingBusy}
                    onClick={() => void actPending(Number(detailJob.pending_id), "discard")}
                  >
                    Discard
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {addFor ? (
        <div
          className="day-board-detail-backdrop"
          role="presentation"
          onClick={() => !pendingBusy && setAddFor(null)}
        >
          <div
            className="day-board-detail card"
            role="dialog"
            aria-label="Add pending service job"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="day-board-detail-head">
              <h2>Pending · {addFor.display_name}</h2>
              <button
                type="button"
                className="btn secondary"
                disabled={pendingBusy}
                onClick={() => setAddFor(null)}
              >
                Close
              </button>
            </div>
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
              Parks on the board only. Approve later to link ServiceTitan (Confirms OFF).
            </p>
            <form className="form" onSubmit={(ev) => void submitPendingAdd(ev)}>
              <label>
                Customer *
                <input
                  required
                  minLength={2}
                  value={addForm.customer_name}
                  onChange={(e) =>
                    setAddForm({ ...addForm, customer_name: e.target.value })
                  }
                  placeholder="Name"
                  autoFocus
                />
              </label>
              <label>
                Phone
                <input
                  value={addForm.customer_phone}
                  onChange={(e) =>
                    setAddForm({ ...addForm, customer_phone: e.target.value })
                  }
                  placeholder="Optional"
                  inputMode="tel"
                />
              </label>
              <label>
                Address *
                <input
                  required
                  minLength={5}
                  value={addForm.address}
                  onChange={(e) => setAddForm({ ...addForm, address: e.target.value })}
                  placeholder="Maps-correct street"
                />
              </label>
              <label>
                Issue
                <input
                  value={addForm.issue}
                  onChange={(e) => setAddForm({ ...addForm, issue: e.target.value })}
                  placeholder="No Cool"
                />
              </label>
              <div className="form row">
                <label>
                  Start
                  <input
                    type="time"
                    value={addForm.window_start}
                    onChange={(e) =>
                      setAddForm({ ...addForm, window_start: e.target.value })
                    }
                  />
                </label>
                <label>
                  End
                  <input
                    type="time"
                    value={addForm.window_end}
                    onChange={(e) =>
                      setAddForm({ ...addForm, window_end: e.target.value })
                    }
                  />
                </label>
              </div>
              <div className="toolbar">
                <button className="btn" type="submit" disabled={pendingBusy}>
                  {pendingBusy ? "Saving…" : "Save pending"}
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={pendingBusy}
                  onClick={() => setAddFor(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type MatLine = {
  id: number;
  description: string;
  qty: number;
  status: string;
};

function JobMaterialsBlock({
  jobId,
  jobNumber,
  customerName,
  address,
  appointmentDate,
  canEdit,
  onChange,
}: {
  jobId: string;
  jobNumber: string | null;
  customerName: string | null;
  address: string | null;
  appointmentDate: string;
  canEdit: boolean;
  onChange: () => void;
}) {
  const [lines, setLines] = useState<MatLine[]>([]);
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const res = await api<{ lines: MatLine[] }>(
      `/materials/job/${encodeURIComponent(jobId)}`
    );
    setLines(res.lines || []);
  }, [jobId]);

  useEffect(() => {
    void load().catch(() => setLines([]));
  }, [load]);

  async function addLine(e: FormEvent) {
    e.preventDefault();
    if (!canEdit || desc.trim().length < 2) return;
    setBusy(true);
    setErr("");
    try {
      await api("/materials", {
        method: "POST",
        body: JSON.stringify({
          job_id: jobId,
          job_number: jobNumber,
          customer_name: customerName,
          address,
          appointment_date: appointmentDate,
          description: desc.trim(),
          qty: Number(qty) || 1,
          status: "needed",
        }),
      });
      setDesc("");
      setQty("1");
      await load();
      onChange();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not add");
    } finally {
      setBusy(false);
    }
  }

  const label = (s: string) =>
    s === "needed" ? "Needed" : s === "tbd" ? "Parts TBD" : s === "staged" ? "Staged" : s === "ordered" ? "Ordered" : s;

  return (
    <div style={{ marginTop: "0.85rem" }}>
      <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>Materials</h3>
      <p className="muted" style={{ margin: "0 0 0.4rem", fontSize: "0.82rem" }}>
        Pull, bag, label (job # + address + date), Next Day shelf, tap Staged.
      </p>
      {!lines.length ? <p className="muted">No materials flagged</p> : null}
      <ul style={{ margin: "0 0 0.5rem", paddingLeft: "1.1rem" }}>
        {lines.map((l) => (
          <li key={l.id}>
            {l.qty} x {l.description}{" "}
            <span className={`badge badge-sm ${l.status === "staged" ? "ok" : "warn"}`}>
              {label(l.status)}
            </span>
          </li>
        ))}
      </ul>
      {err ? <div className="error">{err}</div> : null}
      {canEdit ? (
        <form className="form" onSubmit={(e) => void addLine(e)}>
          <div className="form row">
            <label style={{ flex: "1 1 12rem" }}>
              Add materials
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="6 filters"
              />
            </label>
            <label style={{ flex: "0 0 5rem" }}>
              Qty
              <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
            </label>
          </div>
          <button className="btn btn-sm" type="submit" disabled={busy || desc.trim().length < 2}>
            {busy ? "Saving..." : "Add"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
