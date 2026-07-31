-- Tool loan money ledger (Phase 1): charges, payments, balances.
-- Append-only; void flags instead of DELETE. Former employees keep person rows forever.

CREATE TABLE IF NOT EXISTS tool_loan_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  display_name TEXT NOT NULL,
  weekly_deduction REAL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'former')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_loan_people_user
  ON tool_loan_people(user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tool_loan_people_name
  ON tool_loan_people(display_name);

CREATE INDEX IF NOT EXISTS idx_tool_loan_people_status
  ON tool_loan_people(status);

CREATE TABLE IF NOT EXISTS tool_loan_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES tool_loan_people(id),
  description TEXT NOT NULL,
  charge_date TEXT NOT NULL,
  amount REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  import_key TEXT,
  tool_loan_request_id INTEGER,
  created_by_user_id INTEGER REFERENCES users(id),
  voided INTEGER NOT NULL DEFAULT 0,
  voided_at TEXT,
  voided_by_user_id INTEGER REFERENCES users(id),
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_loan_charges_person
  ON tool_loan_charges(person_id, charge_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_loan_charges_import
  ON tool_loan_charges(import_key) WHERE import_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS tool_loan_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES tool_loan_people(id),
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_type TEXT NOT NULL DEFAULT 'payroll'
    CHECK (payment_type IN ('payroll', 'spiff', 'other')),
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  import_key TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  voided INTEGER NOT NULL DEFAULT 0,
  voided_at TEXT,
  voided_by_user_id INTEGER REFERENCES users(id),
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_loan_payments_person
  ON tool_loan_payments(person_id, payment_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_loan_payments_import
  ON tool_loan_payments(import_key) WHERE import_key IS NOT NULL;
