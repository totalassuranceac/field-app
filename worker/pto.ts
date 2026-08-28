/**
 * PTO / sick banks — hire date, anniversary grants, negatives allowed.
 * Policy mirrors Total Assurance PTO Tracker spreadsheet.
 */

export type PtoKind = "vacation" | "sick";

export type PtoBalanceRow = {
  employee_id: number;
  vacation_entitlement_hours: number;
  vacation_used_hours: number;
  sick_entitlement_hours: number;
  sick_used_hours: number;
  last_anniversary_applied: string | null;
  updated_at?: string;
};

export type EmployeePtoProfile = {
  id: number;
  name: string;
  active: number;
  hire_date: string | null;
  birthday_md: string | null;
  separation_date?: string | null;
  original_hire_date?: string | null;
};

/**
 * Days away before a return counts as a new hire for PTO / years of service.
 * Under this: keep prior hire_date + banks. At/over this: restart from rehire date.
 */
export const PTO_REHIRE_BREAK_DAYS = 90;

/** Calendar days from `fromIso` to `toIso` (can be negative if to < from). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T12:00:00Z");
  const b = Date.parse(toIso + "T12:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

export function shouldRestartPtoOnRehire(
  separationDateIso: string | null | undefined,
  rehireDateIso: string,
  breakDays = PTO_REHIRE_BREAK_DAYS
): { restart: boolean; gap_days: number | null; reason: string } {
  if (!separationDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(separationDateIso)) {
    return {
      restart: true,
      gap_days: null,
      reason: "No separation date on file — treating return as a new hire for PTO",
    };
  }
  const gap = daysBetweenIso(separationDateIso, rehireDateIso);
  if (gap >= breakDays) {
    return {
      restart: true,
      gap_days: gap,
      reason: `Away ${gap} days (≥ ${breakDays}) — PTO restarts from rehire date`,
    };
  }
  return {
    restart: false,
    gap_days: gap,
    reason: `Away ${gap} days (< ${breakDays}) — keep prior hire date and PTO banks`,
  };
}

/** Completed years of service as of `asOf` (YYYY-MM-DD). */
export function completedYearsOfService(
  hireDateIso: string | null | undefined,
  asOfIso: string
): number {
  if (!hireDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(hireDateIso)) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfIso)) return 0;
  const [hy, hm, hd] = hireDateIso.split("-").map(Number);
  const [ay, am, ad] = asOfIso.split("-").map(Number);
  let years = ay - hy;
  if (am < hm || (am === hm && ad < hd)) years -= 1;
  return Math.max(0, years);
}

/** Vacation / sick entitlement hours for completed years. */
export function entitlementForYears(years: number): {
  vacation: number;
  sick: number;
} {
  if (years < 1) return { vacation: 0, sick: 0 };
  if (years <= 2) return { vacation: 40, sick: 40 };
  if (years <= 4) return { vacation: 80, sick: 40 };
  return { vacation: 120, sick: 40 };
}

export function localIsoDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Next anniversary on or after asOf (hire month/day). */
export function nextAnniversary(
  hireDateIso: string | null | undefined,
  asOfIso: string
): string | null {
  if (!hireDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(hireDateIso)) return null;
  const [, hm, hd] = hireDateIso.split("-");
  const [ay] = asOfIso.split("-").map(Number);
  let cand = `${ay}-${hm}-${hd}`;
  if (cand < asOfIso) cand = `${ay + 1}-${hm}-${hd}`;
  return cand;
}

export function lastAnniversary(
  hireDateIso: string | null | undefined,
  asOfIso: string
): string | null {
  if (!hireDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(hireDateIso)) return null;
  const [hy, hm, hd] = hireDateIso.split("-").map(Number);
  const [ay] = asOfIso.split("-").map(Number);
  const md = `${String(hm).padStart(2, "0")}-${String(hd).padStart(2, "0")}`;
  let y = ay;
  let cand = `${y}-${md}`;
  if (cand > asOfIso) y -= 1;
  cand = `${y}-${md}`;
  // Before first anniversary → no "last" grant year yet (use hire date)
  if (cand < hireDateIso) return hireDateIso;
  // If asOf is before first anniversary occurrence
  const firstAnn = `${hy + 1}-${md}`;
  if (asOfIso < firstAnn) return hireDateIso;
  return cand;
}

/** Normalize birthday from sheet "12/28" or "01-27" → "MM-DD" */
export function normalizeBirthdayMd(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-]\d{2,4})?$/);
  if (!m) return null;
  const mm = String(Number(m[1])).padStart(2, "0");
  const dd = String(Number(m[2])).padStart(2, "0");
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${mm}-${dd}`;
}

/** Parse sheet dates like 07/29/2024 or 5/4/2026 → ISO */
export function parseFlexibleDate(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const mm = String(Number(m[1])).padStart(2, "0");
  const dd = String(Number(m[2])).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

export function calendarDaysInclusive(startIso: string, endIso: string): number {
  const a = Date.parse(startIso + "T12:00:00Z");
  const b = Date.parse(endIso + "T12:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

export function hoursForDateRange(startIso: string, endIso: string, hoursPerDay = 8): number {
  return calendarDaysInclusive(startIso, endIso) * hoursPerDay;
}

export async function ensurePtoTables(db: D1Database): Promise<void> {
  const stmts = [
    `ALTER TABLE employees ADD COLUMN hire_date TEXT`,
    `ALTER TABLE employees ADD COLUMN birthday_md TEXT`,
    `ALTER TABLE employees ADD COLUMN separation_date TEXT`,
    `ALTER TABLE employees ADD COLUMN original_hire_date TEXT`,
    `CREATE TABLE IF NOT EXISTS pto_balances (
      employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      vacation_entitlement_hours REAL NOT NULL DEFAULT 0,
      vacation_used_hours REAL NOT NULL DEFAULT 0,
      sick_entitlement_hours REAL NOT NULL DEFAULT 0,
      sick_used_hours REAL NOT NULL DEFAULT 0,
      last_anniversary_applied TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS pto_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      entry_date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('vacation', 'sick')),
      hours REAL NOT NULL,
      source TEXT NOT NULL
        CHECK (source IN ('request_approved', 'anniversary_grant', 'manual', 'import')),
      time_off_request_id INTEGER,
      note TEXT,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pto_ledger_employee ON pto_ledger(employee_id, entry_date DESC, id DESC)`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* column/table may already exist */
    }
  }
}

async function getBalance(
  db: D1Database,
  employeeId: number
): Promise<PtoBalanceRow | null> {
  return db
    .prepare(`SELECT * FROM pto_balances WHERE employee_id = ?`)
    .bind(employeeId)
    .first<PtoBalanceRow>();
}

async function upsertBalance(
  db: D1Database,
  row: {
    employee_id: number;
    vacation_entitlement_hours: number;
    vacation_used_hours: number;
    sick_entitlement_hours: number;
    sick_used_hours: number;
    last_anniversary_applied: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pto_balances (
         employee_id, vacation_entitlement_hours, vacation_used_hours,
         sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(employee_id) DO UPDATE SET
         vacation_entitlement_hours = excluded.vacation_entitlement_hours,
         vacation_used_hours = excluded.vacation_used_hours,
         sick_entitlement_hours = excluded.sick_entitlement_hours,
         sick_used_hours = excluded.sick_used_hours,
         last_anniversary_applied = excluded.last_anniversary_applied,
         updated_at = datetime('now')`
    )
    .bind(
      row.employee_id,
      row.vacation_entitlement_hours,
      row.vacation_used_hours,
      row.sick_entitlement_hours,
      row.sick_used_hours,
      row.last_anniversary_applied
    )
    .run();
}

export async function writePtoLedger(
  db: D1Database,
  entry: {
    employee_id: number;
    entry_date: string;
    kind: PtoKind;
    hours: number;
    source: "request_approved" | "anniversary_grant" | "manual" | "import";
    time_off_request_id?: number | null;
    note?: string | null;
    created_by_user_id?: number | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pto_ledger (
         employee_id, entry_date, kind, hours, source,
         time_off_request_id, note, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.employee_id,
      entry.entry_date,
      entry.kind,
      entry.hours,
      entry.source,
      entry.time_off_request_id ?? null,
      entry.note ?? null,
      entry.created_by_user_id ?? null
    )
    .run();
}

/**
 * If an anniversary is due and not yet applied, refresh entitlements and clear used.
 * Called on board reads and daily cron — automatic, no button.
 */
export async function applyDueAnniversary(
  db: D1Database,
  employeeId: number,
  hireDate: string | null,
  asOfIso = localIsoDate()
): Promise<{ applied: boolean; anniversary?: string }> {
  if (!hireDate) return { applied: false };
  const years = completedYearsOfService(hireDate, asOfIso);
  // First anniversary = hire + 1 year; only grant when years >= 1
  if (years < 1) {
    // Ensure zero banks exist
    const bal = await getBalance(db, employeeId);
    if (!bal) {
      await upsertBalance(db, {
        employee_id: employeeId,
        vacation_entitlement_hours: 0,
        vacation_used_hours: 0,
        sick_entitlement_hours: 0,
        sick_used_hours: 0,
        last_anniversary_applied: null,
      });
    }
    return { applied: false };
  }

  const lastAnn = lastAnniversary(hireDate, asOfIso);
  if (!lastAnn || lastAnn === hireDate) return { applied: false };

  const bal = await getBalance(db, employeeId);
  const already = bal?.last_anniversary_applied || "";
  if (already >= lastAnn) return { applied: false };

  const ent = entitlementForYears(years);
  const prevVacUsed = Number(bal?.vacation_used_hours || 0);
  const prevSickUsed = Number(bal?.sick_used_hours || 0);

  await upsertBalance(db, {
    employee_id: employeeId,
    vacation_entitlement_hours: ent.vacation,
    vacation_used_hours: 0,
    sick_entitlement_hours: ent.sick,
    sick_used_hours: 0,
    last_anniversary_applied: lastAnn,
  });

  // Ledger: anniversary grant (credit equal to clearing prior used + documenting new bank)
  await writePtoLedger(db, {
    employee_id: employeeId,
    entry_date: lastAnn,
    kind: "vacation",
    hours: -prevVacUsed,
    source: "anniversary_grant",
    note: `Anniversary ${lastAnn}: vacation reset (was used ${prevVacUsed}h) → ${ent.vacation}h entitlement`,
  });
  await writePtoLedger(db, {
    employee_id: employeeId,
    entry_date: lastAnn,
    kind: "sick",
    hours: -prevSickUsed,
    source: "anniversary_grant",
    note: `Anniversary ${lastAnn}: sick reset (was used ${prevSickUsed}h) → ${ent.sick}h entitlement`,
  });

  return { applied: true, anniversary: lastAnn };
}

export async function applyDueAnniversariesAll(
  db: D1Database,
  asOfIso = localIsoDate()
): Promise<number> {
  await ensurePtoTables(db);
  const rows = await db
    .prepare(
      `SELECT id, hire_date FROM employees WHERE active = 1 AND hire_date IS NOT NULL AND trim(hire_date) != ''`
    )
    .all<{ id: number; hire_date: string }>();
  let n = 0;
  for (const e of rows.results || []) {
    const r = await applyDueAnniversary(db, e.id, e.hire_date, asOfIso);
    if (r.applied) n += 1;
  }
  return n;
}

export type RehireTransitionResult = {
  restart: boolean;
  gap_days: number | null;
  message: string;
  hire_date: string | null;
  separation_date: string | null;
  original_hire_date: string | null;
};

/**
 * Apply leave / rehire side effects for PTO.
 * - Deactivate: stamp separation_date (banks kept for history).
 * - Reactivate after ≥90 days (or unknown gap): hire_date → rehire date, banks → 0.
 * - Reactivate under 90 days: keep hire_date + banks; clear separation_date.
 */
export async function applyLeaveOrRehireTransition(
  db: D1Database,
  opts: {
    employee_id: number;
    was_active: boolean;
    will_be_active: boolean;
    current_hire_date: string | null;
    current_original_hire_date: string | null;
    current_separation_date: string | null;
    /** Last day worked / leave date when deactivating */
    separation_date?: string | null;
    /** First day back when reactivating (defaults to today) */
    rehire_date?: string | null;
    created_by_user_id?: number | null;
    /** Admin override: force restart even if gap &lt; 90 */
    force_restart?: boolean;
    /** Admin override: force keep prior seniority even if gap ≥ 90 */
    force_keep?: boolean;
  }
): Promise<RehireTransitionResult | null> {
  await ensurePtoTables(db);
  const asOf = localIsoDate();

  // Leaving
  if (opts.was_active && !opts.will_be_active) {
    const sep =
      parseFlexibleDate(opts.separation_date) ||
      (opts.separation_date && /^\d{4}-\d{2}-\d{2}$/.test(opts.separation_date)
        ? opts.separation_date
        : null) ||
      asOf;
    await db
      .prepare(
        `UPDATE employees SET separation_date = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(sep, opts.employee_id)
      .run();
    return {
      restart: false,
      gap_days: null,
      message: `Marked inactive · separation ${sep} (PTO banks kept; rehire after ${PTO_REHIRE_BREAK_DAYS}+ days restarts from new hire date)`,
      hire_date: opts.current_hire_date,
      separation_date: sep,
      original_hire_date: opts.current_original_hire_date,
    };
  }

  // Returning
  if (!opts.was_active && opts.will_be_active) {
    const rehire =
      parseFlexibleDate(opts.rehire_date) ||
      (opts.rehire_date && /^\d{4}-\d{2}-\d{2}$/.test(opts.rehire_date)
        ? opts.rehire_date
        : null) ||
      asOf;
    let decision = shouldRestartPtoOnRehire(opts.current_separation_date, rehire);
    if (opts.force_restart) {
      decision = {
        restart: true,
        gap_days: decision.gap_days,
        reason: `Forced restart · ${decision.reason}`,
      };
    } else if (opts.force_keep) {
      decision = {
        restart: false,
        gap_days: decision.gap_days,
        reason: `Forced keep seniority · ${decision.reason}`,
      };
    }

    if (decision.restart) {
      const original =
        opts.current_original_hire_date || opts.current_hire_date || null;
      await db
        .prepare(
          `UPDATE employees SET
             hire_date = ?,
             original_hire_date = COALESCE(original_hire_date, ?),
             separation_date = NULL,
             updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(rehire, original, opts.employee_id)
        .run();

      const bal = await getBalance(db, opts.employee_id);
      const prevVac = Number(bal?.vacation_used_hours || 0);
      const prevSick = Number(bal?.sick_used_hours || 0);
      await upsertBalance(db, {
        employee_id: opts.employee_id,
        vacation_entitlement_hours: 0,
        vacation_used_hours: 0,
        sick_entitlement_hours: 0,
        sick_used_hours: 0,
        last_anniversary_applied: null,
      });
      await writePtoLedger(db, {
        employee_id: opts.employee_id,
        entry_date: rehire,
        kind: "vacation",
        hours: -prevVac,
        source: "manual",
        note: `Rehire restart · ${decision.reason} · hire ${rehire} (prior used ${prevVac}h cleared)`,
        created_by_user_id: opts.created_by_user_id ?? null,
      });
      await writePtoLedger(db, {
        employee_id: opts.employee_id,
        entry_date: rehire,
        kind: "sick",
        hours: -prevSick,
        source: "manual",
        note: `Rehire restart · ${decision.reason} · hire ${rehire} (prior used ${prevSick}h cleared)`,
        created_by_user_id: opts.created_by_user_id ?? null,
      });

      return {
        restart: true,
        gap_days: decision.gap_days,
        message: decision.reason,
        hire_date: rehire,
        separation_date: null,
        original_hire_date: original,
      };
    }

    // Keep seniority — clear separation only
    await db
      .prepare(
        `UPDATE employees SET separation_date = NULL, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(opts.employee_id)
      .run();
    return {
      restart: false,
      gap_days: decision.gap_days,
      message: decision.reason,
      hire_date: opts.current_hire_date,
      separation_date: null,
      original_hire_date: opts.current_original_hire_date,
    };
  }

  return null;
}

export function boardRowFrom(
  emp: EmployeePtoProfile,
  bal: PtoBalanceRow | null,
  asOfIso: string
) {
  const hire = emp.hire_date;
  const years = completedYearsOfService(hire, asOfIso);
  const vacEnt = Number(bal?.vacation_entitlement_hours ?? 0);
  const vacUsed = Number(bal?.vacation_used_hours ?? 0);
  const sickEnt = Number(bal?.sick_entitlement_hours ?? 0);
  const sickUsed = Number(bal?.sick_used_hours ?? 0);
  return {
    employee_id: emp.id,
    name: emp.name,
    active: emp.active,
    hire_date: hire,
    birthday_md: emp.birthday_md,
    years_of_service: years,
    last_anniversary: lastAnniversary(hire, asOfIso),
    next_anniversary: nextAnniversary(hire, asOfIso),
    vacation_entitlement: vacEnt,
    vacation_used: vacUsed,
    vacation_balance: vacEnt - vacUsed,
    sick_entitlement: sickEnt,
    sick_used: sickUsed,
    sick_balance: sickEnt - sickUsed,
    last_anniversary_applied: bal?.last_anniversary_applied ?? null,
  };
}

/** Deduct hours after approved time-off (allows negative balance). */
export async function deductForApprovedRequest(
  db: D1Database,
  opts: {
    employee_id: number;
    kind: PtoKind;
    hours: number;
    entry_date: string;
    time_off_request_id: number;
    note?: string;
    created_by_user_id?: number | null;
  }
): Promise<{ vacation_balance: number; sick_balance: number }> {
  await ensurePtoTables(db);
  const emp = await db
    .prepare(`SELECT id, name, active, hire_date, birthday_md FROM employees WHERE id = ?`)
    .bind(opts.employee_id)
    .first<EmployeePtoProfile>();
  if (emp?.hire_date) {
    await applyDueAnniversary(db, emp.id, emp.hire_date);
  }
  let bal = await getBalance(db, opts.employee_id);
  if (!bal) {
    const years = completedYearsOfService(emp?.hire_date, localIsoDate());
    const ent = entitlementForYears(years);
    await upsertBalance(db, {
      employee_id: opts.employee_id,
      vacation_entitlement_hours: ent.vacation,
      vacation_used_hours: 0,
      sick_entitlement_hours: ent.sick,
      sick_used_hours: 0,
      last_anniversary_applied: years >= 1 ? lastAnniversary(emp?.hire_date, localIsoDate()) : null,
    });
    bal = await getBalance(db, opts.employee_id);
  }
  const vacUsed =
    Number(bal!.vacation_used_hours) + (opts.kind === "vacation" ? opts.hours : 0);
  const sickUsed =
    Number(bal!.sick_used_hours) + (opts.kind === "sick" ? opts.hours : 0);
  await upsertBalance(db, {
    employee_id: opts.employee_id,
    vacation_entitlement_hours: Number(bal!.vacation_entitlement_hours),
    vacation_used_hours: vacUsed,
    sick_entitlement_hours: Number(bal!.sick_entitlement_hours),
    sick_used_hours: sickUsed,
    last_anniversary_applied: bal!.last_anniversary_applied,
  });
  await writePtoLedger(db, {
    employee_id: opts.employee_id,
    entry_date: opts.entry_date,
    kind: opts.kind,
    hours: opts.hours,
    source: "request_approved",
    time_off_request_id: opts.time_off_request_id,
    note: opts.note || null,
    created_by_user_id: opts.created_by_user_id ?? null,
  });
  return {
    vacation_balance: Number(bal!.vacation_entitlement_hours) - vacUsed,
    sick_balance: Number(bal!.sick_entitlement_hours) - sickUsed,
  };
}

export type UpcomingEvent = {
  employee_id: number;
  name: string;
  event_type: "birthday" | "anniversary";
  date: string;
  years_of_service?: number;
};

/** Events in the upcoming calendar month (and rest of current month). */
export function upcomingRecognition(
  employees: EmployeePtoProfile[],
  asOfIso = localIsoDate()
): UpcomingEvent[] {
  const [ay, am] = asOfIso.split("-").map(Number);
  const out: UpcomingEvent[] = [];
  for (const e of employees) {
    if (!e.active) continue;
    if (e.birthday_md) {
      const [bm, bd] = e.birthday_md.split("-").map(Number);
      let y = ay;
      let d = `${y}-${String(bm).padStart(2, "0")}-${String(bd).padStart(2, "0")}`;
      if (d < asOfIso) {
        y += 1;
        d = `${y}-${String(bm).padStart(2, "0")}-${String(bd).padStart(2, "0")}`;
      }
      // Include if within ~45 days (this month remainder + next month)
      const limit = new Date(asOfIso + "T12:00:00Z");
      limit.setUTCDate(limit.getUTCDate() + 45);
      const limIso = limit.toISOString().slice(0, 10);
      if (d <= limIso) {
        out.push({
          employee_id: e.id,
          name: e.name,
          event_type: "birthday",
          date: d,
        });
      }
    }
    if (e.hire_date) {
      const next = nextAnniversary(e.hire_date, asOfIso);
      if (next) {
        const limit = new Date(asOfIso + "T12:00:00Z");
        limit.setUTCDate(limit.getUTCDate() + 45);
        const limIso = limit.toISOString().slice(0, 10);
        if (next <= limIso) {
          const yrs = completedYearsOfService(e.hire_date, next);
          out.push({
            employee_id: e.id,
            name: e.name,
            event_type: "anniversary",
            date: next,
            years_of_service: yrs,
          });
        }
      }
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return out;
}
