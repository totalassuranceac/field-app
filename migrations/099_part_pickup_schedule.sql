-- Part pickup: persist contact tech + Miller install-schedule loop
ALTER TABLE part_pickup_tickets ADD COLUMN needs_install_schedule INTEGER NOT NULL DEFAULT 0;
ALTER TABLE part_pickup_tickets ADD COLUMN schedule_status TEXT;
ALTER TABLE part_pickup_tickets ADD COLUMN contact_user_id INTEGER;
ALTER TABLE part_pickup_tickets ADD COLUMN miller_assigned_user_id INTEGER;
ALTER TABLE part_pickup_tickets ADD COLUMN miller_assigned_at TEXT;
ALTER TABLE part_pickup_tickets ADD COLUMN miller_assigned_by INTEGER;
ALTER TABLE part_pickup_tickets ADD COLUMN picked_notified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE part_pickup_tickets ADD COLUMN miller_reminded_at TEXT;
