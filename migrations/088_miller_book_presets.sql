-- Miller Book Job custom presets (named installer groups).
-- Soft: no money. HARD LOCK pairs remain code starters; these are user-owned extras.
CREATE TABLE IF NOT EXISTS miller_book_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  technician_ids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_miller_book_presets_user
  ON miller_book_presets(user_id);
