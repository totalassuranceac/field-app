-- Total Assurance fleet data imported from Google Sheet
-- https://docs.google.com/spreadsheets/d/1FSUekGeQxM6YTr8RIwjkAtNhataK_FjrVtyICvC-mP8
-- Registration dates from sheet (M/YYYY or MM/YYYY) stored as last day of that month.
-- Multiple sheet rows with unit "XXX" get unique unit numbers (plate or name suffix).

DELETE FROM mileage_alerts;
DELETE FROM fuel_entries;
DELETE FROM vehicle_issues;
DELETE FROM vehicles;
DELETE FROM employees;

-- Employees (drivers from sheet; skip pure vehicle labels)
INSERT INTO employees (id, name, active, phone) VALUES
  (1,  'Justin Lyles', 1, '(361) 461-5395'),
  (2,  'Abel Herrera', 1, '(361) 558-4395'),
  (3,  'Kirk Crumbley', 1, NULL),
  (4,  'Adam Bosquez', 1, '(361) 500-3246'),
  (5,  'Arin Ramirez', 1, '(361) 749-7355'),
  (6,  'Omar Camacho', 1, '(361) 500-3727'),
  (7,  'Robert Gonzalez', 1, '(361) 765-9793'),
  (8,  'Kai Woodruff', 1, '(361) 960-3688'),
  (9,  'John Williams', 1, '(361) 445-7863'),
  (10, 'John Alvarado', 1, '(361) 660-5572'),
  (11, 'Mike Casarez', 1, '(361) 658-5084'),
  (12, 'Warren Engle', 1, '(361) 704-0418'),
  (13, 'Marcus Tovar', 1, '(361) 288-5889'),
  (14, 'Wayne McCaskill', 1, '(361) 290-4110'),
  (15, 'Beto Ortiz', 1, '(361) 445-8609'),
  (16, 'Eric Gonzalez', 1, '(361) 446-0930'),
  (17, 'Chris Miller', 1, '(361) 300-4574'),
  (18, 'Kyle Duffield', 1, '(361) 391-3064');

-- Vehicles
INSERT INTO vehicles (
  unit_number, plate, year, make, model, vin, status,
  assigned_driver, phone, insurance_card,
  dash_cam_status, cam_type, gps_tracker,
  registration_expires, notes
) VALUES
(
  '001', 'MCW7359', 2018, 'Ford', 'Transit 250', '1FTYR2CM7JKB40703', 'active',
  'Justin Lyles', '(361) 461-5395', 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2025-06-30', 'Imported from fleet sheet'
),
(
  '002', 'TSG8388', 2017, 'Ford', 'Transit 250', '1FTYR2CM7HKA99130', 'active',
  'Abel Herrera', '(361) 558-4395', 'Yes',
  'working', 'Verizon', 'Verizon',
  '2025-11-30', 'Imported from fleet sheet'
),
(
  '003', 'PJS0530', 2015, 'Ford', 'Transit 350', '1FTSW2CM2FKA15551', 'active',
  'Kirk Crumbley', NULL, 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2025-03-31', 'Imported from fleet sheet'
),
(
  '005', 'SHS4206', 2019, 'Ford', 'F-250 Super Duty', '1FD7W2B61KEC62847', 'active',
  'Adam Bosquez', '(361) 500-3246', 'Yes',
  'working', 'Dash Cam', 'Verizon',
  '2025-10-31', 'Imported from fleet sheet'
),
(
  '007', 'RHX5689', 2018, 'Nissan', 'NV Cargo', '1N6BF0LY4JN808197', 'active',
  'Duct Cleaning Van', '(361) 522-3308', 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2026-02-28', 'Imported from fleet sheet'
),
(
  '008', 'CFN7918', 2013, 'Ford', 'E-250', '1FTNE2EL4DDA71111', 'active',
  'Arin Ramirez', '(361) 749-7355', 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2026-04-30', 'Imported from fleet sheet'
),
(
  '009', 'RDS1831', 2019, 'Ford', 'Transit 150', '1FTYE1YM5KKA24240', 'active',
  'Omar Camacho', '(361) 500-3727', 'Yes',
  'working', 'Verizon', 'Verizon',
  '2026-04-30', 'Imported from fleet sheet'
),
(
  '010', 'NJH8266', 2019, 'Ram', 'Promaster 2500 Base 159 WB', '3C6TRVDG7KE512122', 'active',
  'Robert Gonzalez', '(361) 765-9793', 'Yes',
  'working', 'Verizon', 'Verizon',
  '2025-05-31', 'Imported from fleet sheet'
),
(
  '011', 'SYN4203', 2020, 'Ford', 'Transit 250', '1FTBR1C82LKB16783', 'active',
  'Kai Woodruff', '(361) 960-3688', 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2026-05-31', 'Imported from fleet sheet'
),
(
  '012', 'SCX9386', 2017, 'Ford', 'F-250 Super Duty Lariat / XL / XLT', '3C7WRVKG8HE538555', 'active',
  'John Williams (dodge)', '(361) 445-7863', 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2026-04-30', 'Sheet lists Ford body with Ram/Dodge VIN prefix 3C7; verify make/model. Imported from fleet sheet'
),
(
  '013', 'TCH8358', 2015, 'Ford', 'Transit 250', '1FTNR2CM6FKA07523', 'active',
  'John Alvarado', '(361) 660-5572', 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2026-05-31', 'Imported from fleet sheet'
),
(
  '014', 'VHJ7798', 2018, 'Ford', 'Transit 250', '1FTYR2CG6JKB29850', 'active',
  'Mike Casarez', '(361) 658-5084', 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2026-05-31', 'Imported from fleet sheet'
),
(
  '015', 'RHX5690', 2020, 'Nissan', 'NV1500 S / SV', '1N6BF0KM7LN800936', 'active',
  'Warren Engle', '(361) 704-0418', 'Yes',
  'working', 'Verizon', 'Verizon',
  '2025-02-28', 'Imported from fleet sheet'
),
(
  '016', NULL, 2021, 'Ford', 'Transit 250', '1FTBR1C86MKA05672', 'active',
  'Marcus Tovar', '(361) 288-5889', 'N/A',
  'working', 'Dash Cam', 'One Step',
  NULL, 'No plate / reg on sheet. Imported from fleet sheet'
),
(
  '018', 'VBS3774', 2019, 'Ford', 'Transit 150', '1FTYE2CM2KKB52173', 'active',
  'Wayne McCaskill', '(361) 290-4110', 'Yes',
  'missing', NULL, 'Verizon',
  '2026-03-31', 'Cam blank on sheet. Imported from fleet sheet'
),
(
  'Box2', 'TPJ4698', 2019, 'Ford', 'E-350 Super Duty', '1FDWE3F68KDC28506', 'active',
  'Beto Ortiz', '(361) 445-8609', 'Yes',
  'working', 'Dash Cam', 'One Step',
  '2025-12-31', 'Imported from fleet sheet'
),
(
  'Box1', 'WSG6438', 2021, 'Chevy', 'Express 3500', '1HA3GTC71MN010849', 'active',
  'Warehouse', NULL, NULL,
  'working', 'Dash Cam', 'One Step',
  '2026-08-31', 'Imported from fleet sheet'
),
(
  'XXX-TRAILER', '252171M', 2022, NULL, '25'' Trailer', '5WWBK2024N6025383', 'active',
  'Warehouse / Trailer', NULL, 'Yes',
  'working', 'Dash Cam', 'Dash Cam',
  NULL, 'Sheet unit XXX; reg N/A. Imported from fleet sheet'
),
(
  'XXX-WKW2986', 'WKW2986', 2025, 'Ford', 'F-150 Raptor', '1FTFW1RJ7PFB36126', 'active',
  'Eric Gonzalez', '(361) 446-0930', 'Yes',
  'missing', NULL, NULL,
  '2027-04-30', 'Sheet unit XXX. Imported from fleet sheet'
),
(
  'XXX-TPJ4876', 'TPJ4876', 2023, 'Ford', 'F-250 (6.7L)', '1FT8W2BT2PEE19159', 'active',
  'Chris Miller', '(361) 300-4574', 'Yes',
  'missing', NULL, NULL,
  '2025-11-30', 'Sheet unit XXX. Imported from fleet sheet'
),
(
  'XXX-DUFFIELD', NULL, 2017, 'Ford', 'Transit 250', '1FTBW2CM6JKA13973', 'active',
  'Kyle Duffield', '(361) 391-3064', 'Yes',
  'working', 'Verizon', 'Verizon',
  NULL, 'Sheet unit/plate XXX; reg PENDING. Imported from fleet sheet'
);
