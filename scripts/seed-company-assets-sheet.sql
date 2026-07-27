-- One-time import from company asset spreadsheet (TA / R454 / NPR / dolly list).
-- Idempotent on asset_tag. Warehouse location_id = 1. created_by_user_id = 1 (admin).
-- User map: John Williams 16, Kyle Duffield 20, Adam Bosquez 11, Justin Lyles 22,
--   Mike Casarez 23, John Alvarado 28, Kai Woodruff 13, Beto Ortiz 21, Marcus Tovar 18, Warren Engle 30.
-- Jonathan Willie has no Field App user — left unlinked with note.

-- Available tools (warehouse)
INSERT OR IGNORE INTO company_assets (
  asset_tag, name, category, subcategory, serial_number, manufacturer, model,
  status, location_id, condition, condition_date, condition_notes,
  issued_at, issued_to_user_id, notes, active
) VALUES
('TA001', 'Refrigerant Scale', 'tool', 'Diagnostic Scale', '21060534ACAO', 'Fieldpiece', 'SRS1',
  'in_service', 1, 'good', date('now'), NULL, NULL, NULL, NULL, 1),
('TA002', 'ODB Diagnostic Tool', 'tool', 'Smart Diagnostic System', '79B68169-8E2B-407E-A500-7384561F37C6', 'Innova', '7111',
  'in_service', 1, 'good', date('now'), NULL, NULL, NULL, NULL, 1),
('TA003', 'Auto Manifold Gauge', 'tool', 'R134A A/C Manifold Gauge Set', '36747-2449', 'Pittsburgh', '58776',
  'in_service', 1, 'good', date('now'), NULL, NULL, NULL, NULL, 1),
('TA004', 'Flow Hood', 'tool', 'CPS Bluetooth Flow Hood', NULL, 'CPS', 'ABM-HOOD',
  'in_service', 1, 'good', date('now'), NULL, NULL, NULL, NULL, 1),
('TA006', 'Acetylene Regulator', 'tool', 'G-Series Acetylene Regulator', NULL, 'Victor', 'G150-15-200R',
  'in_service', 1, 'good', date('now'), NULL, NULL, NULL, NULL, 1),
('VAC', 'Power 10 Portable Vacuum', 'tool', NULL, NULL, NULL, NULL,
  'in_service', 1, 'good', date('now'), NULL, NULL, NULL, NULL, 1);

-- TA005: sheet status Available but John Williams listed in possession
INSERT OR IGNORE INTO company_assets (
  asset_tag, name, category, subcategory, serial_number, manufacturer, model,
  status, location_id, condition, condition_date, condition_notes,
  issued_at, issued_to_user_id, notes, active
) VALUES
('TA005', 'Refrigerant Scale', 'tool', 'Diagnostic Scale', '22070981ACAO', 'Fieldpiece', 'SRS1',
  'in_service', 1, 'good', date('now'), NULL, '2025-08-06', 16, 'From sheet — in possession of John Williams', 1);

-- Issued tools
INSERT OR IGNORE INTO company_assets (
  asset_tag, name, category, subcategory, serial_number, manufacturer, model,
  status, location_id, condition, condition_date, condition_notes,
  issued_at, issued_to_user_id, notes, active
) VALUES
('TA007', 'Bluetooth Shared Data Loader', 'tool', 'Bluetooth Shared Data Loader', NULL, 'Bencor', 'BTSDL01',
  'in_service', 1, 'good', date('now'), NULL, '2025-07-07', 20, NULL, 1),
('TA012', 'E5Pro Thermal Imaging Camera', 'tool', 'E5Pro Thermal Imaging Camera', '13308957', 'Flir', 'E1330',
  'in_service', 1, 'good', date('now'), NULL, '2025-07-27', 11, NULL, 1),
('CAM-X4', 'CAM-X4', 'tool', NULL, NULL, NULL, NULL,
  'in_service', 1, 'good', date('now'), NULL, '2026-07-14', 16, 'From asset sheet (name blank on spreadsheet)', 1);

-- R454 adapters (same sheet ID for each unit — unique tags R454ADPT-01…07)
INSERT OR IGNORE INTO company_assets (
  asset_tag, name, category, subcategory, serial_number, manufacturer, model,
  status, location_id, condition, condition_date, condition_notes,
  issued_at, issued_to_user_id, notes, active
) VALUES
('R454ADPT-01', 'R454 Refrigerant Thread Adapter', 'tool', 'R454ADPT', NULL, 'Navac', 'F2010',
  'in_service', 1, 'good', date('now'), NULL, '2025-07-17', 16, 'Sheet ID R454ADPT', 1),
('R454ADPT-02', 'R454 Refrigerant Thread Adapter', 'tool', 'R454ADPT', NULL, 'Navac', 'F2010',
  'in_service', 1, 'good', date('now'), NULL, '2025-07-17', 22, 'Sheet ID R454ADPT', 1),
('R454ADPT-03', 'R454 Refrigerant Thread Adapter', 'tool', 'R454ADPT', NULL, 'Navac', 'F2010',
  'in_service', 1, 'good', date('now'), NULL, '2025-07-17', 11, 'Sheet ID R454ADPT', 1),
('R454ADPT-04', 'R454 Refrigerant Thread Adapter', 'tool', 'R454ADPT', NULL, 'Navac', 'F2010',
  'in_service', 1, 'good', date('now'), NULL, '2025-08-27', NULL,
  'Sheet ID R454ADPT · checked out to Jonathan Willie (no Field App user yet — link when account exists)', 1),
('R454ADPT-05', 'R454 Refrigerant Thread Adapter', 'tool', 'R454ADPT', NULL, 'Navac', 'F2010',
  'in_service', 1, 'good', date('now'), NULL, '2025-10-15', 22, 'Sheet ID R454ADPT', 1),
('R454ADPT-06', 'R454 Refrigerant Thread Adapter', 'tool', 'R454ADPT', NULL, 'Navac', 'F2010',
  'in_service', 1, 'good', date('now'), NULL, '2026-07-03', 23, 'Sheet ID R454ADPT · Michael Casarez', 1),
('R454ADPT-07', 'R454 Refrigerant Thread Adapter', 'tool', 'R454ADPT', NULL, 'Navac', 'F2010',
  'in_service', 1, 'good', date('now'), NULL, '2025-09-03', 23, 'Sheet ID R454ADPT · Michael Casarez', 1);

-- Nitrogen purge regulators
INSERT OR IGNORE INTO company_assets (
  asset_tag, name, category, subcategory, serial_number, manufacturer, model,
  status, location_id, condition, condition_date, condition_notes,
  issued_at, issued_to_user_id, notes, active
) VALUES
('NPR01', 'Nitrogen Purge Regulator', 'tool', NULL, NULL, 'Swiproy', 'SWVN500',
  'in_service', 1, 'good', date('now'), NULL, datetime('now'), 28, NULL, 1),
('NPR02', 'Nitrogen Purge Regulator', 'tool', NULL, NULL, 'Swiproy', 'SWVN500',
  'in_service', 1, 'good', date('now'), NULL, datetime('now'), 16, NULL, 1),
('NPR03', 'Nitrogen Purge Regulator', 'tool', NULL, NULL, 'Swiproy', 'SWVN500',
  'in_service', 1, 'good', date('now'), NULL, datetime('now'), 13, NULL, 1),
('NPR04', 'Nitrogen Purge Regulator', 'tool', NULL, NULL, 'Swiproy', 'SWVN500',
  'in_service', 1, 'good', date('now'), NULL, datetime('now'), 21, NULL, 1),
('NPR05', 'Nitrogen Purge Regulator', 'tool', NULL, NULL, 'Swiproy', 'SWVN500',
  'in_service', 1, 'good', date('now'), NULL, datetime('now'), 18, 'Sheet name Marcus Tover → Marcus Tovar', 1),
('NPR06', 'Nitrogen Purge Regulator', 'tool', NULL, NULL, 'Swiproy', 'SWVN500',
  'in_service', 1, 'good', date('now'), NULL, datetime('now'), 30, 'Sheet name Warren Engel → Warren Engle', 1);

-- Dollies & specialty
INSERT OR IGNORE INTO company_assets (
  asset_tag, name, category, subcategory, serial_number, manufacturer, model,
  status, location_id, condition, condition_date, condition_notes,
  issued_at, issued_to_user_id, notes, active
) VALUES
('D011', 'Dolly', 'dolly', NULL, NULL, NULL, NULL,
  'in_service', 1, 'good', date('now'), NULL, '2026-04-30', 13, NULL, 1),
('D013', 'Dolly', 'dolly', NULL, NULL, NULL, NULL,
  'in_service', 1, 'good', date('now'), NULL, datetime('now'), 28, NULL, 1),
('AUGER01', 'Spyder Auger w/ Center Attachment', 'tool', NULL, NULL, 'Spyder', NULL,
  'in_service', 1, 'good', date('now'), NULL, '2026-06-10', 23, 'Michael Casarez', 1);

-- Create events for imported rows (only if no events yet)
INSERT INTO company_asset_events (
  asset_id, event_type, to_location_id, to_user_id, condition_after, notes, created_by_user_id
)
SELECT a.id, 'create', a.location_id, a.issued_to_user_id, a.condition,
  COALESCE(a.notes, 'Imported from company asset spreadsheet'), 1
FROM company_assets a
WHERE a.asset_tag IN (
  'TA001','TA002','TA003','TA004','TA005','TA006','TA007','TA012','CAM-X4','VAC',
  'R454ADPT-01','R454ADPT-02','R454ADPT-03','R454ADPT-04','R454ADPT-05','R454ADPT-06','R454ADPT-07',
  'NPR01','NPR02','NPR03','NPR04','NPR05','NPR06','D011','D013','AUGER01'
)
AND NOT EXISTS (
  SELECT 1 FROM company_asset_events e WHERE e.asset_id = a.id AND e.event_type = 'create'
);

INSERT INTO company_asset_events (
  asset_id, event_type, to_location_id, to_user_id, condition_after, notes, created_by_user_id
)
SELECT a.id, 'issue', a.location_id, a.issued_to_user_id, a.condition,
  'Initial checkout from spreadsheet' || CASE
    WHEN a.issued_to_user_id IS NULL AND a.notes LIKE '%Jonathan Willie%'
      THEN ' · Jonathan Willie (no app user)'
    ELSE ''
  END, 1
FROM company_assets a
WHERE a.issued_at IS NOT NULL
AND a.asset_tag IN (
  'TA005','TA007','TA012','CAM-X4',
  'R454ADPT-01','R454ADPT-02','R454ADPT-03','R454ADPT-04','R454ADPT-05','R454ADPT-06','R454ADPT-07',
  'NPR01','NPR02','NPR03','NPR04','NPR05','NPR06','D011','D013','AUGER01'
)
AND NOT EXISTS (
  SELECT 1 FROM company_asset_events e WHERE e.asset_id = a.id AND e.event_type = 'issue'
);
