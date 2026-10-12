-- Install permit status (FA-side) for Complete gate on install jobs.
-- Soft: no money writes. Status is where the permit is / N/A.
CREATE TABLE IF NOT EXISTS install_permit_status (
  st_job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('missing', 'at_city', 'on_truck', 'on_site', 'na')),
  note TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_install_permit_status_updated
  ON install_permit_status(updated_at DESC);
