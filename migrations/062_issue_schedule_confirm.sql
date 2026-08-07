-- Tech must confirm shop appointments for accountability
ALTER TABLE vehicle_issues ADD COLUMN tech_confirm_status TEXT;
ALTER TABLE vehicle_issues ADD COLUMN tech_confirmed_at TEXT;
ALTER TABLE vehicle_issues ADD COLUMN tech_confirmed_by_user_id INTEGER REFERENCES users(id);
ALTER TABLE vehicle_issues ADD COLUMN tech_confirm_note TEXT;

-- Existing scheduled jobs await confirm
UPDATE vehicle_issues
SET tech_confirm_status = 'pending'
WHERE status = 'scheduled'
  AND (tech_confirm_status IS NULL OR tech_confirm_status = '');
