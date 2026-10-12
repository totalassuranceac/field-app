-- Repair / warranty part finder requests (serial-first).
-- TEST: stub vendor lookup. NO live Lennox/Daikin/Carrier secrets in Worker.
-- po_reference = job site address string (NOT a random PO number).

CREATE TABLE IF NOT EXISTS part_finder_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  serial TEXT NOT NULL,
  brand TEXT NOT NULL
    CHECK (brand IN ('lennox', 'daikin', 'carrier', 'other')),
  failed_components TEXT NOT NULL,
  failed_other_text TEXT,
  job_id TEXT,
  job_number TEXT,
  job_address TEXT NOT NULL,
  po_reference TEXT NOT NULL,
  finder_url TEXT,
  vendor_label TEXT,
  fulfillment_preference TEXT NOT NULL DEFAULT 'auto'
    CHECK (fulfillment_preference IN ('pickup', 'ship', 'auto')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'in_review', 'ordered_manual', 'cancelled', 'fulfilled')),
  lookup_source TEXT NOT NULL DEFAULT 'stub',
  stub_mode INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_part_finder_req_user
  ON part_finder_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_part_finder_req_status
  ON part_finder_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS part_finder_request_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES part_finder_requests(id) ON DELETE CASCADE,
  line_key TEXT,
  failed_component TEXT,
  cat_number TEXT,
  oem TEXT,
  description TEXT,
  qty REAL NOT NULL DEFAULT 1,
  pickup_qty REAL,
  shipping_status TEXT,
  product_url TEXT,
  vendor TEXT,
  availability TEXT,
  fulfillment TEXT
    CHECK (fulfillment IS NULL OR fulfillment IN ('pickup', 'ship', 'pending_review')),
  source TEXT NOT NULL DEFAULT 'stub',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_part_finder_lines_req
  ON part_finder_request_lines(request_id);
