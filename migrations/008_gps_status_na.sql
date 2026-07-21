-- GPS status: replace "unknown" with "n/a" (acceptable, not flagged), same as dash cam
UPDATE vehicles
SET gps_status = 'n/a'
WHERE gps_status IS NULL OR gps_status = '' OR gps_status = 'unknown';
