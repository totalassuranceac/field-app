-- Void pickup lines: leave the Waiting queue without deleting.
-- Requires reason; stores who/when. Weekday warehouse check skips voided
-- (open queries only use pending/not_ready/partial).

CREATE TABLE part_pickup_ticket_lines_080 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES part_pickup_tickets(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL DEFAULT 1,
  part_id INTEGER REFERENCES parts(id),
  part_code TEXT,
  part_name TEXT,
  qty_requested REAL NOT NULL DEFAULT 1,
  qty_received REAL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'picked', 'not_ready', 'partial', 'cancelled', 'voided')),
  notes TEXT,
  resolved_at TEXT,
  resolved_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_reason TEXT,
  voided_at TEXT,
  voided_by_user_id INTEGER REFERENCES users(id)
);

INSERT INTO part_pickup_ticket_lines_080 (
  id, ticket_id, line_no, part_id, part_code, part_name,
  qty_requested, qty_received, status, notes, resolved_at, resolved_by_user_id,
  created_at
)
SELECT
  id, ticket_id, line_no, part_id, part_code, part_name,
  qty_requested, qty_received, status, notes, resolved_at, resolved_by_user_id,
  created_at
FROM part_pickup_ticket_lines;

DROP TABLE part_pickup_ticket_lines;
ALTER TABLE part_pickup_ticket_lines_080 RENAME TO part_pickup_ticket_lines;

CREATE INDEX IF NOT EXISTS idx_part_pickup_lines_ticket
  ON part_pickup_ticket_lines(ticket_id, line_no);

CREATE INDEX IF NOT EXISTS idx_part_pickup_lines_status
  ON part_pickup_ticket_lines(status, ticket_id);
