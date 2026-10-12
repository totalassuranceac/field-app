-- Day Board sticky reminders for one Chicago calendar day (office).
CREATE TABLE IF NOT EXISTS day_board_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_date TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  completed_by_user_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_day_board_reminders_date
  ON day_board_reminders(board_date, completed_at);
