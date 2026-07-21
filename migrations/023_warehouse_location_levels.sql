-- Warehouse staff flag + per-location min/max (truck-specific stocking levels)
-- Note: users.role CHECK still allows admin|office|driver|mechanic|viewer only.
-- Warehouse accounts are stored as role=office + is_warehouse=1 (app maps to role "warehouse").

ALTER TABLE users ADD COLUMN is_warehouse INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS stock_location_levels (
  location_id INTEGER NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  min_qty REAL,
  max_qty REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (location_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_location_levels_part ON stock_location_levels(part_id);
