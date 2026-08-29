export const CHAT_MVP_SQL = `
ALTER TABLE peers ADD COLUMN attachments_enabled INTEGER NOT NULL DEFAULT 0 CHECK(attachments_enabled IN (0, 1));
ALTER TABLE peers ADD COLUMN max_attachment_bytes INTEGER NOT NULL DEFAULT 16777216 CHECK(max_attachment_bytes BETWEEN 0 AND 16777216);
ALTER TABLE inbound_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbound_messages ADD COLUMN source_chat_jid TEXT NOT NULL DEFAULT 'web:default';
ALTER TABLE outbound_messages ADD COLUMN source_agent_display_name TEXT;
ALTER TABLE outbound_messages ADD COLUMN content TEXT NOT NULL DEFAULT '';
ALTER TABLE outbound_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE outbound_attachments (
  transfer_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES outbound_messages(message_id) ON DELETE CASCADE
);
CREATE INDEX idx_outbound_attachments_message ON outbound_attachments(message_id);

CREATE TABLE inbound_attachments (
  transfer_id TEXT PRIMARY KEY,
  peer_instance_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  data BLOB NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE
);
CREATE INDEX idx_inbound_attachments_message ON inbound_attachments(peer_instance_id, message_id);

CREATE TABLE peer_roster_cache (
  peer_instance_id TEXT PRIMARY KEY,
  roster_json TEXT NOT NULL,
  roster_version INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  last_error TEXT,
  last_error_at TEXT,
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE
);
`;
