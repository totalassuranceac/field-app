-- 096: Repair UTF-8-as-CP1252 mojibake in fuel station_notes (and optional notifications).
-- DO NOT auto-run without Chris Y. Prefer POST /api/admin/repair-utf8-mojibake after deploy,
-- or apply this file via: npx wrangler d1 execute fleet_db --remote --file=migrations/096_fuel_notes_utf8_mojibake.sql
-- Account: f6da342467e60df683731c55dfc0e7b4  DB: fleet_db / 9126adda-009e-4aff-8f78-dddf54be8ffa
-- Dig 2026-09-23: 6 fuel_entries rows had â€¢ / â€™ in CARD MISMATCH notes (ids 238,240-242,254,258).
-- Older CARD MISMATCH rows already store correct U+2022 / U+2019.

-- Preview (read-only):
--   SELECT id, station_notes FROM fuel_entries WHERE hex(station_notes) LIKE '%C3A2E282AC%' LIMIT 20;

UPDATE fuel_entries
SET station_notes =
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(station_notes, 'â€¢', '•'), 'â€™', '’'), 'â€˜', '‘'), 'â€œ', '“'), 'â€', '”'), 'â€”', '—'), 'â€“', '–'), 'â€¦', '…'), 'Â·', '·')
WHERE station_notes IS NOT NULL
  AND (
    hex(station_notes) LIKE '%C3A2E282AC%'
    OR hex(station_notes) LIKE '%C382C2B7%'
  );

-- Optional notifications scrub (titles/bodies). Uncomment if Atlas wants the same pass:
-- UPDATE notifications
-- SET title = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(title, 'â€¢', '•'), 'â€™', '’'), 'â€˜', '‘'), 'â€œ', '“'), 'â€', '”'), 'â€”', '—'), 'â€“', '–'), 'â€¦', '…'), 'Â·', '·'),
--     body = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(body,''), 'â€¢', '•'), 'â€™', '’'), 'â€˜', '‘'), 'â€œ', '“'), 'â€', '”'), 'â€”', '—'), 'â€“', '–'), 'â€¦', '…'), 'Â·', '·')
-- WHERE hex(title) LIKE '%C3A2E282AC%' OR hex(COALESCE(body,'')) LIKE '%C3A2E282AC%';

