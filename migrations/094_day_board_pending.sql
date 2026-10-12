-- Day Board pending service chips (No Cool / after-hours) → approve → background ST link
CREATE TABLE IF NOT EXISTS day_board_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  tech_user_id INTEGER,
  st_technician_id INTEGER,
  display_name TEXT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  address TEXT NOT NULL,
  address_verified INTEGER NOT NULL DEFAULT 0,
  issue TEXT NOT NULL,
  window_start TEXT,
  window_end TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  st_job_id TEXT,
  st_appointment_id TEXT,
  st_job_number TEXT,
  error TEXT,
  created_by INTEGER,
  approved_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_day_board_pending_date
  ON day_board_pending(date, status);
