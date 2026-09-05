/**
 * Tool loan money ledger — Phase 1 (office/admin).
 * Balances = sum(charges) - sum(payments); never delete financial rows (void only).
 */
import type { Hono } from "hono";
import type { Env, PublicUser, Variables } from "./types";
import { writeAudit } from "./audit";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

/** Excel / short names → preferred display_name (must match employees roster). */
const EXCEL_NAME_ALIASES: Record<string, string> = {
  bianca: "Bianca Ramirez",
  "bianca ramirez": "Bianca Ramirez",
  charlesbeard: "Charles Beard",
  "charles beard": "Charles Beard",
  "geovany montes": "Geo Montes",
  "kirk crumbly": "Kirk Crumbley",
  "marcus tover": "Marcus Tovar",
  "michael casarez": "Mike Casarez",
  "warren engel": "Warren Engle",
  "kenneth marroquin": "Speedy Marroquin",
  "jared esquivel": "Lurch Esquivel",
};

function normName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 .'-]/g, "");
}

function isOffice(role: string): boolean {
  return role === "admin" || role === "office";
}

function requireOffice(user: PublicUser): Response | null {
  if (!isOffice(user.role)) {
    return new Response(JSON.stringify({ error: "Office or admin only" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

function parseMoney(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}

/** Policy weekly deduction: max($50, 10% of balance), never more than remaining balance. */
export function policyWeeklyDeduction(balance: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  const b = Math.round(balance * 100) / 100;
  return Math.min(b, Math.max(50, Math.round(b * 0.1 * 100) / 100));
}

function balanceFromPersonRow(row: {
  person_id: number;
  display_name: string;
  balance: number;
}): { balance: number; person_id: number; display_name: string } {
  return {
    balance: Math.round((Number(row.balance) || 0) * 100) / 100,
    person_id: row.person_id,
    display_name: row.display_name,
  };
}

const PERSON_BALANCE_SQL = `SELECT p.id as person_id, p.display_name,
           COALESCE(ch.total_charged, 0) - COALESCE(py.total_paid, 0) as balance
         FROM tool_loan_people p
         LEFT JOIN (
           SELECT person_id, SUM(amount) as total_charged
           FROM tool_loan_charges WHERE IFNULL(voided, 0) = 0 GROUP BY person_id
         ) ch ON ch.person_id = p.id
         LEFT JOIN (
           SELECT person_id, SUM(amount) as total_paid
           FROM tool_loan_payments WHERE IFNULL(voided, 0) = 0 GROUP BY person_id
         ) py ON py.person_id = p.id`;

/**
 * Ledger balance for a Field App user.
 * Matches by: linked user_id → same employee_id → same display name
 * (so "Fleet Admin" / personal login / name on the Excel import all resolve).
 */
export async function ledgerBalanceForUserId(
  db: D1Database,
  userId: number
): Promise<{ balance: number; person_id: number | null; display_name: string | null }> {
  try {
    // 1) Direct link on tool_loan_people.user_id
    const byUser = await db
      .prepare(`${PERSON_BALANCE_SQL} WHERE p.user_id = ? LIMIT 1`)
      .bind(userId)
      .first<{ person_id: number; display_name: string; balance: number }>();
    if (byUser) return balanceFromPersonRow(byUser);

    const me = await db
      .prepare(`SELECT id, display_name, employee_id, username FROM users WHERE id = ?`)
      .bind(userId)
      .first<{
        id: number;
        display_name: string;
        employee_id: number | null;
        username: string | null;
      }>();
    if (!me) return { balance: 0, person_id: null, display_name: null };

    // 2) Another login for the same employee record (e.g. admin + personal)
    if (me.employee_id) {
      const byEmp = await db
        .prepare(
          `${PERSON_BALANCE_SQL}
           WHERE p.user_id IN (SELECT id FROM users WHERE employee_id = ? AND active = 1)
              OR p.user_id = ?
           LIMIT 1`
        )
        .bind(me.employee_id, userId)
        .first<{ person_id: number; display_name: string; balance: number }>();
      if (byEmp) return balanceFromPersonRow(byEmp);
    }

    // 3) Name match (ledger import names vs profile display_name)
    const myName = normName(me.display_name || "");
    const myUser = normName((me.username || "").replace(/[._]/g, " "));
    if (myName || myUser) {
      const candidates = await db
        .prepare(`${PERSON_BALANCE_SQL}`)
        .all<{ person_id: number; display_name: string; balance: number }>();
      for (const p of candidates.results || []) {
        const pn = normName(p.display_name || "");
        if (!pn) continue;
        if (myName && (pn === myName || pn.includes(myName) || myName.includes(pn))) {
          return balanceFromPersonRow(p);
        }
        if (myUser && myUser.length >= 4 && (pn === myUser || pn.includes(myUser))) {
          return balanceFromPersonRow(p);
        }
      }
    }

    return { balance: 0, person_id: null, display_name: null };
  } catch {
    return { balance: 0, person_id: null, display_name: null };
  }
}

/** Normalize to YYYY-MM-DD */
function parseDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    const epoch = Date.UTC(1899, 11, 30);
    const d = new Date(epoch + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const mo = m[1].padStart(2, "0");
    const day = m[2].padStart(2, "0");
    return `${y}-${mo}-${day}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** Local YYYY-MM-DD at noon (avoids UTC off-by-one). */
function toYmdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Pay Friday for tool loan deductions.
 * Office runs payroll mid-week; guys are paid Friday — always post to that Friday.
 * - Mon–Thu → this week's Friday
 * - Friday → that day
 * - Sat–Sun → next Friday
 */
export function toPayFriday(fromYmd?: string | null): string {
  let d: Date;
  if (fromYmd && /^\d{4}-\d{2}-\d{2}$/.test(fromYmd)) {
    const [y, m, day] = fromYmd.split("-").map(Number);
    d = new Date(y, m - 1, day, 12, 0, 0, 0);
  } else {
    const now = new Date();
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  }
  const day = d.getDay(); // 0=Sun … 5=Fri
  const add = (5 - day + 7) % 7;
  d.setDate(d.getDate() + add);
  return toYmdLocal(d);
}

/** Monday of the pay week that ends on the given Friday (YYYY-MM-DD). */
function payWeekMonday(fridayYmd: string): string {
  const [y, m, day] = fridayYmd.split("-").map(Number);
  const d = new Date(y, m - 1, day, 12, 0, 0, 0);
  d.setDate(d.getDate() - 4); // Fri → Mon
  return toYmdLocal(d);
}

/** Tables are created by migration 052 — skip DDL on every request (was risking hangs). */
export async function ensureToolLoanLedgerTables(_db: D1Database): Promise<void> {
  return;
}

/** Person IDs manually skipped for this pay Friday (migration 082). */
export async function payrollSkipPersonIds(
  db: D1Database,
  payFriday: string
): Promise<number[]> {
  const friday = toPayFriday(payFriday);
  try {
    const rows = await db
      .prepare(
        `SELECT person_id FROM tool_loan_payroll_skips WHERE pay_friday = ?`
      )
      .bind(friday)
      .all<{ person_id: number }>();
    return (rows.results || []).map((r) => Number(r.person_id)).filter((id) => id > 0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return [];
    throw e;
  }
}

export type PayrollSkipRow = {
  person_id: number;
  display_name: string;
  pay_friday: string;
  skipped_at: string | null;
};

type UserLite = { id: number; display_name: string; username: string | null };

function matchUser(users: UserLite[], excelName: string): UserLite | null {
  const key = normName(excelName);
  const aliasTarget = EXCEL_NAME_ALIASES[key];
  const candidates = [excelName, aliasTarget].filter(Boolean) as string[];

  for (const c of candidates) {
    const nk = normName(c);
    for (const u of users) {
      if (normName(u.display_name) === nk) return u;
      if (u.username && normName(u.username.replace(/[._]/g, " ")) === nk) return u;
    }
  }
  const tokens = key.split(" ").filter(Boolean);
  if (tokens.length >= 2) {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    for (const u of users) {
      const ut = normName(u.display_name).split(" ").filter(Boolean);
      if (ut.length >= 1 && ut[0] === first && ut[ut.length - 1] === last) return u;
    }
  }
  return null;
}

async function loadUserIndex(db: D1Database): Promise<UserLite[]> {
  const users = await db
    .prepare(`SELECT id, display_name, username FROM users`)
    .all<UserLite>();
  return users.results || [];
}

async function balancesForPeople(db: D1Database, personIds?: number[]) {
  let where = "";
  const binds: (string | number)[] = [];
  if (personIds?.length) {
    where = `WHERE p.id IN (${personIds.map(() => "?").join(",")})`;
    binds.push(...personIds);
  }
  // Joined aggregates — faster / safer than correlated subqueries on D1
  const rows = await db
    .prepare(
      `SELECT p.id as person_id, p.user_id, p.display_name, p.weekly_deduction, p.status, p.notes,
        COALESCE(ch.total_charged, 0) as total_charged,
        COALESCE(py.total_paid, 0) as total_paid
       FROM tool_loan_people p
       LEFT JOIN (
         SELECT person_id, SUM(amount) as total_charged
         FROM tool_loan_charges
         WHERE IFNULL(voided, 0) = 0
         GROUP BY person_id
       ) ch ON ch.person_id = p.id
       LEFT JOIN (
         SELECT person_id, SUM(amount) as total_paid
         FROM tool_loan_payments
         WHERE IFNULL(voided, 0) = 0
         GROUP BY person_id
       ) py ON py.person_id = p.id
       ${where}
       ORDER BY p.display_name`
    )
    .bind(...binds)
    .all<{
      person_id: number;
      user_id: number | null;
      display_name: string;
      weekly_deduction: number | null;
      status: string;
      notes: string | null;
      total_charged: number;
      total_paid: number;
    }>();

  return (rows.results || []).map((r) => {
    const charged = Number(r.total_charged) || 0;
    const paid = Number(r.total_paid) || 0;
    const balance = Math.round((charged - paid) * 100) / 100;
    return {
      ...r,
      total_charged: charged,
      total_paid: paid,
      balance,
      // Office may set weekly_deduction; policy default is max($50, 10% of balance)
      suggested_weekly:
        r.weekly_deduction != null && r.weekly_deduction > 0
          ? Math.min(r.weekly_deduction, Math.max(balance, 0))
          : policyWeeklyDeduction(balance),
    };
  });
}

export function registerToolLoanLedger(api: App): void {
  // GET summary / payroll-week / health / owner-report live in index.ts (fast path).

  api.get("/tool-loan-ledger/people/:id", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const id = Number(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid id" }, 400);
    const summary = (await balancesForPeople(c.env.DB, [id]))[0];
    if (!summary) return c.json({ error: "Not found" }, 404);
    const charges = await c.env.DB.prepare(
      `SELECT * FROM tool_loan_charges WHERE person_id = ? ORDER BY charge_date DESC, id DESC LIMIT 500`
    )
      .bind(id)
      .all();
    const payments = await c.env.DB.prepare(
      `SELECT * FROM tool_loan_payments WHERE person_id = ? ORDER BY payment_date DESC, id DESC LIMIT 500`
    )
      .bind(id)
      .all();
    return c.json({
      person: summary,
      charges: charges.results || [],
      payments: payments.results || [],
    });
  });

  api.post("/tool-loan-ledger/people", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const body = await c.req.json<{
      display_name?: string;
      user_id?: number | null;
      weekly_deduction?: number | null;
      status?: string;
      notes?: string;
    }>();
    const name = (body.display_name || "").trim();
    if (!name) return c.json({ error: "display_name required" }, 400);
    const status = ["active", "inactive", "former"].includes(body.status || "")
      ? body.status!
      : body.user_id
        ? "active"
        : "former";
    const r = await c.env.DB.prepare(
      `INSERT INTO tool_loan_people (user_id, display_name, weekly_deduction, status, notes)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        body.user_id ?? null,
        name,
        body.weekly_deduction ?? null,
        status,
        body.notes?.trim() || null
      )
      .run();
    const id = Number(r.meta.last_row_id);
    await writeAudit(c.env.DB, user, "create", "tool_loan_person", String(id), name);
    return c.json({ id, ok: true });
  });

  api.patch("/tool-loan-ledger/people/:id", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{
      weekly_deduction?: number | null;
      status?: string;
      notes?: string;
      display_name?: string;
      user_id?: number | null;
      /** When true with status former/inactive: deactivate linked app login (balance stays). */
      deactivate_login?: boolean;
    }>();
    const row = await c.env.DB.prepare(
      `SELECT id, user_id, display_name FROM tool_loan_people WHERE id = ?`
    )
      .bind(id)
      .first<{ id: number; user_id: number | null; display_name: string }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (body.weekly_deduction !== undefined) {
      await c.env.DB.prepare(
        `UPDATE tool_loan_people SET weekly_deduction = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(body.weekly_deduction, id)
        .run();
    }
    if (body.status && ["active", "inactive", "former"].includes(body.status)) {
      await c.env.DB.prepare(
        `UPDATE tool_loan_people SET status = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(body.status, id)
        .run();
      // Former / inactive: turn off app login so they can't use the system, but ledger balance remains
      const shouldDeactivate =
        body.deactivate_login !== false &&
        (body.status === "former" || body.status === "inactive") &&
        row.user_id;
      if (shouldDeactivate) {
        await c.env.DB.prepare(`UPDATE users SET active = 0 WHERE id = ? AND active = 1`)
          .bind(row.user_id)
          .run();
        await writeAudit(
          c.env.DB,
          user,
          "update",
          "user",
          String(row.user_id),
          `Deactivated login (tool loan ${body.status}): ${row.display_name} — balance retained`
        );
      }
      // Re-hire path: mark active again → re-enable login if linked
      if (body.status === "active" && row.user_id && body.deactivate_login !== true) {
        await c.env.DB.prepare(`UPDATE users SET active = 1 WHERE id = ?`)
          .bind(row.user_id)
          .run();
      }
    }
    if (body.notes !== undefined) {
      await c.env.DB.prepare(
        `UPDATE tool_loan_people SET notes = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(body.notes, id)
        .run();
    }
    if (body.display_name?.trim()) {
      await c.env.DB.prepare(
        `UPDATE tool_loan_people SET display_name = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(body.display_name.trim(), id)
        .run();
    }
    if (body.user_id !== undefined) {
      await c.env.DB.prepare(
        `UPDATE tool_loan_people SET user_id = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(body.user_id, id)
        .run();
    }
    await writeAudit(c.env.DB, user, "update", "tool_loan_person", String(id), "Updated person");
    return c.json({ ok: true });
  });

  /**
   * Mark all former (no login / already former) people as former and deactivate any linked logins.
   * Does NOT delete balances or history.
   */
  api.post("/tool-loan-ledger/deactivate-former", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const body = await c.req.json<{ person_ids?: number[] }>().catch(() => ({} as { person_ids?: number[] }));

    let people: { id: number; user_id: number | null; display_name: string; status: string }[] = [];
    if (body.person_ids?.length) {
      const ph = body.person_ids.map(() => "?").join(",");
      const r = await c.env.DB.prepare(
        `SELECT id, user_id, display_name, status FROM tool_loan_people WHERE id IN (${ph})`
      )
        .bind(...body.person_ids)
        .all<{ id: number; user_id: number | null; display_name: string; status: string }>();
      people = r.results || [];
    } else {
      // Default: everyone currently flagged former, or unlinked with $0 login
      const r = await c.env.DB.prepare(
        `SELECT id, user_id, display_name, status FROM tool_loan_people
         WHERE status = 'former' OR user_id IS NULL`
      ).all<{ id: number; user_id: number | null; display_name: string; status: string }>();
      people = r.results || [];
    }

    let markedFormer = 0;
    let loginsDeactivated = 0;
    for (const p of people) {
      if (p.status !== "former") {
        await c.env.DB.prepare(
          `UPDATE tool_loan_people SET status = 'former', updated_at = datetime('now') WHERE id = ?`
        )
          .bind(p.id)
          .run();
        markedFormer++;
      }
      if (p.user_id) {
        const u = await c.env.DB.prepare(`SELECT active FROM users WHERE id = ?`)
          .bind(p.user_id)
          .first<{ active: number }>();
        if (u && u.active) {
          await c.env.DB.prepare(`UPDATE users SET active = 0 WHERE id = ?`).bind(p.user_id).run();
          loginsDeactivated++;
          await writeAudit(
            c.env.DB,
            user,
            "update",
            "user",
            String(p.user_id),
            `Deactivated (former employee): ${p.display_name} — tool loan balance retained`
          );
        }
      }
    }

    await writeAudit(
      c.env.DB,
      user,
      "update",
      "tool_loan_ledger",
      null,
      `deactivate-former: ${markedFormer} marked, ${loginsDeactivated} logins off`
    );
    return c.json({
      ok: true,
      people_processed: people.length,
      marked_former: markedFormer,
      logins_deactivated: loginsDeactivated,
      note: "Balances and payment history were not deleted.",
    });
  });

  /**
   * People already on the ledger (any balance, including $0) plus active app users
   * not yet linked — so office can add a charge without the employee request flow.
   * Also returns the full active employee payroll roster for the “include $0” list.
   */
  api.get("/tool-loan-ledger/employee-picker", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const people = await balancesForPeople(c.env.DB);
    const users = await c.env.DB.prepare(
      `SELECT id, display_name, role, employee_id FROM users
       WHERE IFNULL(active, 1) = 1
       ORDER BY display_name COLLATE NOCASE`
    ).all<{ id: number; display_name: string; role: string; employee_id: number | null }>();
    const linkedUserIds = new Set(
      people.map((p) => p.user_id).filter((id): id is number => id != null)
    );
    const users_not_on_ledger = (users.results || []).filter((u) => !linkedUserIds.has(u.id));

    // Prefer active employees; fall back to any employees if the active flag is sparse.
    let emps = await c.env.DB.prepare(
      `SELECT id, name FROM employees WHERE IFNULL(active, 1) = 1 ORDER BY name COLLATE NOCASE`
    ).all<{ id: number; name: string }>();
    if (!(emps.results || []).length) {
      emps = await c.env.DB.prepare(
        `SELECT id, name FROM employees ORDER BY name COLLATE NOCASE`
      ).all<{ id: number; name: string }>();
    }
    const userByEmployeeId = new Map<number, number>();
    const userByName = new Map<string, number>();
    for (const u of users.results || []) {
      if (u.employee_id != null && !userByEmployeeId.has(u.employee_id)) {
        userByEmployeeId.set(u.employee_id, u.id);
      }
      const un =
        String(u.display_name || "")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      if (un && !userByName.has(un)) userByName.set(un, u.id);
    }
    const active_employees: { id: number; name: string; user_id: number | null }[] = (
      emps.results || []
    ).map((e) => {
      const nn = String(e.name || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        id: e.id,
        name: e.name,
        user_id: userByEmployeeId.get(e.id) ?? userByName.get(nn) ?? null,
      };
    });

    // Ensure every active app user also appears on the roster (even without employees row)
    const seenEmpNames = new Set(
      active_employees.map((e) =>
        String(e.name || "")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
    );
    for (const u of users.results || []) {
      const un =
        String(u.display_name || "")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      if (!un || seenEmpNames.has(un)) continue;
      // Skip pure system roles that never get tool loans
      const role = String(u.role || "").toLowerCase();
      if (role === "tv" || role === "system") continue;
      seenEmpNames.add(un);
      active_employees.push({
        id: -u.id,
        name: u.display_name,
        user_id: u.id,
      });
    }
    active_employees.sort((a, b) => a.name.localeCompare(b.name));

    return c.json({
      people,
      users_not_on_ledger,
      active_employees,
    });
  });

  /** Resolve or create a ledger person for a charge (supports $0-balance employees). */
  async function ensureLedgerPerson(
    db: D1Database,
    actor: PublicUser,
    opts: { person_id?: number; user_id?: number; display_name?: string }
  ): Promise<{ person_id: number; display_name: string } | { error: string; status: number }> {
    const personId = Number(opts.person_id) || 0;
    if (personId) {
      const row = await db
        .prepare(`SELECT id, display_name FROM tool_loan_people WHERE id = ?`)
        .bind(personId)
        .first<{ id: number; display_name: string }>();
      if (!row) return { error: "Employee not found on ledger", status: 404 };
      return { person_id: row.id, display_name: row.display_name };
    }

    const userId = Number(opts.user_id) || 0;
    if (userId) {
      const existing = await db
        .prepare(`SELECT id, display_name FROM tool_loan_people WHERE user_id = ?`)
        .bind(userId)
        .first<{ id: number; display_name: string }>();
      if (existing) return { person_id: existing.id, display_name: existing.display_name };

      const u = await db
        .prepare(`SELECT id, display_name FROM users WHERE id = ?`)
        .bind(userId)
        .first<{ id: number; display_name: string }>();
      if (!u) return { error: "User not found", status: 404 };

      const ins = await db
        .prepare(
          `INSERT INTO tool_loan_people (user_id, display_name, weekly_deduction, status, notes)
           VALUES (?, ?, NULL, 'active', NULL)`
        )
        .bind(u.id, u.display_name)
        .run();
      const newId = Number(ins.meta.last_row_id);
      await writeAudit(db, actor, "create", "tool_loan_person", String(newId), u.display_name);
      return { person_id: newId, display_name: u.display_name };
    }

    const name = (opts.display_name || "").trim();
    if (name) {
      const byName = await db
        .prepare(
          `SELECT id, display_name FROM tool_loan_people
           WHERE lower(trim(display_name)) = lower(trim(?))
           ORDER BY id LIMIT 1`
        )
        .bind(name)
        .first<{ id: number; display_name: string }>();
      if (byName) return { person_id: byName.id, display_name: byName.display_name };

      const ins = await db
        .prepare(
          `INSERT INTO tool_loan_people (user_id, display_name, weekly_deduction, status, notes)
           VALUES (NULL, ?, NULL, 'active', NULL)`
        )
        .bind(name)
        .run();
      const newId = Number(ins.meta.last_row_id);
      await writeAudit(db, actor, "create", "tool_loan_person", String(newId), name);
      return { person_id: newId, display_name: name };
    }

    return { error: "person_id, user_id, or display_name required", status: 400 };
  }

  const CHARGE_KIND_LABELS: Record<string, string> = {
    unapproved_card: "Unapproved credit card charge",
    tool_purchase: "Tool purchase / loan",
    balance_adjustment: "Balance adjustment",
    other: "Other charge",
  };

  /**
   * Office adds a charge directly to the ledger (no employee request / approval).
   * Works for people with $0 balance and can create a ledger person from an app user.
   */
  api.post("/tool-loan-ledger/charges", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const body = await c.req.json<{
      person_id?: number;
      user_id?: number;
      display_name?: string;
      description?: string;
      reason?: string;
      charge_kind?: string;
      charge_date?: string;
      amount?: number | string;
    }>();

    const amount = parseMoney(body.amount);
    if (amount == null || amount <= 0) {
      return c.json({ error: "Positive amount required" }, 400);
    }

    const person = await ensureLedgerPerson(c.env.DB, user, {
      person_id: body.person_id,
      user_id: body.user_id,
      display_name: body.display_name,
    });
    if ("error" in person) {
      return c.json({ error: person.error }, person.status as 400);
    }

    const reason = (body.reason || body.description || "").trim();
    if (!reason) {
      return c.json({ error: "Reason / description is required" }, 400);
    }

    const kindKey = (body.charge_kind || "").trim();
    const kindLabel = CHARGE_KIND_LABELS[kindKey] || (kindKey ? kindKey : "");
    const desc = kindLabel ? `${kindLabel}: ${reason}` : reason;
    const date = parseDate(body.charge_date) || new Date().toISOString().slice(0, 10);

    const before = (await balancesForPeople(c.env.DB, [person.person_id]))[0];
    const balanceBefore = before?.balance ?? 0;

    const r = await c.env.DB.prepare(
      `INSERT INTO tool_loan_charges
         (person_id, description, charge_date, amount, source, created_by_user_id)
       VALUES (?, ?, ?, ?, 'manual', ?)`
    )
      .bind(person.person_id, desc, date, amount, user.id)
      .run();
    const chargeId = Number(r.meta.last_row_id);

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "tool_loan_charge",
      String(chargeId),
      `${person.display_name}: ${desc} $${amount}`
    );

    const balanceAfter = Math.round((balanceBefore + amount) * 100) / 100;
    const weeklyAfter = policyWeeklyDeduction(balanceAfter);

    return c.json({
      id: chargeId,
      ok: true,
      person_id: person.person_id,
      display_name: person.display_name,
      description: desc,
      amount,
      charge_date: date,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      weekly_after: weeklyAfter,
      print_path: `/api/tool-loan-ledger/charges/${chargeId}/print-agreement`,
    });
  });

  /** Printable acknowledgment form for employee signature (charge already on ledger). */
  api.get("/tool-loan-ledger/charges/:id/print-agreement", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) {
      return c.html(
        `<!DOCTYPE html><html><body><p>Office or admin only.</p></body></html>`,
        403
      );
    }
    await ensureToolLoanLedgerTables(c.env.DB);
    const id = Number(c.req.param("id"));
    if (!id) {
      return c.html(`<!DOCTYPE html><html><body><p>Invalid charge.</p></body></html>`, 400);
    }

    const charge = await c.env.DB.prepare(
      `SELECT c.id, c.person_id, c.description, c.charge_date, c.amount, c.created_at,
              p.display_name, p.weekly_deduction
       FROM tool_loan_charges c
       JOIN tool_loan_people p ON p.id = c.person_id
       WHERE c.id = ? AND IFNULL(c.voided, 0) = 0`
    )
      .bind(id)
      .first<{
        id: number;
        person_id: number;
        description: string;
        charge_date: string;
        amount: number;
        created_at: string;
        display_name: string;
        weekly_deduction: number | null;
      }>();

    if (!charge) {
      return c.html(`<!DOCTYPE html><html><body><p>Charge not found.</p></body></html>`, 404);
    }

    const summary = (await balancesForPeople(c.env.DB, [charge.person_id]))[0];
    const balanceNow = summary?.balance ?? Number(charge.amount);
    const amount = Number(charge.amount) || 0;
    const balanceBefore = Math.round((balanceNow - amount) * 100) / 100;
    const weekly =
      summary?.suggested_weekly ??
      policyWeeklyDeduction(balanceNow);

    // Who is printing the form (office printed-name line) — always resolve from session + DB
    let officePrinterName = String(user?.display_name || "").trim();
    if (!officePrinterName && user?.id) {
      const urow = await c.env.DB.prepare(
        `SELECT display_name, username, email FROM users WHERE id = ?`
      )
        .bind(user.id)
        .first<{ display_name: string | null; username: string | null; email: string | null }>();
      officePrinterName = String(
        urow?.display_name || urow?.username || urow?.email || ""
      ).trim();
    }
    if (!officePrinterName) {
      officePrinterName = String(user?.username || user?.email || "Office").trim() || "Office";
    }

    const money = (n: number) =>
      n.toLocaleString("en-US", { style: "currency", currency: "USD" });
    const esc = (s: string) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const origin = new URL(c.req.url).origin;
    const logoUrl = `${origin}/logo-print.jpg`;
    const chargeDate = (charge.charge_date || "").slice(0, 10);
    const printedAt = new Date();
    const prepared = printedAt.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    /** Form date = day this copy was printed — no handwritten date needed */
    const formDate = printedAt.toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Tool Loan Acknowledgment — ${esc(charge.display_name)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #0f172a;
      margin: 0.55in 0.65in;
      font-size: 13px;
      line-height: 1.45;
      background: #fff;
    }
    .noprint { margin: 0 0 14px; }
    .noprint button {
      font: inherit;
      padding: 10px 16px;
      border-radius: 999px;
      border: none;
      background: #0c1f4a;
      color: #fff;
      cursor: pointer;
      font-weight: 700;
    }
    .head {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: flex-start;
      padding-bottom: 0.85rem;
      margin-bottom: 1rem;
      border-bottom: 3px solid #0c1f4a;
    }
    .logo {
      height: 52px;
      width: auto;
      max-width: min(300px, 100%);
      object-fit: contain;
      display: block;
      margin-bottom: 0.35rem;
    }
    h1 {
      margin: 0;
      font-size: 1.15rem;
      color: #0c1f4a;
      letter-spacing: -0.02em;
    }
    .meta {
      font-size: 11px;
      text-align: right;
      color: #475569;
    }
    .meta strong { color: #0f172a; display: block; font-size: 12px; }
    .box {
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 0.85rem 1rem;
      margin-bottom: 0.85rem;
      background: #f8fafc;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.55rem 1.25rem;
    }
    .label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #64748b;
    }
    .value {
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
      margin-top: 2px;
    }
    .reason {
      margin-top: 0.65rem;
      padding-top: 0.65rem;
      border-top: 1px dashed #cbd5e1;
    }
    .reason .value {
      font-weight: 600;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .amounts {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.55rem;
      margin-bottom: 0.85rem;
    }
    .amt {
      border: 1px solid #d5dee8;
      border-radius: 8px;
      padding: 0.65rem 0.75rem;
      background: #fff;
    }
    .amt.accent {
      background: #fff5f5;
      border-color: #f5c2c2;
    }
    .amt .value { font-size: 1.15rem; }
    .amt.accent .value { color: #b91c1c; }
    .terms {
      font-size: 12px;
      color: #334155;
      margin: 0 0 1.1rem;
    }
    .terms li { margin: 0.25rem 0; }
    .sign {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem 2rem;
      margin-top: 1.25rem;
    }
    .sign-block {
      border-top: 1px solid #94a3b8;
      padding-top: 0.45rem;
      min-height: 3.75rem;
    }
    .sign-block .line {
      margin-top: 1.6rem;
      border-bottom: 1px solid #0f172a;
      height: 1.55rem;
    }
    /* Pre-filled printed name / date — separate from blank signature lines */
    .sign-block .print-name-value,
    .sign-block .print-date-value {
      margin-top: 0.85rem;
      border-bottom: 1px solid #000;
      min-height: 1.5rem;
      padding: 0.15rem 0 0.2rem;
      font-size: 14px;
      font-weight: 700;
      color: #000 !important;
      line-height: 1.35;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sign-block .print-date-value {
      font-size: 13px;
      font-weight: 600;
    }
    .sign-block .cap {
      margin-top: 0.3rem;
      font-size: 10px;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .foot {
      margin-top: 1.25rem;
      padding-top: 0.65rem;
      border-top: 1px solid #cbd5e1;
      font-size: 10px;
      color: #64748b;
    }
    @media print {
      .noprint { display: none !important; }
      body { margin: 0.45in 0.55in; }
      .box, .amt, .amt.accent {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
    }
    @page { margin: 0.45in; size: letter; }
  </style>
</head>
<body>
  <div class="noprint"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <div class="head">
    <div>
      <img class="logo" src="${esc(logoUrl)}" alt="Total Assurance A/C &amp; Heating"
        onerror="this.onerror=null;this.src='${esc(origin)}/logo-light.png'" />
      <h1>Tool Loan Charge Acknowledgment</h1>
    </div>
    <div class="meta">
      <span>Prepared</span>
      <strong>${esc(prepared)}</strong>
      <span style="display:block;margin-top:0.45rem">By</span>
      <strong>${esc(officePrinterName)}</strong>
      <span style="display:block;margin-top:0.45rem">Charge #</span>
      <strong>${charge.id}</strong>
    </div>
  </div>

  <div class="box">
    <div class="grid">
      <div>
        <div class="label">Employee</div>
        <div class="value">${esc(charge.display_name)}</div>
      </div>
      <div>
        <div class="label">Charge date</div>
        <div class="value">${esc(chargeDate)}</div>
      </div>
    </div>
    <div class="reason">
      <div class="label">Reason / description</div>
      <div class="value">${esc(charge.description)}</div>
    </div>
  </div>

  <div class="amounts">
    <div class="amt">
      <div class="label">Balance before</div>
      <div class="value">${money(balanceBefore)}</div>
    </div>
    <div class="amt accent">
      <div class="label">This charge</div>
      <div class="value">+${money(amount)}</div>
    </div>
    <div class="amt">
      <div class="label">New balance</div>
      <div class="value">${money(balanceNow)}</div>
    </div>
  </div>

  <p class="terms"><strong>Estimated weekly payroll deduction after this charge:</strong> ${money(weekly)}
    (company policy: 10% of remaining balance, minimum $50/week, not more than remaining balance — office may set a different weekly amount).</p>

  <ul class="terms">
    <li>This amount is added to my company <strong>tool loan balance</strong> and is repaid through weekly payroll deductions until paid in full.</li>
    <li>I understand this charge was recorded by the office (it does not require a separate in-app loan request).</li>
    <li>On termination, any remaining balance may be deducted from final pay / PTO / other compensation per company policy; any remainder remains due.</li>
  </ul>

  <p class="terms"><strong>Employee acknowledgment:</strong> I have read this form and acknowledge the charge and the increase to my tool loan balance as shown above.</p>

  <div class="sign">
    <div class="sign-block">
      <div class="line"></div>
      <div class="cap">Technician / employee signature</div>
      <div class="print-name-value">${esc(charge.display_name)}</div>
      <div class="cap">Printed name</div>
      <div class="print-date-value">${esc(formDate)}</div>
      <div class="cap">Date</div>
    </div>
    <div class="sign-block">
      <div class="line"></div>
      <div class="cap">Office / supervisor signature</div>
      <div class="print-name-value">${esc(officePrinterName)}</div>
      <div class="cap">Printed name</div>
      <div class="print-date-value">${esc(formDate)}</div>
      <div class="cap">Date</div>
    </div>
  </div>

  <p class="foot">Total Assurance A/C &amp; Heating · Confidential employee file · Tool loan charge #${charge.id} · Keep signed copy with employee records.</p>
  <script>
    window.addEventListener("load", function () {
      setTimeout(function () { window.focus(); window.print(); }, 450);
    });
  </script>
</body>
</html>`;
    return c.html(html);
  });

  /** List people skipped for a pay Friday (uncheck = skip THIS paycheck only). */
  api.get("/tool-loan-ledger/payroll-skips", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    const payFriday = toPayFriday(
      (c.req.query("pay_friday") || c.req.query("week_of") || "").slice(0, 10) || null
    );
    try {
      const rows = await c.env.DB.prepare(
        `SELECT s.person_id, s.pay_friday, s.skipped_at, p.display_name
         FROM tool_loan_payroll_skips s
         JOIN tool_loan_people p ON p.id = s.person_id
         WHERE s.pay_friday = ?
         ORDER BY lower(p.display_name)`
      )
        .bind(payFriday)
        .all<PayrollSkipRow>();
      return c.json({
        pay_friday: payFriday,
        skips: rows.results || [],
        person_ids: (rows.results || []).map((r) => r.person_id),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({
          pay_friday: payFriday,
          skips: [],
          person_ids: [],
          error: "Run migration 082_tool_loan_payroll_skips.sql on D1",
        });
      }
      return c.json({ error: msg }, 500);
    }
  });

  /** Persist skip for this pay Friday only — does not void loan or change balance. */
  api.post("/tool-loan-ledger/payroll-skips", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    const body = (await c.req.json()) as {
      person_id?: number;
      pay_friday?: string;
      note?: string;
    };
    const personId = Number(body.person_id || 0);
    const payFriday = toPayFriday(body.pay_friday || null);
    if (!personId) return c.json({ error: "person_id required" }, 400);
    try {
      const person = await c.env.DB.prepare(
        `SELECT id, display_name FROM tool_loan_people WHERE id = ?`
      )
        .bind(personId)
        .first<{ id: number; display_name: string }>();
      if (!person) return c.json({ error: "Person not found" }, 404);
      await c.env.DB.prepare(
        `INSERT INTO tool_loan_payroll_skips (person_id, pay_friday, skipped_by_user_id, skipped_at, note)
         VALUES (?, ?, ?, datetime('now'), ?)
         ON CONFLICT(person_id, pay_friday) DO UPDATE SET
           skipped_by_user_id = excluded.skipped_by_user_id,
           skipped_at = datetime('now'),
           note = excluded.note`
      )
        .bind(personId, payFriday, user.id, body.note?.trim() || null)
        .run();
      await writeAudit(
        c.env.DB,
        user,
        "create",
        "tool_loan_payroll_skip",
        personId,
        `Skip payroll ${payFriday} · ${person.display_name}`
      );
      return c.json({
        ok: true,
        pay_friday: payFriday,
        person_id: personId,
        display_name: person.display_name,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json(
          { error: "Run migration 082_tool_loan_payroll_skips.sql on D1" },
          500
        );
      }
      return c.json({ error: msg }, 500);
    }
  });

  /** Put someone back on this Friday's deduction report. */
  api.delete("/tool-loan-ledger/payroll-skips", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    const personId = Number(c.req.query("person_id") || "") || 0;
    const payFriday = toPayFriday(
      (c.req.query("pay_friday") || c.req.query("week_of") || "").slice(0, 10) || null
    );
    if (!personId) return c.json({ error: "person_id required" }, 400);
    try {
      const before = await c.env.DB.prepare(
        `SELECT s.id, p.display_name
         FROM tool_loan_payroll_skips s
         JOIN tool_loan_people p ON p.id = s.person_id
         WHERE s.person_id = ? AND s.pay_friday = ?`
      )
        .bind(personId, payFriday)
        .first<{ id: number; display_name: string }>();
      await c.env.DB.prepare(
        `DELETE FROM tool_loan_payroll_skips WHERE person_id = ? AND pay_friday = ?`
      )
        .bind(personId, payFriday)
        .run();
      if (before) {
        await writeAudit(
          c.env.DB,
          user,
          "delete",
          "tool_loan_payroll_skip",
          personId,
          `Unskip payroll ${payFriday} · ${before.display_name}`
        );
      }
      return c.json({ ok: true, pay_friday: payFriday, person_id: personId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json(
          { error: "Run migration 082_tool_loan_payroll_skips.sql on D1" },
          500
        );
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.post("/tool-loan-ledger/payments", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const body = await c.req.json<{
      person_id?: number;
      payment_date?: string;
      amount?: number | string;
      payment_type?: string;
      note?: string;
      /** When true (default for payroll), reject if already deducted this pay week */
      prevent_duplicate_week?: boolean;
    }>();
    const personId = Number(body.person_id);
    const amount = parseMoney(body.amount);
    const ptype = ["payroll", "spiff", "other"].includes(body.payment_type || "")
      ? body.payment_type!
      : "payroll";
    // Payroll always lands on the pay Friday so the paycheck date is clear for employees.
    // Spiff/other keep the exact date provided (or today).
    const rawDate = parseDate(body.payment_date);
    const date =
      ptype === "payroll"
        ? toPayFriday(rawDate)
        : rawDate || new Date().toISOString().slice(0, 10);
    if (!personId || amount == null || amount <= 0) {
      return c.json({ error: "person_id and positive amount required" }, 400);
    }

    // Manual skip for this pay Friday → do not post (loan stays; try again next Friday)
    if (ptype === "payroll") {
      try {
        const skipped = await c.env.DB.prepare(
          `SELECT id FROM tool_loan_payroll_skips WHERE person_id = ? AND pay_friday = ? LIMIT 1`
        )
          .bind(personId, date)
          .first();
        if (skipped) {
          return c.json(
            {
              error: "skipped_this_friday",
              message: `This employee is skipped for pay Friday ${date}. Unskip them on the payroll report to deduct.`,
              pay_friday: date,
            },
            409
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no such table/i.test(msg)) throw e;
      }
    }

    // Once per pay week: block if this person already has a payroll deduction
    // dated that Friday OR anywhere Mon–Fri of the same week (legacy mid-week dates).
    if (ptype === "payroll" && body.prevent_duplicate_week !== false) {
      const weekMon = payWeekMonday(date);
      const existing = await c.env.DB.prepare(
        `SELECT id, amount, payment_date, created_at FROM tool_loan_payments
         WHERE person_id = ?
           AND payment_type = 'payroll'
           AND IFNULL(voided, 0) = 0
           AND payment_date >= ?
           AND payment_date <= ?
         ORDER BY payment_date DESC, id DESC
         LIMIT 1`
      )
        .bind(personId, weekMon, date)
        .first<{ id: number; amount: number; payment_date: string; created_at: string }>();
      if (existing) {
        return c.json(
          {
            error: `Payroll deduction already recorded for this employee this pay week ($${Number(
              existing.amount
            ).toFixed(2)} on ${existing.payment_date}). Apply only once per week — void that payment first if you need to re-apply.`,
            already_exists: true,
            payment_id: existing.id,
            payment_date: existing.payment_date,
            pay_friday: date,
            amount: existing.amount,
            created_at: existing.created_at,
          },
          409
        );
      }
    }

    const note =
      (body.note || "").trim() ||
      (ptype === "payroll" ? `Payroll deduction for Friday ${date}` : null);

    const r = await c.env.DB.prepare(
      `INSERT INTO tool_loan_payments
         (person_id, payment_date, amount, payment_type, note, source, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'manual', ?)`
    )
      .bind(personId, date, amount, ptype, note, user.id)
      .run();
    await writeAudit(
      c.env.DB,
      user,
      "create",
      "tool_loan_payment",
      String(r.meta.last_row_id),
      `${ptype} $${amount} · pay ${date}`
    );
    return c.json({ id: Number(r.meta.last_row_id), ok: true, payment_date: date });
  });

  api.post("/tool-loan-ledger/charges/:id/void", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    await c.env.DB.prepare(
      `UPDATE tool_loan_charges SET voided = 1, voided_at = datetime('now'),
         voided_by_user_id = ?, void_reason = ? WHERE id = ? AND IFNULL(voided,0) = 0`
    )
      .bind(user.id, body.reason?.trim() || null, id)
      .run();
    await writeAudit(c.env.DB, user, "void", "tool_loan_charge", String(id), body.reason || "");
    return c.json({ ok: true });
  });

  /**
   * Correct a charge amount/description (e.g. forgot sales tax).
   * Keeps the same charge id so acknowledgment print still works.
   * Body: amount (required), description?, reason?, pretax_amount?, tax_rate?
   */
  api.post("/tool-loan-ledger/charges/:id/amend", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const id = Number(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid charge id" }, 400);

    const body = await c.req.json<{
      amount?: number | string;
      description?: string;
      reason?: string;
      pretax_amount?: number | string;
      tax_rate?: number | string;
    }>().catch(() => ({} as Record<string, never>));

    const before = await c.env.DB.prepare(
      `SELECT id, person_id, description, amount, charge_date, voided
       FROM tool_loan_charges WHERE id = ?`
    )
      .bind(id)
      .first<{
        id: number;
        person_id: number;
        description: string;
        amount: number;
        charge_date: string;
        voided: number;
      }>();
    if (!before) return c.json({ error: "Charge not found" }, 404);
    if (before.voided) {
      return c.json({ error: "Cannot edit a voided charge — create a new one instead" }, 400);
    }

    let newAmount = parseMoney(body.amount);
    const pretax = parseMoney(body.pretax_amount);
    const taxRateRaw = Number(body.tax_rate);
    if ((newAmount == null || newAmount <= 0) && pretax != null && pretax > 0) {
      const rate =
        Number.isFinite(taxRateRaw) && taxRateRaw >= 0
          ? Math.round(taxRateRaw * 1000) / 1000
          : 8.25;
      const tax = Math.round(pretax * (rate / 100) * 100) / 100;
      newAmount = Math.round((pretax + tax) * 100) / 100;
    }
    if (newAmount == null || newAmount <= 0) {
      return c.json({ error: "Positive amount required" }, 400);
    }

    const oldAmount = Math.round(Number(before.amount) * 100) / 100;
    let desc = (body.description || "").trim() || before.description;
    const reason = (body.reason || "").trim();
    // If tax fields provided, document breakdown in description when not already detailed
    if (pretax != null && pretax > 0 && Number.isFinite(taxRateRaw) && taxRateRaw >= 0) {
      const tax = Math.round(pretax * (taxRateRaw / 100) * 100) / 100;
      if (!/\+.*% tax/i.test(desc)) {
        desc = `${desc.replace(/\s*\(pre-tax[\s\S]*$/i, "").trim()} (pre-tax $${pretax.toFixed(
          2
        )} + ${taxRateRaw}% tax $${tax.toFixed(2)} = $${newAmount.toFixed(2)})`;
      }
    }

    await c.env.DB.prepare(
      `UPDATE tool_loan_charges SET amount = ?, description = ? WHERE id = ? AND IFNULL(voided, 0) = 0`
    )
      .bind(newAmount, desc, id)
      .run();

    await writeAudit(
      c.env.DB,
      user,
      "update",
      "tool_loan_charge",
      String(id),
      `amend $${oldAmount} → $${newAmount}${reason ? ` · ${reason}` : ""}`
    );

    const bal = (await balancesForPeople(c.env.DB, [before.person_id]))[0];

    return c.json({
      ok: true,
      id,
      amount_before: oldAmount,
      amount_after: newAmount,
      description: desc,
      person_id: before.person_id,
      balance_after: bal?.balance ?? null,
      weekly_after: bal ? policyWeeklyDeduction(bal.balance) : null,
      print_path: `/api/tool-loan-ledger/charges/${id}/print-agreement`,
    });
  });

  api.post("/tool-loan-ledger/payments/:id/void", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    await c.env.DB.prepare(
      `UPDATE tool_loan_payments SET voided = 1, voided_at = datetime('now'),
         voided_by_user_id = ?, void_reason = ? WHERE id = ? AND IFNULL(voided,0) = 0`
    )
      .bind(user.id, body.reason?.trim() || null, id)
      .run();
    await writeAudit(c.env.DB, user, "void", "tool_loan_payment", String(id), body.reason || "");
    return c.json({ ok: true });
  });

  /**
   * Fast Excel import: load users once, batch D1 writes.
   * Client should send chunks if needed; server handles ~1500 rows.
   */
  api.post("/tool-loan-ledger/import", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const body = await c.req.json<{
      charges?: { employee: string; description: string; date: string | number; amount: number | string }[];
      payments?: {
        employee: string;
        date: string | number;
        amount: number | string;
        payment_type?: string;
      }[];
      summary?: { employee: string; weekly_deduction?: number | string | null }[];
      mark_unmatched_former?: boolean;
    }>();

    const chargesIn = body.charges || [];
    const paymentsIn = body.payments || [];
    const summaryIn = body.summary || [];
    const markFormer = body.mark_unmatched_former !== false;

    const users = await loadUserIndex(c.env.DB);
    const existingPeople = await c.env.DB.prepare(
      `SELECT id, user_id, display_name FROM tool_loan_people`
    ).all<{ id: number; user_id: number | null; display_name: string }>();

    /** excel norm name → person_id */
    const personByKey = new Map<string, number>();
    const personByUserId = new Map<number, number>();
    for (const p of existingPeople.results || []) {
      personByKey.set(normName(p.display_name), p.id);
      if (p.user_id) personByUserId.set(p.user_id, p.id);
    }

    let peopleCreated = 0;
    const unmatchedNames = new Set<string>();

    async function ensurePerson(
      excelName: string,
      weekly?: number | null
    ): Promise<number> {
      const key = normName(excelName);
      if (personByKey.has(key)) {
        const id = personByKey.get(key)!;
        if (weekly != null && weekly > 0) {
          await c.env.DB.prepare(
            `UPDATE tool_loan_people SET weekly_deduction = ?, updated_at = datetime('now') WHERE id = ?`
          )
            .bind(weekly, id)
            .run();
        }
        return id;
      }
      const u = matchUser(users, excelName);
      if (u && personByUserId.has(u.id)) {
        const id = personByUserId.get(u.id)!;
        personByKey.set(key, id);
        if (weekly != null && weekly > 0) {
          await c.env.DB.prepare(
            `UPDATE tool_loan_people SET weekly_deduction = ?, updated_at = datetime('now') WHERE id = ?`
          )
            .bind(weekly, id)
            .run();
        }
        return id;
      }
      if (u) {
        const r = await c.env.DB.prepare(
          `INSERT INTO tool_loan_people (user_id, display_name, weekly_deduction, status)
           VALUES (?, ?, ?, 'active')`
        )
          .bind(u.id, u.display_name, weekly ?? null)
          .run();
        const id = Number(r.meta.last_row_id);
        personByKey.set(key, id);
        personByKey.set(normName(u.display_name), id);
        personByUserId.set(u.id, id);
        peopleCreated++;
        return id;
      }
      unmatchedNames.add(excelName.trim());
      const status = markFormer ? "former" : "inactive";
      const r = await c.env.DB.prepare(
        `INSERT INTO tool_loan_people (user_id, display_name, weekly_deduction, status)
         VALUES (NULL, ?, ?, ?)`
      )
        .bind(excelName.trim(), weekly ?? null, status)
        .run();
      const id = Number(r.meta.last_row_id);
      personByKey.set(key, id);
      peopleCreated++;
      return id;
    }

    // Summary first (weekly amounts + people)
    for (const s of summaryIn) {
      const name = (s.employee || "").trim();
      if (!name) continue;
      const weekly = parseMoney(s.weekly_deduction);
      await ensurePerson(name, weekly != null && weekly > 0 ? weekly : null);
    }

    // Collect unique employees from charges/payments
    for (const ch of chargesIn) {
      const name = (ch.employee || "").trim();
      if (name) await ensurePerson(name);
    }
    for (const p of paymentsIn) {
      const name = (p.employee || "").trim();
      if (name) await ensurePerson(name);
    }

    // Existing import keys (for skip)
    const existingChargeKeys = new Set<string>();
    const existingPayKeys = new Set<string>();
    const ck = await c.env.DB.prepare(
      `SELECT import_key FROM tool_loan_charges WHERE import_key IS NOT NULL`
    ).all<{ import_key: string }>();
    for (const r of ck.results || []) existingChargeKeys.add(r.import_key);
    const pk = await c.env.DB.prepare(
      `SELECT import_key FROM tool_loan_payments WHERE import_key IS NOT NULL`
    ).all<{ import_key: string }>();
    for (const r of pk.results || []) existingPayKeys.add(r.import_key);

    let chargesAdded = 0;
    let chargesSkipped = 0;
    let paymentsAdded = 0;
    let paymentsSkipped = 0;

    const chargeStmts: D1PreparedStatement[] = [];
    for (const ch of chargesIn) {
      const name = (ch.employee || "").trim();
      if (!name) continue;
      const amount = parseMoney(ch.amount);
      const date = parseDate(ch.date);
      const desc = (ch.description || "").trim() || "Loan charge";
      if (amount == null || !date) {
        chargesSkipped++;
        continue;
      }
      const personId = personByKey.get(normName(name));
      if (!personId) {
        chargesSkipped++;
        continue;
      }
      const importKey = `ch|${normName(name)}|${date}|${amount}|${normName(desc).slice(0, 80)}`;
      if (existingChargeKeys.has(importKey)) {
        chargesSkipped++;
        continue;
      }
      existingChargeKeys.add(importKey);
      chargeStmts.push(
        c.env.DB.prepare(
          `INSERT INTO tool_loan_charges
             (person_id, description, charge_date, amount, source, import_key, created_by_user_id)
           VALUES (?, ?, ?, ?, 'import', ?, ?)`
        ).bind(personId, desc, date, amount, importKey, user.id)
      );
      chargesAdded++;
    }

    const payStmts: D1PreparedStatement[] = [];
    for (const p of paymentsIn) {
      const name = (p.employee || "").trim();
      if (!name) continue;
      const amount = parseMoney(p.amount);
      const date = parseDate(p.date);
      if (amount == null || amount <= 0 || !date) {
        paymentsSkipped++;
        continue;
      }
      const ptype = ["payroll", "spiff", "other"].includes(p.payment_type || "")
        ? p.payment_type!
        : "payroll";
      const personId = personByKey.get(normName(name));
      if (!personId) {
        paymentsSkipped++;
        continue;
      }
      const importKey = `pay|${normName(name)}|${date}|${amount}|${ptype}`;
      if (existingPayKeys.has(importKey)) {
        paymentsSkipped++;
        continue;
      }
      existingPayKeys.add(importKey);
      payStmts.push(
        c.env.DB.prepare(
          `INSERT INTO tool_loan_payments
             (person_id, payment_date, amount, payment_type, source, import_key, created_by_user_id)
           VALUES (?, ?, ?, ?, 'import', ?, ?)`
        ).bind(personId, date, amount, ptype, importKey, user.id)
      );
      paymentsAdded++;
    }

    // D1 batch max ~1000 statements — chunk
    async function runBatches(stmts: D1PreparedStatement[]) {
      const size = 80;
      for (let i = 0; i < stmts.length; i += size) {
        const chunk = stmts.slice(i, i + size);
        await c.env.DB.batch(chunk);
      }
    }
    await runBatches(chargeStmts);
    await runBatches(payStmts);

    await writeAudit(
      c.env.DB,
      user,
      "import",
      "tool_loan_ledger",
      null,
      `charges +${chargesAdded} payments +${paymentsAdded}`
    );

    const summaryRows = await balancesForPeople(c.env.DB);
    const open = summaryRows.filter((r) => r.balance > 0.009);

    return c.json({
      ok: true,
      people_created: peopleCreated,
      charges_added: chargesAdded,
      charges_skipped: chargesSkipped,
      payments_added: paymentsAdded,
      payments_skipped: paymentsSkipped,
      former_or_unlinked_names: [...unmatchedNames].sort(),
      open_balances: open.length,
      total_owed: Math.round(open.reduce((s, r) => s + r.balance, 0) * 100) / 100,
    });
  });
}
