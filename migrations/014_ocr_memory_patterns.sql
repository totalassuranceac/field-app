-- Allow pattern-based OCR learning (where to look on the receipt)
-- SQLite cannot ALTER CHECK constraints; rebuild ocr_memory.

CREATE TABLE IF NOT EXISTS ocr_memory_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_key TEXT NOT NULL DEFAULT 'global',
  field_name TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('sub', 'line_label', 'value_in_text', 'pattern')),
  key_text TEXT NOT NULL,
  value_text TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_key, field_name, memory_type, key_text, value_text)
);

INSERT OR IGNORE INTO ocr_memory_new (id, store_key, field_name, memory_type, key_text, value_text, hits, updated_at)
SELECT id, store_key, field_name, memory_type, key_text, value_text, hits, updated_at FROM ocr_memory;

DROP TABLE ocr_memory;
ALTER TABLE ocr_memory_new RENAME TO ocr_memory;

CREATE INDEX IF NOT EXISTS idx_ocr_memory_lookup ON ocr_memory(store_key, field_name, hits);
