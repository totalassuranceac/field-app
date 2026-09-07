-- Clock→ST Phase 1: local queue for Dispatch / Arrive / Complete taps.
-- Phase 1 never writes appointment status to ServiceTitan (sync_status stays queued).

CREATE TABLE IF NOT EXISTS job_clock_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  st_job_id TEXT NOT NULL,
  st_appointment_id TEXT,
  step TEXT NOT NULL CHECK (step IN ('dispatch', 'arrive', 'complete')),
  client_ts TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sync_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (sync_status IN ('queued', 'synced', 'error')),
  sync_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_clock_user_appt
  ON job_clock_events(user_id, st_appointment_id, step, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_clock_user_job
  ON job_clock_events(user_id, st_job_id, step, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_clock_sync
  ON job_clock_events(sync_status, created_at);
