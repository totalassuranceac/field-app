-- Threaded team messenger: conversations, subjects, thumbs-up acks

CREATE TABLE IF NOT EXISTS app_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL DEFAULT '',
  is_team INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_conversations_last
  ON app_conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS app_conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_app_conv_members_user
  ON app_conversation_members(user_id, conversation_id);

-- Link each message into a conversation thread
ALTER TABLE app_messages ADD COLUMN conversation_id INTEGER REFERENCES app_conversations(id);

CREATE INDEX IF NOT EXISTS idx_app_messages_conv
  ON app_messages(conversation_id, created_at ASC);

-- Thumbs-up / "got it" confirmation per message
CREATE TABLE IF NOT EXISTS app_message_acks (
  message_id INTEGER NOT NULL REFERENCES app_messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_app_message_acks_msg
  ON app_message_acks(message_id);
