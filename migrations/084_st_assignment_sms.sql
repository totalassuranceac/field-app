-- After-4pm ServiceTitan assignment SMS tracking (dedupe + poll snapshot).
-- No customer texts. Tech Field App phone only.

CREATE TABLE IF NOT EXISTS st_assignment_sms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  st_job_id TEXT NOT NULL,
  st_appointment_id TEXT,
  st_technician_id TEXT NOT NULL,
  user_id INTEGER,
  assigned_at TEXT,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'sent',
  detail TEXT,
  UNIQUE (st_appointment_id, st_technician_id)
);

CREATE INDEX IF NOT EXISTS idx_st_assignment_sms_job_tech
  ON st_assignment_sms(st_job_id, st_technician_id, notified_at DESC);

-- Poll fingerprint: last-seen tech set per appointment (JSON array of tech ids)
CREATE TABLE IF NOT EXISTS st_assignment_snapshot (
  st_appointment_id TEXT PRIMARY KEY,
  st_job_id TEXT,
  tech_ids_json TEXT NOT NULL DEFAULT '[]',
  modified_on TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
