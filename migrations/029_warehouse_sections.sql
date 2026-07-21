-- Named warehouse sections (shelves, overheads, attic racks) + home bin per part.
-- stock_locations already allows multiple warehouse/attic rows (NULL vehicle_id uniqueness).
-- zone labels how to group: main floor, overhead, attic, other.

ALTER TABLE stock_locations ADD COLUMN zone TEXT;
ALTER TABLE stock_locations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_locations ADD COLUMN notes TEXT;

-- Primary "home" bin for a part (where techs look first). Overstock = qty at other non-truck locations.
ALTER TABLE parts ADD COLUMN home_location_id INTEGER REFERENCES stock_locations(id);

CREATE INDEX IF NOT EXISTS idx_parts_home_location ON parts(home_location_id);
CREATE INDEX IF NOT EXISTS idx_stock_locations_zone ON stock_locations(zone);

-- Backfill zones for existing rows
UPDATE stock_locations SET zone = 'main' WHERE type = 'warehouse' AND (zone IS NULL OR zone = '');
UPDATE stock_locations SET zone = 'attic' WHERE type = 'attic' AND (zone IS NULL OR zone = '');
UPDATE stock_locations SET zone = 'truck' WHERE type = 'vehicle' AND (zone IS NULL OR zone = '');
