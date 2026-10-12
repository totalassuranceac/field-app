-- FA Shop/Office time sessions (non-job punches).
-- V1: Field App only. Do NOT invent fake ST jobs.
-- Phase 2 (later): map to ST Non-Job Event / activity types if Gauge confirms Shop/Office/Training.

CREATE TABLE IF NOT EXISTS fa_time_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shop', 'office')),
  clock_in_at TEXT NOT NULL,
  clock_out_at TEXT,
  client_in_ts TEXT,
  client_out_ts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT,
  sync_status TEXT NOT NULL DEFAULT 'fa_only'
    CHECK (sync_status IN ('fa_only', 'queued', 'synced', 'error')),
  sync_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_fa_time_sessions_user_open
  ON fa_time_sessions(user_id, clock_out_at, clock_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_fa_time_sessions_user_day
  ON fa_time_sessions(user_id, clock_in_at DESC);

-- Dedupe clock anomaly SMS: one alert per tech + Chicago day + rule
CREATE TABLE IF NOT EXISTS fa_clock_audit_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, day, rule_key)
);

CREATE INDEX IF NOT EXISTS idx_fa_clock_audit_day
  ON fa_clock_audit_alerts(day, created_at DESC);
