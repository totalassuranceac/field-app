-- Compressor warranty drop-off: seal confirmation + old/new serial photos
ALTER TABLE warranty_claims ADD COLUMN compressor_seals_ok INTEGER;
ALTER TABLE warranty_claims ADD COLUMN old_compressor_photo_key TEXT;
ALTER TABLE warranty_claims ADD COLUMN new_compressor_photo_key TEXT;
ALTER TABLE warranty_claims ADD COLUMN old_compressor_serial TEXT;
ALTER TABLE warranty_claims ADD COLUMN new_compressor_serial TEXT;
