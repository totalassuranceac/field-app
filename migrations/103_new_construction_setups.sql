-- Azali Homes new-house setup (RNC). Do not run against production until Chris says Y.

CREATE TABLE IF NOT EXISTS new_construction_setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  street TEXT NOT NULL,
  city TEXT NOT NULL,
  zip TEXT NOT NULL,
  subdivision TEXT NOT NULL,
  stories TEXT NOT NULL,
  sys1_tons TEXT NOT NULL,
  sys1_loc TEXT NOT NULL,
  sys2_tons TEXT,
  sys2_loc TEXT,
  exhaust_fans INTEGER NOT NULL,
  brand TEXT NOT NULL,
  contract_amount TEXT,
  notes TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  start_date TEXT NOT NULL,
  target_date TEXT NOT NULL,
  estimate_no TEXT,
  st_location_id TEXT,
  st_project_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'created', 'failed')),
  error TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_new_construction_created
  ON new_construction_setups(created_at DESC);
