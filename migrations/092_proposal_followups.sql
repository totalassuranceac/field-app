-- Proposal / estimate follow-up queue (manual send only — never auto-email)
CREATE TABLE IF NOT EXISTS proposal_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT,
  job_address TEXT,
  title TEXT,
  notes TEXT,
  sent_at TEXT NOT NULL,
  followup_due_at TEXT NOT NULL,
  followup_day INTEGER NOT NULL CHECK (followup_day IN (3, 7)),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'ready', 'sent', 'dismissed')),
  draft_body TEXT,
  parent_id INTEGER,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proposal_followups_due
  ON proposal_followups(status, followup_due_at);
CREATE INDEX IF NOT EXISTS idx_proposal_followups_sent
  ON proposal_followups(sent_at DESC);
