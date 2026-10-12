/**
 * Saved employee write-ups. Private HR records.
 * No texts, emails, pushes, or other notifications.
 */

import type { Hono } from "hono";
import type { Env, PublicUser, Role, Variables } from "./types";
import { writeAudit } from "./audit";
import { ROLE_PERMS, roleAtLeast } from "./auth";
import {
  emptyWriteupDetail,
  parseWriteupDetail,
  writeupDetailIsEmpty,
  type WriteupDetail,
} from "./writeupDetail";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

export const WRITEUP_TEXT_CAP = 5000;

const WRITEUP_FIELDS = [
  "employee_name",
  "supervisor_name",
  "incident_date",
  "what_happened",
  "prior_warnings",
  "expectations",
  "consequences",
] as const;

export type WriteupDraft = {
  employee_id: number | null;
  employee_name: string;
  supervisor_name: string;
  incident_date: string;
  what_happened: string;
  prior_warnings: string;
  expectations: string;
  consequences: string;
  form_detail: WriteupDetail;
};

export function canManageWriteups(role: string): boolean {
  return roleAtLeast(role as Role, ROLE_PERMS.manageWriteups);
}

/** Void is admin and office only. Supervisors can save and read. */
const VOID_WRITEUP_ROLES: Role[] = ["admin", "office"];

export function canVoidWriteup(role: string): boolean {
  return roleAtLeast(role as Role, VOID_WRITEUP_ROLES);
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

export function trimWriteupText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim();
}

function tooLong(value: unknown): boolean {
  return trimWriteupText(value).length > WRITEUP_TEXT_CAP;
}

export function readEmployeeId(
  value: unknown
): { ok: true; id: number | null } | { ok: false; error: string } {
  if (value == null || value === "") return { ok: true, id: null };
  if (typeof value === "boolean") {
    return { ok: false, error: "Pick an employee on file, or leave that blank." };
  }
  let n = NaN;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) n = Number(value.trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: "Pick an employee on file, or leave that blank." };
  }
  return { ok: true, id: n };
}

export function validateWriteupInput(
  body: unknown
): { ok: true; value: WriteupDraft } | { ok: false; error: string } {
  const src = asRecord(body);
  for (const key of [...WRITEUP_FIELDS, "expected_correction"] as const) {
    if (tooLong(src[key])) {
      return { ok: false, error: "Keep each box under 5,000 characters." };
    }
  }
  const employee_name = trimWriteupText(src.employee_name);
  const what_happened = trimWriteupText(src.what_happened);
  if (!employee_name) return { ok: false, error: "Type the employee name." };
  if (!what_happened) return { ok: false, error: "Type what happened." };
  const employee = readEmployeeId(src.employee_id);
  if (!employee.ok) return employee;
  const detail = parseWriteupDetail(src.form_detail);
  if (!detail.ok) return detail;
  return {
    ok: true,
    value: {
      employee_id: employee.id,
      employee_name,
      supervisor_name: trimWriteupText(src.supervisor_name),
      incident_date: trimWriteupText(src.incident_date),
      what_happened,
      prior_warnings: trimWriteupText(src.prior_warnings),
      expectations: trimWriteupText(src.expectations ?? src.expected_correction),
      consequences: trimWriteupText(src.consequences),
      form_detail: detail.value,
    },
  };
}

export function validateVoidReason(
  body: unknown
): { ok: true; reason: string } | { ok: false; error: string } {
  const src = asRecord(body);
  const raw = src.reason ?? src.void_reason;
  if (tooLong(raw)) return { ok: false, error: "Keep the reason under 5,000 characters." };
  const reason = trimWriteupText(raw);
  if (!reason) return { ok: false, error: "Type a reason." };
  return { ok: true, reason };
}

type WriteupRow = Record<string, unknown>;

const WRITEUP_SELECT = `
  SELECT
    w.id, w.employee_id, w.employee_name, w.supervisor_name, w.incident_date,
    w.what_happened, w.prior_warnings, w.expectations, w.consequences, w.form_detail,
    w.created_by_user_id, w.created_at, w.voided_at, w.voided_by_user_id, w.void_reason,
    u.display_name AS created_by_name,
    v.display_name AS voided_by_name
  FROM hr_writeups w
  LEFT JOIN users u ON u.id = w.created_by_user_id
  LEFT JOIN users v ON v.id = w.voided_by_user_id
`;

function blankToNull(value: string): string | null {
  return value ? value : null;
}

let detailColumnReady = false;

async function ensureWriteupDetailColumn(db: D1Database): Promise<void> {
  if (detailColumnReady) return;
  try {
    await db.prepare("ALTER TABLE hr_writeups ADD COLUMN form_detail TEXT").run();
    detailColumnReady = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate column|already exists/i.test(msg)) {
      detailColumnReady = true;
      return;
    }
    if (/no such table/i.test(msg)) return;
    throw e;
  }
}

function presentWriteup(row: WriteupRow | null): WriteupRow | null {
  if (!row) return null;
  let raw: unknown = row.form_detail;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) raw = null;
    else {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
    }
  }
  const parsed = parseWriteupDetail(raw);
  return { ...row, form_detail: parsed.ok ? parsed.value : emptyWriteupDetail() };
}

function detailJson(detail: WriteupDetail): string | null {
  return writeupDetailIsEmpty(detail) ? null : JSON.stringify(detail);
}

function forbidUnless(user: PublicUser, roles: Role[]): boolean {
  return roleAtLeast(user.role, roles);
}

export function registerHrWriteupRoutes(api: App): void {
  api.post("/hr/writeups", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!forbidUnless(user, ROLE_PERMS.manageWriteups)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = validateWriteupInput(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const draft = parsed.value;
    try {
      await ensureWriteupDetailColumn(c.env.DB);
      if (draft.employee_id != null) {
        const emp = await c.env.DB.prepare("SELECT id FROM employees WHERE id = ?")
          .bind(draft.employee_id)
          .first<{ id: number }>();
        if (!emp) {
          return c.json(
            { error: "That employee is not on file. Type the name and leave the picker blank." },
            400
          );
        }
      }
      const inserted = await c.env.DB.prepare(
        `INSERT INTO hr_writeups (
           employee_id, employee_name, supervisor_name, incident_date,
           what_happened, prior_warnings, expectations, consequences, form_detail,
           created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          draft.employee_id,
          draft.employee_name,
          blankToNull(draft.supervisor_name),
          blankToNull(draft.incident_date),
          draft.what_happened,
          blankToNull(draft.prior_warnings),
          blankToNull(draft.expectations),
          blankToNull(draft.consequences),
          detailJson(draft.form_detail),
          user.id
        )
        .run();
      const id = Number(inserted.meta.last_row_id);
      const row = await c.env.DB.prepare(`${WRITEUP_SELECT} WHERE w.id = ?`).bind(id).first<WriteupRow>();
      await writeAudit(
        c.env.DB,
        user,
        "create",
        "hr_writeup",
        id,
        `Write-up saved for ${draft.employee_name}`
      );
      return c.json({ writeup: presentWriteup(row) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 115_hr_writeups.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/hr/writeups", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!forbidUnless(user, ROLE_PERMS.manageWriteups)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const includeVoided = c.req.query("include_voided") === "1";
    const q = trimWriteupText(c.req.query("q") || "").slice(0, 200);
    const employeeRaw = c.req.query("employee_id");
    let employeeId: number | null = null;
    if (employeeRaw) {
      const parsedId = readEmployeeId(employeeRaw);
      if (!parsedId.ok) return c.json({ error: parsedId.error }, 400);
      employeeId = parsedId.id;
    }
    const where: string[] = [];
    const binds: Array<string | number> = [];
    if (!includeVoided) where.push("w.voided_at IS NULL");
    if (employeeId != null) {
      const emp = await c.env.DB.prepare("SELECT name FROM employees WHERE id = ?")
        .bind(employeeId)
        .first<{ name: string }>()
        .catch(() => null);
      const name = trimWriteupText(emp?.name || "");
      if (name) {
        where.push("(w.employee_id = ? OR lower(trim(w.employee_name)) = lower(?))");
        binds.push(employeeId, name);
      } else {
        where.push("w.employee_id = ?");
        binds.push(employeeId);
      }
    }
    const qClean = q.replace(/[%_]/g, "");
    if (qClean) {
      const term = `%${qClean}%`;
      where.push(
        "(w.employee_name LIKE ? OR IFNULL(w.supervisor_name, '') LIKE ? OR w.what_happened LIKE ?)"
      );
      binds.push(term, term, term);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    try {
      await ensureWriteupDetailColumn(c.env.DB);
      const countRow = await c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM hr_writeups w ${clause}`
      )
        .bind(...binds)
        .first<{ c: number }>();
      const rows = await c.env.DB.prepare(
        `${WRITEUP_SELECT} ${clause} ORDER BY w.created_at DESC, w.id DESC LIMIT 200`
      )
        .bind(...binds)
        .all<WriteupRow>();
      return c.json({
        writeups: (rows.results || []).map((row) => presentWriteup(row)),
        count: Number(countRow?.c || 0),
        limit: 200,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 115_hr_writeups.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/hr/writeups/:id", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!forbidUnless(user, ROLE_PERMS.manageWriteups)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);
    try {
      await ensureWriteupDetailColumn(c.env.DB);
      const row = await c.env.DB.prepare(`${WRITEUP_SELECT} WHERE w.id = ?`).bind(id).first<WriteupRow>();
      if (!row) return c.json({ error: "Not found" }, 404);
      return c.json({ writeup: presentWriteup(row) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 115_hr_writeups.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.patch("/hr/writeups/:id", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!forbidUnless(user, ROLE_PERMS.manageWriteups)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = validateWriteupInput(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const draft = parsed.value;
    try {
      await ensureWriteupDetailColumn(c.env.DB);
      const existing = await c.env.DB.prepare(
        "SELECT id, voided_at FROM hr_writeups WHERE id = ?"
      )
        .bind(id)
        .first<{ id: number; voided_at: string | null }>();
      if (!existing) return c.json({ error: "Not found" }, 404);
      if (existing.voided_at) {
        return c.json({ error: "This write-up is voided. Start a new one." }, 400);
      }
      if (draft.employee_id != null) {
        const emp = await c.env.DB.prepare("SELECT id FROM employees WHERE id = ?")
          .bind(draft.employee_id)
          .first<{ id: number }>();
        if (!emp) {
          return c.json(
            { error: "That employee is not on file. Type the name and leave the picker blank." },
            400
          );
        }
      }
      await c.env.DB.prepare(
        `UPDATE hr_writeups
         SET employee_id = ?, employee_name = ?, supervisor_name = ?, incident_date = ?,
             what_happened = ?, prior_warnings = ?, expectations = ?, consequences = ?,
             form_detail = ?
         WHERE id = ? AND voided_at IS NULL`
      )
        .bind(
          draft.employee_id,
          draft.employee_name,
          blankToNull(draft.supervisor_name),
          blankToNull(draft.incident_date),
          draft.what_happened,
          blankToNull(draft.prior_warnings),
          blankToNull(draft.expectations),
          blankToNull(draft.consequences),
          detailJson(draft.form_detail),
          id
        )
        .run();
      const row = await c.env.DB.prepare(`${WRITEUP_SELECT} WHERE w.id = ?`).bind(id).first<WriteupRow>();
      await writeAudit(
        c.env.DB,
        user,
        "update",
        "hr_writeup",
        id,
        `Write-up updated for ${draft.employee_name}`
      );
      return c.json({ writeup: presentWriteup(row) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 115_hr_writeups.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.post("/hr/writeups/:id/void", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!forbidUnless(user, ROLE_PERMS.manageWriteups)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    if (!canVoidWriteup(user.role)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = validateVoidReason(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      await ensureWriteupDetailColumn(c.env.DB);
      const existing = await c.env.DB.prepare(
        "SELECT id, employee_name, voided_at FROM hr_writeups WHERE id = ?"
      )
        .bind(id)
        .first<{ id: number; employee_name: string; voided_at: string | null }>();
      if (!existing) return c.json({ error: "Not found" }, 404);
      if (existing.voided_at) {
        return c.json({ error: "This write-up is already voided." }, 400);
      }
      await c.env.DB.prepare(
        `UPDATE hr_writeups
         SET voided_at = datetime('now'), voided_by_user_id = ?, void_reason = ?
         WHERE id = ? AND voided_at IS NULL`
      )
        .bind(user.id, parsed.reason, id)
        .run();
      const row = await c.env.DB.prepare(`${WRITEUP_SELECT} WHERE w.id = ?`).bind(id).first<WriteupRow>();
      await writeAudit(
        c.env.DB,
        user,
        "void",
        "hr_writeup",
        id,
        `Write-up voided for ${existing.employee_name}`
      );
      return c.json({ writeup: presentWriteup(row) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 115_hr_writeups.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });
}
