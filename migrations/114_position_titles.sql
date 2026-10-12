-- 114_position_titles.sql  Optional HVAC job title. Display only. No backfill.
-- Existing rows stay NULL. Apply once:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/114_position_titles.sql
-- Never `wrangler d1 migrations apply`.

ALTER TABLE employees ADD COLUMN position_title TEXT;
ALTER TABLE users ADD COLUMN position_title TEXT;
