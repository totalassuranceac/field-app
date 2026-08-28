-- Last known GPS for live map (out-of-service units stay visible in red)
ALTER TABLE vehicles ADD COLUMN last_lat REAL;
ALTER TABLE vehicles ADD COLUMN last_lng REAL;
ALTER TABLE vehicles ADD COLUMN last_gps_at TEXT;
