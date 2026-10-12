-- Add bereavement to time_off_requests.request_type CHECK (no bank deduction; same as unpaid/other).
-- SQLite cannot ALTER CHECK in place — rebuild table. pto_ledger FKs stay valid by table name after rename.

PRAGMA foreign_keys = OFF;

CREATE TABLE time_off_requests_091 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  manager_user_id INTEGER REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT 'pto'
    CHECK (request_type IN ('pto', 'sick', 'personal', 'unpaid', 'other', 'bereavement')),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  manager_remarks TEXT,
  decided_by_user_id INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  usage_status TEXT,
  hours_deducted REAL,
  hours_actual REAL,
  usage_confirmed_at TEXT,
  usage_confirmed_by_user_id INTEGER,
  usage_note TEXT
);

INSERT INTO time_off_requests_091 (
  id, user_id, manager_user_id, start_date, end_date, request_type, reason, status,
  manager_remarks, decided_by_user_id, decided_at, created_at, updated_at,
  usage_status, hours_deducted, hours_actual, usage_confirmed_at,
  usage_confirmed_by_user_id, usage_note
)
SELECT
  id, user_id, manager_user_id, start_date, end_date, request_type, reason, status,
  manager_remarks, decided_by_user_id, decided_at, created_at, updated_at,
  usage_status, hours_deducted, hours_actual, usage_confirmed_at,
  usage_confirmed_by_user_id, usage_note
FROM time_off_requests;

DROP TABLE time_off_requests;
ALTER TABLE time_off_requests_091 RENAME TO time_off_requests;

CREATE INDEX IF NOT EXISTS idx_time_off_user
  ON time_off_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_off_manager
  ON time_off_requests(manager_user_id, status, start_date);
CREATE INDEX IF NOT EXISTS idx_time_off_status
  ON time_off_requests(status, start_date);
CREATE INDEX IF NOT EXISTS idx_time_off_usage
  ON time_off_requests(usage_status, start_date);

PRAGMA foreign_keys = ON;
