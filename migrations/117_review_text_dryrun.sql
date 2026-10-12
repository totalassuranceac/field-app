-- Post-payment Google review thank-you text (DRY-RUN first). Updated to Chris's 10/3 7:23 AM spec.
-- One row per ServiceTitan payment id (de-dupe), one text per job (st_job_id) and per customer/phone per 90 days.
-- Status flow:
--   queued -> (void recheck after 15 min) -> held (waiting_complete / waiting_paid / waiting_2h / held_for_window)
--   -> would_send (dry, or test mode for a non-test number) | sent (live, or test mode to the env test number)
--   or skipped / voided / error with a reason.
-- Eligible at the LATER of job completed / invoice paid + 2 h, inside 9 AM-7 PM CT Mon-Sat, no holidays.
-- Mode lives in settings.review_text_mode: off (default) | dry | test | live.
-- test/live ALSO need env REVIEW_TEXT_LIVE_SEND=on; test needs env REVIEW_TEXT_TEST_NUMBER (none set in this build).
-- CREATE ... IF NOT EXISTS and INSERT OR IGNORE only. Safe to run twice.

CREATE TABLE IF NOT EXISTS review_text_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  st_payment_id TEXT NOT NULL UNIQUE,
  st_customer_id INTEGER,
  customer_name TEXT,
  st_invoice_ids TEXT,
  payment_type TEXT,
  payment_total REAL,
  payment_created_on TEXT,
  payment_created_by TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  reason TEXT,
  mode TEXT NOT NULL DEFAULT 'dry',
  to_phone TEXT,
  body TEXT,
  recheck_at TEXT,
  hold_until TEXT,
  decided_at TEXT,
  provider_sid TEXT,
  st_job_id TEXT,
  eligible_at TEXT,
  template_variant TEXT,
  segments INTEGER,
  tech_first TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_review_text_status_due
  ON review_text_log (status, recheck_at);
CREATE INDEX IF NOT EXISTS idx_review_text_customer
  ON review_text_log (st_customer_id, status, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_text_phone
  ON review_text_log (to_phone, status, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_text_created
  ON review_text_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_text_job
  ON review_text_log (st_job_id, status);

-- Spec: "already left a Google review" flag, set by the office. Un-marking stamps cleared_at (no DELETE).
CREATE TABLE IF NOT EXISTS review_text_reviewed (
  st_customer_id INTEGER PRIMARY KEY,
  marked_at TEXT NOT NULL DEFAULT (datetime('now')),
  marked_by_user_id INTEGER,
  cleared_at TEXT
);

-- STOP mirror for customer texts (Twilio Advanced Opt-Out still handles STOP itself).
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone TEXT PRIMARY KEY,
  opted_out_at TEXT NOT NULL DEFAULT (datetime('now')),
  opted_in_at TEXT,
  source TEXT,
  last_body TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('review_text_mode', 'off');
INSERT OR IGNORE INTO settings (key, value) VALUES ('review_text_hwm', '');
