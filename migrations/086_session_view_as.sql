-- Admin view-as / impersonation (session + audit)
-- Soft: no password access; active targets only; block view-as other admins by default.

ALTER TABLE sessions ADD COLUMN view_as_user_id INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS view_as_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL,
  admin_display TEXT NOT NULL,
  target_user_id INTEGER NOT NULL,
  target_display TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_view_as_audit_admin ON view_as_audit(admin_user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_view_as ON sessions(view_as_user_id);
