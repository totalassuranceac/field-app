-- Repair part pickup / schedule notifies.
-- needs_install: coil or office/tech checkbox. Miller only when this is on.
-- no_cool: rush comfort. Prefer pickup. Manager check if still unscheduled.

ALTER TABLE part_finder_requests ADD COLUMN needs_install INTEGER NOT NULL DEFAULT 0;
ALTER TABLE part_finder_requests ADD COLUMN no_cool INTEGER NOT NULL DEFAULT 0;
ALTER TABLE part_finder_requests ADD COLUMN picked_up_at TEXT;
ALTER TABLE part_finder_requests ADD COLUMN schedule_status TEXT;
ALTER TABLE part_finder_requests ADD COLUMN manager_pinged_at TEXT;
