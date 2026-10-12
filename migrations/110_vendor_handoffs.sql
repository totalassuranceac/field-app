-- 110_vendor_handoffs.sql
-- Proof of vendor hand-off: vendor rep signs on the phone + printed name + part photo (required) + optional GPS.
-- APPEND-ONLY: no UPDATE, no DELETE (enforced by triggers below). Corrections are a new row with supersedes_id.
-- Apply ONLY after Chris says Y, one file, explicitly:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/110_vendor_handoffs.sql
-- Never `wrangler d1 migrations apply` (d1_migrations is empty). File must be saved with LF line endings.
-- No FOREIGN KEY clauses on purpose: warranty_claims has been rebuilt by DROP/RENAME 3 times (039, 040, 054);
-- an FK here would block the next rebuild. Ids are checked in the worker instead.
-- Does not touch warranty_claims, parts_arrivals, receipt_blobs, part_deliveries or any 108/109 table.

CREATE TABLE IF NOT EXISTS vendor_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('warranty', 'parts_arrival')),
  source_id INTEGER NOT NULL,
  warranty_claim_id INTEGER,
  handoff_type TEXT NOT NULL CHECK (handoff_type IN ('return_to_vendor', 'take_back', 'counter_dropoff')),
  log_number TEXT,
  part_name TEXT,
  part_code TEXT,
  rma_number TEXT,
  vendor_name TEXT NOT NULL,
  vendor_branch TEXT,
  rep_name TEXT NOT NULL CHECK (length(trim(rep_name)) >= 2),
  signature_key TEXT NOT NULL,
  signature_sha256 TEXT NOT NULL,
  photo_key TEXT NOT NULL,
  photo_sha256 TEXT NOT NULL,
  handed_by_user_id INTEGER NOT NULL,
  handed_by_name TEXT NOT NULL,
  recorded_by_user_id INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_captured_at TEXT,
  sent_offline INTEGER NOT NULL DEFAULT 0,
  gps_status TEXT NOT NULL DEFAULT 'skipped'
    CHECK (gps_status IN ('ok', 'denied', 'unavailable', 'timeout', 'unsupported', 'skipped')),
  gps_lat REAL,
  gps_lng REAL,
  gps_accuracy_m REAL,
  gps_captured_at TEXT,
  status_from TEXT,
  notes TEXT,
  supersedes_id INTEGER,
  correction_reason TEXT,
  user_agent TEXT,
  CHECK (supersedes_id IS NULL OR length(trim(COALESCE(correction_reason, ''))) >= 3),
  CHECK (gps_status <> 'ok' OR (gps_lat IS NOT NULL AND gps_lng IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_vendor_handoffs_warranty ON vendor_handoffs(warranty_claim_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_vendor_handoffs_source ON vendor_handoffs(source_type, source_id, recorded_at);

CREATE TRIGGER IF NOT EXISTS trg_vendor_handoffs_no_update
BEFORE UPDATE ON vendor_handoffs
BEGIN
  SELECT RAISE(ABORT, 'vendor_handoffs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_vendor_handoffs_no_delete
BEFORE DELETE ON vendor_handoffs
BEGIN
  SELECT RAISE(ABORT, 'vendor_handoffs is append-only');
END;

-- No settings rows are seeded. Defaults live in worker/vendorHandoffs.ts (getSetting fallbacks).
