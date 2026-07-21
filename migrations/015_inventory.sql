-- Multi-location inventory (ServiceTitan pricebook catalog + on-hand by location)

CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_st_id TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description_text TEXT,
  category TEXT,
  cost REAL,
  price REAL,
  unit_of_measure TEXT,
  is_inventory INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  primary_vendor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_code ON parts(code);
CREATE INDEX IF NOT EXISTS idx_parts_external ON parts(external_st_id);
CREATE INDEX IF NOT EXISTS idx_parts_name ON parts(name);
CREATE INDEX IF NOT EXISTS idx_parts_category ON parts(category);

CREATE TABLE IF NOT EXISTS stock_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('warehouse', 'attic', 'vehicle')),
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (type, vehicle_id)
);

CREATE TABLE IF NOT EXISTS stock_balances (
  location_id INTEGER NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  qty REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (location_id, part_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL REFERENCES parts(id),
  from_location_id INTEGER REFERENCES stock_locations(id),
  to_location_id INTEGER REFERENCES stock_locations(id),
  qty REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT 'adjust',
  notes TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_part ON stock_movements(part_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_balances_part ON stock_balances(part_id);
