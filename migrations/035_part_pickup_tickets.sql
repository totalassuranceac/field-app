-- Part pickup tickets: one vendor call / PO with multiple part lines
-- Warehouse marks each line: picked | not_ready | partial | cancelled

CREATE TABLE IF NOT EXISTS part_pickup_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_name TEXT NOT NULL,
  needed_for_date TEXT,
  purchase_order TEXT,
  notes TEXT,
  qty_unknown INTEGER NOT NULL DEFAULT 0,
  expected_parts INTEGER,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'partial', 'done', 'cancelled')),
  logged_by_user_id INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'office'
    CHECK (source IN ('office', 'tech', 'warehouse', 'other')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_part_pickup_tickets_status
  ON part_pickup_tickets(status, needed_for_date, vendor_name);

CREATE TABLE IF NOT EXISTS part_pickup_ticket_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES part_pickup_tickets(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL DEFAULT 1,
  part_id INTEGER REFERENCES parts(id),
  part_code TEXT,
  part_name TEXT,
  qty_requested REAL NOT NULL DEFAULT 1,
  qty_received REAL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'picked', 'not_ready', 'partial', 'cancelled')),
  notes TEXT,
  resolved_at TEXT,
  resolved_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_part_pickup_lines_ticket
  ON part_pickup_ticket_lines(ticket_id, line_no);

CREATE INDEX IF NOT EXISTS idx_part_pickup_lines_status
  ON part_pickup_ticket_lines(status, ticket_id);
