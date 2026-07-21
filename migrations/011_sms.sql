-- SMS log for Twilio texts between drivers / shop
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_sid TEXT,
  error TEXT,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sms_created ON sms_log(created_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('shop_sms_phone', '');
