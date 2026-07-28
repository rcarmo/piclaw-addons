export const ROSTER_REPLIES_SQL = `
ALTER TABLE advertised_agents ADD COLUMN local_agent_name TEXT;

CREATE TABLE reply_tokens (
  token_hash TEXT PRIMARY KEY,
  peer_instance_id TEXT NOT NULL,
  target_chat_jid TEXT NOT NULL,
  source_agent_name TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE
);
CREATE INDEX idx_reply_tokens_expiry ON reply_tokens(expires_at);

CREATE TABLE peer_agent_permissions (
  peer_instance_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (peer_instance_id, agent_name),
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_name) REFERENCES advertised_agents(agent_name) ON DELETE CASCADE
);
`;
