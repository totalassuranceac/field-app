-- Link techs who ride together (helper ↔ primary)
-- Reliable vehicle assignment for map + driver access when units change

ALTER TABLE employees ADD COLUMN rides_with_employee_id INTEGER REFERENCES employees(id);

CREATE INDEX IF NOT EXISTS idx_employees_rides_with
  ON employees(rides_with_employee_id);

-- Explicit employee link on vehicle (text assigned_driver stays for display / GPS match)
ALTER TABLE vehicles ADD COLUMN assigned_employee_id INTEGER REFERENCES employees(id);
ALTER TABLE vehicles ADD COLUMN helper_employee_id INTEGER REFERENCES employees(id);

CREATE INDEX IF NOT EXISTS idx_vehicles_assigned_emp
  ON vehicles(assigned_employee_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_helper_emp
  ON vehicles(helper_employee_id);

-- Audit trail when fleet manager reassigns a unit
CREATE TABLE IF NOT EXISTS vehicle_assignment_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  assigned_employee_id INTEGER,
  helper_employee_id INTEGER,
  assigned_driver_name TEXT,
  previous_employee_id INTEGER,
  previous_helper_employee_id INTEGER,
  previous_driver_name TEXT,
  assigned_by_user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vehicle_assign_log_vehicle
  ON vehicle_assignment_log(vehicle_id, created_at DESC);
