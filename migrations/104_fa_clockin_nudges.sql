-- Clock-in nudge bookkeeping. employee_id is the Field App users.id.
-- nudge_type is 'late' or 'left_on_job'.
-- Applied by the worker (CREATE IF NOT EXISTS) on first use.
-- Do not run against production until Chris says Y.

CREATE TABLE IF NOT EXISTS fa_clockin_nudges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  appt_id TEXT NOT NULL,
  chicago_day TEXT NOT NULL,
  nudge_type TEXT NOT NULL DEFAULT 'late',
  nudge_at TEXT,
  office_alert_at TEXT,
  resolved_at TEXT,
  employee_name TEXT,
  job_label TEXT,
  window_start TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (employee_id, appt_id, chicago_day, nudge_type)
);

CREATE INDEX IF NOT EXISTS idx_fa_clockin_nudges_left
  ON fa_clockin_nudges (nudge_type, employee_id, appt_id, resolved_at);

-- Day clock-out marker. Does not close a job. Same "do not run until Y" rule.
CREATE TABLE IF NOT EXISTS fa_day_clock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  clock_out_at TEXT NOT NULL,
  chicago_day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fa_day_clock_user
  ON fa_day_clock (user_id, clock_out_at DESC);

CREATE INDEX IF NOT EXISTS idx_fa_clockin_nudges_day
  ON fa_clockin_nudges (chicago_day, resolved_at, nudge_at);

CREATE TABLE IF NOT EXISTS fa_clockin_morning (
  chicago_day TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fa_clockin_nudge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chicago_day TEXT NOT NULL,
  kind TEXT NOT NULL,
  employee_id INTEGER,
  appt_id TEXT,
  mode TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fa_clockin_nudge_log_day
  ON fa_clockin_nudge_log (chicago_day, id);
