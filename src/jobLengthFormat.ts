/** Pure job-length math. Shared by the API, the office table, and the Day Board hint. */

export const JOB_LENGTH_MIN_MINUTES = 10;
export const JOB_LENGTH_MAX_MINUTES = 16 * 60;
export const JOB_LENGTH_MIN_SAMPLE = 5;

export function dropOutlierMinutes(values: number[]): number[] {
  return values.filter(
    (n) =>
      Number.isFinite(n) &&
      n >= JOB_LENGTH_MIN_MINUTES &&
      n <= JOB_LENGTH_MAX_MINUTES
  );
}

/** Sorted ascending. Even counts average the two middle values, then round. */
export function medianMinutes(sortedAsc: number[]): number | null {
  if (!sortedAsc.length) return null;
  const n = sortedAsc.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAsc[mid];
  return Math.round((sortedAsc[mid - 1] + sortedAsc[mid]) / 2);
}

/**
 * 80th percentile, nearest rank.
 * For 10 sorted jobs this is the 8th, so 8 of 10 finish at or under it.
 */
export function p80Minutes(sortedAsc: number[]): number | null {
  if (!sortedAsc.length) return null;
  const idx = Math.ceil(0.8 * sortedAsc.length) - 1;
  const clamped = Math.min(sortedAsc.length - 1, Math.max(0, idx));
  return sortedAsc[clamped];
}

export type LengthSummary = {
  jobs: number;
  median_minutes: number | null;
  p80_minutes: number | null;
};

/** Outlier drop, then the under-5 rule (median and p80 stay null). */
export function summarizeDurations(rawMinutes: number[]): LengthSummary {
  const kept = dropOutlierMinutes(rawMinutes).sort((a, b) => a - b);
  if (kept.length < JOB_LENGTH_MIN_SAMPLE) {
    return { jobs: kept.length, median_minutes: null, p80_minutes: null };
  }
  return {
    jobs: kept.length,
    median_minutes: medianMinutes(kept),
    p80_minutes: p80Minutes(kept),
  };
}

/**
 * ServiceTitan job-type `duration`.
 * This tenant stores seconds (1800 = 30 min, 7200 = 2 h).
 * Values that already look like minutes (30 through 16 h) stay minutes.
 * Values under 30 are treated as hours.
 */
export function stEstimateMinutes(row: { duration?: unknown; estimatedDuration?: unknown; durationMinutes?: unknown; estimatedDurationMinutes?: unknown }): number | null {
  const candidates = [row.duration, row.estimatedDuration, row.durationMinutes, row.estimatedDurationMinutes];
  for (const c of candidates) {
    const n = Number(c);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n > JOB_LENGTH_MAX_MINUTES && n <= JOB_LENGTH_MAX_MINUTES * 60) return Math.round(n / 60);
    if (n >= 30 && n <= JOB_LENGTH_MAX_MINUTES) return Math.round(n);
    if (n < 30) return Math.round(n * 60);
  }
  return null;
}

/** 135 -> "2 h 15 min". 60 -> "1 h". 45 -> "45 min". */
export function formatJobLengthMinutes(mins: number): string {
  const m = Math.round(mins);
  if (!Number.isFinite(m) || m < 0) return "";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (rem === 0) return `${h} h`;
  return `${h} h ${rem} min`;
}
