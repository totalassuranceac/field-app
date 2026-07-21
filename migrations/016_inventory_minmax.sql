-- Reorder points (low) and order-up-to (high) for parts

ALTER TABLE parts ADD COLUMN min_qty REAL;
ALTER TABLE parts ADD COLUMN max_qty REAL;
