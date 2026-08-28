-- Payroll confirmation for approved PTO/sick: took it / partial / came in (restore)

ALTER TABLE time_off_requests ADD COLUMN usage_status TEXT;
ALTER TABLE time_off_requests ADD COLUMN hours_deducted REAL;
ALTER TABLE time_off_requests ADD COLUMN hours_actual REAL;
ALTER TABLE time_off_requests ADD COLUMN usage_confirmed_at TEXT;
ALTER TABLE time_off_requests ADD COLUMN usage_confirmed_by_user_id INTEGER;
ALTER TABLE time_off_requests ADD COLUMN usage_note TEXT;

CREATE INDEX IF NOT EXISTS idx_time_off_usage
  ON time_off_requests(usage_status, start_date);
