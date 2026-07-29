-- Admin fuel receipt OCR review queue (teach corrections from photos)
ALTER TABLE fuel_entries ADD COLUMN ocr_raw_text TEXT;
ALTER TABLE fuel_entries ADD COLUMN ocr_json TEXT;
ALTER TABLE fuel_entries ADD COLUMN ocr_needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fuel_entries ADD COLUMN ocr_reviewed_at TEXT;
ALTER TABLE fuel_entries ADD COLUMN ocr_reviewed_by_user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_fuel_ocr_review
  ON fuel_entries(ocr_needs_review, created_at DESC);
