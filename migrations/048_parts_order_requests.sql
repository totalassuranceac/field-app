-- Mechanic parts order hub: track needs → ordered → arriving → received
-- Vendor search stays on AutoZone Pro / First Call Online; Field App tracks the request.

CREATE TABLE IF NOT EXISTS parts_order_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  vehicle_label TEXT,
  issue_id INTEGER,
  part_description TEXT NOT NULL,
  part_number TEXT,
  vendor_preference TEXT NOT NULL DEFAULT 'either'
    CHECK (vendor_preference IN ('autozone', 'firstcall', 'either', 'other')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'needed'
    CHECK (status IN ('needed', 'ordered', 'arriving', 'received', 'cancelled')),
  ordered_from TEXT
    CHECK (ordered_from IS NULL OR ordered_from IN ('autozone', 'firstcall', 'other')),
  order_note TEXT,
  ordered_at TEXT,
  arriving_at TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parts_order_user
  ON parts_order_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_parts_order_status
  ON parts_order_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_parts_order_issue
  ON parts_order_requests(issue_id);
