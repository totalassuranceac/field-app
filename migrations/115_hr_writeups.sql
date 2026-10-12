-- 115_hr_writeups.sql  Saved employee write-ups. Private HR. Append-only (void, never delete).
-- Apply twice (idempotent) BEFORE deploy:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/115_hr_writeups.sql
-- Never `wrangler d1 migrations apply`. No ALTER, DROP, DELETE, or UPDATE.

CREATE TABLE IF NOT EXISTS hr_writeups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER REFERENCES employees(id),
  employee_name TEXT NOT NULL,
  supervisor_name TEXT,
  incident_date TEXT,
  what_happened TEXT NOT NULL,
  prior_warnings TEXT,
  expectations TEXT,
  consequences TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  voided_by_user_id INTEGER REFERENCES users(id),
  void_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_hr_writeups_employee ON hr_writeups(employee_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hr_writeups_created ON hr_writeups(created_at DESC);
