-- Optional barcodes / UPCs linked to a catalog part (many barcodes → one part)
-- Part number (parts.code) still works for scan; this stores package/vendor barcodes.

CREATE TABLE IF NOT EXISTS part_barcodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  label TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (barcode)
);

CREATE INDEX IF NOT EXISTS idx_part_barcodes_part ON part_barcodes(part_id);
CREATE INDEX IF NOT EXISTS idx_part_barcodes_code ON part_barcodes(barcode);
