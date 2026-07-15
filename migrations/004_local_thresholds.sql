-- Corpus Christi / local fleet mileage flags (tighter than long-haul defaults)
INSERT INTO settings (key, value, updated_at) VALUES
  ('large_jump_miles', '250', datetime('now')),
  ('large_jump_miles_per_day', '180', datetime('now')),
  ('expiring_soon_days', '30', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
