-- Learn from receipt OCR corrections so future scans improve
CREATE TABLE IF NOT EXISTS ocr_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  store_key TEXT,
  field_name TEXT NOT NULL,
  ocr_value TEXT,
  correct_value TEXT NOT NULL,
  raw_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ocr_corr_store ON ocr_corrections(store_key, field_name);

-- Aggregated memory: wrong→right and preferred line labels per store
CREATE TABLE IF NOT EXISTS ocr_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_key TEXT NOT NULL DEFAULT 'global',
  field_name TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('sub', 'line_label', 'value_in_text')),
  key_text TEXT NOT NULL,
  value_text TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_key, field_name, memory_type, key_text, value_text)
);

CREATE INDEX IF NOT EXISTS idx_ocr_memory_lookup ON ocr_memory(store_key, field_name, hits);
