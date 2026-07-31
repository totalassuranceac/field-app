/**
 * Tool loan money ledger — Phase 1 (office/admin).
 * Balances = sum(charges) - sum(payments); never delete financial rows (void only).
 */
import type { Hono } from "hono";
import type { Env, PublicUser, Variables } from "./types";
import { writeAudit } from "./audit";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

/** Excel display name → preferred app display_name (confirmed map). */
const EXCEL_NAME_ALIASES: Record<string, string> = {
  "bianca ramirez": "Bianca",
  "charles beard": "CharlesBeard",
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

/** Tables are created by migration 052 — skip DDL on every request (was risking hangs). */
export async function ensureToolLoanLedgerTables(_db: D1Database): Promise<void> {
  return;
}

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

  api.post("/tool-loan-ledger/charges", async (c) => {
    const user = c.get("user");
    const denied = requireOffice(user);
    if (denied) return denied;
    await ensureToolLoanLedgerTables(c.env.DB);
    const body = await c.req.json<{
      person_id?: number;
      description?: string;
      charge_date?: string;
      amount?: number | string;
    }>();
    const personId = Number(body.person_id);
    const amount = parseMoney(body.amount);
    const date = parseDate(body.charge_date) || new Date().toISOString().slice(0, 10);
    const desc = (body.description || "").trim();
    if (!personId || !desc || amount == null) {
      return c.json({ error: "person_id, description, and amount required" }, 400);
    }
    const r = await c.env.DB.prepare(
      `INSERT INTO tool_loan_charges
         (person_id, description, charge_date, amount, source, created_by_user_id)
       VALUES (?, ?, ?, ?, 'manual', ?)`
    )
      .bind(personId, desc, date, amount, user.id)
      .run();
    await writeAudit(
      c.env.DB,
      user,
      "create",
      "tool_loan_charge",
      String(r.meta.last_row_id),
      `${desc} $${amount}`
    );
    return c.json({ id: Number(r.meta.last_row_id), ok: true });
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
    }>();
    const personId = Number(body.person_id);
    const amount = parseMoney(body.amount);
    const date = parseDate(body.payment_date) || new Date().toISOString().slice(0, 10);
    const ptype = ["payroll", "spiff", "other"].includes(body.payment_type || "")
      ? body.payment_type!
      : "payroll";
    if (!personId || amount == null || amount <= 0) {
      return c.json({ error: "person_id and positive amount required" }, 400);
    }
    const r = await c.env.DB.prepare(
      `INSERT INTO tool_loan_payments
         (person_id, payment_date, amount, payment_type, note, source, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'manual', ?)`
    )
      .bind(personId, date, amount, ptype, body.note?.trim() || null, user.id)
      .run();
    await writeAudit(
      c.env.DB,
      user,
      "create",
      "tool_loan_payment",
      String(r.meta.last_row_id),
      `${ptype} $${amount}`
    );
    return c.json({ id: Number(r.meta.last_row_id), ok: true });
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
