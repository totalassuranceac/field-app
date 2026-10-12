/**
 * Tool checklist and NATE practice.
 * Scores stay private. Office can see who is ready. No ranking.
 */

import type { Hono } from "hono";
import type { Env, PublicUser, Variables } from "./types";
import { ROLE_PERMS } from "./auth";
import {
  BUY_NEXT,
  EXAMS,
  GROUP_ORDER,
  TOOL_ITEMS,
  TOPICS,
  TRACKS,
  isExamKey,
  isTrackId,
  itemsForTrack,
  questionById,
  recommendFirstTool,
  suggestedTrack,
  type ExamKey,
  type TrackId,
} from "./growthContent";
import {
  FULL_COUNT,
  FULL_PASS,
  TOPIC_PASS,
  buildQuestionIds,
  gradePaper,
  nateStatus,
  openMisses,
  statusLabel,
  type AttemptSnap,
  type PaperMode,
} from "./nateReady";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

const FULL_MINUTES = 27;

function canSeeOffice(user: PublicUser): boolean {
  return (ROLE_PERMS.viewNateStatus as readonly string[]).includes(user.role);
}

function blockPreviewWrite(c: { get: (k: "viewAsUserId") => number | null }): boolean {
  return c.get("viewAsUserId") != null;
}

async function positionTitle(db: D1Database, userId: number): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT position_title FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ position_title: string | null }>();
    const title = row?.position_title != null ? String(row.position_title).trim() : "";
    return title || null;
  } catch {
    return null;
  }
}

async function savedTrack(db: D1Database, userId: number): Promise<TrackId | null> {
  const row = await db
    .prepare(`SELECT track FROM growth_track WHERE user_id = ?`)
    .bind(userId)
    .first<{ track: string }>();
  return row && isTrackId(row.track) ? row.track : null;
}

async function resolveTrack(db: D1Database, userId: number): Promise<{
  track: TrackId | null;
  suggested: TrackId | null;
  position_title: string | null;
}> {
  const position_title = await positionTitle(db, userId);
  const suggested = suggestedTrack(position_title);
  const saved = await savedTrack(db, userId);
  return { track: saved || suggested, suggested, position_title };
}

function rng(): () => number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  let s = buf[0] || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type AttemptRow = {
  exam_key: string;
  mode: string;
  topic_key: string | null;
  score: number;
  question_ids: string;
  wrong_ids: string;
  finished_at: string;
};

function snapFromRow(row: AttemptRow): AttemptSnap | null {
  if (row.mode !== "full" && row.mode !== "topic" && row.mode !== "review") return null;
  let questionIds: string[] = [];
  let wrongIds: string[] = [];
  try {
    const q = JSON.parse(row.question_ids);
    const w = JSON.parse(row.wrong_ids);
    if (Array.isArray(q)) questionIds = q.map(String);
    if (Array.isArray(w)) wrongIds = w.map(String);
  } catch {
    return null;
  }
  return {
    mode: row.mode,
    topic: row.topic_key,
    score: Number(row.score),
    questionIds,
    wrongIds,
    finishedAt: row.finished_at,
  };
}

async function attemptsFor(
  db: D1Database,
  userId: number,
  exam: ExamKey
): Promise<AttemptSnap[]> {
  const rows = await db
    .prepare(
      `SELECT exam_key, mode, topic_key, score, question_ids, wrong_ids, finished_at
       FROM nate_attempts
       WHERE user_id = ? AND exam_key = ?
       ORDER BY finished_at DESC, id DESC
       LIMIT 80`
    )
    .bind(userId, exam)
    .all<AttemptRow>();
  const snaps: AttemptSnap[] = [];
  for (const row of rows.results || []) {
    const snap = snapFromRow(row);
    if (snap) snaps.push(snap);
  }
  return snaps;
}

function examPayload(
  examKey: ExamKey,
  track: TrackId | null,
  snaps: AttemptSnap[],
  marked: boolean
) {
  const meta = EXAMS.find((e) => e.key === examKey)!;
  const status = nateStatus(examKey, snaps, marked);
  const topicLabels = new Map(TOPICS[examKey].map((t) => [t.key, t.label]));
  return {
    key: meta.key,
    label: meta.label,
    blurb: meta.blurb,
    recommended: track ? meta.tracks.includes(track) : meta.key === "core",
    full_count: FULL_COUNT,
    full_pass: FULL_PASS,
    topic_pass: TOPIC_PASS,
    full_minutes: FULL_MINUTES,
    status: status.status,
    status_label: statusLabel(status.status),
    can_mark: status.canMark,
    marked,
    topics_ok: status.topicsOk,
    fulls_ok: status.fullsOk,
    recent_full_score: status.recentFullScore,
    topics: status.topics.map((t) => ({
      key: t.key,
      label: topicLabels.get(t.key) || t.key,
      score: t.score,
      ok: t.ok,
    })),
  };
}

export const TOOL_LINE_MAX = 80;
export const TOOL_NOTES_MAX = 300;

let growthToolColumnsReady = false;

const GROWTH_TOOL_COLUMN_SQL = [
  "ALTER TABLE growth_tool_checks ADD COLUMN make TEXT",
  "ALTER TABLE growth_tool_checks ADD COLUMN model TEXT",
  "ALTER TABLE growth_tool_checks ADD COLUMN serial TEXT",
  "ALTER TABLE growth_tool_checks ADD COLUMN notes TEXT",
  "ALTER TABLE growth_tool_checks ADD COLUMN needs_upgrade INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE growth_tool_checks ADD COLUMN released_at TEXT",
];

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Adds the optional detail columns. A duplicate-column error means that column is already there. */
export async function ensureGrowthToolColumns(db: D1Database): Promise<boolean> {
  if (growthToolColumnsReady) return true;
  try {
    for (const sql of GROWTH_TOOL_COLUMN_SQL) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        const msg = errorText(err);
        if (/duplicate column|already exists/i.test(msg)) continue;
        throw err;
      }
    }
    growthToolColumnsReady = true;
    return true;
  } catch {
    return false;
  }
}

export function clipToolLine(value: unknown, max: number): string | null {
  const text = String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!text) return null;
  return text.slice(0, max);
}

export function clipToolNotes(value: unknown, max: number): string | null {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  return text.slice(0, max);
}

/** 1 only when they have the tool, a better version exists, and they still have the older one. */
export function toolNeedsUpgrade(have: boolean, hasUpgrade: boolean, requested: boolean): number {
  if (!have || !hasUpgrade || !requested) return 0;
  return 1;
}

export function toolStillOpen(have: boolean, needsUpgrade: boolean): boolean {
  return !have || needsUpgrade;
}

export type GrowthToolCheck = {
  item_id: string;
  have: number;
  needs_upgrade: number;
  make: string | null;
  model: string | null;
  serial: string | null;
  notes: string | null;
  released_at?: string | null;
};

export type GrowthToolView = {
  id: string;
  name: string;
  use: string;
  easier: string;
  tip: string;
  loan_name: string;
  loan_reason: string;
  have: boolean;
  needs_upgrade: boolean;
  buy_next: boolean;
  upgrade_ask: string;
  upgrade_better: string;
  make: string;
  model: string;
  serial: string;
  notes: string;
  step?: number;
  current?: boolean;
};

function storedText(value: string | null | undefined): string {
  return value ? String(value) : "";
}

export function detailField(
  body: Record<string, unknown>,
  key: "make" | "model" | "serial" | "notes",
  existing: string | null | undefined,
  clip: (value: unknown, max: number) => string | null,
  max: number
): string | null {
  if (!Object.prototype.hasOwnProperty.call(body, key)) {
    const kept = existing != null ? String(existing).trim() : "";
    return kept || null;
  }
  return clip(body[key], max);
}

export function buildGrowthToolLists(
  track: TrackId | null,
  checks: GrowthToolCheck[],
  preferredNext?: string | null
): {
  next_item_id: string | null;
  goals: GrowthToolView[];
  goals_owned: number;
  goals_total: number;
  owned: number;
  total: number;
  groups: { name: string; items: GrowthToolView[] }[];
  filed: GrowthToolView[];
} {
  const byId = new Map(checks.map((row) => [row.item_id, row]));
  const flag = (id: string) => {
    const row = byId.get(id);
    const have = Number(row?.have) === 1;
    const needs = have && Number(row?.needs_upgrade) === 1;
    return {
      have,
      needs,
      make: storedText(row?.make),
      model: storedText(row?.model),
      serial: storedText(row?.serial),
      notes: storedText(row?.notes),
    };
  };
  const items = track ? itemsForTrack(track) : [];
  const order = track ? BUY_NEXT[track] : [];
  const goalItems = order
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is (typeof items)[number] => !!item);
  const pathNext =
    goalItems.find((item) => {
      const row = flag(item.id);
      return toolStillOpen(row.have, row.needs);
    })?.id || null;
  const preferredOpen =
    preferredNext &&
    items.some((item) => item.id === preferredNext) &&
    toolStillOpen(flag(preferredNext).have, flag(preferredNext).needs)
      ? preferredNext
      : null;
  const next = preferredOpen || pathNext;
  const shape = (item: (typeof items)[number]): GrowthToolView => {
    const row = flag(item.id);
    return {
      id: item.id,
      name: item.name,
      use: item.use,
      easier: item.easier,
      tip: item.tip || "",
      loan_name: item.loanName || "",
      loan_reason: item.loanReason || "",
      have: row.have,
      needs_upgrade: row.needs,
      buy_next: item.id === next,
      upgrade_ask: item.upgrade?.ask || "",
      upgrade_better: item.upgrade?.better || "",
      make: row.make,
      model: row.model,
      serial: row.serial,
      notes: row.notes,
    };
  };
  const goals = goalItems
    .map((item, index) => ({ item, step: index + 1 }))
    .filter(({ item }) => {
      const row = flag(item.id);
      return toolStillOpen(row.have, row.needs);
    })
    .map(({ item, step }) => ({ ...shape(item), current: item.id === next, step }));
  const groups = GROUP_ORDER.map((name) => ({
    name,
    items: items
      .filter((item) => item.group === name && toolStillOpen(flag(item.id).have, flag(item.id).needs))
      .map(shape),
  })).filter((group) => group.items.length);
  const filed = GROUP_ORDER.flatMap((name) =>
    TOOL_ITEMS.filter((item) => item.group === name && flag(item.id).have).map(shape)
  );
  const goalsOwned = goalItems.filter((item) => {
    const row = flag(item.id);
    return row.have && !row.needs;
  }).length;
  return {
    next_item_id: next,
    goals,
    goals_owned: goalsOwned,
    goals_total: goalItems.length,
    owned: items.filter((item) => flag(item.id).have).length,
    total: items.length,
    groups,
    filed,
  };
}

export function lendBlockReason(input: {
  have: boolean;
  released: boolean;
  samePerson: boolean;
  holderActive: boolean;
  alreadyOut: boolean;
}): string | null {
  if (!input.have) return "Check the tool on your list before you lend it.";
  if (input.released) return "This tool already left with the employee.";
  if (input.samePerson) return "Pick a different tech.";
  if (!input.holderActive) return "That tech is not active.";
  if (input.alreadyOut) return "That tool is already with another tech.";
  return null;
}

export function daysSince(iso: string, nowMs: number): number {
  const text = String(iso || "").trim();
  if (!text) return 0;
  const normalized = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const start = Date.parse(normalized);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((nowMs - start) / 86400000));
}

export const GAS_BOTTLE_TYPES = ["N2", "O2", "ACE"] as const;
export type GasBottleType = (typeof GAS_BOTTLE_TYPES)[number];

export function gasBottleType(value: unknown): GasBottleType | null {
  const code = String(value || "").trim().toUpperCase();
  return (GAS_BOTTLE_TYPES as readonly string[]).includes(code) ? (code as GasBottleType) : null;
}

let custodyTablesReady = false;

const CUSTODY_SQL = [
  `CREATE TABLE IF NOT EXISTS growth_tool_lends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    holder_user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'returned')),
    lent_at TEXT NOT NULL DEFAULT (datetime('now')),
    returned_at TEXT,
    note TEXT,
    created_by_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_growth_tool_lends_owner
    ON growth_tool_lends(owner_user_id, item_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_growth_tool_lends_holder
    ON growth_tool_lends(holder_user_id, status)`,
  `CREATE TABLE IF NOT EXISTS gas_bottles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bottle_type TEXT NOT NULL CHECK (bottle_type IN ('N2', 'O2', 'ACE')),
    serial TEXT,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('company', 'employee')),
    owner_user_id INTEGER,
    vehicle_id INTEGER,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left_with_employee', 'retired')),
    created_by_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gas_bottles_owner ON gas_bottles(owner_user_id, status)`,
];

export async function ensureCustodyTables(db: D1Database): Promise<boolean> {
  if (custodyTablesReady) return true;
  try {
    for (const sql of CUSTODY_SQL) {
      await db.prepare(sql).run();
    }
    custodyTablesReady = true;
    return true;
  } catch {
    return false;
  }
}

async function markToolsReleased(db: D1Database, userId: number): Promise<void> {
  await ensureGrowthToolColumns(db);
  try {
    await db
      .prepare(
        `UPDATE growth_tool_checks
         SET released_at = datetime('now'), updated_at = datetime('now')
         WHERE user_id = ? AND have = 1 AND released_at IS NULL`
      )
      .bind(userId)
      .run();
  } catch (err) {
    if (!/no such table|no such column/i.test(errorText(err))) throw err;
  }
}

async function markEmployeeBottlesLeft(db: D1Database, userId: number): Promise<void> {
  if (!(await ensureCustodyTables(db))) return;
  await db
    .prepare(
      `UPDATE gas_bottles
       SET status = 'left_with_employee', vehicle_id = NULL, updated_at = datetime('now')
       WHERE owner_kind = 'employee' AND owner_user_id = ? AND status = 'active'`
    )
    .bind(userId)
    .run();
}

async function clearTruckAssignment(db: D1Database, employeeId: number): Promise<void> {
  try {
    const trucks = await db
      .prepare(`SELECT id, helper_employee_id FROM vehicles WHERE assigned_employee_id = ?`)
      .bind(employeeId)
      .all<{ id: number; helper_employee_id: number | null }>();
    for (const truck of trucks.results || []) {
      let driver: string | null = null;
      const helperId = truck.helper_employee_id ? Number(truck.helper_employee_id) : 0;
      if (helperId > 0 && helperId !== employeeId) {
        const helper = await db
          .prepare(`SELECT name FROM employees WHERE id = ?`)
          .bind(helperId)
          .first<{ name: string }>();
        driver = helper?.name ? String(helper.name).slice(0, 80) : null;
      }
      await db
        .prepare(
          `UPDATE vehicles
           SET assigned_employee_id = NULL, assigned_driver = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(driver, truck.id)
        .run();
    }
  } catch (err) {
    if (!/no such column|no such table/i.test(errorText(err))) throw err;
  }
  try {
    await db
      .prepare(
        `UPDATE vehicles SET helper_employee_id = NULL, updated_at = datetime('now') WHERE helper_employee_id = ?`
      )
      .bind(employeeId)
      .run();
  } catch (err) {
    if (!/no such column|no such table/i.test(errorText(err))) throw err;
  }
}

/** Personal tools and employee bottles leave with this login. Company bottles stay on the truck. */
export async function releasePersonalGearForUser(db: D1Database, userId: number): Promise<void> {
  await markToolsReleased(db, userId);
  await markEmployeeBottlesLeft(db, userId);
  try {
    const row = await db
      .prepare(`SELECT employee_id FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ employee_id: number | null }>();
    if (row?.employee_id) await clearTruckAssignment(db, Number(row.employee_id));
  } catch (err) {
    if (!/no such column|no such table/i.test(errorText(err))) throw err;
  }
}

/** Personal tools for every login on this employee, and take the person off the truck. */
export async function releasePersonalGearForEmployee(db: D1Database, employeeId: number): Promise<void> {
  await clearTruckAssignment(db, employeeId);
  try {
    const users = await db
      .prepare(`SELECT id FROM users WHERE employee_id = ?`)
      .bind(employeeId)
      .all<{ id: number }>();
    for (const row of users.results || []) {
      await markToolsReleased(db, Number(row.id));
      await markEmployeeBottlesLeft(db, Number(row.id));
    }
  } catch (err) {
    if (!/no such column|no such table/i.test(errorText(err))) throw err;
  }
}

export async function restorePersonalTools(db: D1Database, userId: number): Promise<void> {
  await ensureGrowthToolColumns(db);
  try {
    await db
      .prepare(
        `UPDATE growth_tool_checks
         SET released_at = NULL, updated_at = datetime('now')
         WHERE user_id = ? AND released_at IS NOT NULL`
      )
      .bind(userId)
      .run();
  } catch (err) {
    if (!/no such table|no such column/i.test(errorText(err))) throw err;
  }
}

export async function restorePersonalToolsForEmployee(db: D1Database, employeeId: number): Promise<void> {
  try {
    const users = await db
      .prepare(`SELECT id FROM users WHERE employee_id = ?`)
      .bind(employeeId)
      .all<{ id: number }>();
    for (const row of users.results || []) {
      await restorePersonalTools(db, Number(row.id));
    }
  } catch (err) {
    if (!/no such column|no such table/i.test(errorText(err))) throw err;
  }
}

async function workSignals(db: D1Database, userId: number, positionTitle: string | null): Promise<string[]> {
  const signals: string[] = [];
  try {
    const jobs = await db
      .prepare(
        `SELECT job_type_name FROM miller_board_jobs
         WHERE active = 1 AND work_date >= date('now', '-120 days')
           AND EXISTS (
             SELECT 1 FROM json_each(miller_board_jobs.technician_ids) AS tech
             WHERE CAST(tech.value AS INTEGER) = (
               SELECT st_technician_id FROM users WHERE id = ? AND st_technician_id IS NOT NULL
             )
           )
         ORDER BY work_date DESC
         LIMIT 12`
      )
      .bind(userId)
      .all<{ job_type_name: string | null }>();
    for (const row of jobs.results || []) {
      const name = row.job_type_name ? String(row.job_type_name).trim() : "";
      if (name) signals.push(name);
    }
  } catch {
    /* job list is optional */
  }
  if (positionTitle) signals.push(positionTitle);
  return signals;
}

type CustodyBundle = {
  openByItem: Map<string, { id: number; holder_name: string; lent_at: string; days: number }>;
  returnByItem: Map<string, { holder_name: string; returned_at: string }>;
  lendsOut: ReturnType<typeof lendView>[];
  borrowed: ReturnType<typeof lendView>[];
  teamOut: ReturnType<typeof lendView>[];
  leftWith: { display_name: string; name: string; make: string; model: string; serial: string; released_at: string }[];
  bottles: {
    id: number;
    bottle_type: string;
    serial: string;
    owner_kind: string;
    owner_name: string;
    unit_number: string;
    status: string;
    notes: string;
  }[];
};

async function custodyPayload(db: D1Database, user: PublicUser, filedIds: string[]): Promise<CustodyBundle> {
  const empty: CustodyBundle = {
    openByItem: new Map(),
    returnByItem: new Map(),
    lendsOut: [],
    borrowed: [],
    teamOut: [],
    leftWith: [],
    bottles: [],
  };
  if (!(await ensureCustodyTables(db))) return empty;
  const nowMs = Date.now();
  const lendSql = `SELECT l.id, l.item_id, l.owner_user_id, l.holder_user_id, l.lent_at, l.returned_at,
            l.note, l.status, o.display_name AS owner_name, h.display_name AS holder_name
     FROM growth_tool_lends l
     JOIN users o ON o.id = l.owner_user_id
     JOIN users h ON h.id = l.holder_user_id`;
  const mine = await db
    .prepare(
      `${lendSql}
       WHERE l.owner_user_id = ? OR l.holder_user_id = ?
       ORDER BY l.id DESC
       LIMIT 40`
    )
    .bind(user.id, user.id)
    .all<LendJoin>();
  const rows = mine.results || [];
  const lendsOut = rows.filter((row) => row.status === "out" && row.owner_user_id === user.id).map((row) => lendView(row, nowMs));
  const borrowed = rows.filter((row) => row.status === "out" && row.holder_user_id === user.id).map((row) => lendView(row, nowMs));
  const openByItem = new Map<string, { id: number; holder_name: string; lent_at: string; days: number }>();
  for (const row of lendsOut) {
    if (!filedIds.includes(row.item_id) || openByItem.has(row.item_id)) continue;
    openByItem.set(row.item_id, {
      id: row.id,
      holder_name: row.holder_name,
      lent_at: row.lent_at,
      days: row.days,
    });
  }
  const returnByItem = new Map<string, { holder_name: string; returned_at: string }>();
  for (const row of rows) {
    if (row.status !== "returned" || row.owner_user_id !== user.id || !row.returned_at) continue;
    if (openByItem.has(row.item_id) || returnByItem.has(row.item_id)) continue;
    returnByItem.set(row.item_id, { holder_name: row.holder_name, returned_at: row.returned_at });
  }
  let teamOut: ReturnType<typeof lendView>[] = [];
  let leftWith: CustodyBundle["leftWith"] = [];
  if (canSeeToolCustody(user)) {
    const team = await db
      .prepare(`${lendSql} WHERE l.status = 'out' ORDER BY l.lent_at ASC LIMIT 80`)
      .all<LendJoin>();
    teamOut = (team.results || []).map((row) => lendView(row, nowMs));
    try {
      const left = await db
        .prepare(
          `SELECT u.display_name AS display_name, c.item_id AS item_id, c.make AS make,
                  c.model AS model, c.serial AS serial, c.released_at AS released_at
           FROM growth_tool_checks c
           JOIN users u ON u.id = c.user_id
           WHERE c.have = 1 AND c.released_at IS NOT NULL
           ORDER BY c.released_at DESC
           LIMIT 40`
        )
        .all<{
          display_name: string;
          item_id: string;
          make: string | null;
          model: string | null;
          serial: string | null;
          released_at: string;
        }>();
      leftWith = (left.results || []).map((row) => {
        const item = TOOL_ITEMS.find((tool) => tool.id === row.item_id);
        return {
          display_name: row.display_name,
          name: item?.name || row.item_id,
          make: row.make || "",
          model: row.model || "",
          serial: row.serial || "",
          released_at: row.released_at,
        };
      });
    } catch {
      leftWith = [];
    }
  }
  const bottleRows = await db
    .prepare(
      `SELECT b.id, b.bottle_type, b.serial, b.owner_kind, b.status, b.notes,
              u.display_name AS owner_name, v.unit_number AS unit_number
       FROM gas_bottles b
       LEFT JOIN users u ON u.id = b.owner_user_id
       LEFT JOIN vehicles v ON v.id = b.vehicle_id
       WHERE b.owner_user_id = ? AND b.owner_kind = 'employee' AND b.status != 'retired'
       ORDER BY b.bottle_type, b.id`
    )
    .bind(user.id)
    .all<{
      id: number;
      bottle_type: string;
      serial: string | null;
      owner_kind: string;
      status: string;
      notes: string | null;
      owner_name: string | null;
      unit_number: string | null;
    }>();
  const bottles = (bottleRows.results || []).map((row) => ({
    id: row.id,
    bottle_type: row.bottle_type,
    serial: row.serial || "",
    owner_kind: row.owner_kind,
    owner_name: row.owner_name || "Employee",
    unit_number: row.unit_number || "",
    status: row.status,
    notes: row.notes || "",
  }));
  return { openByItem, returnByItem, lendsOut, borrowed, teamOut, leftWith, bottles };
}

function canSeeToolCustody(user: PublicUser): boolean {
  return (ROLE_PERMS.viewToolCustody as readonly string[]).includes(user.role);
}

function canManageBottles(user: PublicUser): boolean {
  return (ROLE_PERMS.manageGasBottleOwners as readonly string[]).includes(user.role);
}

type LendJoin = {
  id: number;
  item_id: string;
  owner_user_id: number;
  holder_user_id: number;
  lent_at: string;
  returned_at: string | null;
  note: string | null;
  owner_name: string;
  holder_name: string;
  status: string;
};

function lendView(row: LendJoin, nowMs: number) {
  const item = TOOL_ITEMS.find((tool) => tool.id === row.item_id);
  return {
    id: row.id,
    item_id: row.item_id,
    name: item?.name || row.item_id,
    owner_user_id: row.owner_user_id,
    owner_name: row.owner_name,
    holder_user_id: row.holder_user_id,
    holder_name: row.holder_name,
    lent_at: row.lent_at,
    returned_at: row.returned_at,
    days: daysSince(row.lent_at, nowMs),
    note: row.note || "",
    status: row.status,
  };
}

export function registerGrowthRoutes(api: App): void {
  api.get("/growth/tools", async (c) => {
    const user = c.get("user") as PublicUser;
    try {
      const resolved = await resolveTrack(c.env.DB, user.id);
      const track = resolved.track;
      const columns = await ensureGrowthToolColumns(c.env.DB);
      let checks: GrowthToolCheck[] = [];
      if (columns) {
        const haveRows = await c.env.DB.prepare(
          `SELECT item_id, have, needs_upgrade, make, model, serial, notes, released_at
           FROM growth_tool_checks WHERE user_id = ?`
        )
          .bind(user.id)
          .all<GrowthToolCheck>();
        checks = haveRows.results || [];
      } else {
        const haveRows = await c.env.DB.prepare(
          `SELECT item_id FROM growth_tool_checks WHERE user_id = ? AND have = 1`
        )
          .bind(user.id)
          .all<{ item_id: string }>();
        checks = (haveRows.results || []).map((row) => ({
          item_id: row.item_id,
          have: 1,
          needs_upgrade: 0,
          make: null,
          model: null,
          serial: null,
          notes: null,
        }));
      }
      const openIds = (track ? itemsForTrack(track) : [])
        .filter((item) => {
          const row = checks.find((check) => check.item_id === item.id);
          const have = Number(row?.have) === 1;
          const needs = have && Number(row?.needs_upgrade) === 1;
          return toolStillOpen(have, needs);
        })
        .map((item) => item.id);
      const signals = await workSignals(c.env.DB, user.id, resolved.position_title);
      const recommended = recommendFirstTool({ track, openIds, signals });
      const lists = buildGrowthToolLists(track, checks, recommended?.id || null);
      const custody = await custodyPayload(c.env.DB, user, lists.filed.map((item) => item.id));
      const filed = lists.filed.map((item) => {
        const check = checks.find((row) => row.item_id === item.id);
        return {
          ...item,
          released: Boolean(check?.released_at),
          open_lend: custody.openByItem.get(item.id) || null,
          last_return: custody.returnByItem.get(item.id) || null,
        };
      });
      const trackMeta = TRACKS.find((t) => t.id === track) || null;
      return c.json({
        track,
        suggested_track: resolved.suggested,
        position_title: resolved.position_title,
        track_note: trackMeta?.note || "",
        tracks: TRACKS.map((t) => ({ id: t.id, label: t.label, note: t.note })),
        next_item_id: lists.next_item_id,
        recommended_because: recommended?.because || "",
        goals: lists.goals,
        goals_owned: lists.goals_owned,
        goals_total: lists.goals_total,
        owned: lists.owned,
        total: lists.total,
        groups: lists.groups,
        filed,
        lends_out: custody.lendsOut,
        borrowed: custody.borrowed,
        bottles: custody.bottles,
        team_out: canSeeToolCustody(user) ? custody.teamOut : null,
        left_with: canSeeToolCustody(user) ? custody.leftWith : null,
        truck_note:
          "Personal tools stay with you. Company bottles, recovery machines, extinguishers, and dollies stay on the truck.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load the tool list";
      return c.json({ error: msg }, 500);
    }
  });

  api.post("/growth/tools/track", async (c) => {
    if (blockPreviewWrite(c)) {
      return c.json({ error: "Exit view-as before changing the tool list." }, 403);
    }
    const user = c.get("user") as PublicUser;
    const body = await c.req.json<{ track?: string }>().catch(() => ({}));
    const track = String(body.track || "");
    if (!isTrackId(track)) return c.json({ error: "Pick a role." }, 400);
    await c.env.DB.prepare(
      `INSERT INTO growth_track (user_id, track, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET track = excluded.track, updated_at = datetime('now')`
    )
      .bind(user.id, track)
      .run();
    return c.json({ ok: true, track });
  });

  api.post("/growth/tools/item", async (c) => {
    if (blockPreviewWrite(c)) {
      return c.json({ error: "Exit view-as before changing the tool list." }, 403);
    }
    const user = c.get("user") as PublicUser;
    const body = await c.req
      .json<{
        item_id?: string;
        have?: boolean;
        needs_upgrade?: boolean;
        make?: string;
        model?: string;
        serial?: string;
        notes?: string;
      }>()
      .catch(() => ({}));
    const itemId = String(body.item_id || "");
    const item = TOOL_ITEMS.find((row) => row.id === itemId);
    if (!item) return c.json({ error: "That tool is not on the list." }, 400);
    const have = body.have === true;
    if (!have && (await ensureCustodyTables(c.env.DB))) {
      const openLend = await c.env.DB.prepare(
        `SELECT id FROM growth_tool_lends
         WHERE owner_user_id = ? AND item_id = ? AND status = 'out'`
      )
        .bind(user.id, itemId)
        .first<{ id: number }>();
      if (openLend) {
        return c.json(
          { error: "Return this tool before it leaves your list. The tech who has it is still accountable." },
          400
        );
      }
    }
    const bodyRec = body as Record<string, unknown>;
    const wantsUpgrade = body.needs_upgrade === true;
    const wantsDetails =
      wantsUpgrade ||
      Object.prototype.hasOwnProperty.call(bodyRec, "make") ||
      Object.prototype.hasOwnProperty.call(bodyRec, "model") ||
      Object.prototype.hasOwnProperty.call(bodyRec, "serial") ||
      Object.prototype.hasOwnProperty.call(bodyRec, "notes");
    const columns = await ensureGrowthToolColumns(c.env.DB);
    if (!columns) {
      if (wantsDetails) return c.json({ error: "Tool details could not be saved yet." }, 500);
      await c.env.DB.prepare(
        `INSERT INTO growth_tool_checks (user_id, item_id, have, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, item_id) DO UPDATE SET have = excluded.have, updated_at = datetime('now')`
      )
        .bind(user.id, itemId, have ? 1 : 0)
        .run();
      return c.json({ ok: true, item_id: itemId, have, needs_upgrade: false });
    }
    const existing = await c.env.DB.prepare(
      `SELECT make, model, serial, notes, released_at FROM growth_tool_checks WHERE user_id = ? AND item_id = ?`
    )
      .bind(user.id, itemId)
      .first<{
        make: string | null;
        model: string | null;
        serial: string | null;
        notes: string | null;
        released_at: string | null;
      }>();
    if (!have && existing?.released_at) {
      return c.json({ error: "This tool already left with you. It stays on file." }, 400);
    }
    const make = detailField(bodyRec, "make", existing?.make, clipToolLine, TOOL_LINE_MAX);
    const model = detailField(bodyRec, "model", existing?.model, clipToolLine, TOOL_LINE_MAX);
    const serial = detailField(bodyRec, "serial", existing?.serial, clipToolLine, TOOL_LINE_MAX);
    const notes = detailField(bodyRec, "notes", existing?.notes, clipToolNotes, TOOL_NOTES_MAX);
    const needs = toolNeedsUpgrade(have, !!item.upgrade, wantsUpgrade);
    await c.env.DB.prepare(
      `INSERT INTO growth_tool_checks
         (user_id, item_id, have, needs_upgrade, make, model, serial, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, item_id) DO UPDATE SET
         have = excluded.have,
         needs_upgrade = excluded.needs_upgrade,
         make = excluded.make,
         model = excluded.model,
         serial = excluded.serial,
         notes = excluded.notes,
         updated_at = datetime('now')`
    )
      .bind(user.id, itemId, have ? 1 : 0, needs, make, model, serial, notes)
      .run();
    return c.json({ ok: true, item_id: itemId, have, needs_upgrade: needs === 1 });
  });

  api.post("/growth/tools/lend", async (c) => {
    if (blockPreviewWrite(c)) {
      return c.json({ error: "Exit view-as before lending a tool." }, 403);
    }
    const user = c.get("user") as PublicUser;
    const body = await c.req
      .json<{ item_id?: string; holder_user_id?: number; note?: string }>()
      .catch(() => ({}));
    const itemId = String(body.item_id || "");
    const item = TOOL_ITEMS.find((row) => row.id === itemId);
    if (!item) return c.json({ error: "That tool is not on the list." }, 400);
    const holderId = Number(body.holder_user_id);
    if (!Number.isInteger(holderId) || holderId <= 0) {
      return c.json({ error: "Pick the tech who is taking the tool." }, 400);
    }
    if (!(await ensureGrowthToolColumns(c.env.DB)) || !(await ensureCustodyTables(c.env.DB))) {
      return c.json({ error: "Tool lending could not be saved yet." }, 500);
    }
    const owned = await c.env.DB.prepare(
      `SELECT have, released_at FROM growth_tool_checks WHERE user_id = ? AND item_id = ?`
    )
      .bind(user.id, itemId)
      .first<{ have: number; released_at: string | null }>();
    const holder = await c.env.DB.prepare(`SELECT id, active FROM users WHERE id = ?`)
      .bind(holderId)
      .first<{ id: number; active: number }>();
    const open = await c.env.DB.prepare(
      `SELECT id FROM growth_tool_lends WHERE owner_user_id = ? AND item_id = ? AND status = 'out'`
    )
      .bind(user.id, itemId)
      .first<{ id: number }>();
    const reason = lendBlockReason({
      have: Number(owned?.have) === 1,
      released: !!owned?.released_at,
      samePerson: holderId === user.id,
      holderActive: !!holder && Number(holder.active) === 1,
      alreadyOut: !!open,
    });
    if (reason) return c.json({ error: reason }, 400);
    const note = clipToolNotes(body.note, 200);
    const ins = await c.env.DB.prepare(
      `INSERT INTO growth_tool_lends
         (owner_user_id, item_id, holder_user_id, status, note, created_by_user_id)
       VALUES (?, ?, ?, 'out', ?, ?)`
    )
      .bind(user.id, itemId, holderId, note, user.id)
      .run();
    return c.json({ ok: true, id: Number(ins.meta.last_row_id) });
  });

  api.post("/growth/tools/lend/:id/return", async (c) => {
    if (blockPreviewWrite(c)) {
      return c.json({ error: "Exit view-as before returning a tool." }, 403);
    }
    const user = c.get("user") as PublicUser;
    const lendId = Number(c.req.param("id"));
    if (!Number.isInteger(lendId) || lendId <= 0) return c.json({ error: "That lend was not found." }, 400);
    if (!(await ensureCustodyTables(c.env.DB))) {
      return c.json({ error: "Tool lending could not be saved yet." }, 500);
    }
    const row = await c.env.DB.prepare(
      `SELECT id, owner_user_id, holder_user_id, status FROM growth_tool_lends WHERE id = ?`
    )
      .bind(lendId)
      .first<{ id: number; owner_user_id: number; holder_user_id: number; status: string }>();
    if (!row || row.status !== "out") return c.json({ error: "That tool is already back." }, 400);
    const allowed =
      row.owner_user_id === user.id ||
      row.holder_user_id === user.id ||
      canSeeToolCustody(user);
    if (!allowed) return c.json({ error: "Only the owner, the tech who has it, or the office can mark it returned." }, 403);
    await c.env.DB.prepare(
      `UPDATE growth_tool_lends
       SET status = 'returned', returned_at = datetime('now')
       WHERE id = ? AND status = 'out'`
    )
      .bind(lendId)
      .run();
    return c.json({ ok: true, id: lendId });
  });

  api.get("/growth/bottles", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!canManageBottles(user)) return c.json({ error: "Office or warehouse marks bottle owners." }, 403);
    if (!(await ensureCustodyTables(c.env.DB))) return c.json({ bottles: [] });
    const rows = await c.env.DB.prepare(
      `SELECT b.id, b.bottle_type, b.serial, b.owner_kind, b.owner_user_id, b.vehicle_id, b.status, b.notes,
              u.display_name AS owner_name, v.unit_number AS unit_number
       FROM gas_bottles b
       LEFT JOIN users u ON u.id = b.owner_user_id
       LEFT JOIN vehicles v ON v.id = b.vehicle_id
       WHERE b.status != 'retired'
       ORDER BY b.owner_kind, b.bottle_type, b.id`
    ).all<{
      id: number;
      bottle_type: string;
      serial: string | null;
      owner_kind: string;
      owner_user_id: number | null;
      vehicle_id: number | null;
      status: string;
      notes: string | null;
      owner_name: string | null;
      unit_number: string | null;
    }>();
    return c.json({
      bottles: (rows.results || []).map((row) => ({
        id: row.id,
        bottle_type: row.bottle_type,
        serial: row.serial || "",
        owner_kind: row.owner_kind,
        owner_user_id: row.owner_user_id,
        owner_name: row.owner_kind === "company" ? "Company" : row.owner_name || "Employee",
        vehicle_id: row.vehicle_id,
        unit_number: row.unit_number || "",
        status: row.status,
        notes: row.notes || "",
      })),
    });
  });

  api.post("/growth/bottles", async (c) => {
    if (blockPreviewWrite(c)) return c.json({ error: "Exit view-as before saving a bottle." }, 403);
    const user = c.get("user") as PublicUser;
    if (!canManageBottles(user)) return c.json({ error: "Office or warehouse marks bottle owners." }, 403);
    const body = await c.req
      .json<{
        bottle_type?: string;
        owner_kind?: string;
        owner_user_id?: number | null;
        vehicle_id?: number | null;
        serial?: string;
        notes?: string;
      }>()
      .catch(() => ({}));
    const bottleType = gasBottleType(body.bottle_type);
    if (!bottleType) return c.json({ error: "Pick nitrogen, oxygen, or acetylene." }, 400);
    const kind = body.owner_kind === "employee" ? "employee" : body.owner_kind === "company" ? "company" : "";
    if (!kind) return c.json({ error: "Say if the bottle is the company's or an employee's." }, 400);
    const ownerId =
      kind === "employee" && body.owner_user_id != null ? Number(body.owner_user_id) : null;
    if (kind === "employee" && (!ownerId || !Number.isInteger(ownerId) || ownerId <= 0)) {
      return c.json({ error: "Pick the employee who owns the bottle." }, 400);
    }
    if (kind === "employee") {
      const owner = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ? AND active = 1`)
        .bind(ownerId)
        .first<{ id: number }>();
      if (!owner) return c.json({ error: "That employee is not active." }, 400);
    }
    let vehicleId: number | null = null;
    if (body.vehicle_id != null && body.vehicle_id !== 0) {
      const n = Number(body.vehicle_id);
      if (!Number.isInteger(n) || n <= 0) return c.json({ error: "Pick a truck." }, 400);
      const vehicle = await c.env.DB.prepare(`SELECT id FROM vehicles WHERE id = ?`).bind(n).first<{ id: number }>();
      if (!vehicle) return c.json({ error: "That truck was not found." }, 400);
      vehicleId = n;
    }
    if (!(await ensureCustodyTables(c.env.DB))) return c.json({ error: "Bottle ownership could not be saved yet." }, 500);
    const serial = clipToolLine(body.serial, TOOL_LINE_MAX);
    const notes = clipToolNotes(body.notes, 200);
    const ins = await c.env.DB.prepare(
      `INSERT INTO gas_bottles
         (bottle_type, serial, owner_kind, owner_user_id, vehicle_id, notes, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    )
      .bind(bottleType, serial, kind, kind === "employee" ? ownerId : null, vehicleId, notes, user.id)
      .run();
    return c.json({ ok: true, id: Number(ins.meta.last_row_id) });
  });

  api.post("/growth/bottles/:id/restore", async (c) => {
    if (blockPreviewWrite(c)) return c.json({ error: "Exit view-as before updating a bottle." }, 403);
    const user = c.get("user") as PublicUser;
    if (!canManageBottles(user)) return c.json({ error: "Office or warehouse marks bottle owners." }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "That bottle was not found." }, 400);
    if (!(await ensureCustodyTables(c.env.DB))) return c.json({ error: "Bottle ownership could not be saved yet." }, 500);
    await c.env.DB.prepare(
      `UPDATE gas_bottles
       SET status = 'active', updated_at = datetime('now')
       WHERE id = ? AND status = 'left_with_employee'`
    )
      .bind(id)
      .run();
    return c.json({ ok: true, id });
  });

  api.post("/growth/bottles/:id/retire", async (c) => {
    if (blockPreviewWrite(c)) return c.json({ error: "Exit view-as before retiring a bottle." }, 403);
    const user = c.get("user") as PublicUser;
    if (!canManageBottles(user)) return c.json({ error: "Office or warehouse marks bottle owners." }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "That bottle was not found." }, 400);
    if (!(await ensureCustodyTables(c.env.DB))) return c.json({ error: "Bottle ownership could not be saved yet." }, 500);
    await c.env.DB.prepare(
      `UPDATE gas_bottles SET status = 'retired', updated_at = datetime('now') WHERE id = ? AND status != 'retired'`
    )
      .bind(id)
      .run();
    return c.json({ ok: true, id });
  });

  api.get("/growth/nate", async (c) => {
    const user = c.get("user") as PublicUser;
    try {
      const resolved = await resolveTrack(c.env.DB, user.id);
      const marks = await c.env.DB.prepare(
        `SELECT exam_key, marked FROM nate_ready_marks WHERE user_id = ?`
      )
        .bind(user.id)
        .all<{ exam_key: string; marked: number }>();
      const markMap = new Map(
        (marks.results || []).map((r) => [r.exam_key, Number(r.marked) === 1])
      );
      const exams = [];
      for (const meta of EXAMS) {
        const snaps = await attemptsFor(c.env.DB, user.id, meta.key);
        exams.push(examPayload(meta.key, resolved.track, snaps, markMap.get(meta.key) === true));
      }
      let office: unknown[] | null = null;
      if (canSeeOffice(user)) {
        office = await officeRows(c.env.DB);
      }
      return c.json({
        track: resolved.track,
        exams,
        office,
        pass_note:
          "Two full practices in a row at 80% or better (12 of 15), every topic quiz at 70% or better, and you mark that you feel ready. A high score means you are in the range to schedule the real test. It is not a promise you will pass.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load NATE study";
      return c.json({ error: msg }, 500);
    }
  });

  api.post("/growth/nate/paper", async (c) => {
    if (blockPreviewWrite(c)) {
      return c.json({ error: "Exit view-as before starting a practice." }, 403);
    }
    const user = c.get("user") as PublicUser;
    const body = await c.req
      .json<{ exam_key?: string; mode?: string; topic_key?: string }>()
      .catch(() => ({}));
    const examKey = String(body.exam_key || "");
    const mode = String(body.mode || "");
    const topicKey = body.topic_key ? String(body.topic_key) : null;
    if (!isExamKey(examKey)) return c.json({ error: "Pick a test." }, 400);
    if (mode !== "full" && mode !== "topic" && mode !== "review") {
      return c.json({ error: "Pick a practice." }, 400);
    }
    let reviewIds: string[] = [];
    if (mode === "review") {
      const snaps = await attemptsFor(c.env.DB, user.id, examKey);
      reviewIds = openMisses(examKey, [...snaps].reverse());
      if (!reviewIds.length) {
        return c.json({ error: "No missed questions to review on this test." }, 400);
      }
    }
    const ids = buildQuestionIds(examKey, mode as PaperMode, topicKey, reviewIds, rng());
    if (!ids.length) return c.json({ error: "That practice has no questions." }, 400);
    const ins = await c.env.DB.prepare(
      `INSERT INTO nate_papers (user_id, exam_key, mode, topic_key, question_ids, started_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(user.id, examKey, mode, topicKey, JSON.stringify(ids))
      .run();
    const questions = ids.map((id) => {
      const q = questionById(id)!;
      return { id: q.id, topic: q.topic, prompt: q.prompt, choices: q.choices };
    });
    return c.json({
      paper_id: Number(ins.meta.last_row_id),
      exam_key: examKey,
      mode,
      topic_key: topicKey,
      minutes: mode === "full" ? FULL_MINUTES : null,
      questions,
    });
  });

  api.post("/growth/nate/grade", async (c) => {
    if (blockPreviewWrite(c)) {
      return c.json({ error: "Exit view-as before scoring a practice." }, 403);
    }
    const user = c.get("user") as PublicUser;
    const body = await c.req
      .json<{ paper_id?: number; answers?: { id?: string; choice?: number }[] }>()
      .catch(() => ({}));
    const paperId = Number(body.paper_id);
    if (!Number.isFinite(paperId)) return c.json({ error: "Missing practice." }, 400);
    const paper = await c.env.DB.prepare(
      `SELECT id, user_id, exam_key, mode, topic_key, question_ids, started_at, graded_at
       FROM nate_papers WHERE id = ?`
    )
      .bind(paperId)
      .first<{
        id: number;
        user_id: number;
        exam_key: string;
        mode: string;
        topic_key: string | null;
        question_ids: string;
        started_at: string;
        graded_at: string | null;
      }>();
    if (!paper || Number(paper.user_id) !== user.id) {
      return c.json({ error: "That practice is not yours." }, 404);
    }
    if (paper.graded_at) return c.json({ error: "That practice was already scored." }, 400);
    if (!isExamKey(paper.exam_key)) return c.json({ error: "Unknown test." }, 400);
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(paper.question_ids);
      if (Array.isArray(parsed)) ids = parsed.map(String);
    } catch {
      ids = [];
    }
    const choices: Record<string, number> = {};
    for (const row of body.answers || []) {
      const id = String(row.id || "");
      if (!ids.includes(id)) continue;
      const choice = Number(row.choice);
      if (Number.isInteger(choice) && choice >= 0 && choice <= 3) choices[id] = choice;
    }
    const graded = gradePaper(ids, choices);
    const wrongJson = JSON.stringify(graded.wrongIds);
    const topicJson = JSON.stringify(graded.topicScores);
    await c.env.DB.prepare(
      `INSERT INTO nate_attempts (
         user_id, paper_id, exam_key, mode, topic_key, score, correct_count, question_count,
         topic_scores_json, question_ids, wrong_ids, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(
        user.id,
        paperId,
        paper.exam_key,
        paper.mode,
        paper.topic_key,
        graded.score,
        graded.correct,
        graded.total,
        topicJson,
        JSON.stringify(ids),
        wrongJson
      )
      .run();
    await c.env.DB.prepare(`UPDATE nate_papers SET graded_at = datetime('now') WHERE id = ?`)
      .bind(paperId)
      .run();
    const snaps = await attemptsFor(c.env.DB, user.id, paper.exam_key);
    const markRow = await c.env.DB.prepare(
      `SELECT marked FROM nate_ready_marks WHERE user_id = ? AND exam_key = ?`
    )
      .bind(user.id, paper.exam_key)
      .first<{ marked: number }>();
    const marked = Number(markRow?.marked) === 1;
    const payload = examPayload(paper.exam_key, null, snaps, marked);
    const details = graded.details.map((d) => {
      const q = questionById(d.id)!;
      return {
        id: d.id,
        prompt: q.prompt,
        choices: q.choices,
        ok: d.ok,
        your_choice: d.yourChoice,
        answer: d.answer,
        why: d.why,
      };
    });
    return c.json({
      correct: graded.correct,
      total: graded.total,
      score: graded.score,
      details,
      exam: payload,
    });
  });

  api.post("/growth/nate/ready", async (c) => {
    if (blockPreviewWrite(c)) {
      return c.json({ error: "Exit view-as before marking ready." }, 403);
    }
    const user = c.get("user") as PublicUser;
    const body = await c.req
      .json<{ exam_key?: string; marked?: boolean }>()
      .catch(() => ({}));
    const examKey = String(body.exam_key || "");
    if (!isExamKey(examKey)) return c.json({ error: "Pick a test." }, 400);
    const want = body.marked === true;
    const snaps = await attemptsFor(c.env.DB, user.id, examKey);
    const status = nateStatus(examKey, snaps, want);
    if (want && !status.canMark) {
      return c.json(
        {
          error:
            "Two full practices in a row at 80% or better, and every topic at 70% or better, come before the ready mark.",
        },
        400
      );
    }
    await c.env.DB.prepare(
      `INSERT INTO nate_ready_marks (user_id, exam_key, marked, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, exam_key) DO UPDATE SET marked = excluded.marked, updated_at = datetime('now')`
    )
      .bind(user.id, examKey, want ? 1 : 0)
      .run();
    return c.json({ ok: true, exam: examPayload(examKey, null, snaps, want) });
  });
}

async function officeRows(db: D1Database): Promise<
  {
    user_id: number;
    display_name: string;
    position_title: string | null;
    exam_key: string;
    label: string;
    status: string;
    status_label: string;
    recent_full_score: number | null;
  }[]
> {
  const people = await db
    .prepare(
      `SELECT DISTINCT u.id as user_id, u.display_name as display_name, u.position_title as position_title
       FROM nate_attempts a
       JOIN users u ON u.id = a.user_id
       WHERE u.active = 1`
    )
    .all<{ user_id: number; display_name: string; position_title: string | null }>();
  const out: {
    user_id: number;
    display_name: string;
    position_title: string | null;
    exam_key: string;
    label: string;
    status: string;
    status_label: string;
    recent_full_score: number | null;
  }[] = [];
  for (const person of people.results || []) {
    const marks = await db
      .prepare(`SELECT exam_key, marked FROM nate_ready_marks WHERE user_id = ?`)
      .bind(person.user_id)
      .all<{ exam_key: string; marked: number }>();
    const markMap = new Map(
      (marks.results || []).map((r) => [r.exam_key, Number(r.marked) === 1])
    );
    for (const meta of EXAMS) {
      const snaps = await attemptsFor(db, person.user_id, meta.key);
      if (!snaps.length && markMap.get(meta.key) !== true) continue;
      const status = nateStatus(meta.key, snaps, markMap.get(meta.key) === true);
      out.push({
        user_id: person.user_id,
        display_name: person.display_name,
        position_title: person.position_title,
        exam_key: meta.key,
        label: meta.label,
        status: status.status,
        status_label: statusLabel(status.status),
        recent_full_score: status.recentFullScore,
      });
    }
  }
  const rank = { ready: 0, close: 1, learning: 2 };
  out.sort((a, b) => {
    const d = rank[a.status as keyof typeof rank] - rank[b.status as keyof typeof rank];
    if (d) return d;
    const name = a.display_name.localeCompare(b.display_name);
    if (name) return name;
    return a.label.localeCompare(b.label);
  });
  return out;
}
