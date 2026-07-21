-- Mark parts that belong on truck stock lists
ALTER TABLE parts ADD COLUMN truck_stock INTEGER NOT NULL DEFAULT 0;
