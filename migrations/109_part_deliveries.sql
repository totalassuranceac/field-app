-- Parts delivery receiving + Deliveries page.
-- FILE ONLY. Apply ONLY after Chris says Y, with:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/109_part_deliveries.sql
-- Never `wrangler d1 migrations apply` (d1_migrations is empty). Never `npm run db:migrate`.
-- The worker does NOT create these on first use; /api/deliveries/* answers 503 until this runs.
-- Does not touch stock_*, part_pickup_*, parts_arrivals, parts_order_*, part_finder_*, warranty_claims.

CREATE TABLE IF NOT EXISTS delivery_spots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  label_key TEXT NOT NULL UNIQUE,          -- lower(trim(collapsed spaces)); dedupes "Office" vs "office "
  hint TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO delivery_spots (label, label_key, hint, sort_order)
VALUES (
  'Office - next to Kelsie''s desk (small parts)',
  'office - next to kelsie''s desk (small parts)',
  'Small parts go to the office by Kelsie''s desk.',
  10
);

CREATE TABLE IF NOT EXISTS part_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),   -- UTC; UI shows CT
  received_by_user_id INTEGER NOT NULL,
  vendor_name TEXT,
  po_number TEXT,
  photo_key TEXT,                                        -- part-deliveries/...
  job_kind TEXT NOT NULL DEFAULT 'job' CHECK (job_kind IN ('job', 'stock')),
  st_job_id TEXT,                                        -- from ST pick; NULL when typed
  job_number TEXT,
  customer_name TEXT,
  job_address TEXT,
  st_location_id INTEGER,
  spot_id INTEGER NOT NULL,
  spot_label TEXT NOT NULL,                              -- snapshot at receive / move
  note TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'scheduled', 'picked_up', 'voided')),
  scheduled_for TEXT,                                    -- optional YYYY-MM-DD
  scheduled_at TEXT,
  scheduled_by_user_id INTEGER,
  picked_up_at TEXT,
  picked_up_by_user_id INTEGER,                          -- who took it (picker, defaults to self)
  picked_up_logged_by_user_id INTEGER,                   -- who tapped the button
  voided_at TEXT,
  voided_by_user_id INTEGER,
  void_reason TEXT,
  client_token TEXT,                                     -- double-tap guard
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_part_deliveries_token ON part_deliveries(client_token);
CREATE INDEX IF NOT EXISTS idx_part_deliveries_status ON part_deliveries(status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_part_deliveries_job ON part_deliveries(job_number);
CREATE INDEX IF NOT EXISTS idx_part_deliveries_po ON part_deliveries(po_number);

CREATE TABLE IF NOT EXISTS part_delivery_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL,
  part_code TEXT,
  qty REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_part_delivery_lines_d ON part_delivery_lines(delivery_id, line_no);

CREATE TABLE IF NOT EXISTS part_delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,   -- received | scheduled | unscheduled | picked_up | undo_pickup | spot_moved | voided
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_part_delivery_events_d ON part_delivery_events(delivery_id, id);
