-- PTO / sick balances from hire date + anniversary grants (sheet parity)
-- Negatives allowed (used can exceed entitlement until next anniversary reset)

ALTER TABLE employees ADD COLUMN hire_date TEXT;
ALTER TABLE employees ADD COLUMN birthday_md TEXT;

CREATE TABLE IF NOT EXISTS pto_balances (
  employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  vacation_entitlement_hours REAL NOT NULL DEFAULT 0,
  vacation_used_hours REAL NOT NULL DEFAULT 0,
  sick_entitlement_hours REAL NOT NULL DEFAULT 0,
  sick_used_hours REAL NOT NULL DEFAULT 0,
  last_anniversary_applied TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pto_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('vacation', 'sick')),
  -- Positive = hours used / deducted from bank; negative = credit
  hours REAL NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('request_approved', 'anniversary_grant', 'manual', 'import')),
  time_off_request_id INTEGER REFERENCES time_off_requests(id),
  note TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pto_ledger_employee
  ON pto_ledger(employee_id, entry_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_employees_hire
  ON employees(hire_date);

CREATE INDEX IF NOT EXISTS idx_employees_birthday
  ON employees(birthday_md);
