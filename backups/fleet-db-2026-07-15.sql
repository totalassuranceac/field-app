PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  username TEXT UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  role TEXT NOT NULL DEFAULT 'driver'
    CHECK (role IN ('admin', 'office', 'driver', 'mechanic', 'viewer')),
  employee_id INTEGER,
  auth_provider TEXT NOT NULL DEFAULT 'password'
    CHECK (auth_provider IN ('password', 'google', 'both')),
  google_sub TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "users" ("id","email","username","display_name","password_hash","password_salt","role","employee_id","auth_provider","google_sub","active","created_at","updated_at") VALUES(1,'admin@example.com','admin','Fleet Admin','0a91169792ea731b165118ef7c60e21e6cec9174ceda111062365e852512b993','1e830f2aa56b7212ed77b87d22d67cef','admin',NULL,'password',NULL,1,'2026-07-15 17:49:20','2026-07-15 17:49:20');
INSERT INTO "users" ("id","email","username","display_name","password_hash","password_salt","role","employee_id","auth_provider","google_sub","active","created_at","updated_at") VALUES(2,'mechanic@example.com','mechanic','Fleet Mechanic','2bdf8bc8408735dd2868c5e4b3e89255b4a6130b827c091efe234fa9cc027924','d2b98f1873463c7eca3c483bf1293da5','mechanic',NULL,'password',NULL,1,'2026-07-15 17:49:20','2026-07-15 17:49:20');
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('86b260d4998b923a324b6d8ed836ae618ac9ce3bfdbab8d50d13e5b54d491471',1,'2026-07-29T17:49:22.652Z','2026-07-15 17:49:22');
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('fd923b30a006301aecf427d5567406c498f36e68053e6d04fec218611d222888',1,'2026-07-29T17:57:16.545Z','2026-07-15 17:57:16');
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('7595a72e7b24d41eff3178efe689d9673f337c618d6992ea8921551790f957d2',1,'2026-07-29T17:57:24.350Z','2026-07-15 17:57:24');
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('498191fc014c4ea2215ca1118a611444cff2896ad636897597db873e990beb79',1,'2026-07-29T17:57:31.046Z','2026-07-15 17:57:31');
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('0e3eee810a793af7bfada4f435ac5a896ad4fa292e6a15364515289bd4c53804',1,'2026-07-29T17:57:35.653Z','2026-07-15 17:57:35');
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('755b75bdeb3029f04e5354741ddff35a65f21c3447b285b4859754d5710a5cec',1,'2026-07-29T17:57:38.538Z','2026-07-15 17:57:38');
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('471fdbb6bfb571f0e709fae352f3e613ecbd4f91ee5b45e3dd28eb76cfb791ff',1,'2026-07-29T17:57:39.275Z','2026-07-15 17:57:39');
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('1677eaf1fd18fdfd68df14b1ea6fe557ba2124b9c5aa71bdf7c328d0f67e3d05',1,'2026-07-29T17:57:43.731Z','2026-07-15 17:57:43');
INSERT INTO "sessions" ("id","user_id","expires_at","created_at") VALUES('e705cc19f8534fe5a0f84112c2032a750eeb32d0d7d725ee4922332cf1c80bb5',1,'2026-07-29T17:58:30.269Z','2026-07-15 17:58:30');
CREATE TABLE employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(1,'Justin Lyles',1,'(361) 461-5395',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(2,'Abel Herrera',1,'(361) 558-4395',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(3,'Kirk Crumbley',1,NULL,NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(4,'Adam Bosquez',1,'(361) 500-3246',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(5,'Arin Ramirez',1,'(361) 749-7355',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(6,'Omar Camacho',1,'(361) 500-3727',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(7,'Robert Gonzalez',1,'(361) 765-9793',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(8,'Kai Woodruff',1,'(361) 960-3688',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(9,'John Williams',1,'(361) 445-7863',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(10,'John Alvarado',1,'(361) 660-5572',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(11,'Mike Casarez',1,'(361) 658-5084',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(12,'Warren Engle',1,'(361) 704-0418',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(13,'Marcus Tovar',1,'(361) 288-5889',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(14,'Wayne McCaskill',1,'(361) 290-4110',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(15,'Beto Ortiz',1,'(361) 445-8609',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(16,'Eric Gonzalez',1,'(361) 446-0930',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(17,'Chris Miller',1,'(361) 300-4574',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "employees" ("id","name","active","phone","notes","created_at","updated_at") VALUES(18,'Kyle Duffield',1,'(361) 391-3064',NULL,'2026-07-15 17:46:57','2026-07-15 17:46:57');
CREATE TABLE vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_number TEXT NOT NULL UNIQUE,
  plate TEXT,
  year INTEGER,
  make TEXT,
  model TEXT,
  vin TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'out_of_service', 'retired')),
  current_odometer REAL,
  assigned_driver TEXT,
  phone TEXT,
  insurance_card TEXT,
  dash_cam_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (dash_cam_status IN ('working', 'not_working', 'missing', 'unknown')),
  cam_type TEXT,
  gps_tracker TEXT,
  registration_expires TEXT,
  inspection_expires TEXT,
  insurance_expires TEXT,
  emissions_expires TEXT,
  modifications TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(1,'001','MCW7359',2018,'Ford','Transit 250','1FTYR2CM7JKB40703','active',NULL,'Justin Lyles','(361) 461-5395','Yes','working','Dash Cam','One Step','2025-06-30',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(2,'002','TSG8388',2017,'Ford','Transit 250','1FTYR2CM7HKA99130','active',NULL,'Abel Herrera','(361) 558-4395','Yes','working','Verizon','Verizon','2025-11-30',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(3,'003','PJS0530',2015,'Ford','Transit 350','1FTSW2CM2FKA15551','active',NULL,'Kirk Crumbley',NULL,'Yes','working','Dash Cam','One Step','2025-03-31',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(4,'005','SHS4206',2019,'Ford','F-250 Super Duty','1FD7W2B61KEC62847','active',NULL,'Adam Bosquez','(361) 500-3246','Yes','missing','Dash Cam','Verizon','2026-10-31',NULL,NULL,NULL,NULL,'Adam''s FX4 ford f250 2026','2026-07-15 17:46:57','2026-07-15 18:12:42');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(5,'007','RHX5689',2018,'Nissan','NV Cargo','1N6BF0LY4JN808197','active',NULL,'Duct Cleaning Van','(361) 522-3308','Yes','working','Dash Cam','One Step','2026-02-28',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(6,'008','CFN7918',2013,'Ford','E-250','1FTNE2EL4DDA71111','active',NULL,'Arin Ramirez','(361) 749-7355','Yes','working','Dash Cam','One Step','2026-04-30',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(7,'009','RDS1831',2019,'Ford','Transit 150','1FTYE1YM5KKA24240','active',NULL,'Omar Camacho','(361) 500-3727','Yes','working','Verizon','Verizon','2026-04-30',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(8,'010','NJH8266',2019,'Ram','Promaster 2500 Base 159 WB','3C6TRVDG7KE512122','active',NULL,'Robert Gonzalez','(361) 765-9793','Yes','working','Verizon','Verizon','2025-05-31',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(9,'011','SYN4203',2020,'Ford','Transit 250','1FTBR1C82LKB16783','active',NULL,'Kai Woodruff','(361) 960-3688','Yes','working','Dash Cam','One Step','2026-05-31',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(10,'012','SCX9386',2017,'Ford','F-250 Super Duty Lariat / XL / XLT','3C7WRVKG8HE538555','active',NULL,'John Williams (dodge)','(361) 445-7863','Yes','working','Dash Cam','One Step','2026-04-30',NULL,NULL,NULL,NULL,'theft module issue','2026-07-15 17:46:57','2026-07-15 18:08:41');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(11,'013','TCH8358',2015,'Ford','Transit 250','1FTNR2CM6FKA07523','active',NULL,'John Alvarado','(361) 660-5572','Yes','working','Dash Cam','One Step','2027-05-31',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 18:04:42');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(12,'014','VHJ7798',2018,'Ford','Transit 250','1FTYR2CG6JKB29850','active',NULL,'Mike Casarez','(361) 658-5084','Yes','working','Dash Cam','One Step','2026-05-31',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(13,'015','RHX5690',2020,'Nissan','NV1500 S / SV','1N6BF0KM7LN800936','active',NULL,'Warren Engle','(361) 704-0418','Yes','working','Verizon','Verizon','2025-02-28',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(14,'016',NULL,2021,'Ford','Transit 250','1FTBR1C86MKA05672','active',NULL,'Marcus Tovar','(361) 288-5889','N/A','working','Dash Cam','One Step',NULL,NULL,NULL,NULL,NULL,'No plate / reg on sheet. Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(15,'018','VBS3774',2019,'Ford','Transit 150','1FTYE2CM2KKB52173','active',NULL,'Wayne McCaskill','(361) 290-4110','Yes','missing',NULL,'Verizon','2026-03-31',NULL,NULL,NULL,NULL,'Cam blank on sheet. Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(16,'Box2','TPJ4698',2019,'Ford','E-350 Super Duty','1FDWE3F68KDC28506','active',NULL,'Beto Ortiz','(361) 445-8609','Yes','working','Dash Cam','One Step','2025-12-31',NULL,NULL,NULL,NULL,'Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(17,'Box1','WSG6438',2021,'Chevy','Express 3500','1HA3GTC71MN010849','active',NULL,'Warehouse',NULL,NULL,'missing','Dash Cam','One Step','2026-08-31',NULL,NULL,NULL,NULL,NULL,'2026-07-15 17:46:57','2026-07-15 18:10:22');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(18,'XXX-TRAILER','252171M',2022,NULL,'25'' Trailer','5WWBK2024N6025383','active',NULL,'Warehouse / Trailer',NULL,'Yes','working','Dash Cam','Dash Cam',NULL,NULL,NULL,NULL,NULL,'Sheet unit XXX; reg N/A. Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(19,'XXX-WKW2986','WKW2986',2025,'Ford','F-150 Raptor','1FTFW1RJ7PFB36126','active',NULL,'Eric Gonzalez','(361) 446-0930','Yes','missing',NULL,NULL,'2027-04-30',NULL,NULL,NULL,NULL,'Sheet unit XXX. Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(20,'XXX-TPJ4876','TPJ4876',2023,'Ford','F-250 (6.7L)','1FT8W2BT2PEE19159','active',NULL,'Chris Miller','(361) 300-4574','Yes','missing',NULL,NULL,'2025-11-30',NULL,NULL,NULL,NULL,'Sheet unit XXX. Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
INSERT INTO "vehicles" ("id","unit_number","plate","year","make","model","vin","status","current_odometer","assigned_driver","phone","insurance_card","dash_cam_status","cam_type","gps_tracker","registration_expires","inspection_expires","insurance_expires","emissions_expires","modifications","notes","created_at","updated_at") VALUES(21,'XXX-DUFFIELD',NULL,2017,'Ford','Transit 250','1FTBW2CM6JKA13973','active',NULL,'Kyle Duffield','(361) 391-3064','Yes','working','Verizon','Verizon',NULL,NULL,NULL,NULL,NULL,'Sheet unit/plate XXX; reg PENDING. Imported from fleet sheet','2026-07-15 17:46:57','2026-07-15 17:46:57');
CREATE TABLE fuel_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  odometer REAL NOT NULL,
  gallons REAL,
  total_cost REAL,
  fuel_date TEXT NOT NULL,
  station_notes TEXT,
  receipt_key TEXT,
  entered_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE mileage_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_entry_id INTEGER NOT NULL REFERENCES fuel_entries(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('decrease', 'large_jump', 'no_baseline', 'duplicate_day')),
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'dismissed')),
  acknowledged_by_user_id INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  acknowledge_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE vehicle_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  reported_by_user_id INTEGER NOT NULL REFERENCES users(id),
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  scheduled_date TEXT,
  schedule_notes TEXT,
  completed_at TEXT,
  completion_notes TEXT,
  photo_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "settings" ("key","value","updated_at") VALUES('large_jump_miles','250','2026-07-15 18:55:20');
INSERT INTO "settings" ("key","value","updated_at") VALUES('large_jump_miles_per_day','180','2026-07-15 18:55:20');
INSERT INTO "settings" ("key","value","updated_at") VALUES('expiring_soon_days','30','2026-07-15 18:55:20');
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  user_display TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(1,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:49:22');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(2,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:57:16');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(3,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:57:24');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(4,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:57:31');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(5,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:57:35');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(6,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:57:38');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(7,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:57:39');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(8,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:57:43');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(9,1,'Fleet Admin','login','user','1','Password login',NULL,NULL,'2026-07-15 17:58:30');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(10,1,'Fleet Admin','update','vehicle','11','Updated vehicle 013','{"id":11,"unit_number":"013","plate":"TCH8358","year":2015,"make":"Ford","model":"Transit 250","vin":"1FTNR2CM6FKA07523","status":"active","current_odometer":null,"assigned_driver":"John Alvarado","phone":"(361) 660-5572","insurance_card":"Yes","dash_cam_status":"working","cam_type":"Dash Cam","gps_tracker":"One Step","registration_expires":"2026-05-31","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":"Imported from fleet sheet","created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 17:46:57"}','{"id":11,"unit_number":"013","plate":"TCH8358","year":2015,"make":"Ford","model":"Transit 250","vin":"1FTNR2CM6FKA07523","status":"active","current_odometer":null,"assigned_driver":"John Alvarado","phone":"(361) 660-5572","insurance_card":"Yes","dash_cam_status":"working","cam_type":"Dash Cam","gps_tracker":"One Step","registration_expires":"2027-05-31","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":"Imported from fleet sheet","created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 18:04:42"}','2026-07-15 18:04:42');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(11,1,'Fleet Admin','update','vehicle','10','Updated vehicle 012','{"id":10,"unit_number":"012","plate":"SCX9386","year":2017,"make":"Ford","model":"F-250 Super Duty Lariat / XL / XLT","vin":"3C7WRVKG8HE538555","status":"active","current_odometer":null,"assigned_driver":"John Williams (dodge)","phone":"(361) 445-7863","insurance_card":"Yes","dash_cam_status":"working","cam_type":"Dash Cam","gps_tracker":"One Step","registration_expires":"2026-04-30","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":"Sheet lists Ford body with Ram/Dodge VIN prefix 3C7; verify make/model. Imported from fleet sheet","created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 17:46:57"}','{"id":10,"unit_number":"012","plate":"SCX9386","year":2017,"make":"Ford","model":"F-250 Super Duty Lariat / XL / XLT","vin":"3C7WRVKG8HE538555","status":"active","current_odometer":null,"assigned_driver":"John Williams (dodge)","phone":"(361) 445-7863","insurance_card":"Yes","dash_cam_status":"working","cam_type":"Dash Cam","gps_tracker":"One Step","registration_expires":"2026-04-30","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":"theft module issue","created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 18:08:41"}','2026-07-15 18:08:41');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(12,1,'Fleet Admin','update','vehicle','4','Updated vehicle 005','{"id":4,"unit_number":"005","plate":"SHS4206","year":2019,"make":"Ford","model":"F-250 Super Duty","vin":"1FD7W2B61KEC62847","status":"active","current_odometer":null,"assigned_driver":"Adam Bosquez","phone":"(361) 500-3246","insurance_card":"Yes","dash_cam_status":"working","cam_type":"Dash Cam","gps_tracker":"Verizon","registration_expires":"2025-10-31","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":"Imported from fleet sheet","created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 17:46:57"}','{"id":4,"unit_number":"005","plate":"SHS4206","year":2019,"make":"Ford","model":"F-250 Super Duty","vin":"1FD7W2B61KEC62847","status":"active","current_odometer":null,"assigned_driver":"Adam Bosquez","phone":"(361) 500-3246","insurance_card":"Yes","dash_cam_status":"missing","cam_type":"Dash Cam","gps_tracker":"Verizon","registration_expires":"2026-10-31","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":null,"created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 18:09:33"}','2026-07-15 18:09:33');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(13,1,'Fleet Admin','update','vehicle','17','Updated vehicle Box1','{"id":17,"unit_number":"Box1","plate":"WSG6438","year":2021,"make":"Chevy","model":"Express 3500","vin":"1HA3GTC71MN010849","status":"active","current_odometer":null,"assigned_driver":"Warehouse","phone":null,"insurance_card":null,"dash_cam_status":"working","cam_type":"Dash Cam","gps_tracker":"One Step","registration_expires":"2026-08-31","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":"Imported from fleet sheet","created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 17:46:57"}','{"id":17,"unit_number":"Box1","plate":"WSG6438","year":2021,"make":"Chevy","model":"Express 3500","vin":"1HA3GTC71MN010849","status":"active","current_odometer":null,"assigned_driver":"Warehouse","phone":null,"insurance_card":null,"dash_cam_status":"missing","cam_type":"Dash Cam","gps_tracker":"One Step","registration_expires":"2026-08-31","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":null,"created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 18:10:22"}','2026-07-15 18:10:22');
INSERT INTO "audit_logs" ("id","user_id","user_display","action","entity_type","entity_id","summary","before_json","after_json","created_at") VALUES(14,1,'Fleet Admin','update','vehicle','4','Updated vehicle 005','{"id":4,"unit_number":"005","plate":"SHS4206","year":2019,"make":"Ford","model":"F-250 Super Duty","vin":"1FD7W2B61KEC62847","status":"active","current_odometer":null,"assigned_driver":"Adam Bosquez","phone":"(361) 500-3246","insurance_card":"Yes","dash_cam_status":"missing","cam_type":"Dash Cam","gps_tracker":"Verizon","registration_expires":"2026-10-31","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":null,"created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 18:09:33"}','{"id":4,"unit_number":"005","plate":"SHS4206","year":2019,"make":"Ford","model":"F-250 Super Duty","vin":"1FD7W2B61KEC62847","status":"active","current_odometer":null,"assigned_driver":"Adam Bosquez","phone":"(361) 500-3246","insurance_card":"Yes","dash_cam_status":"missing","cam_type":"Dash Cam","gps_tracker":"Verizon","registration_expires":"2026-10-31","inspection_expires":null,"insurance_expires":null,"emissions_expires":null,"modifications":null,"notes":"Adam''s FX4 ford f250 2026","created_at":"2026-07-15 17:46:57","updated_at":"2026-07-15 18:12:42"}','2026-07-15 18:12:42');
CREATE TABLE inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  inspector_user_id INTEGER NOT NULL REFERENCES users(id),
  inspection_date TEXT NOT NULL DEFAULT (date('now')),
  odometer REAL,
  overall_status TEXT NOT NULL DEFAULT 'pass'
    CHECK (overall_status IN ('pass', 'pass_with_notes', 'fail')),
  checklist_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  photo_key TEXT,
  created_issue_id INTEGER REFERENCES vehicle_issues(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE downtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  issue_id INTEGER REFERENCES vehicle_issues(id),
  reason TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  started_by_user_id INTEGER REFERENCES users(id),
  ended_by_user_id INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('employees',18);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('vehicles',21);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('users',2);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('audit_logs',14);
CREATE INDEX idx_fuel_vehicle_date ON fuel_entries(vehicle_id, fuel_date);
CREATE INDEX idx_fuel_employee ON fuel_entries(employee_id);
CREATE INDEX idx_alerts_status ON mileage_alerts(status);
CREATE INDEX idx_issues_status ON vehicle_issues(status);
CREATE INDEX idx_issues_vehicle ON vehicle_issues(vehicle_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_vehicles_unit ON vehicles(unit_number);
CREATE INDEX idx_inspections_vehicle ON inspections(vehicle_id);
CREATE INDEX idx_inspections_date ON inspections(inspection_date);
CREATE INDEX idx_downtime_vehicle ON downtime_events(vehicle_id);
CREATE INDEX idx_downtime_open ON downtime_events(vehicle_id, ended_at);
