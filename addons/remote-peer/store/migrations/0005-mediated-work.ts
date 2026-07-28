export const MEDIATED_WORK_SQL = `
ALTER TABLE proposal_requests ADD COLUMN request_type TEXT NOT NULL DEFAULT 'proposal' CHECK (request_type IN ('proposal', 'execute'));
ALTER TABLE proposal_requests ADD COLUMN prompt TEXT;
ALTER TABLE proposal_requests ADD COLUMN capability_profile TEXT NOT NULL DEFAULT 'restricted';
ALTER TABLE proposal_requests ADD COLUMN requested_capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE proposal_requests ADD COLUMN allowed_capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE proposal_requests ADD COLUMN chain_id TEXT;
ALTER TABLE proposal_requests ADD COLUMN chain_hop INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proposal_requests ADD COLUMN callback_url TEXT;
ALTER TABLE proposal_requests ADD COLUMN origin_chat_jid TEXT;
ALTER TABLE proposal_requests ADD COLUMN origin_thread_id TEXT;
ALTER TABLE proposal_requests ADD COLUMN completed_at TEXT;
ALTER TABLE proposal_requests ADD COLUMN callback_received_at TEXT;
ALTER TABLE proposal_requests ADD COLUMN callback_payload_sha256 TEXT;

CREATE TABLE capability_profiles (
  name TEXT PRIMARY KEY,
  allowed_capabilities_json TEXT NOT NULL,
  max_chain_hops INTEGER NOT NULL DEFAULT 3 CHECK (max_chain_hops BETWEEN 0 AND 8),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
INSERT INTO capability_profiles (name, allowed_capabilities_json, max_chain_hops, enabled, updated_at)
VALUES ('restricted', '["summarize","analyze","research"]', 3, 1, CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX idx_proposal_callback_once
  ON proposal_requests(id, callback_received_at)
  WHERE callback_received_at IS NOT NULL;
`;
