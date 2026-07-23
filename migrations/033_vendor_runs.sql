-- Vendor will-call / "parts ready" run list (Field App owns this; ST is optional later)
-- Office or techs log when a vendor calls; warehouse picks by vendor before EOD.

CREATE TABLE IF NOT EXISTS vendor_run_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'picked', 'cancelled')),
  vendor_name TEXT NOT NULL,
  part_id INTEGER REFERENCES parts(id),
  part_code TEXT,
  part_name TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  needed_for_date TEXT,
  job_number TEXT,
  job_address TEXT,
  customer_name TEXT,
  notes TEXT,
  -- Who heard from the vendor / tech (office, field, warehouse)
  logged_by_user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'office'
    CHECK (source IN ('office', 'tech', 'warehouse', 'other')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  picked_at TEXT,
  picked_by_user_id INTEGER REFERENCES users(id),
  -- When marked picked, optionally received into main warehouse stock
  stock_received INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vendor_run_status
  ON vendor_run_lines(status, needed_for_date, vendor_name);

CREATE INDEX IF NOT EXISTS idx_vendor_run_vendor
  ON vendor_run_lines(vendor_name, status);

CREATE INDEX IF NOT EXISTS idx_vendor_run_needed
  ON vendor_run_lines(needed_for_date, status);
