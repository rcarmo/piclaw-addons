export const INITIAL_SCHEMA_SQL = `
CREATE TABLE addon_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE peers (
  instance_id TEXT PRIMARY KEY,
  peer_alias TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  display_name TEXT,
  base_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paired', 'blocked', 'revoked')),
  trust_epoch INTEGER NOT NULL DEFAULT 1 CHECK (trust_epoch >= 0),
  messaging_scope TEXT NOT NULL DEFAULT 'inbox-only' CHECK (messaging_scope IN ('none', 'inbox-only', 'named-agents', 'all-advertised')),
  mode_ceiling TEXT NOT NULL DEFAULT 'queue' CHECK (mode_ceiling IN ('queue', 'queue-auto', 'queue-auto-steer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  blocked_reason TEXT
);
CREATE INDEX idx_peers_status ON peers(status);
CREATE INDEX idx_peers_updated_at ON peers(updated_at);

CREATE TABLE pair_inbound (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  display_name TEXT,
  callback_url TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'denied', 'blocked', 'expired', 'failed')),
  source_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pair_inbound_status ON pair_inbound(status, created_at);

CREATE TABLE pair_outbound (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  base_url TEXT NOT NULL,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'denied', 'expired', 'failed')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_pair_outbound_status ON pair_outbound(status, created_at);

CREATE TABLE advertised_agents (
  agent_name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  allowed_modes TEXT NOT NULL DEFAULT 'queue',
  updated_at TEXT NOT NULL
);

CREATE TABLE inbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_instance_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  idempotency_key TEXT,
  target_agent_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  local_row_id INTEGER,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(peer_instance_id, message_id),
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_inbound_messages_idempotency
  ON inbound_messages(peer_instance_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_inbound_messages_status ON inbound_messages(status, received_at);

CREATE TABLE outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_instance_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT,
  source_agent_name TEXT,
  target_address TEXT NOT NULL,
  mode TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_outbound_messages_idempotency
  ON outbound_messages(peer_instance_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_outbound_messages_status ON outbound_messages(status, created_at);

CREATE TABLE message_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_instance_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(peer_instance_id, message_id, status),
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE
);

CREATE TABLE proposal_requests (
  id TEXT PRIMARY KEY,
  peer_instance_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE
);
CREATE INDEX idx_proposal_requests_status ON proposal_requests(direction, status, created_at);

CREATE TABLE callback_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_instance_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  callback_type TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL,
  error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(peer_instance_id, request_id, callback_type, attempt),
  FOREIGN KEY (peer_instance_id) REFERENCES peers(instance_id) ON DELETE CASCADE
);
CREATE INDEX idx_callback_attempts_due ON callback_attempts(status, next_attempt_at);

CREATE TABLE transport_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_instance_id TEXT,
  event TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_transport_audit_created_at ON transport_audit(created_at);
CREATE INDEX idx_transport_audit_peer ON transport_audit(peer_instance_id, created_at);
`;
