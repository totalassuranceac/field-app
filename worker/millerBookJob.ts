/**
 * Miller Install quick-add — mirrors ServiceTitan Gauge Book Job path.
 * Path: Search address → Location → Book Job (not Schedule Assistant).
 *
 * Gate: MILLER_BOOK_JOB env
 *   unset / dry / dry-run → dry (build payload, NO ST POST)
 *   live / 1 / true / on   → live Create Job
 * Soft default = dry. Documented in READY note; Chris must opt into live.
 *
 * HARD: Business Unit HVAC Install; Send booking confirmation text OFF
 *       (notificationsEnabled: false). Job types: Install/New Const allowlist only.
 * Techs: installer + new-construction only (big name chips). No service techs.
 * Book Job assigns selected technicianIds. Confirms OFF.
 */
import type { Env } from "./types";
import { getSetting } from "./audit";
import {
  HARD_LOCK_INSTALL_PAIRS,
  namesMatchHint,
  resolveHardLockPairs,
} from "./installCrewPairs";
import { stApiGet, stApiJson, stTenantId } from "./servicetitan";
import { loadStTechnicians } from "./zeroCharge";
import { addressContainsQuery } from "./addressFuzzy";

export type MillerBookMode = "dry" | "live";

export const MILLER_ARRIVAL_WINDOWS = [
  { id: "615-8", label: "6:15–8", startMin: 6 * 60 + 15, endMin: 8 * 60 },
  { id: "801-10", label: "8:01–10", startMin: 8 * 60 + 1, endMin: 10 * 60 },
  { id: "1001-12", label: "10:01–12", startMin: 10 * 60 + 1, endMin: 12 * 60 },
  { id: "1201-2", label: "12:01–2", startMin: 12 * 60 + 1, endMin: 14 * 60 },
  { id: "201-4", label: "2:01–4", startMin: 14 * 60 + 1, endMin: 16 * 60 },
  { id: "custom", label: "Custom", startMin: null, endMin: null },
] as const;

/**
 * Prefer explicit ALLOW over a loose blocklist.
 * Allow: Install + New Construction and clear synonyms (New Const, NC Install,
 * condenser/AH/furnace install, duct, change-out, etc.).
 * Block: service/maintenance/diagnosis paths even if name also says install.
 */
const ALLOWED_JOB_TYPE_RE =
  /\b(?:install(?:ation)?s?|new\s*const(?:ruction)?|nc\s*install|change[\s\-]?outs?|duct(?:s|work|ing)?|(?:condenser|ah|a\/h|air[\s\-]?handler|furnace|coil|heat[\s\-]?pump|package(?:\s*unit)?)\s*install(?:ation)?)\b/i;

const BLOCKED_JOB_TYPE_RE =
  /\b(?:estimate|sold|project|sales|quote|customer\s*quote|no\s*cool|diagnos(?:is|tic)s?|maintenance|service\s*calls?|freon|comfort\s*club|warranty\s*service|tune[\s\-]?ups?|preventive|recall)\b/i;

/** True when name is on the Miller Install allowlist (and not blocked). */
export function isMillerAllowedJobTypeName(name: string): boolean {
  const n = String(name || "").trim();
  if (!n) return false;
  if (BLOCKED_JOB_TYPE_RE.test(n)) return false;
  return ALLOWED_JOB_TYPE_RE.test(n);
}

const BU_NAME = "HVAC Install";
export const NC_BU_NAME = "Residential Construction";

export const NC_JOB_TYPE_DEFS = [
  { key: "rough" as const, picker: "New Construction Rough", stName: "Residential Rough In" },
  { key: "final" as const, picker: "New Construction Final", stName: "Final" },
  { key: "trim" as const, picker: "Trim Out", stName: "Trim Out" },
];

export function isExactNcJobTypeName(name: string): boolean {
  const n = String(name || "").trim().toLowerCase();
  return NC_JOB_TYPE_DEFS.some(
    (d) => d.stName.toLowerCase() === n || d.picker.toLowerCase() === n
  );
}

export function ncDefForName(name: string) {
  const n = String(name || "").trim().toLowerCase();
  return (
    NC_JOB_TYPE_DEFS.find((d) => d.stName.toLowerCase() === n || d.picker.toLowerCase() === n) ||
    null
  );
}

export function businessUnitNameForJobType(name: string): string {
  return isExactNcJobTypeName(name) ? NC_BU_NAME : BU_NAME;
}

export type NcJobSnap = {
  job_number: string | null;
  job_type: string | null;
  status: string | null;
  project_id: number | null;
};

/** NC Final is not blocked by a Rough In. Same open type on the project blocks. Completed same type warns. */
export function ncDuplicateDecision(
  jobs: NcJobSnap[],
  bookingName: string,
  projectId: number | null,
  opts?: { force_duplicate?: boolean; acknowledge_completed?: boolean }
): { ok: true; warning?: string } | { ok: false; error: string; message: string } {
  const def = ncDefForName(bookingName);
  const stName = (def?.stName || bookingName).toLowerCase();
  const label = def?.key === "rough" ? "Rough In" : def?.key === "final" ? "Final" : def?.picker || bookingName;
  const same = jobs.filter((j) => {
    const jt = String(j.job_type || "").trim().toLowerCase();
    if (jt !== stName && jt !== (def?.picker || "").toLowerCase()) return false;
    if (projectId && j.project_id && j.project_id !== projectId) return false;
    return true;
  });
  const open = same.filter((j) => isMillerOpenJobStatus(j.status));
  if (open.length && !opts?.force_duplicate) {
    const sample = open[0];
    const num = sample.job_number ? `#${sample.job_number}` : "job";
    return {
      ok: false,
      error: "existing_open_same_type",
      message: `Already an open ${label} ${num} on this project. Not booking another. Add another appointment to it in ServiceTitan by hand.`,
    };
  }
  const done = same.filter((j) => !isMillerOpenJobStatus(j.status) && /complete|done|finish/i.test(String(j.status || "")));
  if (done.length && !opts?.acknowledge_completed && !opts?.force_duplicate) {
    const sample = done[0];
    const num = sample.job_number ? `#${sample.job_number}` : "";
    return {
      ok: false,
      error: "completed_same_type",
      message: `A Completed ${label} ${num} is on this project. Adding an appointment to it is not built yet. Add the appointment in ServiceTitan by hand.`.replace(/\s+/g, " ").trim(),
    };
  }
  return { ok: true };
}

export function chooseOpenProject(
  projects: { id: number; status: string | null }[]
): { projectId: number | null; mustPick: boolean; openIds: number[] } {
  const open = projects.filter((p) => isMillerOpenJobStatus(p.status));
  if (open.length === 1) return { projectId: open[0].id, mustPick: false, openIds: [open[0].id] };
  return { projectId: null, mustPick: true, openIds: open.map((p) => p.id) };
}
const DEFAULT_CAMPAIGN_NAMES = [
  "Existing Customer",
  "Existing Customers",
  "Customer Referral",
  "Referral",
  "Install",
];

export function millerBookMode(env?: Env): MillerBookMode {
  const raw = String(env?.MILLER_BOOK_JOB ?? "")
    .trim()
    .toLowerCase();
  if (raw === "1" || raw === "true" || raw === "live" || raw === "on" || raw === "yes") {
    return "live";
  }
  // unset / dry / off / anything else → dry (safe; no ST Create until Chris opts in)
  return "dry";
}

function settingOn(raw: string | null | undefined): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Live only when the admin setting is on AND MILLER_BOOK_JOB is live. Setting defaults off. */
export async function millerBookEffectiveMode(env: Env, db: D1Database): Promise<MillerBookMode> {
  const flag = await getSetting(db, "miller_book_live_enabled", "false");
  if (!settingOn(flag)) return "dry";
  return millerBookMode(env);
}

/** New Construction Rough / Final / Trim Out. Default off. */
export async function millerNcBookEnabled(db: D1Database): Promise<boolean> {
  return settingOn(await getSetting(db, "miller_book_nc_enabled", "false"));
}

function asDataArray(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  const d = (json as { data?: unknown }).data;
  return Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
}

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Chicago wall-clock → ISO UTC for ST. */
export function chicagoWallToIso(
  dateIso: string,
  hour: number,
  minute: number
): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  let lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  let hi = Date.UTC(y, m - 1, d + 1, 23, 59, 59);
  const target =
    String(y).padStart(4, "0") +
    "-" +
    String(m).padStart(2, "0") +
    "-" +
    String(d).padStart(2, "0") +
    " " +
    String(hour).padStart(2, "0") +
    ":" +
    String(minute).padStart(2, "0");
  for (let i = 0; i < 48; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(mid)).map((p) => [p.type, p.value])
    );
    const hh = parts.hour === "24" ? "00" : parts.hour;
    const wall = `${parts.year}-${parts.month}-${parts.day} ${hh}:${parts.minute}`;
    if (wall < target) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo).toISOString();
}

function parseHm(raw: string): { hour: number; minute: number } | null {
  const t = raw.trim();
  const m12 = /^(\d{1,2}):(\d{2})\s*(a|p|am|pm)?$/i.exec(t);
  if (!m12) return null;
  let hour = Number(m12[1]);
  const minute = Number(m12[2]);
  const ap = (m12[3] || "").toLowerCase();
  if (ap.startsWith("p") && hour < 12) hour += 12;
  if (ap.startsWith("a") && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export type MillerCrewOption = {
  id: string;
  label: string;
  lead_name: string;
  helper_name: string;
  lead_user_id: number | null;
  helper_user_id: number | null;
  lead_st_id: number | null;
  helper_st_id: number | null;
  /** ST tech ids in preset order (lead then helper) */
  technician_ids: number[];
};

/** Any active field tech eligible for Miller Book Job multi-select. */
export type MillerCustomPreset = {
  id: number;
  name: string;
  technician_ids: number[];
  /** Chip label = preset name */
  label: string;
  kind: "custom";
};

export type MillerPresetChip = {
  id: string;
  label: string;
  technician_ids: number[];
  kind: "hard_lock" | "custom";
  custom_id?: number;
  lead_name?: string;
  helper_name?: string;
};

export type MillerTechOption = {
  user_id: number;
  display_name: string;
  st_technician_id: number | null;
  label: string;
  /**
   * Standing weekly off (JS getDay / Chicago weekday): 3 = Wednesday.
   * Omar Camacho (FA user ~15) — owner agreement, other job. UI-only; no ST PTO writes.
   */
  standing_off_weekday?: number | null;
  standing_off_label?: string | null;
};

export type MillerJobTypeOption = {
  id: number;
  name: string;
  /** Exact ServiceTitan job type name when the picker label differs. */
  st_name?: string;
  nc_key?: "rough" | "final" | "trim";
  unresolved?: boolean;
  /** Resolved default length for auto-When (minutes). */
  duration_minutes: number;
  /** avg = completed-job sample; estimated = ST job-type duration; heuristic = name defaults */
  duration_source: "avg" | "estimated" | "heuristic";
  avg_minutes?: number | null;
  estimated_minutes?: number | null;
};

export type MillerLocationHit = {
  location_id: number;
  customer_id: number | null;
  name: string | null;
  address: string;
  customer_name: string | null;
  /** Apt / unit / suite if known from ST address */
  unit: string | null;
  /** Street without unit — used to detect multi-unit buildings */
  street_key: string;
};

async function loadFieldUsers(db: D1Database): Promise<
  Array<{ id: number; display_name: string; st_technician_id: number | null }>
> {
  try {
    const rows = await db
      .prepare(
        `SELECT id, display_name, st_technician_id FROM users
         WHERE active = 1 AND role IN ('driver','supervisor')
         ORDER BY display_name COLLATE NOCASE`
      )
      .all<{ id: number; display_name: string; st_technician_id: number | null }>();
    return rows.results || [];
  } catch {
    return [];
  }
}

/** Optional HARD LOCK pair presets (not a hard limit on who can be booked). */
export async function listMillerCrews(db: D1Database): Promise<MillerCrewOption[]> {
  const people = await loadFieldUsers(db);
  const resolved = resolveHardLockPairs(people);
  const out: MillerCrewOption[] = [];
  for (const pair of HARD_LOCK_INSTALL_PAIRS) {
    const hit = resolved.find(
      (r) =>
        namesMatchHint(r.lead.display_name, pair.lead) &&
        namesMatchHint(r.helper.display_name, pair.helper)
    );
    const lead = hit?.lead;
    const helper = hit?.helper;
    const leadName = lead?.display_name || pair.lead;
    const helperName = helper?.display_name || pair.helper;
    const pairLabels = shortLabelsForList([leadName, helperName]);
    const technician_ids: number[] = [];
    if (lead?.st_technician_id) technician_ids.push(lead.st_technician_id);
    if (helper?.st_technician_id) technician_ids.push(helper.st_technician_id);
    out.push({
      id: `${pair.lead}+${pair.helper}`.toLowerCase(),
      label: `${pairLabels[0] || firstNameOnly(leadName)}/${pairLabels[1] || firstNameOnly(helperName)}`,
      lead_name: leadName,
      helper_name: helperName,
      lead_user_id: lead?.id ?? null,
      helper_user_id: helper?.id ?? null,
      lead_st_id: lead?.st_technician_id ?? null,
      helper_st_id: helper?.st_technician_id ?? null,
      technician_ids,
    });
  }
  return out;
}

function firstNameOnly(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return (t.split(/\s+/)[0] || "").trim();
}

function firstPlusLastInitial(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}`;
}

/** First name only; First + last initial only when first names collide in the list. */
export function shortLabelsForList(fullNames: string[]): string[] {
  const firsts = fullNames.map(firstNameOnly);
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
      return firstPlusLastInitial(full);
    }
    return first;
  });
}

/** @deprecated prefer shortLabelsForList — kept for single-name fallback */
function shortFirst(full: string): string {
  return firstNameOnly(full);
}

/** ST team is Install or New Construction (not service). */
/** Never offer Ops/Chris names on Miller installer chips. */
export function isMillerExcludedTechName(displayName: string): boolean {
  const n = String(displayName || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n.startsWith("chris")) return false;
  // Chris Marroquin, Chris Miller, Chris Brady (and bare Chris)
  if (n === "chris") return true;
  if (n.includes("marroquin") || n.includes("miller") || n.includes("brady")) return true;
  return false;
}

export function isMillerInstallOrNcTeam(team: string | null | undefined): boolean {
  const t = String(team || "").toLowerCase();
  if (!t) return false;
  if (t.includes("install")) return true;
  if (t.includes("new const") || t.includes("new construction")) return true;
  if (/\bnc\b/.test(t) || t.includes("nc ")) return true;
  return false;
}

/**
 * Installer + new-construction techs only (no service).
 * Prefer ST team label; fall back to HARD LOCK install-pair names if ST teams unavailable.
 */
export async function listMillerTechnicians(
  env: Env,
  db: D1Database
): Promise<MillerTechOption[]> {
  const people = await loadFieldUsers(db);
  const tenantId = await stTenantId(env, db);
  const installStIds = new Set<number>();
  if (tenantId) {
    const got = await loadStTechnicians(env, db, tenantId);
    if (got.ok) {
      for (const t of got.techs) {
        if (t.active !== false && isMillerInstallOrNcTeam(t.team)) {
          installStIds.add(Number(t.id));
        }
      }
    }
  }

  let filtered = people;
  if (installStIds.size) {
    filtered = people.filter(
      (p) => p.st_technician_id != null && installStIds.has(Number(p.st_technician_id))
    );
  } else {
    const pairHints: string[] = [];
    for (const pair of HARD_LOCK_INSTALL_PAIRS) {
      pairHints.push(pair.lead);
      pairHints.push(pair.helper);
    }
    filtered = people.filter((p) =>
      pairHints.some((h) => namesMatchHint(p.display_name, h))
    );
  }

  filtered = filtered.filter(
    (p) =>
      p.st_technician_id != null &&
      Number(p.st_technician_id) > 0 &&
      !isMillerExcludedTechName(p.display_name)
  );

  const labels = shortLabelsForList(filtered.map((p) => p.display_name));
  return filtered.map((p, i) => {
    const omarWed = isOmarCamachoStandingOffPerson(p);
    return {
      user_id: p.id,
      display_name: p.display_name,
      st_technician_id: p.st_technician_id,
      label: labels[i] || firstNameOnly(p.display_name) || p.display_name,
      ...(omarWed
        ? { standing_off_weekday: 3 as const, standing_off_label: "Off Wed" }
        : {}),
    };
  });
}

async function resolveBusinessUnitId(
  env: Env,
  db: D1Database,
  tenantId: string,
  buName: string = BU_NAME,
  cacheKey: string = "miller_book_bu_id"
): Promise<{ id: number | null; name: string; error?: string }> {
  const cached = (await getSetting(db, cacheKey, "")).trim();
  if (cached && Number(cached) > 0 && buName === BU_NAME) {
    return { id: Number(cached), name: buName };
  }
  let page = 1;
  while (page <= 20) {
    const res = await stApiGet(
      env,
      db,
      `/settings/v2/tenant/${tenantId}/business-units?page=${page}&pageSize=100&active=true`
    );
    if (!res.ok) {
      return {
        id: null,
        name: BU_NAME,
        error: `Business units fetch failed (${res.status})`,
      };
    }
    for (const row of asDataArray(res.json)) {
      const name = str(row.name);
      if (name.toLowerCase() === buName.toLowerCase()) {
        const id = num(row.id);
        if (id) return { id, name: buName };
      }
    }
    const hasMore = Boolean((res.json as { hasMore?: boolean })?.hasMore);
    if (!hasMore) break;
    page += 1;
  }
  return { id: null, name: buName, error: `Business Unit "${buName}" not found` };
}

async function resolveCampaignId(
  env: Env,
  db: D1Database,
  tenantId: string
): Promise<{ id: number | null; name: string | null; error?: string }> {
  const idSetting = (await getSetting(db, "miller_book_campaign_id", "")).trim();
  if (idSetting && Number(idSetting) > 0) {
    return { id: Number(idSetting), name: null };
  }
  const namePref = (
    (await getSetting(db, "miller_book_campaign_name", "")) || ""
  ).trim();
  const tryNames = namePref
    ? [namePref, ...DEFAULT_CAMPAIGN_NAMES]
    : [...DEFAULT_CAMPAIGN_NAMES];

  let page = 1;
  const all: Array<{ id: number; name: string }> = [];
  while (page <= 30) {
    const res = await stApiGet(
      env,
      db,
      `/marketing/v2/tenant/${tenantId}/campaigns?page=${page}&pageSize=100&active=true`
    );
    if (!res.ok) {
      // Some tenants use /crm or older path — try alternate once
      if (page === 1) {
        const alt = await stApiGet(
          env,
          db,
          `/marketing/v2/tenant/${tenantId}/campaigns?page=1&pageSize=200`
        );
        if (alt.ok) {
          for (const row of asDataArray(alt.json)) {
            const id = num(row.id);
            const name = str(row.name);
            if (id && name) all.push({ id, name });
          }
        } else {
          return {
            id: null,
            name: null,
            error: `Campaigns fetch failed (${res.status}). Set D1 setting miller_book_campaign_id.`,
          };
        }
        break;
      }
      break;
    }
    for (const row of asDataArray(res.json)) {
      const id = num(row.id);
      const name = str(row.name);
      if (id && name) all.push({ id, name });
    }
    const hasMore = Boolean((res.json as { hasMore?: boolean })?.hasMore);
    if (!hasMore) break;
    page += 1;
  }
  for (const want of tryNames) {
    const hit = all.find((c) => c.name.toLowerCase() === want.toLowerCase());
    if (hit) return { id: hit.id, name: hit.name };
  }
  for (const want of tryNames) {
    const hit = all.find((c) =>
      c.name.toLowerCase().includes(want.toLowerCase())
    );
    if (hit) return { id: hit.id, name: hit.name };
  }
  if (all[0]) return { id: all[0].id, name: all[0].name };
  return {
    id: null,
    name: null,
    error:
      "No marketing campaign found. Set D1 miller_book_campaign_id to the ST campaign id.",
  };
}

/** Omar Camacho — standing Off every Wednesday (America/Chicago). Match user_id 15 + name. */
export function isOmarCamachoStandingOffPerson(p: {
  id?: number;
  user_id?: number;
  display_name?: string | null;
}): boolean {
  const uid = Number(p.id ?? p.user_id ?? 0);
  if (uid === 15) return true;
  const n = String(p.display_name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return false;
  if (n === "omar camacho" || n === "omar j camacho") return true;
  if (n.startsWith("omar") && n.includes("camacho")) return true;
  return false;
}

/** Name-heuristic install defaults (minutes) — last resort after avg + ST estimated. */
export function millerHeuristicDurationMinutes(jobTypeName: string): number {
  const n = String(jobTypeName || "").toLowerCase();
  if (/change[\s\-]?out|full\s*system|package\s*unit/.test(n)) return 6 * 60;
  if (/new\s*const|nc\s*install|(^|[^a-z])nc([^a-z]|$)/.test(n)) return 5 * 60;
  if (/duct/.test(n)) return 4 * 60;
  if (/furnace|condenser|air[\s\-]?handler|\bah\b|a\/h|coil|heat[\s\-]?pump/.test(n)) {
    return 4 * 60;
  }
  return 4 * 60;
}

/** ST job-types `duration` is usually minutes; tiny values treated as hours. */
function estimatedMinutesFromJobTypeRow(row: Record<string, unknown>): number | null {
  const candidates = [
    row.duration,
    row.estimatedDuration,
    row.durationMinutes,
    row.estimatedDurationMinutes,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n >= 30 && n <= 16 * 60) return Math.round(n);
    if (n > 0 && n < 30) return Math.round(n * 60);
  }
  return null;
}

type DurationAccum = { sum: number; count: number };

/**
 * Lean completed-appointment average by jobTypeId (capped pages).
 * Uses appointments modified lookback + jobTypeId when present on the row.
 * No money / no PTO writes.
 */
async function loadAvgDurationMinutesByJobType(
  env: Env,
  db: D1Database,
  tenantId: string,
  typeIds: number[]
): Promise<Map<number, number>> {
  const want = new Set(typeIds.filter((n) => n > 0));
  const out = new Map<number, number>();
  if (!want.size) return out;
  const acc = new Map<number, DurationAccum>();
  const lookFrom = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const modifiedOnOrAfter = lookFrom.toISOString();
  let page = 1;
  while (page <= 6) {
    const q = new URLSearchParams({
      modifiedOnOrAfter,
      page: String(page),
      pageSize: "100",
    });
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/appointments?${q.toString()}`
    );
    if (!res.ok) break;
    const body = res.json as { data?: Record<string, unknown>[]; hasMore?: boolean };
    const rows = body.data || [];
    for (const a of rows) {
      const status = str(a.status || a.appointmentStatus).toLowerCase();
      if (status.includes("cancel")) continue;
      const typeId =
        num(a.jobTypeId) ||
        num((a.jobType as Record<string, unknown> | undefined)?.id) ||
        null;
      if (!typeId || !want.has(typeId)) continue;
      const startRaw = str(a.start) || str(a.arrivalWindowStart);
      const endRaw = str(a.end) || str(a.arrivalWindowEnd);
      if (!startRaw || !endRaw) continue;
      const startMs = Date.parse(startRaw);
      const endMs = Date.parse(endRaw);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      const mins = Math.round((endMs - startMs) / 60000);
      if (mins < 45 || mins > 16 * 60) continue;
      const cur = acc.get(typeId) || { sum: 0, count: 0 };
      cur.sum += mins;
      cur.count += 1;
      acc.set(typeId, cur);
    }
    if (!rows.length || body.hasMore === false) break;
    if (body.hasMore !== true && rows.length < 100) break;
    page += 1;
  }
  for (const [id, a] of acc) {
    if (a.count >= 3) out.set(id, Math.round(a.sum / a.count));
  }
  return out;
}

export async function listMillerJobTypes(
  env: Env,
  db: D1Database,
  opts?: { includeNc?: boolean }
): Promise<{ types: MillerJobTypeOption[]; error?: string }> {
  const includeNc = opts?.includeNc === true;
  const tenantId = await stTenantId(env, db);
  if (!tenantId) return { types: [], error: "ServiceTitan not configured" };
  const types: MillerJobTypeOption[] = [];
  const byExact = new Map<string, { id: number; name: string; estimated: number | null }>();
  let page = 1;
  while (page <= 30) {
    const res = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${tenantId}/job-types?page=${page}&pageSize=100`
    );
    if (!res.ok) {
      return { types, error: `Job types fetch failed (${res.status})` };
    }
    for (const row of asDataArray(res.json)) {
      const id = num(row.id);
      const name = str(row.name);
      if (!id || !name) continue;
      const active = row.active;
      if (active === false) continue;
      byExact.set(name.toLowerCase(), { id, name, estimated: estimatedMinutesFromJobTypeRow(row) });
      if (!includeNc && isExactNcJobTypeName(name)) continue;
      if (!isMillerAllowedJobTypeName(name)) continue;
      const estimated = estimatedMinutesFromJobTypeRow(row);
      const heuristic = millerHeuristicDurationMinutes(name);
      types.push({
        id,
        name,
        estimated_minutes: estimated,
        avg_minutes: null,
        duration_minutes: estimated ?? heuristic,
        duration_source: estimated != null ? "estimated" : "heuristic",
      });
    }
    const hasMore = Boolean((res.json as { hasMore?: boolean })?.hasMore);
    if (!hasMore) break;
    page += 1;
  }
  if (includeNc) for (const def of NC_JOB_TYPE_DEFS) {
    const hit = byExact.get(def.stName.toLowerCase());
    if (hit) {
      const existing = types.find((t) => t.id === hit.id);
      if (existing) {
        existing.name = def.picker;
        existing.st_name = hit.name;
        existing.nc_key = def.key;
      } else {
        const heuristic = millerHeuristicDurationMinutes(hit.name);
        types.push({
          id: hit.id,
          name: def.picker,
          st_name: hit.name,
          nc_key: def.key,
          estimated_minutes: hit.estimated,
          avg_minutes: null,
          duration_minutes: hit.estimated ?? heuristic,
          duration_source: hit.estimated != null ? "estimated" : "heuristic",
        });
      }
    } else {
      types.push({
        id: 0,
        name: def.picker,
        st_name: def.stName,
        nc_key: def.key,
        unresolved: true,
        duration_minutes: millerHeuristicDurationMinutes(def.stName),
        duration_source: "heuristic",
      });
    }
  }
  types.sort((a, b) => a.name.localeCompare(b.name));

  // Prefer completed-job average duration when lean sample has >=3 hits
  try {
    const avgs = await loadAvgDurationMinutesByJobType(
      env,
      db,
      tenantId,
      types.map((t) => t.id)
    );
    for (const t of types) {
      const avg = avgs.get(t.id);
      if (avg != null && avg >= 30) {
        t.avg_minutes = avg;
        t.duration_minutes = avg;
        t.duration_source = "avg";
      }
    }
  } catch {
    /* keep estimated/heuristic */
  }

  return { types };
}

function formatLocationAddress(loc: Record<string, unknown>): string {
  const addr =
    (loc.address as Record<string, unknown> | undefined) ||
    (loc.locationAddress as Record<string, unknown> | undefined) ||
    {};
  const street =
    str(addr.street) ||
    str(addr.address) ||
    [str(addr.street1) || str(addr.line1), str(addr.street2) || str(addr.line2)]
      .filter(Boolean)
      .join(" ");
  const city = str(addr.city);
  const state = str(addr.state) || str(addr.stateProvince);
  const zip = str(addr.zip) || str(addr.postalCode);
  const tail = [city, state, zip].filter(Boolean).join(", ");
  if (street && tail) return `${street}, ${tail}`;
  return street || str(loc.name) || str(loc.customerName) || `Location ${loc.id}`;
}


/** Pull apt/unit/suite from a formatted or ST address string. */
export function extractAddressUnit(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m =
    /\b(?:apt(?:artment)?|unit|ste|suite|#)\s*([a-z0-9\-]+)\b/i.exec(s) ||
    /\s#\s*([a-z0-9\-]+)\s*$/i.exec(s);
  return m ? String(m[1]).toUpperCase() : null;
}

/** Normalize street for multi-unit grouping (drop unit tokens). */
export function streetKeyFromAddress(raw: string | null | undefined): string {
  let s = String(raw || "")
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(
      /\b(?:apt(?:artment)?|unit|ste|suite)\s*[a-z0-9\-]+\b/gi,
      " "
    )
    .replace(/#\s*[a-z0-9\-]+/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = s.split(" ").filter(Boolean);
  if (parts.length <= 4) return s;
  return parts.slice(0, 4).join(" ");
}

function unitFromLocRow(row: Record<string, unknown>): string | null {
  const addr =
    (row.address as Record<string, unknown> | undefined) ||
    (row.locationAddress as Record<string, unknown> | undefined) ||
    {};
  const direct =
    str(addr.unit) ||
    str(addr.apartment) ||
    str(addr.apt) ||
    str(addr.suite) ||
    str((row as { unit?: unknown }).unit);
  if (direct) return direct.toUpperCase();
  return extractAddressUnit(formatLocationAddress(row));
}

export async function searchMillerLocations(
  env: Env,
  db: D1Database,
  q: string
): Promise<{
  hits: MillerLocationHit[];
  multi_unit: boolean;
  error?: string;
}> {
  const tenantId = await stTenantId(env, db);
  if (!tenantId) return { hits: [], multi_unit: false, error: "ServiceTitan not configured" };
  const query = q.trim();
  if (query.length < 2) return { hits: [], multi_unit: false };

  /**
   * How Miller lands on the same location ST Global Search shows:
   * Locations?street= is NOT Global Search — it often matches the full street
   * line (prefix/exact-ish), not "contains". Global Search also finds people.
   * So we: (1) try specific house#+street[+suffix] first with active=Any,
   * (2) search customers by name when the query looks like a person,
   * (3) keep customer-name hits even when the address does not contain that name.
   */
  const bare = query.replace(/[,#]/g, " ").replace(/\s+/g, " ").trim();
  const looksLikeName = !/^\d/.test(bare) && /[a-zA-Z]{2,}/.test(bare);
  const SUFFIXES = [
    "dr",
    "drive",
    "rd",
    "road",
    "st",
    "street",
    "ln",
    "lane",
    "ct",
    "court",
    "ave",
    "avenue",
    "blvd",
    "boulevard",
  ];
  const suffixTitle = ["Dr", "Drive", "Rd", "St", "Ln", "Ct", "Ave"] as const;

  // Ordered most-specific first (cap work; stop early when house# fuzzy hits land)
  const ordered: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length >= 2 && !ordered.includes(t)) ordered.push(t);
  };
  push(query);
  push(bare);
  const mNum = /^(\d+)\s+(.+)$/i.exec(bare);
  if (mNum) {
    const house = mNum[1];
    const streetOnly = mNum[2].trim();
    const words = streetOnly.split(" ").filter(Boolean);
    const last = (words[words.length - 1] || "").toLowerCase();
    const hasSuffix = SUFFIXES.includes(last);
    // Full street line as ST often stores it: "158 Bent Grass Dr"
    if (!hasSuffix) {
      for (const suf of suffixTitle) {
        push(`${house} ${streetOnly} ${suf}`);
      }
    } else {
      push(`${house} ${streetOnly}`);
    }
    push(`${house} ${streetOnly}`);
    // Prefix-friendly short form: "158 Bent"
    if (words.length >= 1) push(`${house} ${words[0]}`);
    if (words.length >= 2) push(`${house} ${words.slice(0, 2).join(" ")}`);
    // Street-only after house-line attempts (weaker; can be noisy)
    if (streetOnly.length >= 3) {
      if (!hasSuffix) {
        for (const suf of suffixTitle) push(`${streetOnly} ${suf}`);
      }
      push(streetOnly);
      if (words.length >= 2) push(words.slice(0, 2).join(" "));
      if (words.length === 2) push(words.join(""));
    }
  } else if (looksLikeName) {
    push(bare);
    const parts = bare.split(" ").filter(Boolean);
    if (parts.length >= 2) {
      push(parts[parts.length - 1]!); // last name
      push(parts[0]!); // first name
    }
  }

  const byId = new Map<number, MillerLocationHit>();
  let locApiOk = false;
  let locApiLastStatus: number | null = null;
  let custApiOk = false;

  const ingestLoc = (
    row: Record<string, unknown>,
    customerFallback: { id?: number | null; name?: string | null } = {}
  ) => {
    const locationId = num(row.id);
    if (!locationId || byId.has(locationId)) return;
    const customerId =
      num(row.customerId) ||
      num((row.customer as Record<string, unknown> | undefined)?.id) ||
      customerFallback.id ||
      null;
    const address = formatLocationAddress(row);
    const unit = unitFromLocRow(row);
    byId.set(locationId, {
      location_id: locationId,
      customer_id: customerId,
      name: str(row.name) || null,
      address,
      customer_name:
        str(row.customerName) ||
        str((row.customer as Record<string, unknown> | undefined)?.name) ||
        customerFallback.name ||
        null,
      unit,
      street_key: streetKeyFromAddress(address),
    });
  };

  // Address-shaped queries: Locations street/name with active=Any
  if (!looksLikeName || mNum) {
    for (const v of ordered) {
      if (byId.size >= 8) break;
      const encoded = encodeURIComponent(v);
      const paths = [
        `/crm/v2/tenant/${encodeURIComponent(tenantId)}/locations?pageSize=25&active=Any&street=${encoded}`,
        `/crm/v2/tenant/${encodeURIComponent(tenantId)}/locations?pageSize=25&active=Any&name=${encoded}`,
      ];
      for (const path of paths) {
        const got = await stApiGet(env, db, path);
        locApiLastStatus = got.status;
        if (!got.ok) continue;
        locApiOk = true;
        for (const row of asDataArray(got.json)) ingestLoc(row);
      }
      if (
        mNum &&
        [...byId.values()].some((h) => addressContainsQuery(h.address, mNum[1]))
      ) {
        break;
      }
    }
  }

  // Customers path — required for name search; also street fallback
  const custVariants =
    looksLikeName && !mNum
      ? ordered
      : ordered.filter((v) => v.length >= 3).slice(0, 8);
  for (const v of custVariants) {
    if (looksLikeName && byId.size >= 1) break;
    if (!looksLikeName && byId.size >= 8) break;
    const encoded = encodeURIComponent(v);
    const paths = looksLikeName
      ? [
          `/crm/v2/tenant/${encodeURIComponent(tenantId)}/customers?pageSize=25&active=Any&name=${encoded}`,
        ]
      : [
          `/crm/v2/tenant/${encodeURIComponent(tenantId)}/customers?pageSize=25&active=Any&street=${encoded}`,
          `/crm/v2/tenant/${encodeURIComponent(tenantId)}/customers?pageSize=25&active=Any&name=${encoded}`,
        ];
    for (const path of paths) {
      const got = await stApiGet(env, db, path);
      if (!got.ok) continue;
      custApiOk = true;
      for (const cust of asDataArray(got.json)) {
        const cid = num(cust.id);
        if (!cid) continue;
        const custName = str(cust.name) || str(cust.customerName) || "";
        const nameMatched =
          looksLikeName ||
          (custName.length >= 2 && addressContainsQuery(custName, query));
        const locs = await stApiGet(
          env,
          db,
          `/crm/v2/tenant/${encodeURIComponent(tenantId)}/customers/${cid}/locations?pageSize=25&active=Any`
        );
        if (!locs.ok) continue;
        for (const row of asDataArray(locs.json)) {
          const locationId = num(row.id);
          if (!locationId || byId.has(locationId)) continue;
          const address = formatLocationAddress(row);
          // BUGFIX: keep locations when Miller searched by customer name
          if (
            query.length >= 3 &&
            !nameMatched &&
            !addressContainsQuery(address, query)
          ) {
            continue;
          }
          ingestLoc(row, { id: cid, name: custName || null });
        }
      }
    }
  }

  let hitList = [...byId.values()];
  if (!looksLikeName && query.length >= 3 && hitList.length > 1) {
    const filtered = hitList.filter((h) => addressContainsQuery(h.address, query));
    if (filtered.length) hitList = filtered;
  } else if (!looksLikeName && query.length >= 5 && hitList.length > 8) {
    const filtered = hitList.filter((h) => addressContainsQuery(h.address, query));
    if (filtered.length) hitList = filtered;
  }

  const hits = hitList.slice(0, 40);
  const byStreet = new Map<string, number>();
  let anyUnit = false;
  for (const h of hits) {
    if (h.unit) anyUnit = true;
    const k = h.street_key || streetKeyFromAddress(h.address);
    if (!k) continue;
    byStreet.set(k, (byStreet.get(k) || 0) + 1);
  }
  const multi_unit =
    anyUnit || [...byStreet.values()].some((n) => n > 1);

  let errMsg: string | undefined;
  if (!hits.length) {
    if (!locApiOk && !custApiOk && locApiLastStatus) {
      errMsg = `ST location search failed (${locApiLastStatus}). Check CRM Locations Read scope.`;
    } else if (!looksLikeName) {
      errMsg =
        "No ST match yet — try the full street (with Dr/Rd) or customer last name. Or check Not listed for Day Board only.";
    } else {
      errMsg =
        "No customer match — check spelling, or search the street address instead.";
    }
  }
  return { hits: hits.slice(0, 25), multi_unit, error: errMsg };
}

export type MillerBookInput = {
  location_id: number;
  customer_id?: number | null;
  job_type_id: number;
  crew_id: string;
  date: string; // YYYY-MM-DD Chicago
  arrival_window_id: string;
  /** Custom window HH:MM (24h or am/pm) when arrival_window_id=custom */
  custom_start?: string | null;
  custom_end?: string | null;
  summary?: string | null;
  /** Optional override - defaults to HARD LOCK pair techs */
  technician_ids?: number[] | null;
  /** Day Board only — never create in ServiceTitan */
  not_listed?: boolean;
  /** Free-text address when Not listed (location_id optional) */
  address_text?: string | null;
  /** Optional creator user id for audit */
  created_by?: number | null;
  /**
   * HARD override: allow ST Create even when open jobs exist at location.
   * Default false — office almost duplicated Bent Grass (#104297 on board).
   */
  force_duplicate?: boolean;
  /** NC only: Miller confirmed a Completed job of the same type. */
  acknowledge_completed?: boolean;
  /** Required when the location has 0 or 2+ open projects. */
  project_id?: number | null;
};

/** Chris HARD LOCK: Miller Install cannot book without a signed (Sold) proposal. */
export type MillerProposalStatus = {
  signed: boolean;
  estimate_id?: number | null;
  estimate_number?: string | null;
  status?: string | null;
  signed_on?: string | null;
  sold_on?: string | null;
  sold_by?: string | null;
  total?: number | null;
  message: string;
  /** How we decided signed (for ops / Gauge dig). */
  detection?: string | null;
};

const MILLER_PROPOSAL_NOT_SIGNED_MSG =
  "Proposal not signed — get with the customer.";

export type MillerBookResult = {
  ok: boolean;
  mode: MillerBookMode;
  dry_run: boolean;
  message: string;
  enable_live_hint: string;
  intended_payload?: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  st_job_id?: number | null;
  st_job_number?: string | null;
  st_appointment_id?: number | null;
  st_status?: number;
  st_error?: string;
  error?: string;
  board_job_id?: number | null;
  not_listed?: boolean;
  /** Open ST jobs already at this location (anti-dupe). */
  existing_jobs?: MillerExistingJob[];
  projects?: { id: number; name: string; status: string | null }[];
  /** Signed-proposal HARD LOCK result (Sold estimate). */
  proposal_status?: MillerProposalStatus;
};

const ENABLE_LIVE_HINT =
  "Live needs BOTH: MILLER_BOOK_JOB secret = live AND Settings > Install Book live = on (admin). Chris Y first.";


function parseMillerPresetTechIds(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

export async function listMillerCustomPresets(
  db: D1Database,
  userId: number
): Promise<MillerCustomPreset[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT id, name, technician_ids FROM miller_book_presets
         WHERE user_id = ? ORDER BY updated_at DESC, id DESC`
      )
      .bind(userId)
      .all<{ id: number; name: string; technician_ids: string }>();
    return (rows.results || []).map((r) => {
      const technician_ids = parseMillerPresetTechIds(String(r.technician_ids || '[]'));
      const name = String(r.name || '').trim() || 'Preset';
      return {
        id: Number(r.id),
        name,
        technician_ids,
        label: name,
        kind: 'custom' as const,
      };
    });
  } catch {
    return [];
  }
}

export async function createMillerCustomPreset(
  db: D1Database,
  userId: number,
  name: string,
  technicianIds: number[]
): Promise<{ ok: true; preset: MillerCustomPreset } | { ok: false; error: string }> {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { ok: false, error: 'Name required' };
  const ids = [...new Set((technicianIds || []).map(Number).filter((n) => n > 0))];
  if (!ids.length) return { ok: false, error: 'Pick at least one tech' };
  try {
    const res = await db
      .prepare(
        `INSERT INTO miller_book_presets (user_id, name, technician_ids, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(userId, cleanName, JSON.stringify(ids))
      .run();
    const id = Number(res.meta?.last_row_id || 0);
    if (!(id > 0)) return { ok: false, error: 'Could not save preset' };
    return {
      ok: true,
      preset: {
        id,
        name: cleanName,
        technician_ids: ids,
        label: cleanName,
        kind: 'custom',
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Save failed' };
  }
}

export async function updateMillerCustomPreset(
  db: D1Database,
  userId: number,
  presetId: number,
  patch: { name?: string; technician_ids?: number[] }
): Promise<{ ok: true; preset: MillerCustomPreset } | { ok: false; error: string }> {
  if (!(presetId > 0)) return { ok: false, error: 'Bad preset id' };
  const existing = await db
    .prepare(
      `SELECT id, name, technician_ids FROM miller_book_presets WHERE id = ? AND user_id = ?`
    )
    .bind(presetId, userId)
    .first<{ id: number; name: string; technician_ids: string }>();
  if (!existing) return { ok: false, error: 'Preset not found' };
  const name =
    patch.name != null ? String(patch.name).trim() : String(existing.name || '').trim();
  if (!name) return { ok: false, error: 'Name required' };
  const ids =
    patch.technician_ids != null
      ? [...new Set(patch.technician_ids.map(Number).filter((n) => n > 0))]
      : parseMillerPresetTechIds(String(existing.technician_ids || '[]'));
  if (!ids.length) return { ok: false, error: 'Pick at least one tech' };
  try {
    await db
      .prepare(
        `UPDATE miller_book_presets SET name = ?, technician_ids = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      )
      .bind(name, JSON.stringify(ids), presetId, userId)
      .run();
    return {
      ok: true,
      preset: { id: presetId, name, technician_ids: ids, label: name, kind: 'custom' },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Update failed' };
  }
}

export async function deleteMillerCustomPreset(
  db: D1Database,
  userId: number,
  presetId: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(presetId > 0)) return { ok: false, error: 'Bad preset id' };
  try {
    const res = await db
      .prepare(`DELETE FROM miller_book_presets WHERE id = ? AND user_id = ?`)
      .bind(presetId, userId)
      .run();
    if (!(Number(res.meta?.changes || 0) > 0)) return { ok: false, error: 'Preset not found' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Delete failed' };
  }
}

export async function millerBookMeta(
  env: Env,
  db: D1Database,
  userId?: number | null
) {
  const mode = await millerBookEffectiveMode(env, db);
  const ncEnabled = await millerNcBookEnabled(db);
  const liveSetting = settingOn(await getSetting(db, "miller_book_live_enabled", "false"));
  const tenantId = await stTenantId(env, db);
  const crews = await listMillerCrews(db);
  const technicians = await listMillerTechnicians(env, db);
  const customPresets =
    userId && userId > 0 ? await listMillerCustomPresets(db, userId) : [];
  const presetChips: MillerPresetChip[] = [
    ...crews.map((c) => ({
      id: c.id,
      label: c.label,
      technician_ids: c.technician_ids,
      kind: "hard_lock" as const,
      lead_name: c.lead_name,
      helper_name: c.helper_name,
    })),
    ...customPresets.map((p) => ({
      id: `custom-${p.id}`,
      label: p.label,
      technician_ids: p.technician_ids,
      kind: "custom" as const,
      custom_id: p.id,
    })),
  ];
  const { types, error: typesError } = await listMillerJobTypes(env, db, { includeNc: ncEnabled });
  let bu: { id: number | null; name: string; error?: string } = {
    id: null,
    name: BU_NAME,
  };
  let campaign: { id: number | null; name: string | null; error?: string } = {
    id: null,
    name: null,
  };
  if (tenantId) {
    bu = await resolveBusinessUnitId(env, db, tenantId);
    campaign = await resolveCampaignId(env, db, tenantId);
  }
  return {
    mode,
    nc_enabled: ncEnabled,
    live_env: millerBookMode(env) === "live",
    live_setting: liveSetting,
    dry_run: mode !== "live",
    st_configured: Boolean(tenantId),
    business_unit: bu,
    campaign,
    crews,
    /** HARD LOCK starters + user custom presets */
    presets: presetChips,
    custom_presets: customPresets,
    technicians,
    job_types: types,
    arrival_windows: MILLER_ARRIVAL_WINDOWS.map((w) => ({
      id: w.id,
      label: w.label,
    })),
    hard_locks: {
      send_booking_confirmation_text: false,
      business_unit_name: BU_NAME,
      path: "Search address → Location → Book Job (not Schedule Assistant)",
      job_types_allowlist_only: true,
      installers_nc_only: true,
      no_estimate_sold_project: true,
      crew_pairs_are_presets_only: true,
    },
    enable_live_hint: ENABLE_LIVE_HINT,
    errors: [typesError, bu.error, campaign.error, !tenantId ? "ST not configured" : null].filter(
      Boolean
    ),
  };
}


/** Save a Not listed job to D1 — Day Board only, never ServiceTitan. */

export type MillerExistingJob = {
  job_id: number;
  job_number: string | null;
  job_type: string | null;
  status: string | null;
  technician_names: string[];
  appointment_start: string | null;
  location_id: number | null;
  project_id?: number | null;
};

/** Open = not canceled/completed (Scheduled / Dispatched / Working / Hold / etc.). */
export function isMillerOpenJobStatus(status: string | null | undefined): boolean {
  const s = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  if (!s) return true;
  if (
    s === "canceled" ||
    s === "cancelled" ||
    s.includes("canceled") ||
    s.includes("cancelled")
  ) {
    return false;
  }
  if (
    s === "done" ||
    s === "completed" ||
    s === "complete" ||
    s === "finished" ||
    /\bdone\b/.test(s) ||
    s.includes("finish")
  ) {
    return false;
  }
  return true;
}

function jobStatusFromRow(row: Record<string, unknown>): string | null {
  return (
    str(row.jobStatus) ||
    str(row.status) ||
    str((row.jobStatus as Record<string, unknown> | undefined)?.name) ||
    null
  );
}

function chicagoYmdShift(ymd: string, deltaDays: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const dt = new Date(utc);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function apptYmdChicago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  // Chicago = America/Chicago; approximate via en-US format in that zone
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(t));
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* ignore */
  }
  return null;
}



/**
 * Detect a signed ST Sales estimate for location (prefer) or customer.
 *
 * Gauge FINAL: signed = Estimate **status === Sold** only (Sign/Accept sets Sold).
 * Do NOT use invoice signature. No separate signature-date field required.
 * API: GET /sales/v2/tenant/{t}/estimates?locationId= (fallback customerId).
 *
 * Smoke: Griessen loc 268674752 — Sold #396189951 (~$11750) PASS;
 *         Open #396183685 FAIL.
 * Capture soldOn/soldBy when present for display only (not required for gate).
 */
function estimateStatusRaw(row: Record<string, unknown>): string {
  const nested = row.status;
  if (nested && typeof nested === "object") {
    const o = nested as Record<string, unknown>;
    return str(o.name || o.value || o.status || o.label);
  }
  return str(row.status || row.estimateStatus || row.Status);
}

function estimateLooksSigned(row: Record<string, unknown>): {
  signed: boolean;
  detection: string;
  signed_on: string | null;
} {
  // Gauge FINAL: gate ONLY on estimate status Sold. Ignore invoice signatures.
  const status = estimateStatusRaw(row);
  const statusLower = status.toLowerCase().replace(/_/g, " ");
  const soldOn =
    str(row.soldOn) ||
    str(row.soldOnDate) ||
    str(row.SoldOn) ||
    null;
  if (statusLower === "sold" || /(^|\s)sold(\s|$)/.test(statusLower)) {
    return {
      signed: true,
      detection: soldOn ? "status=Sold+soldOn" : "status=Sold",
      signed_on: soldOn,
    };
  }
  return {
    signed: false,
    detection: status ? `status=${status}` : "no Sold estimate",
    signed_on: null,
  };
}

function mapEstimateProposalHit(
  row: Record<string, unknown>
): MillerProposalStatus {
  const look = estimateLooksSigned(row);
  const estimate_id = num(row.id);
  const estimate_number =
    str(row.estimateNumber) ||
    str(row.number) ||
    str(row.name) ||
    (estimate_id ? String(estimate_id) : null);
  const status = estimateStatusRaw(row) || null;
  const sold_on =
    str(row.soldOn) || str(row.soldOnDate) || look.signed_on || null;
  const soldByObj = row.soldBy as Record<string, unknown> | undefined;
  const sold_by =
    str(row.soldByName) ||
    str(soldByObj?.name) ||
    str(row.soldBy) ||
    null;
  const totalRaw = row.total ?? row.subtotal ?? row.grandTotal;
  const total =
    totalRaw != null && Number.isFinite(Number(totalRaw))
      ? Number(totalRaw)
      : null;
  if (look.signed) {
    return {
      signed: true,
      estimate_id,
      estimate_number,
      status,
      signed_on: look.signed_on,
      sold_on,
      sold_by,
      total,
      message: "Signed proposal on file (Sold).",
      detection: look.detection,
    };
  }
  return {
    signed: false,
    estimate_id,
    estimate_number,
    status,
    signed_on: null,
    sold_on,
    sold_by,
    total,
    message: MILLER_PROPOSAL_NOT_SIGNED_MSG,
    detection: look.detection,
  };
}

async function listSalesEstimates(
  env: Env,
  db: D1Database,
  tenantId: string,
  params: { locationId?: number | null; customerId?: number | null }
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  const ingest = (list: Record<string, unknown>[]) => {
    for (const row of list) {
      const id = num(row.id) || 0;
      if (id > 0 && seen.has(id)) continue;
      if (id > 0) seen.add(id);
      rows.push(row);
    }
  };

  const lid = params.locationId != null ? Number(params.locationId) : 0;
  const cid = params.customerId != null ? Number(params.customerId) : 0;

  // Prefer locationId (Gauge / Chris). Also try status=Sold filter for speed,
  // then unfiltered location list so we can detect soldOn without status.
  if (lid > 0) {
    const paths = [
      `/sales/v2/tenant/${encodeURIComponent(tenantId)}/estimates?locationId=${lid}&status=Sold&pageSize=50&includeTotal=true`,
      `/sales/v2/tenant/${encodeURIComponent(tenantId)}/estimates?locationId=${lid}&pageSize=50&includeTotal=true`,
    ];
    for (const path of paths) {
      const got = await stApiGet(env, db, path);
      if (!got.ok) continue;
      ingest(asDataArray(got.json));
      if (rows.some((r) => estimateLooksSigned(r).signed)) break;
    }
  }

  // Fallback: customerId (ST may or may not honor this filter — best-effort)
  if (!rows.some((r) => estimateLooksSigned(r).signed) && cid > 0) {
    const paths = [
      `/sales/v2/tenant/${encodeURIComponent(tenantId)}/estimates?customerId=${cid}&status=Sold&pageSize=50&includeTotal=true`,
      `/sales/v2/tenant/${encodeURIComponent(tenantId)}/estimates?customerId=${cid}&pageSize=50&includeTotal=true`,
    ];
    for (const path of paths) {
      const got = await stApiGet(env, db, path);
      if (!got.ok) continue;
      ingest(asDataArray(got.json));
      if (rows.some((r) => estimateLooksSigned(r).signed)) break;
    }
  }

  return rows;
}

/**
 * HARD LOCK helper: signed proposal for location/customer?
 * Prefer locationId; fallback customerId. Soft: read-only ST GET (no writes).
 */

/** Sample GET /day-board/miller-book/proposal-status?location_id=268674752
 * PASS: { "signed": true, "estimate_id": 396189951, "status": "Sold", "total": 11750,
 *         "message": "Signed proposal on file (Sold).", "detection": "status=Sold" }
 * FAIL (Open only): { "signed": false, "estimate_id": 396183685, "status": "Open",
 *         "message": "Proposal not signed — get with the customer.",
 *         "detection": "status=Open" }
 */
export async function checkSignedProposal(
  env: Env,
  db: D1Database,
  locationId?: number | null,
  customerId?: number | null
): Promise<MillerProposalStatus> {
  const lid = locationId != null ? Number(locationId) : 0;
  const cid = customerId != null ? Number(customerId) : 0;
  if (!(lid > 0) && !(cid > 0)) {
    return {
      signed: false,
      message: MILLER_PROPOSAL_NOT_SIGNED_MSG,
      detection: "missing locationId/customerId",
    };
  }

  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return {
      signed: false,
      message: MILLER_PROPOSAL_NOT_SIGNED_MSG,
      detection: "ServiceTitan not configured",
    };
  }

  let rows: Record<string, unknown>[] = [];
  try {
    rows = await listSalesEstimates(env, db, tenantId, {
      locationId: lid > 0 ? lid : null,
      customerId: cid > 0 ? cid : null,
    });
  } catch {
    rows = [];
  }

  // Prefer a Sold hit; else first row for diagnostics
  let best: Record<string, unknown> | null = null;
  for (const row of rows) {
    if (estimateLooksSigned(row).signed) {
      best = row;
      break;
    }
  }
  if (!best && rows.length) best = rows[0]!;

  if (!best) {
    return {
      signed: false,
      message: MILLER_PROPOSAL_NOT_SIGNED_MSG,
      detection: lid > 0 ? "no estimates for locationId" : "no estimates for customerId",
    };
  }
  return mapEstimateProposalHit(best);
}


/**
 * Look up open ST jobs at a CRM locationId (Bent Grass / Griessen case).
 * Query: JPM jobs?locationId= (fallback locationIds=, then customerId + filter).
 * Completed/Canceled are excluded so #104256 Completed does not block; #104297 Scheduled does.
 */
export async function findOpenJobsAtLocation(
  env: Env,
  db: D1Database,
  tenantId: string,
  locationId: number,
  date?: string | null,
  customerId?: number | null,
  allStatuses?: boolean
): Promise<MillerExistingJob[]> {
  const lid = Number(locationId);
  if (!(lid > 0) || !tenantId) return [];

  const rows: Record<string, unknown>[] = [];
  const seen = new Set<number>();

  const ingest = (list: Record<string, unknown>[], requireLoc: boolean) => {
    for (const row of list) {
      const id = num(row.id);
      if (!(id && id > 0) || seen.has(id)) continue;
      const rowLid =
        num(row.locationId) ||
        num((row.location as Record<string, unknown> | undefined)?.id);
      if (requireLoc && rowLid && rowLid !== lid) continue;
      if (!requireLoc && rowLid && rowLid !== lid) continue;
      seen.add(id);
      rows.push(row);
    }
  };

  // 1) Preferred: locationId filter (ST JPM Jobs list)
  const tryPaths = [
    `/jpm/v2/tenant/${encodeURIComponent(tenantId)}/jobs?locationId=${lid}&pageSize=50&includeTotal=true`,
    `/jpm/v2/tenant/${encodeURIComponent(tenantId)}/jobs?locationIds=${lid}&pageSize=50&includeTotal=true`,
  ];
  let locFilterWorked = false;
  for (const path of tryPaths) {
    const got = await stApiGet(env, db, path);
    if (!got.ok) continue;
    const data = asDataArray(got.json);
    if (data.length || got.status === 200) {
      locFilterWorked = true;
      ingest(data, true);
      if (data.length) break;
    }
  }

  // 2) Fallback: customerId then filter by locationId client-side
  const cid = customerId != null ? Number(customerId) : null;
  if (!rows.length && cid && cid > 0) {
    const got = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${encodeURIComponent(tenantId)}/jobs?customerId=${cid}&pageSize=50&includeTotal=true`
    );
    if (got.ok) ingest(asDataArray(got.json), true);
  } else if (!locFilterWorked && !rows.length) {
    // Last resort: no filter worked — cannot safely list all jobs
  }

  const openRows = allStatuses
    ? rows
    : rows.filter((r) => isMillerOpenJobStatus(jobStatusFromRow(r)));
  if (!openRows.length) return [];

  // Job type names (best-effort)
  const typeIds = [
    ...new Set(
      openRows
        .map((r) => num(r.jobTypeId) || num((r.jobType as Record<string, unknown> | undefined)?.id))
        .filter((n): n is number => n != null && n > 0)
    ),
  ];
  const typeName = new Map<number, string>();
  if (typeIds.length) {
    try {
      const { types } = await listMillerJobTypes(env, db, { includeNc: await millerNcBookEnabled(db) });
      for (const t of types) typeName.set(t.id, t.name);
    } catch {
      /* ignore */
    }
    // Fill gaps via job-types by ids if needed
    const missing = typeIds.filter((id) => !typeName.has(id));
    if (missing.length) {
      const q = new URLSearchParams({
        ids: missing.join(","),
        pageSize: String(Math.max(missing.length, 10)),
      });
      const got = await stApiGet(
        env,
        db,
        `/jpm/v2/tenant/${encodeURIComponent(tenantId)}/job-types?${q.toString()}`
      );
      if (got.ok) {
        for (const row of asDataArray(got.json)) {
          const id = num(row.id);
          const name = str(row.name);
          if (id && name) typeName.set(id, name);
        }
      }
    }
  }

  // Appointments for tech names + date preference (today±1 / book date)
  const jobIds = openRows.map((r) => num(r.id)!).filter((n) => n > 0);
  type ApptInfo = {
    start: string | null;
    status: string | null;
    techIds: number[];
    ymd: string | null;
  };
  const apptsByJob = new Map<number, ApptInfo[]>();
  for (const jid of jobIds) {
    const q = new URLSearchParams({
      jobId: String(jid),
      pageSize: "20",
    });
    const got = await stApiGet(
      env,
      db,
      `/jpm/v2/tenant/${encodeURIComponent(tenantId)}/appointments?${q.toString()}`
    );
    if (!got.ok) continue;
    for (const a of asDataArray(got.json)) {
      const aid =
        num(a.jobId) ||
        num((a.job as Record<string, unknown> | undefined)?.id) ||
        jid;
      if (!(aid && aid > 0)) continue;
      const start =
        str(a.start) ||
        str(a.arrivalWindowStart) ||
        str(a.startDate) ||
        null;
      const techIds: number[] = [];
      const rawTech = a.technicianIds;
      if (Array.isArray(rawTech)) {
        for (const t of rawTech) {
          const n = Number(t);
          if (n > 0) techIds.push(n);
        }
      }
      const info: ApptInfo = {
        start,
        status: str(a.status) || str(a.appointmentStatus) || null,
        techIds,
        ymd: apptYmdChicago(start),
      };
      const list = apptsByJob.get(aid) || [];
      list.push(info);
      apptsByJob.set(aid, list);
    }
  }

  // Tech name map (best-effort)
  const allTechIds = [
    ...new Set(
      [...apptsByJob.values()].flatMap((list) => list.flatMap((a) => a.techIds))
    ),
  ];
  const techLabel = new Map<number, string>();
  if (allTechIds.length) {
    try {
      const loaded = await loadStTechnicians(env, db, tenantId);
      if (loaded.ok) {
        for (const t of loaded.techs) {
          const id = Number(t.id);
          if (id > 0) techLabel.set(id, str(t.name) || String(id));
        }
      }
    } catch {
      /* ignore */
    }
  }

  const bookYmd = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  const preferYmds = new Set<string>();
  if (bookYmd) {
    preferYmds.add(bookYmd);
    const prev = chicagoYmdShift(bookYmd, -1);
    const next = chicagoYmdShift(bookYmd, 1);
    if (prev) preferYmds.add(prev);
    if (next) preferYmds.add(next);
  }

  const out: MillerExistingJob[] = [];
  for (const row of openRows) {
    const jobId = num(row.id)!;
    const appts = apptsByJob.get(jobId) || [];
    // Prefer appointment on book date ±1, else any still-open appointment, else first
    const openAppts = appts.filter((a) => isMillerOpenJobStatus(a.status) || !a.status);
    let pick =
      (bookYmd &&
        openAppts.find((a) => a.ymd && preferYmds.has(a.ymd))) ||
      openAppts[0] ||
      appts[0] ||
      null;

    // If book date given and none of the appointments are in ±1 and job has only completed appts, still keep if job itself is open
    const techNames = pick
      ? pick.techIds.map((id) => techLabel.get(id) || String(id))
      : [];
    const typeId =
      num(row.jobTypeId) ||
      num((row.jobType as Record<string, unknown> | undefined)?.id);
    const jt =
      str(row.jobTypeName) ||
      str((row.jobType as Record<string, unknown> | undefined)?.name) ||
      (typeId ? typeName.get(typeId) || null : null);

    out.push({
      job_id: jobId,
      job_number: str(row.jobNumber) || str(row.number) || null,
      job_type: jt,
      status: jobStatusFromRow(row),
      technician_names: techNames,
      appointment_start: pick?.start || null,
      project_id:
        num(row.projectId) ||
        num((row.project as Record<string, unknown> | undefined)?.id) ||
        null,
      location_id:
        num(row.locationId) ||
        num((row.location as Record<string, unknown> | undefined)?.id) ||
        lid,
    });
  }

  // Prefer jobs with appointments on selected book date
  if (bookYmd) {
    out.sort((a, b) => {
      const ay = apptYmdChicago(a.appointment_start);
      const by = apptYmdChicago(b.appointment_start);
      const ascore = ay && preferYmds.has(ay) ? 0 : 1;
      const bscore = by && preferYmds.has(by) ? 0 : 1;
      return ascore - bscore;
    });
  }
  return out;
}

/**
 * Best-effort: open ST jobs whose location address fuzzy-matches (Not listed path).
 * Uses customer/location search then findOpenJobsAtLocation — no ST write.
 */
export async function findOpenJobsAtAddressText(
  env: Env,
  db: D1Database,
  tenantId: string,
  addressText: string,
  date?: string | null
): Promise<MillerExistingJob[]> {
  const q = String(addressText || "").trim();
  if (q.length < 5 || !tenantId) return [];
  const { hits } = await searchMillerLocations(env, db, q);
  const street = streetKeyFromAddress(q);
  const matched = hits.filter((h) => {
    if (street && h.street_key && h.street_key === street) return true;
    return addressContainsQuery(h.address, q) || addressContainsQuery(q, h.address);
  });
  const byJob = new Map<number, MillerExistingJob>();
  for (const h of matched.slice(0, 5)) {
    const jobs = await findOpenJobsAtLocation(
      env,
      db,
      tenantId,
      h.location_id,
      date,
      h.customer_id
    );
    for (const j of jobs) byJob.set(j.job_id, j);
  }
  return [...byJob.values()];
}


export async function createMillerBoardOnlyJob(
  env: Env,
  db: D1Database,
  input: MillerBookInput
): Promise<MillerBookResult> {
  const mode = await millerBookEffectiveMode(env, db);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || "")) {
    return {
      ok: false,
      mode,
      dry_run: false,
      message: "Start date required (YYYY-MM-DD)",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "Invalid date",
      not_listed: true,
    };
  }

  const allowedTechs = await listMillerTechnicians(env, db);
  const allowedSt = new Set(
    allowedTechs
      .map((t) => Number(t.st_technician_id))
      .filter((n) => n > 0)
  );
  const techIds: number[] = [];
  const seenTech = new Set<number>();
  for (const raw of input.technician_ids || []) {
    const n = Number(raw);
    if (!(n > 0) || seenTech.has(n)) continue;
    if (!allowedSt.has(n)) {
      return {
        ok: false,
        mode,
        dry_run: false,
        message: "Technician not on Install / New Construction roster",
        enable_live_hint: ENABLE_LIVE_HINT,
        error: "technician_id not allowed",
        not_listed: true,
      };
    }
    seenTech.add(n);
    techIds.push(n);
  }
  if (!techIds.length) {
    return {
      ok: false,
      mode,
      dry_run: false,
      message: "Select at least one installer / new-construction tech",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "No technicians",
      not_listed: true,
    };
  }

  const win = MILLER_ARRIVAL_WINDOWS.find((w) => w.id === input.arrival_window_id);
  let startIso: string;
  let endIso: string;
  if (!win || win.id === "custom") {
    const cs = parseHm(String(input.custom_start || ""));
    const ce = parseHm(String(input.custom_end || ""));
    if (!cs || !ce) {
      return {
        ok: false,
        mode,
        dry_run: false,
        message: "Custom window needs start and end times",
        enable_live_hint: ENABLE_LIVE_HINT,
        error: "custom times required",
        not_listed: true,
      };
    }
    startIso = chicagoWallToIso(input.date, cs.hour, cs.minute);
    endIso = chicagoWallToIso(input.date, ce.hour, ce.minute);
  } else {
    startIso = chicagoWallToIso(
      input.date,
      Math.floor(win.startMin! / 60),
      win.startMin! % 60
    );
    endIso = chicagoWallToIso(
      input.date,
      Math.floor(win.endMin! / 60),
      win.endMin! % 60
    );
  }

  let address = str(input.address_text);
  let customerName: string | null = null;
  let locationId = num(input.location_id);
  let customerId = input.customer_id ? num(input.customer_id) : null;

  if (locationId) {
    const tenantId = await stTenantId(env, db);
    if (tenantId) {
      const locRes = await stApiGet(
        env,
        db,
        `/crm/v2/tenant/${tenantId}/locations/${locationId}`
      );
      if (locRes.ok && locRes.json && typeof locRes.json === "object") {
        const loc = locRes.json as Record<string, unknown>;
        if (!address) address = formatLocationAddress(loc);
        customerId =
          customerId ||
          num(loc.customerId) ||
          num((loc.customer as Record<string, unknown> | undefined)?.id) ||
          null;
        const cn = str(
          (loc.customer as Record<string, unknown> | undefined)?.name ||
            loc.customerName
        );
        if (cn) customerName = cn;
      }
    }
  }

  // HARD LOCK: signed proposal required (Sold estimate) — block Not listed too (Chris default).
  {
    const proposal = await checkSignedProposal(
      env,
      db,
      locationId && locationId > 0 ? locationId : null,
      customerId && customerId > 0 ? customerId : null
    );
    if (!proposal.signed) {
      return {
        ok: false,
        mode,
        dry_run: false,
        message: proposal.message || MILLER_PROPOSAL_NOT_SIGNED_MSG,
        enable_live_hint: ENABLE_LIVE_HINT,
        error: "proposal_not_signed",
        not_listed: true,
        proposal_status: proposal,
      };
    }
  }

  if (!address) {
    return {
      ok: false,
      mode,
      dry_run: false,
      message: "Not listed needs an address (type one or pick a location)",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "address required",
      not_listed: true,
    };
  }

  // Best-effort warn: ST already has open job at this address/location (same date window)
  let boardWarnJobs: MillerExistingJob[] = [];
  try {
    const tenantId = await stTenantId(env, db);
    if (tenantId) {
      if (locationId && locationId > 0) {
        boardWarnJobs = await findOpenJobsAtLocation(
          env,
          db,
          tenantId,
          locationId,
          input.date,
          customerId
        );
      } else if (address.length >= 5) {
        boardWarnJobs = await findOpenJobsAtAddressText(
          env,
          db,
          tenantId,
          address,
          input.date
        );
      }
    }
  } catch {
    boardWarnJobs = [];
  }

  let jobTypeName = "Not listed";
  if (Number(input.job_type_id) > 0) {
    const { types } = await listMillerJobTypes(env, db, { includeNc: await millerNcBookEnabled(db) });
    const hit = types.find((x) => x.id === Number(input.job_type_id));
    if (hit) jobTypeName = hit.name;
  }

  const techLabels = techIds.map((id) => {
    const hit = allowedTechs.find((x) => Number(x.st_technician_id) === id);
    return hit?.label || hit?.display_name || String(id);
  });

  const note =
    str(input.summary) ||
    `Not listed · ${jobTypeName} · ${techLabels.join(", ")}`;

  try {
    const ins = await db
      .prepare(
        `INSERT INTO miller_board_jobs
          (work_date, address, customer_name, job_type_name, window_start, window_end,
           technician_ids, tech_labels, note, location_id, customer_id, created_by, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         RETURNING id`
      )
      .bind(
        input.date,
        address,
        customerName,
        jobTypeName,
        startIso,
        endIso,
        JSON.stringify(techIds),
        JSON.stringify(techLabels),
        note,
        locationId,
        customerId,
        input.created_by != null ? Number(input.created_by) : null
      )
      .first<{ id: number }>();

    const boardId = ins?.id != null ? Number(ins.id) : null;
    return {
      ok: true,
      mode,
      dry_run: false,
      message:
        boardWarnJobs.length > 0
          ? `Not listed on Day Board${boardId ? ` (#${boardId})` : ""} — WARNING: ST already has open job(s) at this address (e.g. #${boardWarnJobs[0]?.job_number || boardWarnJobs[0]?.job_id}). No ServiceTitan job created.`
          : `Not listed on Day Board${boardId ? ` (#${boardId})` : ""} — no ServiceTitan job`,
      enable_live_hint: ENABLE_LIVE_HINT,
      board_job_id: boardId,
      not_listed: true,
      existing_jobs: boardWarnJobs.length ? boardWarnJobs : undefined,
      resolved: {
        not_listed: true,
        address,
        job_type: jobTypeName,
        technicians: techLabels,
        technician_ids: techIds,
        date: input.date,
        arrival_window_id: input.arrival_window_id,
        window_start: startIso,
        window_end: endIso,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      mode,
      dry_run: false,
      message: `Could not save Not listed job (${msg}). Run migration 089 if table missing.`,
      enable_live_hint: ENABLE_LIVE_HINT,
      error: msg,
      not_listed: true,
    };
  }
}

async function listProjectsAtLocation(
  env: Env,
  db: D1Database,
  tenantId: string,
  locationId: number
): Promise<{ id: number; name: string; status: string | null }[]> {
  const got = await stApiGet(
    env,
    db,
    `/jpm/v2/tenant/${encodeURIComponent(tenantId)}/projects?locationId=${locationId}&pageSize=50`
  );
  if (!got.ok) return [];
  return asDataArray(got.json)
    .map((p) => {
      const statusRaw = p.status;
      const status =
        statusRaw && typeof statusRaw === "object"
          ? str((statusRaw as { name?: string }).name)
          : str(statusRaw);
      const id = num(p.id) || 0;
      return { id, name: str(p.name) || `Project ${id}`, status: status || null };
    })
    .filter((p) => p.id > 0);
}

async function localProjectForLocation(db: D1Database, locationId: number): Promise<number[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT st_project_id FROM new_construction_setups
         WHERE st_location_id = ? AND st_project_id IS NOT NULL AND TRIM(st_project_id) != ''`
      )
      .bind(String(locationId))
      .all<{ st_project_id: string }>();
    return (rows.results || []).map((r) => Number(r.st_project_id)).filter((n) => n > 0);
  } catch {
    return [];
  }
}

export async function createMillerBookJob(
  env: Env,
  db: D1Database,
  input: MillerBookInput
): Promise<MillerBookResult> {
  if (input.not_listed) {
    return createMillerBoardOnlyJob(env, db, input);
  }
  const mode = await millerBookEffectiveMode(env, db);
  const tenantId = await stTenantId(env, db);
  if (!tenantId) {
    return {
      ok: false,
      mode,
      dry_run: true,
      message: "ServiceTitan not configured",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "ServiceTitan not configured",
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || "")) {
    return {
      ok: false,
      mode,
      dry_run: mode !== "live",
      message: "Start date required (YYYY-MM-DD)",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "Invalid date",
    };
  }

  // Server reject: job_type_id must be on Install / New Construction allowlist
  const includeNc = await millerNcBookEnabled(db);
  const { types: allowedTypes, error: allowedTypesError } = await listMillerJobTypes(
    env,
    db,
    { includeNc }
  );
  if (allowedTypesError && !allowedTypes.length) {
    return {
      ok: false,
      mode,
      dry_run: mode !== "live",
      message: allowedTypesError,
      enable_live_hint: ENABLE_LIVE_HINT,
      error: allowedTypesError,
    };
  }
  const allowedType = allowedTypes.find((t) => t.id === Number(input.job_type_id) && t.id > 0);
  if (allowedTypes.some((t) => t.unresolved && t.name && Number(input.job_type_id) === 0)) {
    const missing = allowedTypes.find((t) => t.unresolved);
    return {
      ok: false,
      mode,
      dry_run: mode !== "live",
      message: `Job type "${missing?.st_name || missing?.name}" was not found in ServiceTitan`,
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "job_type_unresolved",
    };
  }
  if (!allowedType) {
    return {
      ok: false,
      mode,
      dry_run: mode !== "live",
      message:
        "Job type not on Miller Install allowlist (Install / New Construction only)",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "job_type_id not allowed",
      resolved: { job_type_id: input.job_type_id },
    };
  }

// Installer / NC techs only - Book Job assigns selected technicianIds
  const allowedTechs = await listMillerTechnicians(env, db);
  const allowedSt = new Set(
    allowedTechs
      .map((t) => Number(t.st_technician_id))
      .filter((n) => n > 0)
  );
  const techIds: number[] = [];
  const seenTech = new Set<number>();
  for (const raw of input.technician_ids || []) {
    const n = Number(raw);
    if (!(n > 0) || seenTech.has(n)) continue;
    if (!allowedSt.has(n)) {
      return {
        ok: false,
        mode,
        dry_run: mode !== "live",
        message: "Technician not on Install / New Construction roster",
        enable_live_hint: ENABLE_LIVE_HINT,
        error: "technician_id not allowed",
        resolved: { technician_id: n },
      };
    }
    seenTech.add(n);
    techIds.push(n);
  }
  if (!techIds.length) {
    return {
      ok: false,
      mode,
      dry_run: mode !== "live",
      message: "Select at least one installer / new-construction tech",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "No technicians",
    };
  }

  const nc = isExactNcJobTypeName(allowedType.st_name || allowedType.name);
  const bu = await resolveBusinessUnitId(
    env,
    db,
    tenantId,
    nc ? NC_BU_NAME : BU_NAME,
    nc ? "miller_book_bu_nc_id" : "miller_book_bu_id"
  );
  const campaign = await resolveCampaignId(env, db, tenantId);
  if (!bu.id) {
    return {
      ok: false,
      mode,
      dry_run: mode !== "live",
      message: bu.error || "HVAC Install business unit missing",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: bu.error || "BU missing",
    };
  }
  if (!campaign.id) {
    return {
      ok: false,
      mode,
      dry_run: mode !== "live",
      message: campaign.error || "Marketing campaign missing",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: campaign.error || "Campaign missing",
    };
  }

  // Resolve customerId from location if not provided
  let customerId = input.customer_id || null;
  let locationLabel = `Location ${input.location_id}`;
  const locRes = await stApiGet(
    env,
    db,
    `/crm/v2/tenant/${tenantId}/locations/${input.location_id}`
  );
  if (locRes.ok && locRes.json && typeof locRes.json === "object") {
    const loc = locRes.json as Record<string, unknown>;
    customerId =
      customerId ||
      num(loc.customerId) ||
      num((loc.customer as Record<string, unknown> | undefined)?.id) ||
      null;
    locationLabel = formatLocationAddress(loc);
  }
  if (!customerId) {
    return {
      ok: false,
      mode,
      dry_run: mode !== "live",
      message: "Location has no customerId — pick another location hit",
      enable_live_hint: ENABLE_LIVE_HINT,
      error: "customerId required",
    };
  }


  // HARD LOCK: signed proposal (Sold estimate) required before Create / dry-run.
  // New Construction Rough / Final / Trim Out skip it. Azali projects have no estimates.
  if (!nc) {
    const proposal = await checkSignedProposal(
      env,
      db,
      Number(input.location_id),
      customerId
    );
    if (!proposal.signed) {
      return {
        ok: false,
        mode,
        dry_run: mode !== "live",
        message: proposal.message || MILLER_PROPOSAL_NOT_SIGNED_MSG,
        enable_live_hint: ENABLE_LIVE_HINT,
        error: "proposal_not_signed",
        proposal_status: proposal,
        resolved: {
          location: { id: input.location_id, label: locationLabel, customer_id: customerId },
          date: input.date,
        },
      };
    }
  }

  let bookedProjectId: number | null = num(input.project_id);

  // HARD anti-dupe: refuse Create when open ST jobs already at this location
  // (Bent Grass: #104297 Scheduled blocks; #104256 Completed does not)
  // NC: only the same type on the same project blocks. A Rough In does not block a Final.
  if (nc) {
    let jobs: MillerExistingJob[] = [];
    try {
      jobs = await findOpenJobsAtLocation(
        env,
        db,
        tenantId,
        Number(input.location_id),
        input.date,
        customerId,
        true
      );
    } catch {
      jobs = [];
    }
    const projects = await listProjectsAtLocation(env, db, tenantId, Number(input.location_id));
    if (!projects.length && !bookedProjectId) {
      const local = await localProjectForLocation(db, Number(input.location_id));
      if (local.length === 1) bookedProjectId = local[0];
      else if (local.length > 1) {
        return {
          ok: false,
          mode,
          dry_run: mode !== "live",
          message: "This location has more than one saved project. Pick one.",
          enable_live_hint: ENABLE_LIVE_HINT,
          error: "pick_project",
          projects: local.map((id) => ({ id, name: `Project ${id}`, status: null })),
        };
      }
    }
    const choice = chooseOpenProject(projects);
    if (!bookedProjectId) {
      if (choice.mustPick) {
        return {
          ok: false,
          mode,
          dry_run: mode !== "live",
          message: projects.length
            ? "Pick the project for this house."
            : "No ServiceTitan project on this location. Set the house up first.",
          enable_live_hint: ENABLE_LIVE_HINT,
          error: "pick_project",
          projects,
        };
      }
      bookedProjectId = choice.projectId;
    } else if (projects.length && !projects.some((p) => p.id === bookedProjectId)) {
      return {
        ok: false,
        mode,
        dry_run: mode !== "live",
        message: "That project is not on this location.",
        enable_live_hint: ENABLE_LIVE_HINT,
        error: "pick_project",
        projects,
      };
    }
    const decision = ncDuplicateDecision(
      jobs.map((j) => ({
        job_number: j.job_number,
        job_type: j.job_type,
        status: j.status,
        project_id: j.project_id ?? null,
      })),
      allowedType.st_name || allowedType.name,
      bookedProjectId,
      {
        force_duplicate: false,
        acknowledge_completed: false,
      }
    );
    if (!decision.ok) {
      return {
        ok: false,
        mode,
        dry_run: mode !== "live",
        message: decision.message,
        enable_live_hint: ENABLE_LIVE_HINT,
        error: decision.error,
        existing_jobs: jobs,
        projects,
      };
    }
  } else if (!input.force_duplicate) {
    let existing: MillerExistingJob[] = [];
    try {
      existing = await findOpenJobsAtLocation(
        env,
        db,
        tenantId,
        Number(input.location_id),
        input.date,
        customerId
      );
    } catch {
      existing = [];
    }
    if (existing.length > 0) {
      const sample = existing[0]!;
      const techBit = sample.technician_names.length
        ? ` · ${sample.technician_names.join(" + ")}`
        : "";
      const label = sample.job_number
        ? `#${sample.job_number}`
        : `job ${sample.job_id}`;
      return {
        ok: false,
        mode,
        dry_run: mode !== "live",
        message: `Already on board — do not create another. ${label} ${sample.job_type || "job"} · ${sample.status || "open"}${techBit}`,
        enable_live_hint: ENABLE_LIVE_HINT,
        error: "existing_open_jobs",
        existing_jobs: existing,
        resolved: {
          location: { id: input.location_id, label: locationLabel, customer_id: customerId },
          date: input.date,
        },
      };
    }
  }

  // Arrival window → start/end
  const win = MILLER_ARRIVAL_WINDOWS.find((w) => w.id === input.arrival_window_id);
  let startIso: string;
  let endIso: string;
  if (!win || win.id === "custom") {
    const cs = parseHm(String(input.custom_start || ""));
    const ce = parseHm(String(input.custom_end || ""));
    if (!cs || !ce) {
      return {
        ok: false,
        mode,
        dry_run: mode !== "live",
        message: "Custom window needs start and end times",
        enable_live_hint: ENABLE_LIVE_HINT,
        error: "custom times required",
      };
    }
    startIso = chicagoWallToIso(input.date, cs.hour, cs.minute);
    endIso = chicagoWallToIso(input.date, ce.hour, ce.minute);
  } else {
    startIso = chicagoWallToIso(
      input.date,
      Math.floor(win.startMin! / 60),
      win.startMin! % 60
    );
    endIso = chicagoWallToIso(
      input.date,
      Math.floor(win.endMin! / 60),
      win.endMin! % 60
    );
  }

  const techLabels = techIds.map((id) => {
    const hit = allowedTechs.find((t) => Number(t.st_technician_id) === id);
    return hit?.label || hit?.display_name || String(id);
  });
  const summary =
    str(input.summary) ||
    `${locationLabel} - Install (${techLabels.join(", ") || "crew TBD"})`;

  // Mirror Gauge Book Job — notificationsEnabled OFF (no booking confirmation text)
  const payload: Record<string, unknown> = {
    customerId,
    locationId: input.location_id,
    businessUnitId: bu.id,
    jobTypeId: input.job_type_id,
    priority: "Normal",
    campaignId: campaign.id,
    summary,
    ...(bookedProjectId ? { projectId: bookedProjectId } : {}),
    // HARD LOCK: Send booking confirmation text MUST OFF
    notificationsEnabled: false,
    appointments: [
      {
        start: startIso,
        end: endIso,
        arrivalWindowStart: startIso,
        arrivalWindowEnd: endIso,
        technicianIds: techIds,
      },
    ],
  };

  const resolved = {
    business_unit: { id: bu.id, name: bu.name },
    campaign: { id: campaign.id, name: campaign.name },
    technicians: techLabels,
    technician_ids: techIds,
    job_type: { id: allowedType.id, name: allowedType.name },
    location: { id: input.location_id, label: locationLabel, customer_id: customerId },
    arrival_window_id: input.arrival_window_id,
    date: input.date,
    send_booking_confirmation_text: false,
  };

  if (mode !== "live") {
    return {
      ok: true,
      mode: "dry",
      dry_run: true,
      message:
        "DRY-RUN — payload ready. No ServiceTitan Create Job was sent. Enable live only after READY + Chris Y.",
      enable_live_hint: ENABLE_LIVE_HINT,
      intended_payload: payload,
      resolved,
    };
  }

  // LIVE
  const post = await stApiJson(env, db, `/jpm/v2/tenant/${tenantId}/jobs`, {
    method: "POST",
    body: payload,
  });
  if (!post.ok) {
    return {
      ok: false,
      mode: "live",
      dry_run: false,
      message: `ST Create Job failed (${post.status})`,
      enable_live_hint: ENABLE_LIVE_HINT,
      intended_payload: payload,
      resolved,
      st_status: post.status,
      st_error: post.text.slice(0, 400),
      error: post.text.slice(0, 400),
    };
  }
  const body = (post.json || {}) as Record<string, unknown>;
  return {
    ok: true,
    mode: "live",
    dry_run: false,
    message: `Created ST job ${str(body.jobNumber) || body.id || ""}`,
    enable_live_hint: ENABLE_LIVE_HINT,
    intended_payload: payload,
    resolved,
    st_job_id: num(body.id),
    st_job_number: str(body.jobNumber) || null,
    st_appointment_id: num(body.firstAppointmentId) || num(body.lastAppointmentId),
    st_status: post.status,
  };
}

/** Roles that may use Miller quick-add (drivers view board only). */
export function canMillerBookJob(user: { role: string }): boolean {
  return ["admin", "office", "supervisor"].includes(user.role);
}
