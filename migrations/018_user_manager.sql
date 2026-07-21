-- Who each user reports to (manager for org chart / future routing)
ALTER TABLE users ADD COLUMN manager_user_id INTEGER REFERENCES users(id);
