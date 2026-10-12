-- Field App stock move audit. Counts stay in Field App tables.
-- Kill switch: parts_run_stock_moves = 1. Remote apply waits for Chris.

CREATE TABLE IF NOT EXISTS stock_move_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,
  source_id INTEGER,
  source_line_id INTEGER,
  part_id INTEGER NOT NULL REFERENCES parts(id),
  from_location_id INTEGER REFERENCES stock_locations(id),
  to_location_id INTEGER REFERENCES stock_locations(id),
  qty REAL NOT NULL,
  from_before REAL,
  from_after REAL,
  to_before REAL,
  to_after REAL,
  status TEXT NOT NULL,
  flag_text TEXT,
  stock_movement_id INTEGER,
  undo_of_log_id INTEGER REFERENCES stock_move_log(id),
  undone_by_log_id INTEGER,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stock_move_log_source
  ON stock_move_log(source_kind, source_id);

CREATE INDEX IF NOT EXISTS idx_stock_move_log_part
  ON stock_move_log(part_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_move_log_status
  ON stock_move_log(status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_move_log_line_moved
  ON stock_move_log(source_kind, source_line_id)
  WHERE status = 'moved' AND undo_of_log_id IS NULL;

INSERT INTO settings (key, value, updated_at)
SELECT 'parts_run_stock_moves', '1', datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'parts_run_stock_moves');
