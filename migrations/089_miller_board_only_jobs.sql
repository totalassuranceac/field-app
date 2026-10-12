-- Miller Not listed jobs: Day Board only, never ServiceTitan.
CREATE TABLE IF NOT EXISTS miller_board_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  address TEXT NOT NULL,
  customer_name TEXT,
  job_type_name TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  technician_ids TEXT NOT NULL,
  tech_labels TEXT,
  note TEXT,
  location_id INTEGER,
  customer_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_miller_board_jobs_date
  ON miller_board_jobs(work_date, active);
