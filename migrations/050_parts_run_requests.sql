-- Field parts delivery runs: tech needs materials brought out; documents why it wasn't on the truck
CREATE TABLE IF NOT EXISTS parts_run_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  vehicle_label TEXT,
  job_address TEXT,
  part_needed TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'en_route', 'delivered', 'cancelled')),
  delivery_notes TEXT,
  delivered_by_user_id INTEGER REFERENCES users(id),
  delivered_at TEXT,
  inventory_transferred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parts_run_user
  ON parts_run_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_parts_run_status
  ON parts_run_requests(status, created_at DESC);
