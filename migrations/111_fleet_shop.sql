-- 111_fleet_shop.sql - Fleet Shop: PM schedule, work-order extras, wrench timer, stage history.
-- FILE ONLY in the build. Run remotely only after Chris says Y, after deploy:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/111_fleet_shop.sql
-- Never `wrangler d1 migrations apply`. Save with LF line endings.
-- Additive only: no ALTER of existing tables, no data changes except INSERT OR IGNORE
-- seeds into fleet_pm_types and settings. Safe to run twice.
-- Work orders ARE vehicle_issues rows; fleet_wo_meta adds Fleet Shop fields.

CREATE TABLE IF NOT EXISTS fleet_pm_types (
  code TEXT PRIMARY KEY
    CHECK (length(code) BETWEEN 2 AND 24 AND code NOT GLOB '*[^a-z_]*'),
  label TEXT NOT NULL,
  interval_miles REAL CHECK (interval_miles IS NULL OR interval_miles > 0),
  interval_days INTEGER CHECK (interval_days IS NULL OR interval_days > 0),
  soon_miles REAL NOT NULL DEFAULT 500 CHECK (soon_miles >= 0),
  soon_days INTEGER NOT NULL DEFAULT 14 CHECK (soon_days >= 0),
  date_source TEXT NOT NULL DEFAULT 'interval'
    CHECK (date_source IN ('interval', 'registration_expires', 'inspection_expires')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by_user_id INTEGER
);

INSERT OR IGNORE INTO fleet_pm_types
  (code, label, interval_miles, interval_days, soon_miles, soon_days, date_source, sort_order)
VALUES
  ('oil',          'Oil change',            5000,  NULL, 500,  14, 'interval',             1),
  ('tires',        'Tire rotation / check', 7500,  182, 500,  14, 'interval',             2),
  ('brakes',       'Brake inspection',      15000, 365, 1000, 30, 'interval',             3),
  ('inspection',   'State inspection',      NULL,  NULL, 0,   60, 'inspection_expires',   4),
  ('registration', 'Registration',          NULL,  NULL, 0,   30, 'registration_expires', 5);

CREATE TABLE IF NOT EXISTS fleet_pm_vehicle (
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  pm_code TEXT NOT NULL REFERENCES fleet_pm_types(code),
  interval_miles REAL CHECK (interval_miles IS NULL OR interval_miles > 0),
  interval_days INTEGER CHECK (interval_days IS NULL OR interval_days > 0),
  last_done_date TEXT,
  last_done_odometer REAL CHECK (last_done_odometer IS NULL OR last_done_odometer >= 0),
  last_issue_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by_user_id INTEGER,
  PRIMARY KEY (vehicle_id, pm_code)
);

CREATE TABLE IF NOT EXISTS fleet_wo_meta (
  issue_id INTEGER PRIMARY KEY REFERENCES vehicle_issues(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  kind TEXT NOT NULL DEFAULT 'repair' CHECK (kind IN ('repair', 'pm')),
  pm_code TEXT,
  -- '<vehicle_id>:<pm_code>' while a PM work order is open; NULL once done/cancelled.
  pm_open_key TEXT UNIQUE,
  due_odometer REAL,
  due_date TEXT,
  due_reason TEXT,
  odometer_in REAL,
  odometer_out REAL,
  truck_down INTEGER NOT NULL DEFAULT 0 CHECK (truck_down IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'fleet_shop'
    CHECK (source IN ('fleet_shop', 'tech_report', 'pm_auto', 'repair_board')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind <> 'pm' OR pm_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_fleet_wo_meta_vehicle ON fleet_wo_meta (vehicle_id, kind);

CREATE TABLE IF NOT EXISTS fleet_wrench_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- This build allows only 'work_order' and 'shop' (enforced in worker/fleetShopPlan.ts).
  -- Kept open so a later type (e.g. 'warehouse', parked) needs no table rebuild.
  entry_type TEXT NOT NULL
    CHECK (length(entry_type) BETWEEN 2 AND 24 AND entry_type NOT GLOB '*[^a-z_]*'),
  issue_id INTEGER REFERENCES vehicle_issues(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  category TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
    CHECK (end_reason IS NULL OR end_reason IN ('pause', 'done', 'switch', 'clock_out', 'auto_close')),
  note TEXT,
  client_uuid TEXT UNIQUE,
  edited_by_user_id INTEGER,
  edited_at TEXT,
  edit_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (entry_type <> 'work_order' OR issue_id IS NOT NULL),
  CHECK (entry_type = 'work_order' OR issue_id IS NULL),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

-- One running timer per person.
CREATE UNIQUE INDEX IF NOT EXISTS ux_fleet_wrench_one_open
  ON fleet_wrench_segments (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fleet_wrench_user_day
  ON fleet_wrench_segments (user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_fleet_wrench_issue
  ON fleet_wrench_segments (issue_id, started_at);

CREATE TABLE IF NOT EXISTS fleet_wo_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES vehicle_issues(id),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  part_number TEXT,
  qty REAL NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_cost REAL CHECK (unit_cost IS NULL OR unit_cost >= 0),
  source TEXT NOT NULL DEFAULT 'stock' CHECK (source IN ('stock', 'bought', 'ordered')),
  parts_order_request_id INTEGER REFERENCES parts_order_requests(id),
  added_by_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at TEXT,
  removed_by_user_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fleet_wo_parts_issue ON fleet_wo_parts (issue_id);

CREATE TABLE IF NOT EXISTS fleet_wo_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES vehicle_issues(id),
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fleet_wo_notes_issue ON fleet_wo_notes (issue_id, id);

CREATE TABLE IF NOT EXISTS fleet_wo_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES vehicle_issues(id),
  photo_key TEXT NOT NULL CHECK (photo_key LIKE 'issue-photos/%'),
  stage TEXT NOT NULL DEFAULT 'during' CHECK (stage IN ('before', 'during', 'after')),
  caption TEXT,
  uploaded_by_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fleet_wo_photos_issue ON fleet_wo_photos (issue_id, id);

-- Shop-entered odometer readings (Chuck confirms the dash, or WO in/out readings).
-- A 'shop_confirm' row is an anchor: the reliable-odometer calc ignores fuel readings dated before it.
CREATE TABLE IF NOT EXISTS fleet_odometer_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  odometer REAL NOT NULL CHECK (odometer > 0),
  read_on TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('shop_confirm', 'wo_in', 'wo_out')),
  issue_id INTEGER REFERENCES vehicle_issues(id),
  user_id INTEGER NOT NULL,
  photo_key TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fleet_odo_vehicle ON fleet_odometer_readings (vehicle_id, read_on);

-- Append-only stage history for work orders (vehicle_issues). Written at each transition
-- from now on. Older rows are NOT backfilled; the worker derives their steps at read time.
CREATE TABLE IF NOT EXISTS fleet_wo_stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES vehicle_issues(id),
  stage TEXT NOT NULL CHECK (stage IN (
    'reported', 'scheduled', 'unscheduled', 'part_ordered', 'part_received',
    'started', 'paused', 'resumed', 'done', 'cancelled', 'reopened')),
  at TEXT NOT NULL,
  actor_user_id INTEGER,
  source TEXT NOT NULL
    CHECK (source IN ('fleet_shop', 'tech_report', 'pm_auto', 'repair_board', 'parts_orders')),
  parts_order_request_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fleet_wo_stage_issue ON fleet_wo_stage_events (issue_id, stage, at);
CREATE INDEX IF NOT EXISTS idx_fleet_wo_stage_actor ON fleet_wo_stage_events (actor_user_id, at);
CREATE TRIGGER IF NOT EXISTS trg_fleet_wo_stage_no_update
BEFORE UPDATE ON fleet_wo_stage_events
BEGIN
  SELECT RAISE(ABORT, 'fleet_wo_stage_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_fleet_wo_stage_no_delete
BEFORE DELETE ON fleet_wo_stage_events
BEGIN
  SELECT RAISE(ABORT, 'fleet_wo_stage_events is append-only');
END;

-- Settings (strings, like every other row in settings). Admin edits them on Fleet Shop > Settings.
INSERT OR IGNORE INTO settings (key, value) VALUES ('fleet_shop_pm_autogen', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('fleet_shop_odo_max_miles_per_day', '400');
INSERT OR IGNORE INTO settings (key, value) VALUES ('fleet_shop_odo_slack_miles', '300');
INSERT OR IGNORE INTO settings (key, value) VALUES ('fleet_shop_stats_window_days', '90');
INSERT OR IGNORE INTO settings (key, value) VALUES ('fleet_shop_age_days',
  '{"reported":[2,5],"scheduled":[3,7],"waiting_parts":[3,7],"in_progress":[2,5],"open_total":[7,14],"step_report_scheduled":[2,5],"step_part_ordered_received":[3,7],"step_report_done":[7,14]}');
