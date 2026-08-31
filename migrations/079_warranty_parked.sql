-- Parked warranty pile: do not file, do not scrap (e.g. new-purchase hold).
-- Flag only — status usually stays dropped_off. File badge = dropped_off AND parked=0.
ALTER TABLE warranty_claims ADD COLUMN parked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE warranty_claims ADD COLUMN parked_reason TEXT;
ALTER TABLE warranty_claims ADD COLUMN parked_at TEXT;
ALTER TABLE warranty_claims ADD COLUMN parked_by_user_id INTEGER REFERENCES users(id);
