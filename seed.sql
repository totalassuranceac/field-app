-- Demo seed for local development
-- Default admin password: ChangeMe123!
-- Salt/hash generated with PBKDF2 (see worker/auth.ts); this is a known test pair.

INSERT OR IGNORE INTO employees (id, name, active) VALUES
  (1, 'John Smith', 1),
  (2, 'Maria Garcia', 1),
  (3, 'James Wilson', 1),
  (4, 'Sarah Johnson', 1),
  (5, 'Robert Brown', 1);

INSERT OR IGNORE INTO vehicles (
  id, unit_number, plate, year, make, model, status, current_odometer,
  dash_cam_status, registration_expires, inspection_expires, modifications, notes
) VALUES
  (1, '101', 'TX-A1B2C3', 2021, 'Ford', 'Transit', 'active', 45210,
   'working', date('now', '+90 days'), date('now', '+120 days'), 'Ladder rack', NULL),
  (2, '102', 'TX-D4E5F6', 2020, 'Chevy', 'Express', 'active', 78100,
   'not_working', date('now', '-5 days'), date('now', '+45 days'), NULL, 'Needs cam repair'),
  (3, '103', 'TX-G7H8I9', 2022, 'Ford', 'F-150', 'active', 22340,
   'working', date('now', '+20 days'), date('now', '+200 days'), 'Tool box', NULL),
  (4, '104', 'TX-J1K2L3', 2019, 'Ram', '1500', 'active', 91200,
   'missing', date('now', '+180 days'), date('now', '-10 days'), NULL, NULL),
  (5, '105', 'TX-M4N5O6', 2023, 'Ford', 'Transit', 'out_of_service', 12000,
   'working', date('now', '+300 days'), date('now', '+300 days'), NULL, 'Transmission shop');

-- password: ChangeMe123!
-- Precomputed for local seed; bootstrap also creates admin if empty
INSERT OR IGNORE INTO users (
  id, email, username, display_name, password_hash, password_salt, role, employee_id, auth_provider, active
) VALUES (
  1,
  'admin@example.com',
  'admin',
  'Fleet Admin',
  'seed-will-be-replaced-on-bootstrap',
  'seed',
  'admin',
  NULL,
  'password',
  1
);

INSERT OR IGNORE INTO users (
  id, email, username, display_name, password_hash, password_salt, role, auth_provider, active
) VALUES (
  2,
  'mechanic@example.com',
  'mechanic',
  'Fleet Mechanic',
  'seed-will-be-replaced-on-bootstrap',
  'seed',
  'mechanic',
  'password',
  1
);
