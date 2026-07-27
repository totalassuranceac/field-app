-- Vendor return / credit tracking on warranties
ALTER TABLE warranty_claims ADD COLUMN rma_number TEXT;
ALTER TABLE warranty_claims ADD COLUMN credit_amount REAL;
ALTER TABLE warranty_claims ADD COLUMN tracking_number TEXT;
ALTER TABLE warranty_claims ADD COLUMN shipped_by_user_id INTEGER REFERENCES users(id);
