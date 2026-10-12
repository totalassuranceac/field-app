/**
 * Install book auto-When — duration + stack helpers (America/Chicago).
 * Soft: no ST writes. Book payload still uses arrival_window_id (+ custom).
 */
export type MillerWindowDef = {
  id: string;
  label: string;
  startMin: number;
  endMin: number;
};

/** Mirror worker MILLER_ARRIVAL_WINDOWS (non-custom). */
export const MILLER_ARRIVAL_WINDOW_DEFS: MillerWindowDef[] = [
  { id: "615-8", label: "6:15-8", startMin: 6 * 60 + 15, endMin: 8 * 60 },
  { id: "801-10", label: "8:01-10", startMin: 8 * 60 + 1, endMin: 10 * 60 },
  { id: "1001-12", label: "10:01-12", startMin: 10 * 60 + 1, endMin: 12 * 60 },
  { id: "1201-2", label: "12:01-2", startMin: 12 * 60 + 1, endMin: 14 * 60 },
  { id: "201-4", label: "2:01-4", startMin: 14 * 60 + 1, endMin: 16 * 60 },
];

const FIRST_MORNING_START = 8 * 60 + 1;
const SHOP_END_MIN = 16 * 60;

export type DurationSource = "avg" | "estimated" | "heuristic";

export type DurationInfo = {
  minutes: number;
  source: DurationSource;
  /** e.g. "~4.5h avg" or "~4h" */
  hoursLabel: string;
};

export type JobTypeDurationMeta = {
  id: number;
  name: string;
  duration_minutes?: number | null;
  avg_minutes?: number | null;
  estimated_minutes?: number | null;
  duration_source?: DurationSource | string | null;
};

export type BoardJobLite = {
  window_start: string | null;
  window_end: string | null;
  status?: string | null;
  is_off?: boolean;
  st_phase?: string | null;
  is_done?: boolean;
};

export type BoardRowLite = {
  display_name: string;
  st_technician_id: number | null;
  jobs: BoardJobLite[];
};

export type AutoWhenSuggestion = {
  arrival_window_id: string;
  custom_start: string;
  custom_end: string;
  /** Big sticky summary, e.g. "First free · 8:01–12" */
  summary: string;
  startMin: number;
  endMin: number;
  duration: DurationInfo;
  /** How many same-day jobs already on selected techs (unique appts approx). */
  existingJobCount: number;
};

/** Name-heuristic install defaults (minutes) when avg + ST estimated missing. */
export function heuristicDurationMinutes(jobTypeName: string): number {
  const n = String(jobTypeName || "").toLowerCase();
  if (/change[\s\-]?out|full\s*system|package\s*unit/.test(n)) return 6 * 60;
  if (/new\s*const|nc\s*install|(^|[^a-z])nc([^a-z]|$)/.test(n)) return 5 * 60;
  if (/duct/.test(n)) return 4 * 60;
  if (/furnace|condenser|air[\s\-]?handler|\bah\b|a\/h|coil|heat[\s\-]?pump/.test(n)) {
    return 4 * 60;
  }
  return 4 * 60;
}

function hoursLabelFor(minutes: number, source: DurationSource): string {
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  const core = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  if (source === "avg") return `~${core}h avg`;
  return `~${core}h`;
}

/**
 * Duration priority (Chris LOCK):
 * 1) completed-job average minutes for that job type
 * 2) ST job-type estimated/duration
 * 3) name heuristic
 */
export function resolveJobTypeDuration(jobType: JobTypeDurationMeta | null | undefined): DurationInfo {
  if (!jobType) {
    const minutes = 4 * 60;
    return { minutes, source: "heuristic", hoursLabel: hoursLabelFor(minutes, "heuristic") };
  }
  const avg = Number(jobType.avg_minutes);
  if (Number.isFinite(avg) && avg >= 30 && avg <= 16 * 60) {
    const minutes = Math.round(avg);
    return { minutes, source: "avg", hoursLabel: hoursLabelFor(minutes, "avg") };
  }
  if (jobType.duration_source === "avg") {
    const d = Number(jobType.duration_minutes);
    if (Number.isFinite(d) && d >= 30 && d <= 16 * 60) {
      const minutes = Math.round(d);
      return { minutes, source: "avg", hoursLabel: hoursLabelFor(minutes, "avg") };
    }
  }
  const estimated =
    Number(jobType.estimated_minutes) ||
    (jobType.duration_source === "estimated" ? Number(jobType.duration_minutes) : NaN);
  if (Number.isFinite(estimated) && estimated >= 30 && estimated <= 16 * 60) {
    const minutes = Math.round(estimated);
    return { minutes, source: "estimated", hoursLabel: hoursLabelFor(minutes, "estimated") };
  }
  const raw = Number(jobType.duration_minutes);
  if (Number.isFinite(raw) && raw >= 30 && raw <= 16 * 60 && jobType.duration_source !== "heuristic") {
    const minutes = Math.round(raw);
    const source: DurationSource =
      jobType.duration_source === "avg"
        ? "avg"
        : jobType.duration_source === "estimated"
          ? "estimated"
          : "estimated";
    return { minutes, source, hoursLabel: hoursLabelFor(minutes, source) };
  }
  const minutes = heuristicDurationMinutes(jobType.name || "");
  return { minutes, source: "heuristic", hoursLabel: hoursLabelFor(minutes, "heuristic") };
}

/** YYYY-MM-DD → weekday short in America/Chicago (Sun..Sat). */
export function chicagoWeekdayShort(dateIso: string): string {
  const [y, m, d] = String(dateIso || "").split("-").map(Number);
  if (!y || !m || !d) return "";
  // 17:00 UTC ≈ noon CT year-round enough for calendar weekday
  const utc = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      weekday: "short",
    }).format(utc);
  } catch {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][utc.getUTCDay()] || "";
  }
}

export function isChicagoWednesday(dateIso: string): boolean {
  return chicagoWeekdayShort(dateIso) === "Wed";
}

/**
 * Omar Camacho — standing Off every Wednesday (owner agreement).
 * Match carefully: FA user_id 15 and/or Omar Camacho name. No ST PTO writes.
 */
export function isOmarCamachoTech(t: {
  user_id?: number | null;
  display_name?: string | null;
  standing_off_weekday?: number | null;
}): boolean {
  if (Number(t.standing_off_weekday) === 3) return true;
  if (Number(t.user_id) === 15) return true;
  const n = String(t.display_name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return false;
  if (n === "omar camacho" || n === "omar j camacho") return true;
  if (n.startsWith("omar") && n.includes("camacho")) return true;
  return false;
}

export function techOffOnInstallBookDate(
  t: {
    user_id?: number | null;
    display_name?: string | null;
    standing_off_weekday?: number | null;
  },
  dateIso: string
): boolean {
  if (!isOmarCamachoTech(t)) return false;
  return isChicagoWednesday(dateIso);
}

function chicagoMinutesFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(new Date(t))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value])
    ) as { hour?: string; minute?: string };
    let hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (hour === 24) hour = 0;
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isCanceledOrSkipJob(j: BoardJobLite): boolean {
  if (j.is_off) return true;
  const phase = String(j.st_phase || "").toLowerCase();
  if (phase === "canceled" || phase === "off") return true;
  const s = String(j.status || "")
    .toLowerCase()
    .replace(/_/g, " ");
  if (!s) return false;
  return s.includes("cancel") || s === "off" || s.includes("pto");
}

/** Format minutes → wall label: 8:01, 12, 2, 10:01 */
export function formatWallClock(minTotal: number): string {
  let m = Math.round(minTotal);
  while (m < 0) m += 24 * 60;
  m = m % (24 * 60);
  let h = Math.floor(m / 60);
  const mins = m % 60;
  const h12 = ((h + 11) % 12) + 1;
  if (mins === 0) return String(h12);
  return `${h12}:${String(mins).padStart(2, "0")}`;
}


function matchExactWindow(startMin: number, endMin: number): MillerWindowDef | null {
  for (const w of MILLER_ARRIVAL_WINDOW_DEFS) {
    if (Math.abs(w.startMin - startMin) <= 2 && Math.abs(w.endMin - endMin) <= 15) {
      return w;
    }
  }
  return null;
}

function firstName(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return (t.split(/\s+/)[0] || "").trim();
}

/**
 * Auto stack for Miller crews (1–2 jobs/day, rarely 3):
 * empty → first morning window that fits duration
 * 1 job → second in line after latest end
 * 2 jobs → third after latest end
 */
export function suggestAutoWhen(opts: {
  dateIso: string;
  jobType: JobTypeDurationMeta | null | undefined;
  selectedTechIds: number[];
  boardRows: BoardRowLite[] | null | undefined;
}): AutoWhenSuggestion {
  const duration = resolveJobTypeDuration(opts.jobType);
  const selected = new Set(
    (opts.selectedTechIds || []).map(Number).filter((n) => n > 0)
  );

  const ends: number[] = [];
  const morningNames: string[] = [];
  const seenAppt = new Set<string>();
  let existingJobCount = 0;

  for (const row of opts.boardRows || []) {
    const st = Number(row.st_technician_id);
    if (!(st > 0) || !selected.has(st)) continue;
    for (const j of row.jobs || []) {
      if (isCanceledOrSkipJob(j)) continue;
      const key = `${j.window_start || ""}|${j.window_end || ""}|${row.st_technician_id}`;
      const endM = chicagoMinutesFromIso(j.window_end) ?? chicagoMinutesFromIso(j.window_start);
      if (endM == null) continue;
      if (!seenAppt.has(key)) {
        seenAppt.add(key);
        existingJobCount += 1;
      }
      ends.push(endM);
      const startM = chicagoMinutesFromIso(j.window_start);
      if (startM != null && startM < 12 * 60) {
        const fn = firstName(row.display_name);
        if (fn && !morningNames.includes(fn)) morningNames.push(fn);
      }
    }
  }

  // Unique jobs across paired techs: re-count by start|end only (shared appt)
  const uniqueKeys = new Set<string>();
  for (const row of opts.boardRows || []) {
    const st = Number(row.st_technician_id);
    if (!(st > 0) || !selected.has(st)) continue;
    for (const j of row.jobs || []) {
      if (isCanceledOrSkipJob(j)) continue;
      uniqueKeys.add(`${j.window_start || ""}|${j.window_end || ""}`);
    }
  }
  existingJobCount = uniqueKeys.size;

  let startMin: number;
  let narrative: "first" | "after_morning" | "stack";

  if (!ends.length || !selected.size) {
    startMin = FIRST_MORNING_START;
    narrative = "first";
  } else {
    const latestEnd = Math.max(...ends);
    const after = MILLER_ARRIVAL_WINDOW_DEFS.find((w) => w.startMin > latestEnd);
    startMin = after ? after.startMin : Math.max(latestEnd + 1, FIRST_MORNING_START);
    narrative =
      existingJobCount <= 1 && Math.min(...ends) < 12 * 60
        ? "after_morning"
        : "stack";
  }

  // Empty day: first morning window that fits duration (end ≤ shop end when possible)
  if (narrative === "first") {
    let placed = false;
    for (const w of MILLER_ARRIVAL_WINDOW_DEFS) {
      if (w.startMin < FIRST_MORNING_START) continue;
      if (w.startMin + duration.minutes <= SHOP_END_MIN + 30) {
        startMin = w.startMin;
        placed = true;
        break;
      }
    }
    if (!placed) startMin = FIRST_MORNING_START;
  }

  let endMin = startMin + duration.minutes;
  if (endMin <= startMin) endMin = startMin + 2 * 60;

  const exact = matchExactWindow(startMin, endMin);
  const arrival_window_id = exact ? exact.id : "custom";
  const custom_start = formatWallClock(startMin);
  const custom_end = formatWallClock(endMin);
  const span = `${formatWallClock(startMin)}–${formatWallClock(endMin)}`;

  const weekday = chicagoWeekdayShort(opts.dateIso);
  const avgPrefix = duration.source === "avg" ? `${duration.hoursLabel} · ` : "";

  let summary: string;
  if (narrative === "first") {
    summary = `${avgPrefix}First free · ${span}`;
  } else if (narrative === "after_morning") {
    if (morningNames.length) {
      const who = morningNames.slice(0, 2).join("+");
      summary = `${avgPrefix}${weekday} · ${span} · after ${who} morning`;
    } else {
      summary = `${avgPrefix}After morning · ${span}`;
    }
  } else {
    if (morningNames.length) {
      const who = morningNames.slice(0, 2).join("+");
      summary = `${avgPrefix}${weekday} · ${span} · after ${who}`;
    } else {
      summary = `${avgPrefix}After latest · ${span}`;
    }
  }

  return {
    arrival_window_id,
    custom_start,
    custom_end,
    summary,
    startMin,
    endMin,
    duration,
    existingJobCount,
  };
}
