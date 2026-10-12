-- 113_tech_assist.sql  Field App tech assist (2026-10-02). Equipment snaps, wrap-up notes, brief cache.
-- FILE ONLY until Chris says Y:
--   npx wrangler d1 execute fleet_db --remote --file=migrations/113_tech_assist.sql
-- Never `wrangler d1 migrations apply`. LF line endings.

CREATE TABLE IF NOT EXISTS tech_equipment_snaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  st_job_id TEXT NOT NULL,
  st_location_id TEXT,
  address_norm TEXT,
  unit_role TEXT NOT NULL DEFAULT 'unknown'
    CHECK (unit_role IN ('outdoor','indoor','furnace','air_handler','package','unknown')),
  manufacturer TEXT,
  model_number TEXT,
  serial_number TEXT,
  mfg_year INTEGER,
  mfg_month INTEGER,
  tonnage REAL,
  refrigerant_hint TEXT,
  decode_confidence TEXT NOT NULL DEFAULT 'low' CHECK (decode_confidence IN ('high','medium','low')),
  source TEXT NOT NULL CHECK (source IN ('ocr','typed')),
  raw_ocr TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tech_equip_loc ON tech_equipment_snaps(st_location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tech_equip_addr ON tech_equipment_snaps(address_norm);
CREATE INDEX IF NOT EXISTS idx_tech_equip_job ON tech_equipment_snaps(st_job_id);

CREATE TABLE IF NOT EXISTS tech_job_wrapups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  st_job_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  found_text TEXT,
  did_text TEXT,
  recommend_text TEXT,
  parts_text TEXT,
  split_by TEXT NOT NULL DEFAULT 'rules' CHECK (split_by IN ('rules','ai')),
  input TEXT NOT NULL DEFAULT 'typed' CHECK (input IN ('typed','spoken')),
  copied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tech_wrapups_job ON tech_job_wrapups(st_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tech_wrapups_user ON tech_job_wrapups(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tech_brief_cache (
  st_job_id TEXT PRIMARY KEY,
  built_at TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  ai_text TEXT,
  ai_model TEXT
);
