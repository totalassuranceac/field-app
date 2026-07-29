-- Tool loan requests: employee → office approval only
-- Rules: 10% weekly deduction (min $50), total open loans ≤ weekly pay, company/field use only
-- Product link is optional free text. manager_* columns kept for schema history only.

CREATE TABLE IF NOT EXISTS tool_loan_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  manager_user_id INTEGER REFERENCES users(id),
  item_name TEXT NOT NULL,
  item_url TEXT NOT NULL,
  amount REAL NOT NULL,
  weekly_pay REAL NOT NULL,
  purpose TEXT NOT NULL,
  disclaimer_accepted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_office'
    CHECK (status IN ('pending_manager', 'pending_office', 'approved', 'declined', 'cancelled')),
  manager_remarks TEXT,
  office_remarks TEXT,
  manager_decided_by_user_id INTEGER REFERENCES users(id),
  manager_decided_at TEXT,
  office_decided_by_user_id INTEGER REFERENCES users(id),
  office_decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_loan_user
  ON tool_loan_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_loan_status
  ON tool_loan_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_loan_manager
  ON tool_loan_requests(manager_user_id, status);
