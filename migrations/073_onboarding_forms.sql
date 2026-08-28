-- Official hire-packet blanks (W-4, I-9) — admin-replaceable so forms stay current
CREATE TABLE IF NOT EXISTS onboarding_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL UNIQUE CHECK (kind IN ('w4', 'i9')),
  version_label TEXT,
  file_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  file_size INTEGER,
  uploaded_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_onboarding_forms_kind ON onboarding_forms(kind);
