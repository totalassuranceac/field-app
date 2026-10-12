-- Tool checklist checks and NATE practice scores. Private. No ranking table.
-- Apply once:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/119_growth_nate_tools.sql

CREATE TABLE IF NOT EXISTS growth_tool_checks (
  user_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  have INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS growth_track (
  user_id INTEGER PRIMARY KEY,
  track TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nate_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  exam_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  topic_key TEXT,
  question_ids TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  graded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_nate_papers_user ON nate_papers(user_id, id DESC);

CREATE TABLE IF NOT EXISTS nate_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  paper_id INTEGER,
  exam_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  topic_key TEXT,
  score REAL NOT NULL,
  correct_count INTEGER NOT NULL,
  question_count INTEGER NOT NULL,
  topic_scores_json TEXT NOT NULL,
  question_ids TEXT NOT NULL,
  wrong_ids TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nate_attempts_user_exam
  ON nate_attempts(user_id, exam_key, finished_at DESC);

CREATE TABLE IF NOT EXISTS nate_ready_marks (
  user_id INTEGER NOT NULL,
  exam_key TEXT NOT NULL,
  marked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, exam_key)
);
