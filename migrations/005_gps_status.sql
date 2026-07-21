-- GPS working status (separate from provider type in gps_tracker)
ALTER TABLE vehicles ADD COLUMN gps_status TEXT DEFAULT 'unknown';
