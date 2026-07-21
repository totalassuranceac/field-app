-- SQLite UNIQUE(type, vehicle_id) allows many warehouse/attic rows (NULL vehicle_id).
-- Keep the lowest id for each fixed type; drop the rest after merging balances.

-- Re-home balances from duplicate warehouses onto the first warehouse id
UPDATE stock_balances
SET location_id = (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse')
WHERE location_id IN (
  SELECT id FROM stock_locations
  WHERE type = 'warehouse'
    AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse')
)
AND NOT EXISTS (
  SELECT 1 FROM stock_balances b2
  WHERE b2.location_id = (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse')
    AND b2.part_id = stock_balances.part_id
);

DELETE FROM stock_balances
WHERE location_id IN (
  SELECT id FROM stock_locations
  WHERE type = 'warehouse'
    AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse')
);

UPDATE stock_balances
SET location_id = (SELECT MIN(id) FROM stock_locations WHERE type = 'attic')
WHERE location_id IN (
  SELECT id FROM stock_locations
  WHERE type = 'attic'
    AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'attic')
)
AND NOT EXISTS (
  SELECT 1 FROM stock_balances b2
  WHERE b2.location_id = (SELECT MIN(id) FROM stock_locations WHERE type = 'attic')
    AND b2.part_id = stock_balances.part_id
);

DELETE FROM stock_balances
WHERE location_id IN (
  SELECT id FROM stock_locations
  WHERE type = 'attic'
    AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'attic')
);

UPDATE stock_movements
SET from_location_id = (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse')
WHERE from_location_id IN (
  SELECT id FROM stock_locations WHERE type = 'warehouse'
    AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse')
);

UPDATE stock_movements
SET to_location_id = (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse')
WHERE to_location_id IN (
  SELECT id FROM stock_locations WHERE type = 'warehouse'
    AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse')
);

UPDATE stock_movements
SET from_location_id = (SELECT MIN(id) FROM stock_locations WHERE type = 'attic')
WHERE from_location_id IN (
  SELECT id FROM stock_locations WHERE type = 'attic'
    AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'attic')
);

UPDATE stock_movements
SET to_location_id = (SELECT MIN(id) FROM stock_locations WHERE type = 'attic')
WHERE to_location_id IN (
  SELECT id FROM stock_locations WHERE type = 'attic'
    AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'attic')
);

DELETE FROM stock_locations
WHERE type = 'warehouse'
  AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'warehouse');

DELETE FROM stock_locations
WHERE type = 'attic'
  AND id > (SELECT MIN(id) FROM stock_locations WHERE type = 'attic');

-- Prevent future duplicates of fixed locations (one warehouse, one attic)
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_locations_fixed_type
  ON stock_locations(type)
  WHERE type IN ('warehouse', 'attic');
