-- Private Safety training (topics + stamped completions). No rankings.
-- Chris manages topics; techs see active topics and their own history only.

CREATE TABLE IF NOT EXISTS safety_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  video_url TEXT,
  video_file_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_user_id INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS safety_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES safety_topics(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  stamped_by_user_id INTEGER REFERENCES users(id),
  -- Optional: admin retake creates a new row; never deletes prior stamps
  is_retake INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_safety_topics_active_sort
  ON safety_topics(active, sort_order, id);

CREATE INDEX IF NOT EXISTS idx_safety_completions_user
  ON safety_completions(user_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_safety_completions_topic
  ON safety_completions(topic_id, completed_at DESC);

-- Seed one empty untitled topic for admin to fill (no invented OSHA text)
INSERT INTO safety_topics (title, body, video_url, sort_order, active)
SELECT 'Untitled safety topic', '', NULL, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM safety_topics LIMIT 1);
