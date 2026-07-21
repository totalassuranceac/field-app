-- Employee handbook: admin uploads PDF; staff read and acknowledge in-app

CREATE TABLE IF NOT EXISTS employee_handbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Employee Handbook',
  version_label TEXT,
  file_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  file_size INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  uploaded_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_handbooks_active ON employee_handbooks(active, created_at DESC);

CREATE TABLE IF NOT EXISTS handbook_acknowledgments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handbook_id INTEGER NOT NULL REFERENCES employee_handbooks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
  ack_name TEXT,
  UNIQUE (handbook_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_handbook_acks_user ON handbook_acknowledgments(user_id);
CREATE INDEX IF NOT EXISTS idx_handbook_acks_book ON handbook_acknowledgments(handbook_id);
