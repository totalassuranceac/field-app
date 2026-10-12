-- Live inventory v1: location go-live, parts used, morning restock.
-- File only. Do not run on production until Chris says Y.
-- The worker also creates these with CREATE IF NOT EXISTS / ALTER on first use.

ALTER TABLE stock_locations ADD COLUMN counted_live_at TEXT;
ALTER TABLE stock_locations ADD COLUMN counted_by_user_id INTEGER;

ALTER TABLE stock_movements ADD COLUMN job_ref TEXT;

CREATE TABLE IF NOT EXISTS inventory_count_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL,
  part_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (location_id, part_id)
);

CREATE TABLE IF NOT EXISTS job_parts_used (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  vehicle_id INTEGER,
  location_id INTEGER NOT NULL,
  part_id INTEGER,
  other_text TEXT,
  photo_key TEXT,
  qty REAL NOT NULL,
  job_ref TEXT,
  st_appointment_id TEXT,
  status TEXT NOT NULL DEFAULT 'posted', -- posted, pending, needs_match, voided
  usage_ymd TEXT,
  client_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT,
  voided_at TEXT,
  voided_by_user_id INTEGER,
  matched_by_user_id INTEGER,
  matched_at TEXT
);

-- 0 = usage history only. The physical count already includes it. Do not change on-hand.
ALTER TABLE job_parts_used ADD COLUMN stock_applied INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_parts_used_token
  ON job_parts_used(client_token);

CREATE INDEX IF NOT EXISTS idx_job_parts_used_job
  ON job_parts_used(job_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_parts_used_usage
  ON job_parts_used(usage_ymd, vehicle_id, status);

CREATE TABLE IF NOT EXISTS truck_restocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  usage_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  filled_at TEXT,
  filled_by_user_id INTEGER,
  confirmed_at TEXT,
  confirmed_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vehicle_id, usage_date)
);

CREATE TABLE IF NOT EXISTS truck_restock_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restock_id INTEGER NOT NULL,
  part_id INTEGER,
  qty REAL NOT NULL,
  pulled INTEGER NOT NULL DEFAULT 0,
  short_qty REAL NOT NULL DEFAULT 0,
  parts_order_id INTEGER,
  other_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_truck_restock_lines_restock
  ON truck_restock_lines(restock_id);
