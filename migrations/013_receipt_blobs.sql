-- Local receipt storage when Cloudflare R2 is not bound (small fleet / free setup)
CREATE TABLE IF NOT EXISTS receipt_blobs (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  data BLOB NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_receipt_blobs_created ON receipt_blobs(created_at);
