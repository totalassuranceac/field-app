-- Link Field App logins to ServiceTitan technician IDs for Zero-charge counts.
ALTER TABLE users ADD COLUMN st_technician_id INTEGER;
