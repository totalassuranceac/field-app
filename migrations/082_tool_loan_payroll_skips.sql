-- Skip one pay Friday's tool-loan payroll deduction for a person.
-- Does not void loans or delete charges — next Friday they are included again
-- unless another skip row is added.

CREATE TABLE IF NOT EXISTS tool_loan_payroll_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES tool_loan_people(id) ON DELETE CASCADE,
  pay_friday TEXT NOT NULL,
  skipped_by_user_id INTEGER REFERENCES users(id),
  skipped_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_loan_payroll_skips_person_friday
  ON tool_loan_payroll_skips(person_id, pay_friday);

CREATE INDEX IF NOT EXISTS idx_tool_loan_payroll_skips_friday
  ON tool_loan_payroll_skips(pay_friday);
