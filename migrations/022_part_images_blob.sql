-- Cache / store part photos (from ST media paths or manual upload)
CREATE TABLE IF NOT EXISTS part_image_blobs (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  data BLOB NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
