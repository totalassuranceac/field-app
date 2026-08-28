-- Separation / rehire tracking for PTO seniority
-- Policy: gone 90+ days → hire_date becomes rehire date; PTO banks restart at 0 until next anniversary.
-- Gone under 90 days → keep original hire_date and existing banks.

ALTER TABLE employees ADD COLUMN separation_date TEXT;
ALTER TABLE employees ADD COLUMN original_hire_date TEXT;

CREATE INDEX IF NOT EXISTS idx_employees_separation
  ON employees(separation_date);
