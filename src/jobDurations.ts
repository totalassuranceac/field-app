/**
 * Real on-site job lengths from ServiceTitan timesheets.
 * Static table, built 2026-10-02. No live ServiceTitan call.
 * Source text travels with the rows in src/data/jobDurations2026-10-02.json.
 */
import raw from "./data/jobDurations2026-10-02.json";
import { formatJobLengthMinutes } from "./jobLengthFormat";

export type JobDurationRow = {
  job_type: string;
  cls: string;
  jobs: number;
  median_minutes: number;
  mean_minutes: number;
  p75_minutes: number;
  crew_hours_mean: number;
  techs_mean: number;
  drive_minutes_mean: number;
  days_mean: number;
  multi_day_jobs: number;
  book_slot_minutes: number;
  low_sample: boolean;
};

type DurationFile = {
  source: string;
  built: string;
  jobs_in_averages: number;
  rows: JobDurationRow[];
};

const file = raw as DurationFile;

export const JOB_DURATIONS_SOURCE = file.source;
export const JOB_DURATIONS_BUILT = file.built;
export const JOB_DURATIONS_JOB_COUNT = file.jobs_in_averages;

/** Trim, case-fold, collapse whitespace, and treat " / " the same as "/". */
export function normalizeJobTypeName(name: string | null | undefined): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/");
}

const byName = new Map<string, JobDurationRow>();
for (const row of file.rows) {
  byName.set(normalizeJobTypeName(row.job_type), row);
}

export const JOB_DURATION_ROWS: readonly JobDurationRow[] = file.rows;

export function lookupJobDuration(jobTypeName: string | null | undefined): JobDurationRow | null {
  const key = normalizeJobTypeName(jobTypeName);
  if (!key) return null;
  return byName.get(key) || null;
}

/** days_mean >= 1.5 -> "over about N days". N is the rounded day count, at least 2. */
export function multiDayLabel(row: { days_mean: number }): string | null {
  if (!(row.days_mean >= 1.5)) return null;
  const n = Math.max(2, Math.round(row.days_mean));
  return `over about ${n} days`;
}

export function bookSlotLabel(row: JobDurationRow): string {
  const time = formatJobLengthMinutes(row.book_slot_minutes);
  const days = multiDayLabel(row);
  if (days) return `${time} total, ${days}`;
  return time;
}

function withFew(text: string, low: boolean): string {
  return low ? `${text} (few jobs)` : text;
}

export function usualCell(row: JobDurationRow): string {
  return withFew(formatJobLengthMinutes(row.median_minutes), row.low_sample);
}

export function longDayCell(row: JobDurationRow): string {
  return withFew(formatJobLengthMinutes(row.p75_minutes), row.low_sample);
}

export function bookSlotCell(row: JobDurationRow): string {
  return withFew(bookSlotLabel(row), row.low_sample);
}

/** Today card. Null when the type is unknown or the sample is thin. */
export function usualAboutLine(jobTypeName: string | null | undefined): string | null {
  const row = lookupJobDuration(jobTypeName);
  if (!row || row.low_sample) return null;
  const time = formatJobLengthMinutes(row.median_minutes);
  const days = multiDayLabel(row);
  if (days) return `Usually about ${time} total, ${days}`;
  return `Usually about ${time} on site`;
}

export function appointmentSpanMinutes(
  start: string | null | undefined,
  end: string | null | undefined
): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 60000);
}

/**
 * Office Day Board hint.
 * Solid sample: real median and book slot. Thin or unknown: booked-window fallback, or nothing.
 * Tight is display-only when the appointment start/end is shorter than the book slot.
 */
export function dayBoardUsualLine(
  jobTypeName: string | null | undefined,
  bookedWindowMinutes: number | null,
  windowStart?: string | null,
  windowEnd?: string | null
): string | null {
  const row = lookupJobDuration(jobTypeName);
  if (row && !row.low_sample) {
    let line = `Usually ${formatJobLengthMinutes(row.median_minutes)} \u00B7 book ${formatJobLengthMinutes(row.book_slot_minutes)}`;
    const span = appointmentSpanMinutes(windowStart, windowEnd);
    if (span != null && span < row.book_slot_minutes) line += " \u00B7 Tight";
    return line;
  }
  if (bookedWindowMinutes == null) return null;
  return `Booked about ${formatJobLengthMinutes(bookedWindowMinutes)}`;
}

/**
 * Display-only real median beside an estimate.
 * A thin sample is not shown as a measured time.
 */
export function realMedianNote(jobTypeName: string | null | undefined): string | null {
  const row = lookupJobDuration(jobTypeName);
  if (!row || row.low_sample) return null;
  const time = formatJobLengthMinutes(row.median_minutes);
  const days = multiDayLabel(row);
  if (days) return `Real: ${time} total, ${days}`;
  return `Real: ${time}`;
}
