-- Repair detail fields, service records (oil changes), in-app notifications

ALTER TABLE vehicle_issues ADD COLUMN issue_category TEXT;
ALTER TABLE vehicle_issues ADD COLUMN is_emergency INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicle_issues ADD COLUMN mechanic_diagnosis TEXT;
ALTER TABLE vehicle_issues ADD COLUMN work_performed TEXT;
ALTER TABLE vehicle_issues ADD COLUMN parts_used TEXT;
ALTER TABLE vehicle_issues ADD COLUMN labor_hours REAL;
ALTER TABLE vehicle_issues ADD COLUMN diagnosed_by_user_id INTEGER;
ALTER TABLE vehicle_issues ADD COLUMN completed_by_user_id INTEGER;

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

CREATE INDEX IF NOT EXISTS idx_service_vehicle ON service_records(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_service_type ON service_records(service_type);

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

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('oil_change_interval_miles', '5000'),
  ('weekly_check_days', '7');
