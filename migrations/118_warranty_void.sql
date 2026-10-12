-- Void a warranty submission without deleting the row or changing status.
-- Voided cards leave File / Hold / Return / Parked and stay findable on Closed and search.
-- Apply before deploying worker code that reads voided:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/118_warranty_void.sql
ALTER TABLE warranty_claims ADD COLUMN voided INTEGER NOT NULL DEFAULT 0;
ALTER TABLE warranty_claims ADD COLUMN void_reason TEXT;
ALTER TABLE warranty_claims ADD COLUMN voided_at TEXT;
ALTER TABLE warranty_claims ADD COLUMN voided_by_user_id INTEGER REFERENCES users(id);
