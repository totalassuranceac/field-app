-- Company-owned assets outside ServiceTitan pricebook
-- Bottles: full/empty counts per location (O2, N2, acetylene)
-- Equipment: individual ladders, dollies, tools with condition history

CREATE TABLE IF NOT EXISTS bottle_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bottle_balances (
  location_id INTEGER NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
  bottle_type_id INTEGER NOT NULL REFERENCES bottle_types(id) ON DELETE CASCADE,
  full_qty INTEGER NOT NULL DEFAULT 0,
  empty_qty INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (location_id, bottle_type_id),
  CHECK (full_qty >= 0 AND empty_qty >= 0)
);

CREATE TABLE IF NOT EXISTS bottle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bottle_type_id INTEGER NOT NULL REFERENCES bottle_types(id),
  event_type TEXT NOT NULL DEFAULT 'adjust'
    CHECK (event_type IN ('swap', 'adjust', 'set')),
  from_location_id INTEGER REFERENCES stock_locations(id),
  to_location_id INTEGER REFERENCES stock_locations(id),
  full_delta INTEGER NOT NULL DEFAULT 0,
  empty_delta INTEGER NOT NULL DEFAULT 0,
  tech_user_id INTEGER REFERENCES users(id),
  notes TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bottle_events_created ON bottle_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bottle_events_type ON bottle_events(bottle_type_id, created_at DESC);

CREATE TABLE IF NOT EXISTS company_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_tag TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'tool'
    CHECK (category IN ('ladder', 'dolly', 'tool', 'other')),
  subcategory TEXT,
  serial_number TEXT,
  manufacturer TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'in_service'
    CHECK (status IN ('in_service', 'repair', 'retired', 'missing')),
  location_id INTEGER REFERENCES stock_locations(id),
  condition TEXT NOT NULL DEFAULT 'good'
    CHECK (condition IN ('excellent', 'good', 'fair', 'poor', 'damaged', 'out_of_service')),
  condition_date TEXT,
  condition_notes TEXT,
  issued_at TEXT,
  issued_to_user_id INTEGER REFERENCES users(id),
  photo_key TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_assets_tag
  ON company_assets(asset_tag) WHERE asset_tag IS NOT NULL AND asset_tag != '';
CREATE INDEX IF NOT EXISTS idx_company_assets_cat ON company_assets(category, status);
CREATE INDEX IF NOT EXISTS idx_company_assets_loc ON company_assets(location_id);

CREATE TABLE IF NOT EXISTS company_asset_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES company_assets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('issue', 'return', 'transfer', 'condition', 'damage', 'note', 'status', 'create')),
  from_location_id INTEGER REFERENCES stock_locations(id),
  to_location_id INTEGER REFERENCES stock_locations(id),
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  condition_before TEXT,
  condition_after TEXT,
  notes TEXT,
  photo_key TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_company_asset_events_asset
  ON company_asset_events(asset_id, created_at DESC);

-- Seed gas bottle types (idempotent)
INSERT OR IGNORE INTO bottle_types (code, name, sort_order) VALUES
  ('O2', 'Oxygen', 1),
  ('N2', 'Nitrogen', 2),
  ('ACE', 'Acetylene', 3);
