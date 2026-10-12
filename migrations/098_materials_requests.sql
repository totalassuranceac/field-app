-- Tomorrow materials pull requests (header + lines). No ST parts writes.
CREATE TABLE IF NOT EXISTS materials_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_date TEXT NOT NULL,
  address_text TEXT NOT NULL,
  job_id TEXT,
  tech_user_ids TEXT NOT NULL,
  tech_names_text TEXT,
  status TEXT NOT NULL DEFAULT 'needed',
  created_by_user_id INTEGER NOT NULL,
  ready_by_user_id INTEGER,
  ready_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS materials_request_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES materials_requests(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mat_req_date_status
  ON materials_requests(appointment_date, status);
