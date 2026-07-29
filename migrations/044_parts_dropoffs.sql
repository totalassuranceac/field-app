-- Parts drop-off: employee brought vendor parts to the shop, ready for warehouse to put away / issue
CREATE TABLE IF NOT EXISTS parts_dropoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_name TEXT NOT NULL,
  part_summary TEXT NOT NULL,
  for_unit TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'received', 'cancelled')),
  dropped_by_user_id INTEGER REFERENCES users(id),
  received_by_user_id INTEGER REFERENCES users(id),
  received_at TEXT,
  source TEXT NOT NULL DEFAULT 'tech'
    CHECK (source IN ('office', 'tech', 'warehouse', 'other')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parts_dropoffs_status
  ON parts_dropoffs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS parts_dropoff_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dropoff_id INTEGER NOT NULL REFERENCES parts_dropoffs(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL DEFAULT 1,
  part_code TEXT,
  part_name TEXT,
  qty REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parts_dropoff_lines_dropoff
  ON parts_dropoff_lines(dropoff_id, line_no);
