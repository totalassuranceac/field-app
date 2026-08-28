-- Who marked the claim submitted (for 3-working-day approval follow-up)
ALTER TABLE warranty_claims ADD COLUMN claim_submitted_by_user_id INTEGER REFERENCES users(id);
