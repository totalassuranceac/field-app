-- Part request fields, status history, and warehouse arrivals.
-- File only. Do not run on production until Chris says Y.
-- The worker also creates these with CREATE IF NOT EXISTS / ALTER on first use.

ALTER TABLE parts_order_requests ADD COLUMN job_ref TEXT;
ALTER TABLE parts_order_requests ADD COLUMN needed_by TEXT;
ALTER TABLE parts_order_requests ADD COLUMN deliver_to TEXT;
ALTER TABLE parts_order_requests ADD COLUMN eta_on TEXT;
ALTER TABLE parts_order_requests ADD COLUMN po_number TEXT;

CREATE TABLE IF NOT EXISTS parts_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER,
  arrival_id INTEGER,
  actor_user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parts_order_events_req
  ON parts_order_events(request_id, id);

CREATE TABLE IF NOT EXISTS parts_arrivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_description TEXT NOT NULL,
  vendor_name TEXT,
  po_number TEXT,
  request_id INTEGER,
  known_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'unmatched',
  logged_by_user_id INTEGER NOT NULL,
  not_needed_by_user_id INTEGER,
  not_needed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parts_arrivals_status
  ON parts_arrivals(status, created_at DESC);
