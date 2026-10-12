-- 112_done_today.sql - Done today: optional typed/spoken extra lines.
-- Auto items are NOT stored; they are read at request time from existing tables.
-- FILE ONLY in the build. Run remotely only after Chris says Y, after deploy:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/112_done_today.sql
-- Never `wrangler d1 migrations apply`. Save with LF line endings. Safe to run twice.

CREATE TABLE IF NOT EXISTS done_today_extras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  day_ct TEXT NOT NULL CHECK (day_ct GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 200),
  input TEXT NOT NULL DEFAULT 'typed' CHECK (input IN ('typed', 'spoken')),
  split_by TEXT NOT NULL DEFAULT 'none' CHECK (split_by IN ('none', 'rules', 'ai')),
  batch_uuid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at TEXT,
  CHECK (removed_at IS NULL OR removed_at >= created_at)
);
CREATE INDEX IF NOT EXISTS idx_done_today_extras_user_day
  ON done_today_extras (user_id, day_ct, id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('done_today_ai', '0');
