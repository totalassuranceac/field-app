/**
 * Office view: how long each ServiceTitan job type took over a recent window.
 * Read-only. Job Clock arrive->complete when that sample is big enough,
 * otherwise finished appointment start/end (or actual arrive/done stamps
 * when the appointment row has them).
 */

import type { Env } from "./types";
import { ensureJobClockTables } from "./jobClock";
import { stApiGet, stConfigured, stTenantId } from "./servicetitan";
import {
  stEstimateMinutes,
  summarizeDurations,
  type LengthSummary,
} from "../src/jobLengthFormat";

export type JobLengthSource = "job clock" | "ST appointments";

export type JobLengthRow = {
  job_type_id: number;
  job_type_name: string;
  jobs: number;
  median_minutes: number | null;
  p80_minutes: number | null;
  st_estimate_minutes: number | null;
  source: JobLengthSource;
};

export type JobLengthsResponse = {
  days: number;
  source: JobLengthSource;
  generated_at: string;
  sample_count: number;
  types_with_median: number;
  rows: JobLengthRow[];
};

export class JobLengthsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobLengthsError";
  }
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PAGES = 20;
const PAGE_SIZE = 200;
const JOB_BATCH = 50;
const CONCURRENCY = 4;
const MIN_CLOCK_PAIRS = 5;

type CacheEntry = { at: number; body: JobLengthsResponse };
const cache = new Map<string, CacheEntry>();

type MinuteSample = { typeId: number; minutes: number; typeName: string | null };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function posNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function asRows(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter((row) => row && typeof row === "object") as Record<string, unknown>[];
}

function hasMore(json: unknown, rowCount: number): boolean {
  if (!json || typeof json !== "object") return false;
  const flag = (json as { hasMore?: boolean }).hasMore;
  if (flag === false) return false;
  if (flag === true) return true;
  return rowCount >= PAGE_SIZE;
}

function minutesBetween(startRaw: string, endRaw: string): number | null {
  if (!startRaw || !endRaw) return null;
  const a = Date.parse(startRaw);
  const b = Date.parse(endRaw);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000);
}

function firstStamp(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const s = str(row[k]);
    if (s) return s;
  }
  return "";
}

function isFinishedStatus(raw: string): boolean {
  const s = raw.toLowerCase().replace(/[_\s]/g, "");
  if (!s || s.includes("cancel")) return false;
  return s === "done" || s === "completed" || s === "complete" || s.includes("finish");
}

function typeIdOf(row: Record<string, unknown>): number | null {
  const direct = posNum(row.jobTypeId);
  if (direct) return direct;
  const jt = row.jobType;
  if (jt && typeof jt === "object") {
    const id = posNum((jt as Record<string, unknown>).id);
    if (id) return id;
  }
  const typeObj = row.type;
  if (typeObj && typeof typeObj === "object") {
    const id = posNum((typeObj as Record<string, unknown>).id);
    if (id) return id;
  }
  return null;
}

function typeNameOf(row: Record<string, unknown>): string | null {
  const direct = str(row.jobTypeName);
  if (direct) return direct;
  if (typeof row.jobType === "string" && row.jobType.trim()) return row.jobType.trim();
  const jt = row.jobType;
  if (jt && typeof jt === "object") {
    const name = str((jt as Record<string, unknown>).name);
    if (name) return name;
  }
  const typeObj = row.type;
  if (typeObj && typeof typeObj === "object") {
    const name = str((typeObj as Record<string, unknown>).name);
    if (name) return name;
  }
  if (typeof row.type === "string" && row.type.trim() && !/^\d+$/.test(row.type.trim())) {
    return row.type.trim();
  }
  return null;
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function jobClockSamples(
  db: D1Database,
  days: number
): Promise<{ jobId: number; minutes: number }[]> {
  await ensureJobClockTables(db);
  const res = await db
    .prepare(
      `SELECT st_job_id, step, client_ts, created_at
       FROM job_clock_events
       WHERE step IN ('arrive', 'complete')
         AND created_at >= datetime('now', ?)`
    )
    .bind(`-${days} days`)
    .all<{ st_job_id: string; step: string; client_ts: string; created_at: string }>();
  const byJob = new Map<number, { arrive: string[]; complete: string[] }>();
  for (const row of res.results || []) {
    const jobId = Number(row.st_job_id);
    if (!(jobId > 0)) continue;
    const stamp = (row.client_ts || row.created_at || "").trim();
    if (!stamp) continue;
    const bag = byJob.get(jobId) || { arrive: [], complete: [] };
    if (row.step === "arrive") bag.arrive.push(stamp);
    else if (row.step === "complete") bag.complete.push(stamp);
    byJob.set(jobId, bag);
  }
  const out: { jobId: number; minutes: number }[] = [];
  for (const [jobId, bag] of byJob) {
    const arrive = [...bag.arrive].sort();
    const complete = [...bag.complete].sort();
    if (!arrive.length || !complete.length) continue;
    const start = arrive[0];
    const end = complete.find((stamp) => stamp >= start) || "";
    const minutes = minutesBetween(start, end);
    if (minutes == null) continue;
    out.push({ jobId, minutes });
  }
  return out;
}

async function loadJobTypeCatalog(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<{ names: Map<number, string>; estimates: Map<number, number> }> {
  const names = new Map<number, string>();
  const estimates = new Map<number, number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/job-types?page=${page}&pageSize=${PAGE_SIZE}`
    );
    if (!res.ok) break;
    const rows = asRows(res.json);
    for (const row of rows) {
      const id = posNum(row.id);
      const name = str(row.name);
      if (!id || !name) continue;
      names.set(id, name);
      const est = stEstimateMinutes(row);
      if (est != null) estimates.set(id, est);
    }
    if (!rows.length || !hasMore(res.json, rows.length)) break;
  }
  return { names, estimates };
}

async function loadJobMeta(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobIds: number[]
): Promise<Map<number, { typeId: number | null; typeName: string | null }>> {
  const out = new Map<number, { typeId: number | null; typeName: string | null }>();
  const unique = [...new Set(jobIds.filter((id) => id > 0))];
  const chunks: number[][] = [];
  for (let i = 0; i < unique.length; i += JOB_BATCH) chunks.push(unique.slice(i, i + JOB_BATCH));
  await mapPool(chunks, CONCURRENCY, async (chunk) => {
    const q = new URLSearchParams({
      ids: chunk.join(","),
      pageSize: String(Math.max(chunk.length, 10)),
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
    if (!res.ok) {
      throw new JobLengthsError("ServiceTitan jobs could not be loaded.");
    }
    for (const row of asRows(res.json)) {
      const id = posNum(row.id);
      if (!id) continue;
      out.set(id, { typeId: typeIdOf(row), typeName: typeNameOf(row) });
    }
  });
  return out;
}

function appointmentMinutes(row: Record<string, unknown>): number | null {
  const actual = minutesBetween(
    firstStamp(row, ["arrivedOn", "actualStart", "actualArrival", "arrivedOnUtc"]),
    firstStamp(row, ["doneOn", "actualEnd", "completedOn", "doneOnUtc"])
  );
  if (actual != null && actual > 0) return actual;
  const scheduled = minutesBetween(str(row.start), str(row.end));
  if (scheduled != null && scheduled > 0) return scheduled;
  return null;
}

async function appointmentSamples(
  env: Env,
  db: D1Database,
  tenantId: string,
  days: number
): Promise<MinuteSample[]> {
  const fromMs = Date.now() - days * 24 * 3600 * 1000;
  const toMs = Date.now() + 24 * 3600 * 1000;
  const modifiedOnOrAfter = new Date(fromMs).toISOString();
  const pending: { jobId: number; typeId: number | null; typeName: string | null; minutes: number }[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({
      modifiedOnOrAfter,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/appointments?${q.toString()}`
    );
    if (!res.ok) {
      throw new JobLengthsError("ServiceTitan appointments could not be loaded.");
    }
    const rows = asRows(res.json);
    if (!rows.length) break;
    for (const row of rows) {
      const status = str(row.status) || str(row.appointmentStatus);
      if (!isFinishedStatus(status)) continue;
      const startRaw = str(row.start);
      const startMs = Date.parse(startRaw);
      if (!Number.isFinite(startMs) || startMs < fromMs || startMs > toMs) continue;
      const minutes = appointmentMinutes(row);
      if (minutes == null) continue;
      const jobId = posNum(row.jobId) || 0;
      pending.push({
        jobId,
        typeId: typeIdOf(row),
        typeName: typeNameOf(row),
        minutes,
      });
    }
    if (!hasMore(res.json, rows.length)) break;
  }

  const need = [...new Set(pending.filter((row) => !row.typeId && row.jobId > 0).map((row) => row.jobId))];
  const meta = need.length ? await loadJobMeta(env, db, tenantId, need) : new Map();
  const samples: MinuteSample[] = [];
  for (const row of pending) {
    let typeId = row.typeId;
    let typeName = row.typeName;
    if (!typeId && row.jobId > 0) {
      const hit = meta.get(row.jobId);
      typeId = hit?.typeId || null;
      if (!typeName) typeName = hit?.typeName || null;
    }
    if (!typeId) continue;
    samples.push({ typeId, typeName, minutes: row.minutes });
  }
  return samples;
}

function rowsFromSamples(
  samples: MinuteSample[],
  names: Map<number, string>,
  estimates: Map<number, number>,
  source: JobLengthSource
): JobLengthRow[] {
  const buckets = new Map<number, { minutes: number[]; name: string | null }>();
  for (const sample of samples) {
    const bag = buckets.get(sample.typeId) || { minutes: [], name: null };
    bag.minutes.push(sample.minutes);
    if (!bag.name && sample.typeName) bag.name = sample.typeName;
    buckets.set(sample.typeId, bag);
  }
  const rows: JobLengthRow[] = [];
  for (const [typeId, bag] of buckets) {
    const summary: LengthSummary = summarizeDurations(bag.minutes);
    if (summary.jobs < 1) continue;
    const name = names.get(typeId) || bag.name || `Job type ${typeId}`;
    rows.push({
      job_type_id: typeId,
      job_type_name: name,
      jobs: summary.jobs,
      median_minutes: summary.median_minutes,
      p80_minutes: summary.p80_minutes,
      st_estimate_minutes: estimates.get(typeId) ?? null,
      source,
    });
  }
  rows.sort((a, b) => a.job_type_name.localeCompare(b.job_type_name));
  return rows;
}

export async function buildJobLengths(
  env: Env,
  db: D1Database,
  daysInput: number
): Promise<JobLengthsResponse> {
  const days = Number.isFinite(daysInput) ? Math.min(90, Math.max(1, Math.round(daysInput))) : 90;
  const key = String(days);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;

  if (!(await stConfigured(env, db))) {
    throw new JobLengthsError("ServiceTitan is not connected.");
  }
  const tenantId = await stTenantId(env, db);
  if (!tenantId) throw new JobLengthsError("ServiceTitan is not connected.");

  const catalog = await loadJobTypeCatalog(env, db, tenantId);
  let source: JobLengthSource = "ST appointments";
  let samples: MinuteSample[] = [];

  const clock = await jobClockSamples(db, days);
  const clockKept = summarizeDurations(clock.map((row) => row.minutes)).jobs;
  if (clockKept >= MIN_CLOCK_PAIRS) {
    const meta = await loadJobMeta(
      env,
      db,
      tenantId,
      clock.map((row) => row.jobId)
    );
    const typed: MinuteSample[] = [];
    for (const row of clock) {
      const hitMeta = meta.get(row.jobId);
      if (!hitMeta?.typeId) continue;
      typed.push({ typeId: hitMeta.typeId, typeName: hitMeta.typeName, minutes: row.minutes });
    }
    if (summarizeDurations(typed.map((row) => row.minutes)).jobs >= MIN_CLOCK_PAIRS) {
      source = "job clock";
      samples = typed;
    }
  }

  if (source !== "job clock") {
    source = "ST appointments";
    samples = await appointmentSamples(env, db, tenantId, days);
  }

  const rows = rowsFromSamples(samples, catalog.names, catalog.estimates, source);
  const body: JobLengthsResponse = {
    days,
    source,
    generated_at: new Date().toISOString(),
    sample_count: rows.reduce((sum, row) => sum + row.jobs, 0),
    types_with_median: rows.filter((row) => row.median_minutes != null).length,
    rows,
  };
  cache.set(key, { at: Date.now(), body });
  return body;
}
