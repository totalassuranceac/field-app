-- Extra receipt fields from OCR (store #, card last 4, transaction time)
ALTER TABLE fuel_entries ADD COLUMN store_number TEXT;
ALTER TABLE fuel_entries ADD COLUMN card_last4 TEXT;
ALTER TABLE fuel_entries ADD COLUMN fuel_time TEXT;
