-- Pickup / transfer of custody
-- open  → list built
-- ready → warehouse handed parts to a person (they are accountable)
-- picked_up → receiver put parts on truck stock; chain locked

CREATE TABLE IF NOT EXISTS part_pickups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'ready', 'picked_up', 'cancelled')),
  requested_by_user_id INTEGER NOT NULL,
  for_user_id INTEGER,
  destination_location_id INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ready_at TEXT,
  picked_up_at TEXT,
  picked_up_by_user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Custody chain
  handed_to_user_id INTEGER,
  handed_over_by_user_id INTEGER,
  handed_over_at TEXT
);

CREATE TABLE IF NOT EXISTS part_pickup_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id INTEGER NOT NULL,
  part_id INTEGER NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  from_location_id INTEGER,
  scanned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_part_pickups_status ON part_pickups(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_part_pickup_lines ON part_pickup_lines(pickup_id);

-- If table already existed without custody columns, run:
-- ALTER TABLE part_pickups ADD COLUMN handed_to_user_id INTEGER;
-- ALTER TABLE part_pickups ADD COLUMN handed_over_by_user_id INTEGER;
-- ALTER TABLE part_pickups ADD COLUMN handed_over_at TEXT;
