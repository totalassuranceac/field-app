-- Shop-originated work orders (mechanic logs work without a driver report)
-- origin: 'driver' (default) | 'shop'
ALTER TABLE vehicle_issues ADD COLUMN origin TEXT NOT NULL DEFAULT 'driver';

CREATE INDEX IF NOT EXISTS idx_issues_completed_at ON vehicle_issues(completed_at);
CREATE INDEX IF NOT EXISTS idx_issues_origin ON vehicle_issues(origin);
