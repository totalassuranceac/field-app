-- Parts Ready: materials flagged on a job, staged the day before
CREATE TABLE IF NOT EXISTS job_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  job_number TEXT,
  customer_name TEXT,
  address TEXT,
  appointment_date TEXT,
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'needed',
  note TEXT,
  created_by TEXT,
  staged_by TEXT,
  staged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_materials_date_status
  ON job_materials(appointment_date, status);
CREATE INDEX IF NOT EXISTS idx_job_materials_job ON job_materials(job_id);
