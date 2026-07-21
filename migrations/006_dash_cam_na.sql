-- Replace dash_cam "unknown" with "n/a" (acceptable, not flagged)
-- SQLite cannot ALTER CHECK; rebuild vehicles table.

PRAGMA foreign_keys = OFF;

CREATE TABLE vehicles_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_number TEXT NOT NULL UNIQUE,
  plate TEXT,
  year INTEGER,
  make TEXT,
  model TEXT,
  vin TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'out_of_service', 'retired')),
  current_odometer REAL,
  assigned_driver TEXT,
  phone TEXT,
  insurance_card TEXT,
  dash_cam_status TEXT NOT NULL DEFAULT 'n/a'
    CHECK (dash_cam_status IN ('working', 'not_working', 'missing', 'n/a')),
  cam_type TEXT,
  gps_tracker TEXT,
  gps_status TEXT DEFAULT 'unknown',
  registration_expires TEXT,
  inspection_expires TEXT,
  insurance_expires TEXT,
  emissions_expires TEXT,
  modifications TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO vehicles_new (
  id, unit_number, plate, year, make, model, vin, status, current_odometer,
  assigned_driver, phone, insurance_card, dash_cam_status, cam_type, gps_tracker,
  gps_status, registration_expires, inspection_expires, insurance_expires,
  emissions_expires, modifications, notes, created_at, updated_at
)
SELECT
  id, unit_number, plate, year, make, model, vin, status, current_odometer,
  assigned_driver, phone, insurance_card,
  CASE WHEN dash_cam_status = 'unknown' OR dash_cam_status IS NULL THEN 'n/a' ELSE dash_cam_status END,
  cam_type, gps_tracker,
  COALESCE(gps_status, 'unknown'),
  registration_expires, inspection_expires, insurance_expires,
  emissions_expires, modifications, notes, created_at, updated_at
FROM vehicles;

DROP TABLE vehicles;
ALTER TABLE vehicles_new RENAME TO vehicles;

CREATE INDEX IF NOT EXISTS idx_vehicles_unit ON vehicles(unit_number);

PRAGMA foreign_keys = ON;
