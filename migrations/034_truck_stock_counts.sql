-- Initial / periodic truck stock counts (tech fills, warehouse applies)
-- not_needed = tech has no room / won't use this part on their truck

CREATE TABLE IF NOT EXISTS truck_stock_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  location_id INTEGER NOT NULL REFERENCES stock_locations(id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'submitted', 'applied', 'cancelled')),
  created_by_user_id INTEGER REFERENCES users(id),
  counted_by_user_id INTEGER REFERENCES users(id),
  signed_name TEXT,
  signed_at TEXT,
  accuracy_confirmed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  applied_at TEXT,
  applied_by_user_id INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_truck_stock_counts_status
  ON truck_stock_counts(status, vehicle_id);

CREATE INDEX IF NOT EXISTS idx_truck_stock_counts_vehicle
  ON truck_stock_counts(vehicle_id, created_at DESC);

CREATE TABLE IF NOT EXISTS truck_stock_count_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id INTEGER NOT NULL REFERENCES truck_stock_counts(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES parts(id),
  part_code TEXT,
  part_name TEXT NOT NULL,
  system_qty REAL NOT NULL DEFAULT 0,
  counted_qty REAL,
  not_needed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (count_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_truck_stock_count_lines_count
  ON truck_stock_count_lines(count_id, sort_order, part_name);
