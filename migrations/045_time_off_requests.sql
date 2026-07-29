-- Time off requests: employee → manager approval with remarks
CREATE TABLE IF NOT EXISTS time_off_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  manager_user_id INTEGER REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT 'pto'
    CHECK (request_type IN ('pto', 'sick', 'personal', 'unpaid', 'other')),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  manager_remarks TEXT,
  decided_by_user_id INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_time_off_user
  ON time_off_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_time_off_manager
  ON time_off_requests(manager_user_id, status, start_date);

CREATE INDEX IF NOT EXISTS idx_time_off_status
  ON time_off_requests(status, start_date);
