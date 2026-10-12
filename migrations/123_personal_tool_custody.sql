-- Personal tools stay with the employee. A lend moves accountability until it is returned.
-- Employee gas bottles leave with the person. Company bottles stay on the truck.
-- Do not apply until Chris says to put this live.

ALTER TABLE growth_tool_checks ADD COLUMN released_at TEXT;

CREATE TABLE IF NOT EXISTS growth_tool_lends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  holder_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'returned')),
  lent_at TEXT NOT NULL DEFAULT (datetime('now')),
  returned_at TEXT,
  note TEXT,
  created_by_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_growth_tool_lends_owner
  ON growth_tool_lends(owner_user_id, item_id, status);

CREATE INDEX IF NOT EXISTS idx_growth_tool_lends_holder
  ON growth_tool_lends(holder_user_id, status);

CREATE TABLE IF NOT EXISTS gas_bottles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bottle_type TEXT NOT NULL CHECK (bottle_type IN ('N2', 'O2', 'ACE')),
  serial TEXT,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('company', 'employee')),
  owner_user_id INTEGER,
  vehicle_id INTEGER,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left_with_employee', 'retired')),
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gas_bottles_owner ON gas_bottles(owner_user_id, status);
