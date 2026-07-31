-- Employee app feedback / suggestions for improving Field App
CREATE TABLE IF NOT EXISTS app_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL DEFAULT 'suggestion'
    CHECK (category IN ('suggestion', 'bug', 'praise', 'other')),
  message TEXT NOT NULL,
  page_context TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'reviewed', 'done', 'dismissed')),
  admin_note TEXT,
  reviewed_by_user_id INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_feedback_status
  ON app_feedback(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_feedback_user
  ON app_feedback(user_id, created_at DESC);
