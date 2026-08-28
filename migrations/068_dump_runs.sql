-- Dump / landfill ticket logs (warehouse + mechanic)
CREATE TABLE IF NOT EXISTS dump_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dump_date TEXT NOT NULL,
  net_weight_lbs REAL NOT NULL,
  total_amount REAL NOT NULL,
  notes TEXT,
  receipt_key TEXT NOT NULL,
  ocr_raw_text TEXT,
  logged_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dump_runs_date ON dump_runs(dump_date);
CREATE INDEX IF NOT EXISTS idx_dump_runs_created ON dump_runs(created_at);
