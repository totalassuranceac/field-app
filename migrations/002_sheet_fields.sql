-- Add columns from fleet Google Sheet (safe to re-run: ignores duplicate column errors if applied carefully)

ALTER TABLE employees ADD COLUMN phone TEXT;

ALTER TABLE vehicles ADD COLUMN vin TEXT;
ALTER TABLE vehicles ADD COLUMN assigned_driver TEXT;
ALTER TABLE vehicles ADD COLUMN phone TEXT;
ALTER TABLE vehicles ADD COLUMN insurance_card TEXT;
ALTER TABLE vehicles ADD COLUMN cam_type TEXT;
ALTER TABLE vehicles ADD COLUMN gps_tracker TEXT;
