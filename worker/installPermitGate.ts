import type { Env } from "./types";

const READY_D1 = new Set(["on_truck", "on_site", "na"]);
const MAJOR_INSTALL_RE =
  /complete\s*system\s*install|furnace\s*install|condenser\s*install|air\s*handler\s*install|heat\s*pump\s*install|package\s*unit\s*install|minisplit|ductless\s*install|ptac\s*install|residential\s*rough|ductwork\s*&\s*installation|complete\s*duct/i;
const LIGHT_INSTALL_RE =
  /thermostat\s*install|exhaust\s*fan|grill|filter\s*change|trim\s*out|dehumidifier|drain\s*pan|heat\s*kit|kitchen\s*vent|attic\s*register|furdown|roof\s*curb|iaq\s*installation/i;

export function jobTypeRequiresPermit(jobTypeName: string | null | undefined): boolean {
  const name = String(jobTypeName || "").trim();
  if (!name) return false;
  if (LIGHT_INSTALL_RE.test(name)) return false;
  if (MAJOR_INSTALL_RE.test(name)) return true;
  if (/\binstall/i.test(name) && !LIGHT_INSTALL_RE.test(name)) return true;
  return false;
}

function normStatus(raw: unknown): "missing" | "at_city" | "on_truck" | "on_site" | "na" | null {
  const s = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "missing" || s === "needed" || s === "pending") return "missing";
  if (s === "at_city" || s === "city" || s === "atcity") return "at_city";
  if (s === "on_truck" || s === "truck" || s === "ontruck") return "on_truck";
  if (s === "on_site" || s === "onsite" || s === "site") return "on_site";
  if (s === "na" || s === "n_a" || s === "n/a" || s === "not_applicable") return "na";
  return null;
}

function stPermitValueReady(value: unknown): boolean {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return false;
  if (/^(no|n\/a|na|needed|missing|pending|none|false|0)$/i.test(v)) return false;
  if (/^(at[_\s-]?city|city)$/i.test(v)) return false;
  return true;
}

async function ensureInstallPermitTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS install_permit_status (
        st_job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('missing', 'at_city', 'on_truck', 'on_site', 'na')),
        note TEXT,
        updated_by INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();
}

async function getD1PermitStatus(
  db: D1Database,
  stJobId: string
): Promise<{ status: "missing" | "at_city" | "on_truck" | "on_site" | "na"; note: string | null } | null> {
  await ensureInstallPermitTable(db);
  const row = await db
    .prepare(`SELECT status, note FROM install_permit_status WHERE st_job_id = ? LIMIT 1`)
    .bind(String(stJobId))
    .first<{ status: string; note: string | null }>();
  if (!row) return null;
  const status = normStatus(row.status);
  if (!status) return null;
  return { status, note: row.note };
}

export async function setD1PermitStatus(
  db: D1Database,
  stJobId: string,
  statusRaw: string,
  opts?: { note?: unknown; updatedBy?: number | null }
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const status = normStatus(statusRaw);
  if (!status) {
    return { ok: false, error: "status must be missing|at_city|on_truck|on_site|na" };
  }
  const id = String(stJobId || "").trim();
  if (!id) return { ok: false, error: "st_job_id required" };
  await ensureInstallPermitTable(db);
  await db
    .prepare(
      `INSERT INTO install_permit_status (st_job_id, status, note, updated_by, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(st_job_id) DO UPDATE SET
         status = excluded.status,
         note = excluded.note,
         updated_by = excluded.updated_by,
         updated_at = datetime('now')`
    )
    .bind(
      id,
      status,
      opts?.note != null ? String(opts.note).slice(0, 500) : null,
      opts?.updatedBy ?? null
    )
    .run();
  return { ok: true, status };
}

function pickPermitCustomField(
  fields: Array<{ name?: string; value?: unknown }>
): { name: string; value: string } | null {
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    const name = String(f?.name || "");
    if (/permit/i.test(name)) {
      return { name, value: String(f?.value ?? "") };
    }
  }
  return null;
}

export type PermitGate = {
  required: boolean;
  ready: boolean;
  status: string | null;
  source: string;
  message: string | null;
  st_field_name: string | null;
  st_field_value: string | null;
  job_type: string | null;
};

export async function evaluatePermitGate(
  _env: Env,
  db: D1Database,
  stJobId: string,
  hint?: { jobTypeName?: string | null; customFields?: Array<{ name?: string; value?: unknown }> | null }
): Promise<PermitGate> {
  const jobTypeName = hint?.jobTypeName ?? null;
  const customFields = hint?.customFields ?? [];
  const required = jobTypeRequiresPermit(jobTypeName);
  const stField = pickPermitCustomField(customFields || []);
  const d1 = await getD1PermitStatus(db, stJobId);
  if (stField) {
    const ready = stPermitValueReady(stField.value);
    return {
      required: true,
      ready,
      status: ready ? "on_site" : "missing",
      source: "st_custom_field",
      message: ready ? null : `Permit required — ST field "${stField.name}" is empty or not ready.`,
      st_field_name: stField.name,
      st_field_value: stField.value || null,
      job_type: jobTypeName,
    };
  }
  if (!required) {
    return {
      required: false,
      ready: true,
      status: d1?.status ?? null,
      source: d1 ? "d1" : "none",
      message: null,
      st_field_name: null,
      st_field_value: null,
      job_type: jobTypeName,
    };
  }
  if (d1 && READY_D1.has(d1.status)) {
    return {
      required: true,
      ready: true,
      status: d1.status,
      source: "d1",
      message: null,
      st_field_name: null,
      st_field_value: null,
      job_type: jobTypeName,
    };
  }
  const status = d1?.status ?? "missing";
  const where =
    status === "at_city"
      ? "Permit is still at the city — mark on_truck or on_site when the crew has it."
      : "Permit not cleared — office must set permit to on_truck, on_site, or N/A before Complete.";
  return {
    required: true,
    ready: false,
    status,
    source: d1 ? "d1" : "none",
    message: where,
    st_field_name: null,
    st_field_value: null,
    job_type: jobTypeName,
  };
}

export async function permitBlocksComplete(
  env: Env,
  db: D1Database,
  stJobId: string
): Promise<{ status: number; error: string; permit: PermitGate } | null> {
  const permit = await evaluatePermitGate(env, db, stJobId);
  if (!permit.required || permit.ready) return null;
  return {
    status: 409,
    error: permit.message || "Complete blocked until permit is on truck, on site, or N/A.",
    permit,
  };
}

