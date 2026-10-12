-- Shop counter: a tech can take waiting parts onto the van assigned to them.
-- status stays received (the live CHECK only allows waiting / received / cancelled).
-- disposition van_stock plus vehicle_id records which truck they went on.

ALTER TABLE parts_dropoffs ADD COLUMN disposition TEXT;
ALTER TABLE parts_dropoffs ADD COLUMN vehicle_id INTEGER;
