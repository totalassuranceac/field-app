/**
 * Azali Homes new-house setup.
 * ServiceTitan writes only when azali_rnc_st_create is on and the caller confirmed.
 */
import type { Env, PublicUser } from "./types";
import { getSetting, setSetting, writeAudit } from "./audit";
import { notifyUsers } from "./notifications";
import { stApiGet, stApiJson, stTenantId } from "./servicetitan";
import {
  BUSINESS_UNIT_KEY,
  CUSTOMER_ID_KEY,
  DEFAULT_CUSTOMER_ID,
  FLAG_KEY,
  GROUPS_KEY,
  PAYROLL_KEY,
  PROJECT_MANAGER_KEY,
  PROJECT_STATUS_KEY,
  PROJECT_TYPE_KEY,
  TAG_KEY,
  TEMPLATE_SINGLE_KEY,
  TEMPLATE_TWO_KEY,
  DEFAULT_SINGLE_TEMPLATE,
  DEFAULT_TWO_TEMPLATE,
  estimateIsApproved,
  estimateIsClosed,
  flagIsOn,
  isAzaliMiller,
  missingStIds,
  sameStreet,
  type StIds,
  type Stories,
} from "../src/lib/azaliRnc";

export async function ensureAzaliTables(db: D1Database): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS new_construction_setups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          street TEXT NOT NULL,
          city TEXT NOT NULL,
          zip TEXT NOT NULL,
          subdivision TEXT NOT NULL,
          stories TEXT NOT NULL,
          sys1_tons TEXT NOT NULL,
          sys1_loc TEXT NOT NULL,
          sys2_tons TEXT,
          sys2_loc TEXT,
          exhaust_fans INTEGER NOT NULL,
          brand TEXT NOT NULL,
          contract_amount TEXT,
          notes TEXT,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          start_date TEXT NOT NULL,
          target_date TEXT NOT NULL,
          estimate_no TEXT,
          st_location_id TEXT,
          st_project_id TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          error TEXT,
          created_by INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      )
      .run();
  } catch {
    /* already exists */
  }
}

export async function azaliCreateEnabled(db: D1Database): Promise<boolean> {
  return flagIsOn(await getSetting(db, FLAG_KEY, "false"));
}

export function canUseAzaliRnc(user: PublicUser | null): boolean {
  return isAzaliMiller(user);
}

export async function loadAzaliSettings(db: D1Database): Promise<StIds & {
  flag_on: boolean;
  groups: string[];
  single_template: string;
  two_template: string;
  manual_fields: string[];
}> {
  const [customer, typeId, statusId, bu, pm, tag, payroll, groups, singleTpl, twoTpl, flagOn] = await Promise.all([
    getSetting(db, CUSTOMER_ID_KEY, DEFAULT_CUSTOMER_ID),
    getSetting(db, PROJECT_TYPE_KEY, ""),
    getSetting(db, PROJECT_STATUS_KEY, ""),
    getSetting(db, BUSINESS_UNIT_KEY, ""),
    getSetting(db, PROJECT_MANAGER_KEY, ""),
    getSetting(db, TAG_KEY, ""),
    getSetting(db, PAYROLL_KEY, ""),
    getSetting(db, GROUPS_KEY, ""),
    getSetting(db, TEMPLATE_SINGLE_KEY, ""),
    getSetting(db, TEMPLATE_TWO_KEY, ""),
    azaliCreateEnabled(db),
  ]);
  let parsed: string[] = [];
  try {
    const raw = JSON.parse(groups);
    if (Array.isArray(raw)) parsed = raw.map((x) => String(x)).filter(Boolean);
  } catch {
    parsed = [];
  }
  return {
    customer_id: customer || DEFAULT_CUSTOMER_ID,
    project_type_id: typeId,
    status_id: statusId,
    business_unit_id: bu,
    project_manager_id: pm,
    tag_id: tag,
    payroll_id: payroll,
    flag_on: flagOn,
    groups: parsed,
    single_template: singleTpl.trim() || DEFAULT_SINGLE_TEMPLATE,
    two_template: twoTpl.trim() || DEFAULT_TWO_TEMPLATE,
    manual_fields: [
      "Invoice signature required",
      "Non-taxable",
      "Payroll Prevailing Wage",
      "Group",
      "Contract amount",
    ],
  };
}

function rowsOf(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function idOf(row: Record<string, unknown> | null): string {
  const n = Number(row?.id);
  return n > 0 ? String(n) : "";
}

/** Read-only. Pull type, BU, manager, tag, and status ids from project number 10565. */
export async function readRncIds(env: Env, db: D1Database): Promise<{
  ok: boolean;
  error?: string;
  ids: StIds;
  project_number: string;
}> {
  const ids: StIds = {
    customer_id: DEFAULT_CUSTOMER_ID,
    project_type_id: "",
    status_id: "",
    business_unit_id: "",
    project_manager_id: "",
    tag_id: "",
    payroll_id: "",
  };
  const tenant = await stTenantId(env, db);
  if (!tenant) return { ok: false, error: "ServiceTitan is not configured", ids, project_number: "10565" };

  const project = await stApiGet(
    env,
    db,
    `/jpm/v2/tenant/${tenant}/projects?number=10565&pageSize=20`
  );
  const matches = project.ok
    ? rowsOf(project.json).filter((p) => String(p.number ?? "") === "10565")
    : [];
  if (!project.ok || matches.length !== 1) {
    return {
      ok: false,
      error: !project.ok
        ? `Project read failed (${project.status})`
        : "Project number 10565 was not found. Nothing was guessed.",
      ids,
      project_number: "10565",
    };
  }
  const row = matches[0];
  ids.project_type_id = String(row.projectTypeId || "");
  ids.status_id = String(row.statusId || "");
  const bus = row.businessUnitIds;
  ids.business_unit_id = Array.isArray(bus) && bus.length ? String(bus[0]) : String(row.businessUnitId || "");
  const pms = row.projectManagerIds;
  ids.project_manager_id = Array.isArray(pms) && pms.length ? String(pms[0]) : String(row.projectManagerId || "");

  const tags = await stApiGet(env, db, `/settings/v2/tenant/${tenant}/tag-types?pageSize=200&active=true`);
  if (tags.ok) {
    const tag = rowsOf(tags.json).find((t) => String(t.name || "").trim().toLowerCase() === "construction");
    ids.tag_id = idOf(tag || null);
  }
  return {
    ok: missingStIds(ids).length === 0,
    error: missingStIds(ids).length ? `Still missing: ${missingStIds(ids).join(", ")}` : undefined,
    ids,
    project_number: "10565",
  };
}

export async function checkEstimate(env: Env, db: D1Database, estimateNo: string) {
  const num = estimateNo.trim();
  const tenant = await stTenantId(env, db);
  if (!tenant) {
    return { found: false, approved: false, status: "", id: null, job_id: null, others: [] as { id: number; number: string; status: string }[], error: "ServiceTitan is not configured" };
  }
  const got = await stApiGet(
    env,
    db,
    `/sales/v2/tenant/${tenant}/estimates?pageSize=20&number=${encodeURIComponent(num)}`
  );
  if (!got.ok) {
    return { found: false, approved: false, status: "", id: null, job_id: null, others: [], error: `Estimate read failed (${got.status})` };
  }
  const rows = rowsOf(got.json);
  const hit = rows.find((r) => String(r.number || r.estimateNumber || r.id || "") === num) || rows[0];
  if (!hit) return { found: false, approved: false, status: "", id: null, job_id: null, others: [] };
  const status = String(
    typeof hit.status === "object" && hit.status ? (hit.status as { name?: string }).name || "" : hit.status || ""
  );
  const id = Number(hit.id) || null;
  const jobObj = hit.job;
  const jobFromObj = jobObj && typeof jobObj === "object" ? Number((jobObj as { id?: number }).id) || 0 : 0;
  const jobId = Number(hit.jobId || jobFromObj || 0) || null;
  const others: { id: number; number: string; status: string }[] = [];
  if (jobId) {
    const more = await stApiGet(env, db, `/sales/v2/tenant/${tenant}/estimates?jobId=${jobId}&pageSize=50`);
    if (more.ok) {
      for (const row of rowsOf(more.json)) {
        const st = String(
          typeof row.status === "object" && row.status ? (row.status as { name?: string }).name || "" : row.status || ""
        );
        const rid = Number(row.id) || 0;
        if (rid === id || estimateIsClosed(st)) continue;
        others.push({ id: rid, number: String(row.number || row.estimateNumber || rid), status: st || "open" });
      }
    }
  }
  return { found: true, approved: estimateIsApproved(status), status, id, job_id: jobId, others };
}

async function notifyNotApproved(db: D1Database, actor: PublicUser, estimateNo: string, status: string) {
  const ids = new Set<number>();
  try {
    const people = await db
      .prepare(`SELECT id, display_name, username, role FROM users WHERE active = 1`)
      .all<{ id: number; display_name: string; username: string; role: string }>();
    for (const u of people.results || []) if (isAzaliMiller(u)) ids.add(u.id);
  } catch {
    /* ignore */
  }
  ids.delete(actor.id);
  if (!ids.size) return;
  await notifyUsers(
    db,
    [...ids].slice(0, 10),
    "azali_rnc_estimate",
    "Not approved in ServiceTitan yet",
    `Estimate ${estimateNo} is ${status || "not sold"}.`,
    { type: "new_construction", id: estimateNo }
  );
}

export type CreateInput = {
  street: string;
  city: string;
  state: string;
  zip: string;
  group: string;
  stories: Stories;
  tons1: string;
  loc1: string;
  tons2: string;
  loc2: string;
  fans: number;
  brand: string;
  contract: string;
  notes: string;
  project_name: string;
  description: string;
  start_date: string;
  target_date: string;
  estimate_no: string;
  confirm: boolean;
};

export async function createAzaliInSt(env: Env, db: D1Database, user: PublicUser, body: CreateInput) {
  await ensureAzaliTables(db);
  if (!(await azaliCreateEnabled(db))) {
    return { ok: false, status: 403, error: "ServiceTitan create is off. Copy the name and description." };
  }
  if (!body.confirm) return { ok: false, status: 400, error: "Confirm the ServiceTitan write first" };
  const settings = await loadAzaliSettings(db);
  const missing = missingStIds(settings);
  if (missing.length) {
    return {
      ok: false,
      status: 400,
      error: `Stop. These ServiceTitan ids are not saved: ${missing.join(", ")}. Set them in Settings. Nothing was created.`,
    };
  }
  const tenant = await stTenantId(env, db);
  if (!tenant) return { ok: false, status: 503, error: "ServiceTitan is not configured" };
  const customerId = Number(settings.customer_id);

  const street = body.street.replace(/\s+/g, " ").trim();
  const locs = await stApiGet(
    env,
    db,
    `/crm/v2/tenant/${tenant}/locations?customerId=${customerId}&street=${encodeURIComponent(street)}&pageSize=20`
  );
  if (!locs.ok) return { ok: false, status: 502, error: `Location read failed (${locs.status})` };
  const existing = rowsOf(locs.json).find((l) => {
    const addr = (l.address || {}) as { street?: string };
    return sameStreet(String(addr.street || l.name || ""), street);
  });
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: "A location with this street already exists on Azali Homes",
      existing_location_id: existing.id,
      existing_location_url: `https://go.servicetitan.com/#/location/${existing.id}`,
    };
  }

  const name = body.project_name.trim();
  const locPost = await stApiJson(env, db, `/crm/v2/tenant/${tenant}/locations`, {
    method: "POST",
    body: {
      name,
      customerId,
      address: {
        street,
        city: body.city.trim(),
        state: body.state.trim() || "TX",
        zip: body.zip.trim(),
        country: "USA",
      },
      tagTypeIds: [],
    },
  });
  if (!locPost.ok) {
    const text = locPost.text.slice(0, 300);
    await insertSetup(db, user, body, "failed", null, null, text);
    return { ok: false, status: 502, error: `Location create failed (${locPost.status}): ${text}` };
  }
  const locationId = Number((locPost.json as { id?: number })?.id);
  if (!locationId) return { ok: false, status: 502, error: "Location create did not return an id" };

  const projPost = await stApiJson(env, db, `/jpm/v2/tenant/${tenant}/projects`, {
    method: "POST",
    body: {
      name,
      summary: body.description,
      customerId,
      locationId,
      startDate: body.start_date,
      targetCompletionDate: body.target_date,
      projectTypeId: Number(settings.project_type_id),
      statusId: Number(settings.status_id),
      businessUnitIds: [Number(settings.business_unit_id)],
      projectManagerIds: [Number(settings.project_manager_id)],
      tagTypeIds: [Number(settings.tag_id)],
    },
  });
  if (!projPost.ok) {
    const text = projPost.text.slice(0, 300);
    await insertSetup(db, user, body, "failed", String(locationId), null, text);
    return {
      ok: false,
      status: 502,
      error: `Project create failed (${projPost.status}): ${text}. Location ${locationId} was created.`,
      st_location_id: locationId,
      location_url: `https://go.servicetitan.com/#/location/${locationId}`,
    };
  }
  const projectId = Number((projPost.json as { id?: number })?.id) || null;
  await insertSetup(db, user, body, "created", String(locationId), projectId ? String(projectId) : null, null);
  try {
    await writeAudit(
      db,
      user,
      "create",
      "new_construction_setup",
      projectId || locationId,
      `Azali ${name} location ${locationId} project ${projectId || "?"}.`.slice(0, 180)
    );
  } catch {
    /* optional */
  }
  return {
    ok: true,
    st_location_id: locationId,
    st_project_id: projectId,
    location_url: `https://go.servicetitan.com/#/location/${locationId}`,
    project_url: projectId ? `https://go.servicetitan.com/#/project/${projectId}` : null,
  };
}

async function insertSetup(
  db: D1Database,
  user: PublicUser,
  body: CreateInput,
  status: string,
  locationId: string | null,
  projectId: string | null,
  error: string | null
) {
  await db
    .prepare(
      `INSERT INTO new_construction_setups (
         street, city, zip, subdivision, stories, sys1_tons, sys1_loc, sys2_tons, sys2_loc,
         exhaust_fans, brand, contract_amount, notes, name, description, start_date, target_date,
         estimate_no, st_location_id, st_project_id, status, error, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      body.street,
      body.city,
      body.zip,
      body.group,
      body.stories,
      body.tons1,
      body.loc1,
      body.tons2 || null,
      body.loc2 || null,
      body.fans,
      body.brand,
      body.contract || null,
      body.notes || null,
      body.project_name,
      body.description,
      body.start_date,
      body.target_date,
      body.estimate_no || null,
      locationId,
      projectId,
      status,
      error,
      user.id
    )
    .run();
}

export { notifyNotApproved };
