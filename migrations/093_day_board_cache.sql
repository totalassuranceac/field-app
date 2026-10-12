-- Short shared cache for GET /day-board (HIT ≤45s / SWR ≤10min)
CREATE TABLE IF NOT EXISTS day_board_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  built_at TEXT NOT NULL
);
