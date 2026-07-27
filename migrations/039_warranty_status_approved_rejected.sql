-- Warranty statuses: dropped_off → claim_submitted → approved | rejected
-- Rebuild table so CHECK allows new values; map legacy statuses on INSERT

CREATE TABLE IF NOT EXISTS warranty_claims_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'dropped_off'
    CHECK (status IN ('dropped_off', 'claim_submitted', 'approved', 'rejected')),
  part_id INTEGER REFERENCES parts(id),
  part_code TEXT,
  part_name TEXT NOT NULL,
  model_number TEXT,
  serial_number TEXT,
  service_address TEXT,
  customer_name TEXT,
  vendor_name TEXT,
  notes TEXT,
  needs_vendor_return INTEGER NOT NULL DEFAULT 0,
  dropped_off_by_user_id INTEGER REFERENCES users(id),
  dropped_off_at TEXT NOT NULL DEFAULT (datetime('now')),
  claim_submitted_at TEXT,
  processed_at TEXT,
  processed_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  dropoff_photo_key TEXT,
  nameplate_photo_key TEXT
);

INSERT INTO warranty_claims_new (
  id, log_number, status, part_id, part_code, part_name, model_number, serial_number,
  service_address, customer_name, vendor_name, notes, needs_vendor_return,
  dropped_off_by_user_id, dropped_off_at, claim_submitted_at, processed_at, processed_by_user_id,
  created_at, updated_at, dropoff_photo_key, nameplate_photo_key
)
SELECT
  id,
  log_number,
  CASE status
    WHEN 'processed' THEN 'approved'
    WHEN 'return_to_vendor' THEN 'rejected'
    WHEN 'cancelled' THEN 'rejected'
    WHEN 'approved' THEN 'approved'
    WHEN 'rejected' THEN 'rejected'
    WHEN 'claim_submitted' THEN 'claim_submitted'
    ELSE 'dropped_off'
  END,
  part_id, part_code, part_name, model_number, serial_number,
  service_address, customer_name, vendor_name, notes, needs_vendor_return,
  dropped_off_by_user_id, dropped_off_at, claim_submitted_at, processed_at, processed_by_user_id,
  created_at, updated_at, dropoff_photo_key, nameplate_photo_key
FROM warranty_claims;

DROP TABLE warranty_claims;
ALTER TABLE warranty_claims_new RENAME TO warranty_claims;

CREATE INDEX IF NOT EXISTS idx_warranty_status ON warranty_claims(status, dropped_off_at);
CREATE INDEX IF NOT EXISTS idx_warranty_dropped ON warranty_claims(dropped_off_at DESC);
