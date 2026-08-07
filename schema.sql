-- Total Assurance Fleet Tracker schema

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  username TEXT UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  role TEXT NOT NULL DEFAULT 'driver'
    CHECK (role IN ('admin', 'office', 'driver', 'mechanic', 'viewer', 'supervisor')),
  employee_id INTEGER,
  phone TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  auth_provider TEXT NOT NULL DEFAULT 'password'
    CHECK (auth_provider IN ('password', 'google', 'both')),
  google_sub TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicles (
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
  gps_status TEXT DEFAULT 'n/a'
    CHECK (gps_status IS NULL OR gps_status IN ('working', 'not_working', 'missing', 'n/a')),
  registration_expires TEXT,
  inspection_expires TEXT,
  insurance_expires TEXT,
  emissions_expires TEXT,
  modifications TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fuel_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  odometer REAL NOT NULL,
  gallons REAL,
  total_cost REAL,
  fuel_date TEXT NOT NULL,
  fuel_time TEXT,
  store_number TEXT,
  card_last4 TEXT,
  station_notes TEXT,
  receipt_key TEXT,
  entered_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mileage_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_entry_id INTEGER NOT NULL REFERENCES fuel_entries(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('decrease', 'large_jump', 'no_baseline', 'duplicate_day')),
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'dismissed')),
  acknowledged_by_user_id INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  acknowledge_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  reported_by_user_id INTEGER NOT NULL REFERENCES users(id),
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  description TEXT,
  issue_category TEXT,
  is_emergency INTEGER NOT NULL DEFAULT 0,
  mechanic_diagnosis TEXT,
  work_performed TEXT,
  parts_used TEXT,
  labor_hours REAL,
  diagnosed_by_user_id INTEGER,
  completed_by_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  scheduled_date TEXT,
  schedule_notes TEXT,
  /** pending | confirmed | declined — set when mechanic schedules shop visit */
  tech_confirm_status TEXT,
  tech_confirmed_at TEXT,
  tech_confirmed_by_user_id INTEGER REFERENCES users(id),
  tech_confirm_note TEXT,
  completed_at TEXT,
  completion_notes TEXT,
  photo_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS service_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  service_type TEXT NOT NULL DEFAULT 'oil_change'
    CHECK (service_type IN ('oil_change', 'other')),
  service_date TEXT NOT NULL,
  odometer REAL,
  interval_miles REAL NOT NULL DEFAULT 5000,
  next_due_odometer REAL,
  next_due_date TEXT,
  performed_by_user_id INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT,
  entity_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_sid TEXT,
  error TEXT,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  user_display TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  inspector_user_id INTEGER NOT NULL REFERENCES users(id),
  inspection_date TEXT NOT NULL DEFAULT (date('now')),
  odometer REAL,
  overall_status TEXT NOT NULL DEFAULT 'pass'
    CHECK (overall_status IN ('pass', 'pass_with_notes', 'fail')),
  checklist_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  photo_key TEXT,
  created_issue_id INTEGER REFERENCES vehicle_issues(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS downtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  issue_id INTEGER REFERENCES vehicle_issues(id),
  reason TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  started_by_user_id INTEGER REFERENCES users(id),
  ended_by_user_id INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Receipt photos when R2 is not configured
CREATE TABLE IF NOT EXISTS receipt_blobs (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  data BLOB NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Receipt OCR learning from user corrections
CREATE TABLE IF NOT EXISTS ocr_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  store_key TEXT,
  field_name TEXT NOT NULL,
  ocr_value TEXT,
  correct_value TEXT NOT NULL,
  raw_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ocr_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_key TEXT NOT NULL DEFAULT 'global',
  field_name TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('sub', 'line_label', 'value_in_text', 'pattern')),
  key_text TEXT NOT NULL,
  value_text TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_key, field_name, memory_type, key_text, value_text)
);

CREATE INDEX IF NOT EXISTS idx_fuel_vehicle_date ON fuel_entries(vehicle_id, fuel_date);
CREATE INDEX IF NOT EXISTS idx_fuel_employee ON fuel_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON mileage_alerts(status);
CREATE INDEX IF NOT EXISTS idx_issues_status ON vehicle_issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_vehicle ON vehicle_issues(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_unit ON vehicles(unit_number);
CREATE INDEX IF NOT EXISTS idx_inspections_vehicle ON inspections(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_downtime_vehicle ON downtime_events(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_ocr_corr_store ON ocr_corrections(store_key, field_name);
CREATE INDEX IF NOT EXISTS idx_ocr_memory_lookup ON ocr_memory(store_key, field_name, hits);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('large_jump_miles', '250'),
  ('large_jump_miles_per_day', '180'),
  ('expiring_soon_days', '30'),
  ('gps_stale_hours', '6');
