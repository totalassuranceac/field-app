-- Board-mismatch nudge, INSTALL CREWS ONLY (case a: clocked in, not on a job; case b: Dispatched, van at job).
-- user_id / lead_user_id = Field App users.id (the install crew lead).
-- File only. Do not run on production until Chris says Y.
-- Apply ONLY with:  npx wrangler d1 execute fleet_db --remote --file=migrations/108_onsite_clock_nudge.sql
-- (d1_migrations is empty, so `wrangler d1 migrations apply` would replay everything. Never use it.)
-- The worker also runs these CREATE IF NOT EXISTS on first non-off use.

-- One row per JOB ARRIVAL = lead + appointment + Chicago day (cases a and b share it).
-- At most one lead text and one Chris escalation per row.
CREATE TABLE IF NOT EXISTS fa_onsite_nudges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_user_id INTEGER NOT NULL,
  appt_id TEXT NOT NULL,
  chicago_day TEXT NOT NULL,
  case_kind TEXT,               -- case that fired first: 'day_no_job' (a) | 'dispatched_on_site' (b); NULL if closed before any mismatch
  crew TEXT NOT NULL DEFAULT 'install', -- always 'install' in this round (audit)
  crew_user_ids TEXT,           -- JSON array, lead first
  job_number TEXT,
  street TEXT,
  vehicle_id INTEGER,           -- case b
  unit_number TEXT,
  map_source TEXT,              -- 'fk_assigned' | 'fk_helper' | 'name' | 'partner'
  day_clock_source TEXT,        -- case a: 'fa_shop_session' | 'fa_job_punch'
  first_seen_at TEXT,           -- first tick the mismatch was seen (UTC ISO)
  seen_ticks INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_distance_m REAL,         -- case b
  lead_at TEXT,                 -- lead text logged (sent / would_send)
  lead_tick_count INTEGER NOT NULL DEFAULT 0, -- ticks still wrong since lead_at
  chris_at TEXT,                -- Chris escalation logged
  closed_at TEXT,               -- arrival closed for the day: seen arrived/working, FA arrive, or terminal. Never re-opens.
  resolved_at TEXT,
  resolved_by TEXT,             -- 'board_ok' | 'fa_punch' | 'terminal' (closes) ; 'left_site' resets seen only
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lead_user_id, appt_id, chicago_day)
);
CREATE INDEX IF NOT EXISTS idx_fa_onsite_nudges_day ON fa_onsite_nudges (chicago_day, resolved_at);
CREATE INDEX IF NOT EXISTS idx_fa_onsite_nudges_lead ON fa_onsite_nudges (lead_user_id, chicago_day);

-- Append-only log of every decision and send (dry or live). Repeat-offender view reads this.
CREATE TABLE IF NOT EXISTS fa_onsite_nudge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chicago_day TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'lead' | 'lead_push' | 'chris' | 'resolve' | 'skip'
  case_kind TEXT,
  lead_user_id INTEGER,
  appt_id TEXT,
  job_number TEXT,
  vehicle_id INTEGER,
  provider TEXT,
  point_at TEXT,
  distance_m REAL,
  mode TEXT NOT NULL,           -- 'dry' | 'live'
  status TEXT NOT NULL,         -- 'would_send' | 'sent' | 'failed' | 'skipped_<reason>' | 'resolved'
  to_phone_last4 TEXT,
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fa_onsite_nudge_log_day ON fa_onsite_nudge_log (chicago_day, id);
CREATE INDEX IF NOT EXISTS idx_fa_onsite_nudge_log_lead ON fa_onsite_nudge_log (lead_user_id, chicago_day);

-- Address -> point cache (geocode once, reuse forever). Only used if D4 = yes.
CREATE TABLE IF NOT EXISTS fa_onsite_geocodes (
  address_key TEXT PRIMARY KEY,
  address_text TEXT NOT NULL,
  lat REAL,
  lng REAL,
  source TEXT NOT NULL,         -- 'census' | 'manual'
  match_count INTEGER NOT NULL, -- 0 none, 1 good, >1 ambiguous (not used)
  matched_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dry-run GPS cadence sample (answers "how often do points really update"). Pruned at 14 days.
CREATE TABLE IF NOT EXISTS fa_onsite_gps_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at TEXT NOT NULL,
  vehicle_id INTEGER NOT NULL,
  provider TEXT,
  point_at TEXT,
  lat REAL,
  lng REAL,
  speed_mph REAL,
  status TEXT
);
CREATE INDEX IF NOT EXISTS idx_fa_onsite_gps_samples_v ON fa_onsite_gps_samples (vehicle_id, tick_at);
