import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

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
  status: string | null;
  is_done: boolean;
  is_off?: boolean;
  ink?: "st" | "board";
  note: string | null;
  helpers?: string[];
};

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
  message?: string;
  error?: string;
};
type DayBoardReminder = {
  id: number;
  board_date: string;
  body: string;
  created_by_user_id: number | null;
  created_at: string;
  completed_at: string | null;
  completed_by_user_id: number | null;
};

type DayBoardRemindersResponse = {
  date: string;
  can_edit: boolean;
  items: DayBoardReminder[];
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

function formatWindow(start: string | null, end: string | null): string {
  const fmt = (iso: string) => {
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
  };
  const a = start ? fmt(start) : "";
  const b = end ? fmt(end) : "";
  if (a && b) return `${a}–${b}`;
  return a || b || "";
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
    n === "chris marroquin" ||
    n === "chris brady"
  ) {
    return true;
  }
  if (
    n.startsWith("chris miller") ||
    n.startsWith("chris marroquin") ||
    n.startsWith("chris brady")
  ) {
    return true;
  }
  if (/\bmiller\b/.test(n) && /\bchris\b/.test(n)) return true;
  if (/\bmarroquin\b/.test(n) && /\bchris\b/.test(n)) return true;
  if (/\bbrady\b/.test(n) && /\bchris\b/.test(n)) return true;
  return false;
}

/**
 * Same street → one Install row with joined names (Williams/Ortiz Montes).
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
  phone: string;
  title: string;
} {
  const street = (j.address || "").replace(/\s+/g, " ").trim();
  const cust = (j.customer_name || "").replace(/\s+/g, " ").trim();
  const type = (j.job_type || "").replace(/\s+/g, " ").trim();
  const note = (j.note || "").replace(/\s+/g, " ").trim();
  const phone = (j.customer_phone || "").replace(/\s+/g, " ").trim();
  const when = formatWindow(j.window_start, j.window_end);
  let work = [type, note].filter(Boolean).join(" / ");
  // Prefer full street; shorten work before cutting street
  const MAX_WORK = 56;
  if (work.length > MAX_WORK) {
    work = `${work.slice(0, MAX_WORK - 1).trimEnd()}…`;
  }
  // Street wins; customer only when no street; "no address" only when truly empty
  const place = street || cust || "no address";
  const title = [
    street || (cust ? `${cust} (no street on file)` : "no address"),
    j.address_source ? `[${j.address_source}]` : null,
    j.customer_name,
    j.job_type,
    j.note,
    when,
    j.customer_phone,
    j.job_number ? `Job #${j.job_number}` : j.st_job_id ? `Job ${j.st_job_id}` : null,
    j.status,
  ]
    .filter(Boolean)
    .join(" · ");
  return { street: place, work, when, phone, title };
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
function shortBoardLabel(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.includes("/")) {
    return t
      .split("/")
      .map((p) => shortBoardLabel(p.trim()))
      .filter(Boolean)
      .join("/");
  }
  const parts = t.split(/\s+/).filter(Boolean);
  const first = parts[0] || t;
  if (first.toLowerCase() === "chris" && parts.length === 1) return "";
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1];
  return `${first} ${last.charAt(0).toUpperCase()}`;
}

/** Single horizontal label string for the sticky name column. Never bare Chris. */
function boardNameLabel(display: string): string {
  const s = shortBoardLabel(display);
  // Do not fall back to raw display — that reintroduces bare "Chris"
  return s;
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
 * Soft-refresh can clear an individual’s PTO (D1 blip / race) while other rows
 * still look fine. Per-user: if next lost PTO for a user that prev had, keep it.
 * Weekends stay empty. Force reload (prev=null) trusts the server.
 */
function stickDayBoardPto(
  prev: DayBoardResponse | null,
  next: DayBoardResponse
): DayBoardResponse {
  if (!prev || prev.date !== next.date) return next;
  if (isChicagoWeekendIso(next.date)) return next;
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

export function DayBoardPage() {
  const { user } = useAuth();
  const allowed = can(user, "viewDayBoard");
  const [date, setDate] = useState(todayIso);
  const [data, setData] = useState<DayBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reminders, setReminders] = useState<DayBoardReminder[]>([]);
  const [remindersCanEdit, setRemindersCanEdit] = useState(false);
  const [reminderDraft, setReminderDraft] = useState("");
  const [reminderBusy, setReminderBusy] = useState(false);
  const [detailJob, setDetailJob] = useState<DayBoardJob | null>(null);
  const cacheRef = useRef<Map<string, DayBoardResponse>>(new Map());
  const prefetchGen = useRef(0);

  const fetchDay = useCallback(async (day: string): Promise<DayBoardResponse> => {
    const res = await api<DayBoardResponse>(
      `/day-board?date=${encodeURIComponent(day)}`,
      { timeoutMs: 60_000 }
    );
    return res;
  }, []);

  const commitDay = useCallback((day: string, res: DayBoardResponse, prev: DayBoardResponse | null) => {
    const sticky = stickDayBoardPto(prev, res);
    cacheRef.current.set(day, sticky);
    if (sticky.date && sticky.date !== day) cacheRef.current.set(sticky.date, sticky);
    return sticky;
  }, []);

  const load = useCallback(async (day: string, opts?: { force?: boolean }) => {
    if (!allowed) return;
    const cached = !opts?.force ? cacheRef.current.get(day) : undefined;
    if (cached) {
      setData(cached);
      setError(cached.error && !(cached.rows || []).length ? cached.error : "");
      setLoading(false);
      // soft refresh in background — keep PTO if refresh drops it
      void fetchDay(day)
        .then((res) => {
          setData((prev) => {
            const sticky = commitDay(day, res, prev?.date === day ? prev : cached);
            if (res.error && !(sticky.rows || []).length) setError(res.error);
            else setError("");
            return sticky;
          });
        })
        .catch(() => { /* keep cache */ });
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetchDay(day);
      const sticky = commitDay(day, res, null);
      setData(sticky);
      if (sticky.date && sticky.date !== day) setDate(sticky.date);
      if (res.error && !(sticky.rows || []).length) setError(res.error);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Could not load day board");
    } finally {
      setLoading(false);
    }
  }, [allowed, fetchDay, commitDay]);

  const prefetchWeek = useCallback(async (center: string) => {
    if (!allowed) return;
    const gen = ++prefetchGen.current;
    const days = [-3, -2, -1, 1, 2, 3].map((n) => shiftIso(center, n));
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
  }, [allowed, fetchDay, commitDay]);

  const loadReminders = useCallback(async (day: string) => {
    if (!allowed) return;
    try {
      const res = await api<DayBoardRemindersResponse>(
        `/day-board/reminders?date=${encodeURIComponent(day)}`
      );
      setReminders(res.items || []);
      setRemindersCanEdit(!!res.can_edit);
    } catch {
      setReminders([]);
      setRemindersCanEdit(false);
    }
  }, [allowed]);

  useEffect(() => {
    void load(date);
    void prefetchWeek(date);
  }, [date, load, prefetchWeek]);

  useEffect(() => {
    void loadReminders(date);
  }, [date, loadReminders]);

  async function addReminder() {
    const text = reminderDraft.replace(/\s+/g, " ").trim();
    if (!text || reminderBusy) return;
    setReminderBusy(true);
    try {
      await api(`/day-board/reminders`, {
        method: "POST",
        body: JSON.stringify({ date, body: text }),
      });
      setReminderDraft("");
      await loadReminders(date);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save reminder");
    } finally {
      setReminderBusy(false);
    }
  }

  async function completeReminder(id: number) {
    if (reminderBusy) return;
    setReminderBusy(true);
    try {
      await api(`/day-board/reminders/${id}/complete`, { method: "POST" });
      await loadReminders(date);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete reminder");
    } finally {
      setReminderBusy(false);
    }
  }


  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Day board</h1>
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

  return (
    <div className="page day-board-page">
      <header className="page-header day-board-page-header">
        <div>
          <h1>Day board</h1>
          <p className="muted">
            {isOffice ? "All techs · live ServiceTitan" : "Your day · live ServiceTitan"}
            {" · "}
            sheet backup only when the app is down
          </p>
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
            ◀
          </button>
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
          <button
            type="button"
            className="btn secondary day-board-date-step"
            onClick={() => setDate((d) => shiftIso(d, 1))}
            aria-label="Next day"
          >
            ▶
          </button>
        
          {loading ? (
            <span className="day-board-date-loading" aria-live="polite">
              Loading…
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
      </div>

      <div className="day-board-reminders is-compact" aria-label="Day reminders">
        <div className="day-board-reminders-head">
          <span className="day-board-reminders-title">Reminders</span>
          <span className="muted day-board-reminders-sub">{date}</span>
        </div>
        {reminders.length === 0 ? null : (
          <ul className="day-board-reminders-list">
            {reminders.map((r) => (
              <li key={r.id} className="day-board-reminder">
                <span className="day-board-reminder-body">{r.body}</span>
                {remindersCanEdit ? (
                  <button
                    type="button"
                    className="btn secondary day-board-reminder-done"
                    disabled={reminderBusy}
                    onClick={() => void completeReminder(r.id)}
                    aria-label="Mark reminder done"
                  >
                    Done
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {remindersCanEdit ? (
          <form
            className="day-board-reminders-add"
            onSubmit={(e) => {
              e.preventDefault();
              void addReminder();
            }}
          >
            <input
              type="text"
              value={reminderDraft}
              onChange={(e) => setReminderDraft(e.target.value)}
              placeholder="Add reminder…"
              maxLength={500}
              aria-label="New day reminder"
            />
            <button type="submit" className="btn" disabled={reminderBusy || !reminderDraft.trim()}>
              Add
            </button>
          </form>
        ) : reminders.length === 0 ? (
          <p className="muted day-board-reminders-empty">No reminders</p>
        ) : null}
      </div>

      {error && (
        <div className="error" style={{ marginBottom: "0.75rem" }}>
          {error}
        </div>
      )}

      {data?.message && !error ? (
        <p className="muted day-board-msg">{data.message}</p>
      ) : null}

      {loading && !data ? <p className="muted">Loading board…</p> : null}

      {(() => {
        const all = (data?.rows || []).filter((r) => {
          if (isHiddenChrisRow(r.display_name)) return false;
          // Drop rows that would render with no usable name (bare Chris → "")
          const label = boardNameLabel(r.display_name);
          return Boolean(label);
        });
        const service = all.filter((r) => (r.crew || "service") !== "install");
        const install = mergeInstallSameAddress(
          all.filter((r) => r.crew === "install")
        );
        // Disambiguate John Williams vs John Alvarado (and any other shared firsts)
        const renderRows = (list: DayBoardTechRow[], label: string) => (
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
                  const nameLabel = boardNameLabel(row.display_name);
                  return (
                    <div
                      key={`${row.st_technician_id || "x"}-${
                        row.user_id || row.display_name
                      }`}
                      className={`day-board-row${
                        row.is_self ? " is-self" : ""
                      }${blocked ? " is-pto-blocked" : ""}`}
                      role="row"
                    >
                      <div
                        className="day-board-tech"
                        role="rowheader"
                        title={row.display_name}
                      >
                        <span className="day-board-tech-name">{nameLabel}</span>
                      </div>
                      <div
                        className={`day-board-jobs${
                          label === "Install" ? " is-timeline" : ""
                        }${blocked ? " is-pto-span" : ""}`}
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
                          !row.jobs.length ? (
                            <div className="day-board-install-empty muted">
                              No install jobs
                            </div>
                          ) : (
                            <div
                              className="day-board-timeline"
                              style={{
                                ["--install-lanes" as string]: Math.max(
                                  1,
                                  buildInstallBars(row.jobs).reduce(
                                    (m, b) => Math.max(m, b.lane + 1),
                                    1
                                  )
                                ),
                              }}
                            >
                              {buildInstallBars(row.jobs).map((b) => {
                                const j = b.job;
                                const ink =
                                  j.ink === "board" ? "ink-board" : "ink-st";
                                const parts = installBarParts(j);
                                // STREET — work · time · phone  (job # hover-only)
                                const mid = [parts.work, parts.when]
                                  .filter(Boolean)
                                  .join(" · ");
                                const trail = parts.phone
                                  ? `${mid ? " · " : ""}${parts.phone}`
                                  : "";
                                return (
                                  <button
                                    type="button"
                                    key={j.st_appointment_id}
                                    className={`day-board-bar is-miller ${ink}${
                                      j.is_done ? " is-done" : ""
                                    }${j.is_off ? " is-off" : ""}${
                                      (() => {
                                        const streets = new Set(
                                          (row.jobs || [])
                                            .map((x) => normBoardStreet(x.address))
                                            .filter(Boolean)
                                        );
                                        return streets.size <= 1 ? " is-fullspan" : "";
                                      })()
                                    }`}
                                    style={{
                                      left: `${b.leftPct}%`,
                                      width: `${b.widthPct}%`,
                                      top: `calc(${b.lane} * (100% / var(--install-lanes)))`,
                                      height: `calc(100% / var(--install-lanes) - 2px)`,
                                    }}
                                    title={parts.title}
                                    onClick={() => setDetailJob(j)}
                                  >
                                    <span className="day-board-miller-line">
                                      <span className="day-board-miller-street">
                                        {parts.street}
                                      </span>
                                      {mid || trail ? (
                                        <span className="day-board-miller-detail">
                                          {mid ? `— ${mid}` : ""}
                                          {trail}
                                        </span>
                                      ) : null}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )
                        ) : (
                          jobsToSlots(row.jobs).map((j, i) => {
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
                            return (
                              <button
                                type="button"
                                key={j.st_appointment_id}
                                className={`day-board-cell ${ink}${
                                  j.is_done ? " is-done" : ""
                                }${j.is_off ? " is-off" : ""}`}
                                title={[
                                  j.address ||
                                    (j.customer_name
                                      ? `${j.customer_name} (no street on file)`
                                      : "no address"),
                                  j.address_source ? `[${j.address_source}]` : null,
                                  j.customer_name,
                                  j.status,
                                  j.customer_phone,
                                  j.note,
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
                                <span className="day-board-cell-main">{primary}</span>
                                <span className="day-board-cell-meta">
                                  {formatWindow(j.window_start, j.window_end) || "—"}
                                </span>
                                {(j.job_type || j.note) && (
                                  <span className="day-board-cell-work">
                                    {[j.job_type, j.note].filter(Boolean).join(" / ")}
                                  </span>
                                )}
                                {j.customer_phone ? (
                                  <span className="day-board-cell-loc">
                                    <span className="day-board-cell-phone">
                                      {j.customer_phone}
                                    </span>
                                  </span>
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

        return (
          <>
            <div className="day-board-guide is-compact" aria-label="Day board legend">
              <div className="day-board-legend-chips">
                <span className="day-board-chip-legend ink-board">
                  Black = not in ST yet
                </span>
                <span className="day-board-chip-legend ink-st">Blue = in ST</span>
                <span className="day-board-chip-legend is-done-chip">
                  Yellow = done in field
                </span>
              </div>
              <p className="day-board-legend-line muted">
                Service = slots · Install = hour bar
              </p>
            </div>
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
                {detailJob.address_source ? (
                  <span className="muted" style={{ display: "block", fontSize: "0.85em" }}>
                    source: {detailJob.address_source}
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
              <dd>{truncateNote(detailJob.note, 400) || "—"}</dd>
              <dt>Status</dt>
              <dd>{detailJob.status || "—"}</dd>
            </dl>
          </div>
        </div>
      ) : null}
    </div>
  );
}
