-- Add supervisor role to users.role CHECK (SQLite requires table rebuild).
-- Supervisor: broad operational visibility; cannot manage system settings / user accounts.

PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  manager_user_id INTEGER,
  is_warehouse INTEGER NOT NULL DEFAULT 0
);

INSERT INTO users_new (
  id, email, username, display_name, password_hash, password_salt, role,
  employee_id, phone, must_change_password, auth_provider, google_sub, active,
  created_at, updated_at, manager_user_id, is_warehouse
)
SELECT
  id, email, username, display_name, password_hash, password_salt, role,
  employee_id, phone, must_change_password, auth_provider, google_sub, active,
  created_at, updated_at, manager_user_id, IFNULL(is_warehouse, 0)
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_employee_id ON users(employee_id);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_user_id);

PRAGMA foreign_keys = ON;
