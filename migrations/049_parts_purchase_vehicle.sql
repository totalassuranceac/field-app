-- Tie parts purchase receipts to the vehicle that was worked on
ALTER TABLE parts_purchase_receipts ADD COLUMN vehicle_id INTEGER REFERENCES vehicles(id);
ALTER TABLE parts_purchase_receipts ADD COLUMN issue_id INTEGER;
ALTER TABLE parts_purchase_receipts ADD COLUMN parts_order_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_parts_purch_vehicle
  ON parts_purchase_receipts(vehicle_id, created_at DESC);
