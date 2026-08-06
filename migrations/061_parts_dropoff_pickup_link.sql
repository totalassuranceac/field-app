-- Link shop drop-offs back to vendor pickup lines (so we can prompt "where did you place it?")
ALTER TABLE parts_dropoffs ADD COLUMN pickup_ticket_id INTEGER;
ALTER TABLE parts_dropoffs ADD COLUMN pickup_line_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_parts_dropoffs_pickup_line
  ON parts_dropoffs(pickup_line_id);
CREATE INDEX IF NOT EXISTS idx_parts_dropoffs_pickup_ticket
  ON parts_dropoffs(pickup_ticket_id);
