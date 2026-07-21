-- In-app messenger + warranty part tracking

CREATE TABLE IF NOT EXISTS app_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id), -- NULL = whole team broadcast
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_messages_to ON app_messages(to_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_messages_from ON app_messages(from_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_message_reads (
  message_id INTEGER NOT NULL REFERENCES app_messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS warranty_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'dropped_off'
    CHECK (status IN ('dropped_off', 'claim_submitted', 'processed', 'return_to_vendor', 'cancelled')),
  part_id INTEGER REFERENCES parts(id),
  part_code TEXT,
  part_name TEXT NOT NULL,
  model_number TEXT,
  serial_number TEXT,
  service_address TEXT,
  customer_name TEXT,
  vendor_name TEXT,
  notes TEXT,
  needs_vendor_return INTEGER NOT NULL DEFAULT 0,
  dropped_off_by_user_id INTEGER REFERENCES users(id),
  dropped_off_at TEXT NOT NULL DEFAULT (datetime('now')),
  claim_submitted_at TEXT,
  processed_at TEXT,
  processed_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_warranty_status ON warranty_claims(status, dropped_off_at);
CREATE INDEX IF NOT EXISTS idx_warranty_dropped ON warranty_claims(dropped_off_at DESC);
