-- Optional make, model, serial, and notes on a tech's tools.
-- needs_upgrade = 1 keeps the row on the working list because a better version is still worth getting.

ALTER TABLE growth_tool_checks ADD COLUMN make TEXT;
ALTER TABLE growth_tool_checks ADD COLUMN model TEXT;
ALTER TABLE growth_tool_checks ADD COLUMN serial TEXT;
ALTER TABLE growth_tool_checks ADD COLUMN notes TEXT;
ALTER TABLE growth_tool_checks ADD COLUMN needs_upgrade INTEGER NOT NULL DEFAULT 0;
