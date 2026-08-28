-- Per-user Home shortcuts (favorite app sections)
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, path)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user
  ON user_favorites(user_id, sort_order);
