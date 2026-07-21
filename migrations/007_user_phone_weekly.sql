-- User phone for repair / weekly-check reminders; force password change on first login
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
