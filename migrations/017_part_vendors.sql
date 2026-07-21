-- Multiple vendors per part; default vendor = lowest cost among available

CREATE TABLE IF NOT EXISTS part_vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  vendor_name TEXT NOT NULL,
  vendor_part_number TEXT,
  cost REAL,
  available INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (part_id, vendor_name)
);

CREATE INDEX IF NOT EXISTS idx_part_vendors_part ON part_vendors(part_id);
CREATE INDEX IF NOT EXISTS idx_part_vendors_available ON part_vendors(part_id, available, cost);
