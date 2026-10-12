-- Extra disciplinary-action fields on a saved write-up. Old rows stay blank.
-- Apply once before the write-up form that uses these fields goes live:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/120_hr_writeup_detail.sql

ALTER TABLE hr_writeups ADD COLUMN form_detail TEXT;
