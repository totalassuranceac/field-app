-- Seed hire dates + PTO banks from Total Assurance PTO Tracker sheet
-- Names mapped from sheet formal names → Field App employee roster

-- Abelardo Herrera → Abel Herrera
UPDATE employees SET hire_date = '2024-07-29', birthday_md = '12-28', updated_at = datetime('now') WHERE id = 2;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (2, 40, 0, 40, 0, '2026-07-29', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=0, last_anniversary_applied='2026-07-29', updated_at=datetime('now');

-- Adam M Bosquez → Adam Bosquez
UPDATE employees SET hire_date = '2015-11-23', birthday_md = '06-25', updated_at = datetime('now') WHERE id = 4;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (4, 120, 24, 40, 8, '2025-11-23', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=24, sick_entitlement_hours=40, sick_used_hours=8, last_anniversary_applied='2025-11-23', updated_at=datetime('now');

-- Arin R Ramirez → Arin Ramirez
UPDATE employees SET hire_date = '2022-01-24', birthday_md = '09-10', updated_at = datetime('now') WHERE id = 5;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (5, 80, 39, 40, 40, '2026-01-24', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=80, vacation_used_hours=39, sick_entitlement_hours=40, sick_used_hours=40, last_anniversary_applied='2026-01-24', updated_at=datetime('now');

-- Bianca M Ramirez → Bianca Ramirez (sick over: 71/40 → balance -31)
UPDATE employees SET hire_date = '2021-10-28', birthday_md = '10-08', updated_at = datetime('now') WHERE id = 23;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (23, 80, 80, 40, 71, '2025-10-28', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=80, vacation_used_hours=80, sick_entitlement_hours=40, sick_used_hours=71, last_anniversary_applied='2025-10-28', updated_at=datetime('now');

-- Charles Beard
UPDATE employees SET hire_date = '2026-05-04', birthday_md = '04-13', updated_at = datetime('now') WHERE id = 24;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (24, 0, 0, 0, 0, NULL, datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=0, vacation_used_hours=0, sick_entitlement_hours=0, sick_used_hours=0, last_anniversary_applied=NULL, updated_at=datetime('now');

-- Charles Dickerson → Chuck Dickerson
UPDATE employees SET hire_date = '2024-12-16', birthday_md = '02-27', updated_at = datetime('now') WHERE id = 22;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (22, 40, 11, 40, 29, '2025-12-16', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=11, sick_entitlement_hours=40, sick_used_hours=29, last_anniversary_applied='2025-12-16', updated_at=datetime('now');

-- Chris Brady
UPDATE employees SET hire_date = '2026-07-13', birthday_md = '09-23', updated_at = datetime('now') WHERE id = 26;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (26, 0, 0, 0, 0, NULL, datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=0, vacation_used_hours=0, sick_entitlement_hours=0, sick_used_hours=0, last_anniversary_applied=NULL, updated_at=datetime('now');

-- Christopher E Miller → Chris Miller
UPDATE employees SET hire_date = '2020-09-27', birthday_md = '06-24', updated_at = datetime('now') WHERE id = 17;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (17, 120, 0, 40, 0, '2025-09-27', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=0, last_anniversary_applied='2025-09-27', updated_at=datetime('now');

-- Christopher R Marroquin → Chris Marroquin
UPDATE employees SET hire_date = '2024-08-05', birthday_md = '01-27', updated_at = datetime('now') WHERE id = 19;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (19, 40, 0, 40, 0, '2026-08-05', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=0, last_anniversary_applied='2026-08-05', updated_at=datetime('now');

-- Eric Gonzalez
UPDATE employees SET hire_date = '2012-01-06', birthday_md = '09-10', updated_at = datetime('now') WHERE id = 16;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (16, 120, 0, 40, 0, '2026-01-06', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=0, last_anniversary_applied='2026-01-06', updated_at=datetime('now');

-- Geovany Montes → Geo Montes
UPDATE employees SET hire_date = '2019-08-19', birthday_md = '07-15', updated_at = datetime('now') WHERE id = 28;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (28, 120, 0, 40, 0, '2025-08-19', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=0, last_anniversary_applied='2025-08-19', updated_at=datetime('now');

-- Humberto Ortiz → Beto Ortiz
UPDATE employees SET hire_date = '2019-08-05', birthday_md = '01-18', updated_at = datetime('now') WHERE id = 15;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (15, 120, 0, 40, 7, '2026-08-05', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=7, last_anniversary_applied='2026-08-05', updated_at=datetime('now');

-- Jaden De La Garza → Jaden DeLaGarza
UPDATE employees SET hire_date = '2025-07-07', birthday_md = '07-15', updated_at = datetime('now') WHERE id = 25;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (25, 40, 0, 40, 18, '2026-07-07', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=18, last_anniversary_applied='2026-07-07', updated_at=datetime('now');

-- Jared Lurch Esquivel → Lurch Esquivel
UPDATE employees SET hire_date = '2026-04-13', birthday_md = '09-27', updated_at = datetime('now') WHERE id = 29;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (29, 0, 0, 0, 0, NULL, datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=0, vacation_used_hours=0, sick_entitlement_hours=0, sick_used_hours=0, last_anniversary_applied=NULL, updated_at=datetime('now');

-- John J Alvarado → John Alvarado
UPDATE employees SET hire_date = '2019-07-22', birthday_md = '11-07', updated_at = datetime('now') WHERE id = 10;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (10, 120, 0, 40, 8, '2026-07-22', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=8, last_anniversary_applied='2026-07-22', updated_at=datetime('now');

-- John Williams
UPDATE employees SET hire_date = '2023-10-10', birthday_md = '05-08', updated_at = datetime('now') WHERE id = 9;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (9, 40, 40, 40, 40, '2025-10-10', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=40, sick_entitlement_hours=40, sick_used_hours=40, last_anniversary_applied='2025-10-10', updated_at=datetime('now');

-- Justin D Lyles → Justin Lyles
UPDATE employees SET hire_date = '2021-03-03', birthday_md = '06-23', updated_at = datetime('now') WHERE id = 1;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (1, 120, 0, 40, 8, '2026-03-03', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=8, last_anniversary_applied='2026-03-03', updated_at=datetime('now');

-- Kai G Woodruff → Kai Woodruff
UPDATE employees SET hire_date = '2022-11-07', birthday_md = '11-09', updated_at = datetime('now') WHERE id = 8;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (8, 80, 80, 40, 40, '2025-11-07', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=80, vacation_used_hours=80, sick_entitlement_hours=40, sick_used_hours=40, last_anniversary_applied='2025-11-07', updated_at=datetime('now');

-- Kelsie M Gomez → Kelsie Gomez
UPDATE employees SET hire_date = '2019-07-09', birthday_md = '06-10', updated_at = datetime('now') WHERE id = 21;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (21, 120, 0, 40, 11, '2026-07-09', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=11, last_anniversary_applied='2026-07-09', updated_at=datetime('now');

-- Kenneth Marroquin Jr → Speedy Marroquin
UPDATE employees SET hire_date = '2024-09-18', birthday_md = '01-20', updated_at = datetime('now') WHERE id = 20;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (20, 40, 40, 40, 40, '2025-09-18', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=40, sick_entitlement_hours=40, sick_used_hours=40, last_anniversary_applied='2025-09-18', updated_at=datetime('now');

-- Kirk Crumbly → Kirk Crumbley
UPDATE employees SET hire_date = '2025-01-10', birthday_md = '11-24', updated_at = datetime('now') WHERE id = 3;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (3, 40, 40, 40, 40, '2026-01-10', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=40, sick_entitlement_hours=40, sick_used_hours=40, last_anniversary_applied='2026-01-10', updated_at=datetime('now');

-- Kyle Duffield
UPDATE employees SET hire_date = '2025-04-01', birthday_md = '01-14', updated_at = datetime('now') WHERE id = 18;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (18, 40, 25, 40, 8, '2026-04-01', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=25, sick_entitlement_hours=40, sick_used_hours=8, last_anniversary_applied='2026-04-01', updated_at=datetime('now');

-- Marcus T Tovar → Marcus Tovar
UPDATE employees SET hire_date = '2024-01-02', birthday_md = '01-28', updated_at = datetime('now') WHERE id = 13;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (13, 40, 12, 40, 40, '2026-01-02', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=12, sick_entitlement_hours=40, sick_used_hours=40, last_anniversary_applied='2026-01-02', updated_at=datetime('now');

-- Michael Casarez → Mike Casarez (sick over 44/40)
UPDATE employees SET hire_date = '2023-09-05', birthday_md = '05-31', updated_at = datetime('now') WHERE id = 11;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (11, 40, 40, 40, 44, '2025-09-05', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=40, sick_entitlement_hours=40, sick_used_hours=44, last_anniversary_applied='2025-09-05', updated_at=datetime('now');

-- Nathaniel Torres → Nate Torres (vac over 47/40)
UPDATE employees SET hire_date = '2025-04-07', birthday_md = '01-13', updated_at = datetime('now') WHERE id = 30;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (30, 40, 47, 40, 40, '2026-04-07', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=47, sick_entitlement_hours=40, sick_used_hours=40, last_anniversary_applied='2026-04-07', updated_at=datetime('now');

-- Noah Maxwell
UPDATE employees SET hire_date = '2025-06-23', birthday_md = '06-14', updated_at = datetime('now') WHERE id = 31;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (31, 40, 0, 40, 7, '2026-06-23', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=7, last_anniversary_applied='2026-06-23', updated_at=datetime('now');

-- Omar J Camacho → Omar Camacho
UPDATE employees SET hire_date = '2019-04-08', birthday_md = '10-31', updated_at = datetime('now') WHERE id = 6;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (6, 120, 0, 40, 0, '2026-04-08', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=0, last_anniversary_applied='2026-04-08', updated_at=datetime('now');

-- Roberto F Gonzalez → Robert Gonzalez
UPDATE employees SET hire_date = '2022-05-16', birthday_md = '09-16', updated_at = datetime('now') WHERE id = 7;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (7, 80, 16, 40, 18, '2026-05-16', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=80, vacation_used_hours=16, sick_entitlement_hours=40, sick_used_hours=18, last_anniversary_applied='2026-05-16', updated_at=datetime('now');

-- Warren T Engle → Warren Engle
UPDATE employees SET hire_date = '2020-02-01', birthday_md = '10-09', updated_at = datetime('now') WHERE id = 12;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (12, 120, 30, 40, 40, '2026-02-01', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=120, vacation_used_hours=30, sick_entitlement_hours=40, sick_used_hours=40, last_anniversary_applied='2026-02-01', updated_at=datetime('now');

-- Wayne McCaskill
UPDATE employees SET hire_date = '2024-03-18', birthday_md = '03-29', updated_at = datetime('now') WHERE id = 14;
INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours, sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at)
VALUES (14, 40, 0, 40, 32, '2026-03-18', datetime('now'))
ON CONFLICT(employee_id) DO UPDATE SET vacation_entitlement_hours=40, vacation_used_hours=0, sick_entitlement_hours=40, sick_used_hours=32, last_anniversary_applied='2026-03-18', updated_at=datetime('now');
