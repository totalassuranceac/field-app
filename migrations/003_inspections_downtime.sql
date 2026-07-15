-- Inspections + vehicle downtime tracking

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

CREATE INDEX IF NOT EXISTS idx_inspections_vehicle ON inspections(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_inspections_date ON inspections(inspection_date);
CREATE INDEX IF NOT EXISTS idx_downtime_vehicle ON downtime_events(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_downtime_open ON downtime_events(vehicle_id, ended_at);

-- Link open downtime when issue moves in_progress; close when completed
