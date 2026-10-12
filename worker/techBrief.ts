/**
 * Pre-job brief. ServiceTitan reads only. Each read soft-fails.
 * Cache uses tech_brief_cache when migration 113 is applied. Without it, builds every time.
 */
import { getSetting } from "./audit";
import { scoreAddressMatch } from "./addressFuzzy";
import { evaluatePermitGate } from "./installPermitGate";
import { formatAddress } from "./jobClock";
import { jobNotesFor, type JobNote } from "./jobNoteRules";
import { stApiGet, stTenantId } from "./servicetitan";
import { extractAccessCode, enrichCustomerNames, enrichJobsWithSite } from "./stJobSiteEnrich";
import { buildBriefLines } from "./techBriefPlan";
import type { Env } from "./types";

export type EquipmentSnap = {
  id?: number;
  st_job_id?: string;
  st_location_id?: string | null;
  unit_role: string;
  manufacturer: string | null;
  model_number: string | null;
  serial_number: string | null;
  mfg_year: number | null;
  mfg_month: number | null;
  tonnage: number | null;
  refrigerant_hint: string | null;
  decode_confidence?: string;
  source?: string;
  created_at?: string;
};

export type TechBrief = {
  st_job_id: string;
  job_number: string | null;
  built_at: string;
  cached: boolean;
  lines: string[];
  notes: JobNote[];
  past_jobs: { job_number: string | null; date: string | null; job_type: string | null; summary: string | null }[];
  warranty: { log_number: string; part_name: string | null; status: string }[];
  equipment: EquipmentSnap[];
  open_estimates: { count: number; names: string[] };
  ai_text: string | null;
  ai_model: string | null;
  missing: string[];
};

const CLOSED_WARRANTY = new Set(["approved", "rejected", "not_warranty"]);

function ascii(s: unknown, max: number): string {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normAddr(s: string | null | undefined): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function solderIds(raw: string): number[] {
  const ids = String(raw || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  return ids.length ? ids : [339591774, 336193175];
}

function ageYears(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 40 ? Math.round(n) : 12;
}

export async function tableExists(db: D1Database, name: string): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .bind(name)
      .first<{ ok: number }>();
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function jobTypeNameOf(job: Record<string, unknown> | null): string | null {
  if (!job) return null;
  if (typeof job.jobTypeName === "string" && job.jobTypeName.trim()) return job.jobTypeName.trim();
  if (typeof job.jobType === "string" && job.jobType.trim()) return job.jobType.trim();
  if (job.jobType && typeof job.jobType === "object") {
    const n = (job.jobType as Record<string, unknown>).name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return null;
}

function textOf(job: Record<string, unknown> | null, key: string): string | null {
  const v = job?.[key];
  return typeof v === "string" ? v : null;
}

async function loadJobTypeNames(env: Env, db: D1Database, tenant: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    for (let page = 1; page <= 3; page++) {
      const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenant}/job-types?page=${page}&pageSize=200`);
      if (!res.ok) break;
      const body = asRecord(res.json);
      const rows = (body?.data as Array<{ id?: number; name?: string }> | undefined) || [];
      for (const row of rows) {
        const id = Number(row.id);
        const name = typeof row.name === "string" ? row.name.trim() : "";
        if (id > 0 && name) map.set(id, name);
      }
      if (!body?.hasMore) break;
    }
  } catch {
    /* soft */
  }
  return map;
}

async function readCache(db: D1Database, stJobId: string): Promise<{ built_at: string; brief_json: string; ai_text: string | null; ai_model: string | null } | null> {
  if (!(await tableExists(db, "tech_brief_cache"))) return null;
  try {
    return await db
      .prepare(`SELECT built_at, brief_json, ai_text, ai_model FROM tech_brief_cache WHERE st_job_id = ?`)
      .bind(stJobId)
      .first();
  } catch {
    return null;
  }
}

function fromCache(row: { built_at: string; brief_json: string; ai_text: string | null; ai_model: string | null }, stJobId: string): TechBrief {
  let parsed: Partial<TechBrief> = {};
  try {
    parsed = JSON.parse(row.brief_json) as Partial<TechBrief>;
  } catch {
    parsed = {};
  }
  return {
    st_job_id: stJobId,
    job_number: parsed.job_number ?? null,
    built_at: row.built_at,
    cached: true,
    lines: parsed.lines || [],
    notes: parsed.notes || [],
    past_jobs: parsed.past_jobs || [],
    warranty: parsed.warranty || [],
    equipment: parsed.equipment || [],
    open_estimates: parsed.open_estimates || { count: 0, names: [] },
    ai_text: row.ai_text,
    ai_model: row.ai_model,
    missing: parsed.missing || [],
  };
}

export async function buildTechBrief(
  env: Env,
  db: D1Database,
  stJobId: string,
  opts: { refresh: boolean; limitRefresh: boolean }
): Promise<TechBrief> {
  const cached = await readCache(db, stJobId);
  if (cached?.built_at) {
    const age = Date.now() - Date.parse(cached.built_at);
    const fresh = Number.isFinite(age) && age >= 0 && age < 30 * 60 * 1000;
    const limited = opts.limitRefresh && Number.isFinite(age) && age >= 0 && age < 5 * 60 * 1000;
    if ((opts.refresh && limited) || (!opts.refresh && fresh)) return fromCache(cached, stJobId);
  }

  const now = new Date();
  const missing: string[] = [];
  const tenant = await stTenantId(env, db).catch(() => null);
  let job: Record<string, unknown> | null = null;
  if (!tenant) missing.push("job");
  else {
    try {
      const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenant}/jobs/${encodeURIComponent(stJobId)}`);
      if (!res.ok) missing.push("job");
      else job = asRecord(res.json);
    } catch {
      missing.push("job");
    }
  }

  const jobIdNum = Number(stJobId);
  if (tenant && jobIdNum > 0 && !formatAddress(job?.location) && !formatAddress(job?.locationAddress)) {
    try {
      const map = await enrichJobsWithSite(env, db, tenant, [jobIdNum]);
      const enriched = map.get(jobIdNum);
      if (enriched) job = { ...(job || {}), ...enriched };
    } catch {
      /* address stays thin */
    }
  }

  const customerId = Number(job?.customerId || 0);
  if (tenant && customerId > 0) {
    try {
      await enrichCustomerNames(env, db, tenant, [customerId]);
    } catch {
      /* name is not shown on the brief */
    }
  }

  const locationId = Number(job?.locationId || 0);
  const address =
    formatAddress(job?.location) ||
    formatAddress(job?.locationAddress) ||
    formatAddress(job?._resolvedLocation) ||
    (typeof job?.address === "string" ? job.address : null);
  const jobNumber = job?.jobNumber != null ? String(job.jobNumber) : job?.number != null ? String(job.number) : null;
  const typeId = Number(job?.jobTypeId || 0) || null;
  let typeName = jobTypeNameOf(job);

  let past: TechBrief["past_jobs"] = [];
  if (tenant && locationId > 0) {
    try {
      const base = `/jpm/v2/tenant/${tenant}/jobs?locationId=${locationId}&pageSize=10`;
      let res = await stApiGet(env, db, `${base}&sort=-CreatedOn`);
      if (!res.ok) res = await stApiGet(env, db, base);
      if (!res.ok) missing.push("past_jobs");
      else {
        const names = typeName ? new Map<number, string>() : await loadJobTypeNames(env, db, tenant);
        if (typeId && names.has(typeId) && !typeName) typeName = names.get(typeId) || typeName;
        const rows = ((asRecord(res.json)?.data as Record<string, unknown>[] | undefined) || [])
          .filter((row) => String(row.id || "") !== String(stJobId))
          .map((row) => {
            const tid = Number(row.jobTypeId || 0);
            const named = jobTypeNameOf(row) || (tid > 0 ? names.get(tid) || null : null);
            const date = (typeof row.completedOn === "string" && row.completedOn) || (typeof row.createdOn === "string" && row.createdOn) || null;
            return {
              job_number: row.jobNumber != null ? String(row.jobNumber) : row.number != null ? String(row.number) : null,
              date,
              job_type: named,
              summary: ascii(row.summary, 140) || null,
            };
          })
          .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
          .slice(0, 5);
        past = rows;
        if (typeId && !typeName) {
          const names2 = names.size ? names : await loadJobTypeNames(env, db, tenant);
          typeName = names2.get(typeId) || null;
        }
      }
    } catch {
      missing.push("past_jobs");
    }
  } else if (!missing.includes("job")) {
    past = [];
  }

  if (tenant && typeId && !typeName) {
    try {
      const names = await loadJobTypeNames(env, db, tenant);
      typeName = names.get(typeId) || null;
    } catch {
      /* type name stays blank */
    }
  }

  let estimates = { count: 0, names: [] as string[] };
  if (tenant) {
    try {
      const res = await stApiGet(env, db, `/sales/v2/tenant/${tenant}/estimates?jobId=${encodeURIComponent(stJobId)}&pageSize=50`);
      if (!res.ok) missing.push("estimates");
      else {
        const rows = (asRecord(res.json)?.data as Record<string, unknown>[] | undefined) || [];
        const open = rows.filter((row) => {
          const st = String(row.status || row.estimateStatus || "").toLowerCase();
          return st !== "dismissed" && st !== "sold" && st !== "cancelled" && st !== "canceled";
        });
        estimates = {
          count: open.length,
          names: open.map((row) => ascii(row.name || row.summary || row.jobType || "Estimate", 80)).filter(Boolean).slice(0, 8),
        };
      }
    } catch {
      missing.push("estimates");
    }
  } else missing.push("estimates");

  const warranty: TechBrief["warranty"] = [];
  const addr = address ? String(address) : "";
  if (addr) {
    try {
      const briefSql = `SELECT log_number, part_name, status, service_address FROM warranty_claims
           WHERE service_address IS NOT NULL AND trim(service_address) != ''`;
      type BriefWarranty = {
        log_number: string;
        part_name: string | null;
        status: string;
        service_address: string;
      };
      let q;
      try {
        q = await db
          .prepare(briefSql + ` AND IFNULL(voided, 0) = 0 ORDER BY id DESC LIMIT 400`)
          .all<BriefWarranty>();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no such column.*voided/i.test(msg)) throw e;
        q = await db.prepare(briefSql + ` ORDER BY id DESC LIMIT 400`).all<BriefWarranty>();
      }
      const ranked = (q.results || [])
        .filter((row) => !CLOSED_WARRANTY.has(String(row.status || "")))
        .map((row) => ({ row, hit: scoreAddressMatch(String(row.service_address || ""), addr) }))
        .filter((x) => x.hit && x.hit.score >= 50)
        .sort((a, b) => (b.hit?.score || 0) - (a.hit?.score || 0))
        .slice(0, 3);
      for (const item of ranked) {
        warranty.push({
          log_number: item.row.log_number,
          part_name: item.row.part_name,
          status: item.row.status,
        });
      }
    } catch {
      missing.push("warranty");
    }
  }

  const equipment: EquipmentSnap[] = [];
  const addressNorm = normAddr(addr);
  if (await tableExists(db, "tech_equipment_snaps")) {
    try {
      const q = await db
        .prepare(
          `SELECT id, st_job_id, st_location_id, unit_role, manufacturer, model_number, serial_number,
                  mfg_year, mfg_month, tonnage, refrigerant_hint, decode_confidence, source, created_at
           FROM tech_equipment_snaps
           WHERE removed_at IS NULL
             AND (st_location_id = ? OR (? != '' AND address_norm = ?))
           ORDER BY created_at DESC LIMIT 30`
        )
        .bind(locationId > 0 ? String(locationId) : "", addressNorm, addressNorm)
        .all<EquipmentSnap>();
      const seen = new Set<string>();
      for (const row of q.results || []) {
        const role = String(row.unit_role || "unknown");
        if (seen.has(role)) continue;
        seen.add(role);
        equipment.push(row);
      }
    } catch {
      missing.push("equipment");
    }
  }

  let assistOn = true;
  let ids = solderIds("");
  let years = 12;
  try {
    assistOn = (await getSetting(db, "tech_assist", "1")) !== "0";
    ids = solderIds(await getSetting(db, "job_rule_solder_type_ids", "339591774,336193175"));
    years = ageYears(await getSetting(db, "job_rule_options_age_years", "12"));
  } catch {
    assistOn = true;
  }

  const customFields = Array.isArray(job?.customFields)
    ? (job?.customFields as Array<{ name?: string; value?: string }>)
    : [];
  const access = extractAccessCode({
    specialInstructions: job?.specialInstructions,
    notes: job?.notes,
    customFields,
  });
  let permitBlocking = false;
  try {
    const permit = await evaluatePermitGate(env, db, stJobId, { jobTypeName: typeName, customFields });
    permitBlocking = Boolean(permit.required && !permit.ready);
  } catch {
    permitBlocking = false;
  }

  // jobNotesFor applies needsSolder and emits SOLDER_TEXT when the job needs solder.
  const notes = assistOn
    ? jobNotesFor({
        job_type_id: typeId,
        job_type: typeName,
        texts: [textOf(job, "summary"), textOf(job, "summaryOfWork"), textOf(job, "specialInstructions"), textOf(job, "notes")],
        prior_jobs: past.map((p) => ({ job_number: p.job_number, completed_on: p.date, job_type: p.job_type })),
        equipment: equipment.map((e) => ({ mfg_year: e.mfg_year ?? null, refrigerant_hint: e.refrigerant_hint ?? null })),
        now,
        solder_type_ids: ids,
        options_age_years: years,
      })
    : [];

  const lines = buildBriefLines({
    now,
    notes,
    past_jobs: past.map((p) => ({ job_number: p.job_number, date: p.date, job_type: p.job_type })),
    equipment: equipment.map((e) => ({
      unit_role: e.unit_role,
      manufacturer: e.manufacturer,
      model_number: e.model_number,
      tonnage: e.tonnage ?? null,
      mfg_year: e.mfg_year ?? null,
    })),
    warranty: warranty.map((w) => ({ log_number: w.log_number, part_name: w.part_name })),
    open_estimates: estimates.count,
    access_code: access,
    permit_blocking: permitBlocking,
  });

  const brief: TechBrief = {
    st_job_id: stJobId,
    job_number: jobNumber,
    built_at: now.toISOString(),
    cached: false,
    lines,
    notes,
    past_jobs: past,
    warranty,
    equipment,
    open_estimates: estimates,
    ai_text: cached?.ai_text || null,
    ai_model: cached?.ai_model || null,
    missing,
  };

  if (await tableExists(db, "tech_brief_cache")) {
    try {
      const stored = { ...brief, cached: false, ai_text: null, ai_model: null };
      await db
        .prepare(
          `INSERT INTO tech_brief_cache (st_job_id, built_at, brief_json, ai_text, ai_model)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(st_job_id) DO UPDATE SET
             built_at = excluded.built_at,
             brief_json = excluded.brief_json,
             ai_text = tech_brief_cache.ai_text,
             ai_model = tech_brief_cache.ai_model`
        )
        .bind(stJobId, brief.built_at, JSON.stringify(stored), brief.ai_text, brief.ai_model)
        .run();
    } catch {
      /* cache is optional */
    }
  }
  return brief;
}

export async function saveBriefAi(db: D1Database, stJobId: string, text: string, model: string): Promise<void> {
  if (!(await tableExists(db, "tech_brief_cache"))) return;
  try {
    await db
      .prepare(`UPDATE tech_brief_cache SET ai_text = ?, ai_model = ? WHERE st_job_id = ?`)
      .bind(text, model, stJobId)
      .run();
  } catch {
    /* best effort */
  }
}
