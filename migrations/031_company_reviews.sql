-- Company Google reviews board (team celebration feed)
-- Google does not push reviews to us; admin posts highlights when new ones appear.
-- All active users can read; everyone gets an in-app notification on new posts.

CREATE TABLE IF NOT EXISTS company_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_name TEXT,
  rating INTEGER,
  review_text TEXT NOT NULL,
  tech_mentioned TEXT,
  review_date TEXT,
  source_url TEXT,
  posted_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_company_reviews_created ON company_reviews(created_at DESC);
