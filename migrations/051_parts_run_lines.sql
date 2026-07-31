-- Parts run line items (part # + qty) for warehouse transfer into tech/vehicle custody
CREATE TABLE IF NOT EXISTS parts_run_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES parts_run_requests(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL DEFAULT 1,
  part_id INTEGER,
  part_code TEXT,
  part_name TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  transferred INTEGER NOT NULL DEFAULT 0,
  transfer_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_parts_run_lines_run
  ON parts_run_lines(run_id, line_no);

ALTER TABLE parts_run_requests ADD COLUMN inventory_transferred INTEGER NOT NULL DEFAULT 0;
